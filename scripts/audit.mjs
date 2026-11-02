// Measures what a viewer feels and stills can't show: does the picture answer the music, and does
// it repeat? Renders frames offline (exact song times, fixed step) in GPU-backed Chrome.
//
// Reactivity (one track, one stretch):
//   node scripts/audit.mjs react --file <wav> --from 40 --dur 8 [--fps 30] [--pin <scene id>]
//        [--layout id --layers a,b --camera id --background id --material m] [--save 15] [--out dir] [--json file]
//        [--variant 0.3] [--nolook]   fixed DNA variant / no post look, so before-and-after runs compare the same visual
//   For each event kind (kick, snare, hat, lead note, bass note, chord change) it reports the lift:
//   picture change in the 100 ms after the event over the change in the 200 ms before it. About 1
//   means the picture ignores that event; well above 1 means you see it. Also the correlation of
//   frame-to-frame change with the onset envelope, and the overall motion level.
//
// Variety (several tracks, played in sequence like a session, novelty memory shared):
//   node scripts/audit.mjs variety --files a.wav,b.wav,c.wav [--per 2] [--out dir]
//   Captures frames through each show and reports the most similar pairs across the session.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const outDir = opt('out', `artifacts/audit-${mode}`);
await mkdir(outDir, { recursive: true });

const server = await createServer({ server: { port: 5198, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const problems = [];

async function openTrack(file) {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`[console] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  const q = new URLSearchParams(file ? {} : { demo: '1' });
  for (const k of ['layout', 'layers', 'camera', 'background', 'material', 'scale']) if (opt(k)) q.set(k, opt(k));
  if (args.includes('--cues')) q.set('cues', '1');
  await page.goto(`${url}?${q}`);
  if (file) {
    await page.waitForFunction(() => !!window.__psy, null, { timeout: 60000 });
    await page.setInputFiles('input[type=file]', file);
  }
  await page.waitForFunction(() => window.__psy?.stats?.playing === true, null, { timeout: 180000 });
  if (opt('pin')) await page.evaluate((id) => window.__psy.pin(id), opt('pin'));
  // Comparable runs: a fixed DNA variant and no post look (otherwise every run draws new ones).
  if (opt('variant')) await page.evaluate((v) => window.__psy.variant(v), Number(opt('variant')));
  if (args.includes('--nolook')) await page.evaluate(() => window.__psy.look(null));
  return page;
}

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const diff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length / 255;
};

async function measure(page, ev, from, dur, fps, save) {
  // Warm up the simulation state before measuring.
  for (let t = from - 2; t < from; t += 1 / fps) await page.evaluate(([tt, dt]) => window.__psy.renderAt(tt, dt, 8, 8), [t, 1 / fps]);
  const n = Math.round(dur * fps);
  const d = [];
  const lum = [];
  let prev = null;
  let scene = '';
  for (let i = 0; i < n; i++) {
    const t = from + i / fps;
    const r = await page.evaluate(([tt, dt, j]) => window.__psy.renderAt(tt, dt, 160, 90, j), [t, 1 / fps, save > 0 && i % save === 0]);
    scene = r.scene;
    if (r.image) await writeFile(path.join(outDir, `f${String(i).padStart(4, '0')}.jpg`), Buffer.from(r.image.split(',')[1], 'base64'));
    d.push(prev ? diff(r.rgb, prev) : 0);
    lum.push(mean(r.rgb) / 255);
    prev = r.rgb;
  }
  d[0] = d[1] ?? 0;
  const at = (t) => Math.round((t - from) * fps);
  const lift = (times) => {
    const ls = [];
    for (const te of times) {
      const k = at(te);
      if (k < 7 || k + 3 >= n) continue;
      const after = Math.max(...d.slice(k, k + 3));
      const before = mean(d.slice(k - 7, k - 1));
      ls.push((after + 1e-4) / (before + 1e-4));
    }
    return ls.length ? { n: ls.length, lift: +median(ls).toFixed(2) } : { n: 0, lift: null };
  };
  const inWin = (xs) => xs.filter((t) => t >= from && t < from + dur);
  const env = d.map((_, i) => {
    const t = from + i / fps;
    let e = 0;
    for (const te of [...inWin(ev.kicks), ...inWin(ev.snares), ...inWin(ev.leadOnsets)]) if (t >= te) e += Math.exp(-(t - te) / 0.12);
    return e;
  });
  const corr = (() => {
    const ma = mean(d);
    const mb = mean(env);
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < d.length; i++) {
      sab += (d[i] - ma) * (env[i] - mb);
      saa += (d[i] - ma) ** 2;
      sbb += (env[i] - mb) ** 2;
    }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  })();
  const report = {
    scene,
    window: [from, from + dur],
    motion: +(median(d) * 100).toFixed(2),
    brightness: +mean(lum).toFixed(3),
    corr: +corr.toFixed(2),
    kick: lift(inWin(ev.kicks)),
    snare: lift(inWin(ev.snares)),
    hat: lift(inWin(ev.hats)),
    lead: lift(inWin(ev.leadOnsets)),
    bass: lift(inWin(ev.bassOnsets)),
    chord: lift(inWin(ev.chordChanges)),
  };
  return { report, d, env };
}

async function react() {
  const page = await openTrack(opt('file'));
  const ev = await page.evaluate(() => window.__psy.events());
  const { report, d, env } = await measure(page, ev, Number(opt('from', 40)), Number(opt('dur', 8)), Number(opt('fps', 30)), Number(opt('save', 0)));
  console.log(JSON.stringify(report));
  if (opt('json')) await writeFile(opt('json'), JSON.stringify({ ...report, d, env }, null, 0));
}

/** Every hand-authored scene (pinned) and every composed layer (forced alone), on one page. */
async function batch() {
  const page = await openTrack(opt('file'));
  const ev = await page.evaluate(() => window.__psy.events());
  const what = opt('what', 'all');
  const from = Number(opt('from', 40));
  const dur = Number(opt('dur', 6));
  const out = opt('jsonl', path.join(outDir, 'audit.jsonl'));
  const items = [];
  if (what !== 'layers') for (const id of await page.evaluate(() => window.__psy.scenes())) if (!id.startsWith('sculpt:')) items.push({ kind: 'scene', id });
  if (what !== 'scenes') for (const l of await page.evaluate(() => window.__psy.layers())) items.push({ kind: 'layer', id: l.id, layout: l.layout });
  for (const it of items) {
    try {
      if (it.kind === 'scene') {
        await page.evaluate((id) => window.__psy.pin(id), it.id);
      } else {
        await page.evaluate(() => window.__psy.pin(null));
        await page.evaluate((f) => window.__psy.recompose(f), { layout: it.layout, layers: [it.id], background: 'deep' });
      }
      const { report } = await measure(page, ev, from, dur, 30, Number(opt('save', 0)) ? 60 : 0);
      const line = JSON.stringify({ ...it, r: report });
      console.log(line);
      await writeFile(out, `${line}\n`, { flag: 'a' });
    } catch (e) {
      console.log(JSON.stringify({ ...it, error: String(e) }));
    }
  }
}

async function variety() {
  const files = opt('files').split(',');
  const per = Number(opt('per', 2));
  const shots = [];
  for (const file of files) {
    const page = await openTrack(file);
    const ev = await page.evaluate(() => window.__psy.events());
    const name = path.basename(file).replace(/\.\w+$/, '');
    // Walk the song in order (so the director records what was shown), capturing per section.
    for (const s of ev.sections) {
      for (let k = 0; k < per; k++) {
        const t = s.start + ((k + 0.5) / per) * (s.end - s.start);
        for (let w = 1.5; w > 0; w -= 1 / 30) await page.evaluate(([tt, dt]) => window.__psy.renderAt(tt, dt, 8, 8), [t - w, 1 / 30]);
        const r = await page.evaluate(([tt, dt]) => window.__psy.renderAt(tt, dt, 32, 18, true), [t, 1 / 30]);
        const id = `${name.slice(0, 12)}@${t.toFixed(0)}-${String(r.scene).slice(0, 18)}`;
        await writeFile(path.join(outDir, `${String(shots.length).padStart(3, '0')}-${id.replace(/[^\w@.-]/g, '_')}.jpg`), Buffer.from(r.image.split(',')[1], 'base64'));
        shots.push({ id, rgb: r.rgb, scene: r.scene, kind: s.kind });
      }
    }
    await page.close();
  }
  // Similarity: structure (luminance layout) and colour (mean RGB per region), 0..1.
  const sim = (a, b) => 1 - Math.min(1, diff(a.rgb, b.rgb) * 4);
  const pairs = [];
  for (let i = 0; i < shots.length; i++) for (let j = i + 1; j < shots.length; j++) pairs.push({ a: shots[i].id, b: shots[j].id, s: sim(shots[i], shots[j]), same: shots[i].scene === shots[j].scene });
  pairs.sort((x, y) => y.s - x.s);
  console.log(`shots: ${shots.length}; mean similarity ${mean(pairs.map((p) => p.s)).toFixed(2)}; pairs >0.8: ${pairs.filter((p) => p.s > 0.8).length}/${pairs.length}`);
  for (const p of pairs.slice(0, 12)) console.log(`  ${p.s.toFixed(2)}  ${p.a}  ~  ${p.b}`);
  const scenes = new Map();
  for (const s of shots) scenes.set(s.scene, (scenes.get(s.scene) ?? 0) + 1);
  console.log(`distinct scenes: ${scenes.size}`);
}

try {
  if (mode === 'react') await react();
  else if (mode === 'variety') await variety();
  else if (mode === 'batch') await batch();
  else console.log('usage: audit.mjs react|variety ...');
} finally {
  if (problems.length) console.log(`problems:\n${[...new Set(problems)].slice(0, 20).join('\n')}`);
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
