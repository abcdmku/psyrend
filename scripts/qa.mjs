// Quality gate for a world: everything the user has asked for that a machine can check, PASS/FAIL.
//   node scripts/qa.mjs --pin <scene id>[,<id>...] [--file <wav>] [--from 60] [--out artifacts/qa]
// Per world it writes <out>/<id>/: stills of three DNA variants at two moments, sheet.jpg, report.json.
// Checks: compiles cleanly; colour (several hues, no blow-out, no grey murk, not an empty void);
// the shape changes over 2 s; variants differ; never static; beats are seen (kick, snare, melody
// lifts) and change follows the music (corr). Passing the gate is necessary, not sufficient: a
// person still judges the sheet against docs/references.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const file = opt('file', 'C:/Users/Borg/Downloads/03 - Bass Face.wav');
const from = Number(opt('from', 60));
const outRoot = opt('out', 'artifacts/qa');
const VARIANTS = [0.13, 0.47, 0.81];
const MW = 96;
const MH = 54;

const server = await createServer({ server: { port: 5197, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
page.on('pageerror', (e) => problems.push(e.message));

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

/** Colour statistics of one frame (rgb bytes). */
function colour(rgb) {
  const bins = new Array(12).fill(0);
  let sat = 0;
  let clipped = 0;
  let black = 0;
  let murk = 0;
  let dark = 0;
  let satSum = 0;
  let satN = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i] / 255;
    const g = rgb[i + 1] / 255;
    const b = rgb[i + 2] / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const s = mx > 0 ? (mx - mn) / mx : 0;
    if (mn > 0.96) clipped++;
    if (mx < 0.05) black++;
    if (s < 0.15 && mx > 0.12 && mx < 0.6) murk++;
    if (mx < 0.14) dark++;
    if (mx > 0.3) {
      satSum += s;
      satN++;
    }
    if (s > 0.25 && mx > 0.15) {
      sat++;
      const d = mx - mn;
      let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      bins[Math.floor(h / 30) % 12]++;
    }
  }
  // Distinct hues: runs of neighbouring 30-degree bins that each hold at least 3% of the coloured
  // pixels (thin accent lines count); a run wider than 90 degrees counts as more than one hue.
  const q = bins.map((b) => sat > 0 && b > 0.03 * sat);
  let hues = 0;
  if (q.every(Boolean)) hues = 4;
  else
    for (let k = 0; k < 12; k++) {
      if (!q[k] || q[(k + 11) % 12]) continue;
      let len = 0;
      while (q[(k + len) % 12] && len < 12) len++;
      hues += 1 + Math.floor((len - 1) / 3);
    }
  return { hues, coloured: sat / n, clipped: clipped / n, black: black / n, murk: murk / n, dark: dark / n, vivid: satN ? satSum / satN : 0, brightness: mean(rgb) / 255 };
}

/** 1 - correlation of mean-removed luminance: 0 = same structure, 1 = unrelated. */
function structureChange(a, b) {
  const la = [];
  const lb = [];
  for (let i = 0; i < a.length; i += 3) {
    la.push(a[i] * 0.2 + a[i + 1] * 0.7 + a[i + 2] * 0.1);
    lb.push(b[i] * 0.2 + b[i + 1] * 0.7 + b[i + 2] * 0.1);
  }
  const ma = mean(la);
  const mb = mean(lb);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < la.length; i++) {
    ab += (la[i] - ma) * (lb[i] - mb);
    aa += (la[i] - ma) ** 2;
    bb += (lb[i] - mb) ** 2;
  }
  return aa && bb ? 1 - ab / Math.sqrt(aa * bb) : 1;
}

const render = (t, dt, w, h, img, crop) => page.evaluate(([tt, d, ww, hh, im, cr]) => window.__psy.renderAt(tt, d, ww, hh, !!im, im?.[0], im?.[1], cr ?? undefined), [t, dt, w, h, img, crop ?? null]);
async function warm(t, secs = 1.5) {
  for (let k = Math.round(secs * 30); k > 0; k--) await render(t - k / 30, 1 / 30, 8, 8);
}

async function reactivity(ev, dur = 6, fps = 30, t0 = from) {
  await warm(t0, 2);
  const n = Math.round(dur * fps);
  const d = [];
  const drv = [];
  let prev = null;
  let dv = 0;
  for (let i = 0; i < n; i++) {
    const r = await render(t0 + i / fps, 1 / fps, MW, MH);
    d.push(prev ? diff(r.rgb, prev) : 0);
    prev = r.rgb;
    // The morph's bass/loudness drive (same curve and easing as morph.ts), so the flow that rushes
    // with the bass is fitted as its own term and not mistaken for, or hiding, beat reactions.
    const m = await page.evaluate(() => window.__psy.music());
    const w = 1 - Math.exp(-1.4 * (0.55 * m.energy + 0.7 * m.bass + 0.25 * m.sub));
    dv += (w - dv) * (1 - Math.exp(-(1 / fps) / (w > dv ? 0.2 : 0.45)));
    drv.push(i === 0 ? w : dv);
  }
  d[0] = d[1] ?? 0;
  const at = (t) => Math.round((t - t0) * fps);
  const inWin = (xs) => xs.filter((t) => t >= t0 && t < t0 + dur);
  // How much each kind of event adds to the motion, with overlapping reactions separated: fit
  // d = base + sum over kinds of gain * (eased response curves at that kind's events), by least
  // squares. "seen" = gain / base, the extra motion at the peak of a reaction (0.3 = 30% more).
  // An eased reaction counts fully, so nothing has to snap, and dense beats don't hide each other.
  const kernel = (times) =>
    d.map((_, i) => {
      const t = t0 + i / fps;
      let e = 0;
      for (const te of times) if (t >= te) e += ((t - te) / 0.15) * Math.exp(1 - (t - te) / 0.15);
      return e;
    });
  const kinds = [inWin(ev.kicks), inWin(ev.snares), inWin(ev.leadOnsets), inWin(ev.upperOnsets ?? [])];
  // The world reshapes on the phrase grid (every 4 bars, gliding over about a bar). That motion is
  // wanted but isn't a beat reaction, so it gets its own term instead of muddying the beat fits.
  const db = ev.downbeats ?? [];
  const barLen = (60 / (ev.bpm || 120)) * 4;
  const phraseStarts = [...db.filter((_, k) => k % 4 === 0), ...(ev.sections ?? []).map((s) => s.start)].filter((t) => t >= t0 - barLen * 1.5 && t < t0 + dur);
  const phrase = d.map((_, i) => {
    const t = t0 + i / fps;
    let e = 0;
    for (const tb of phraseStarts) {
      const u = (t - tb) / (barLen * 1.5);
      if (u > 0 && u < 1) e += Math.sin(Math.PI * u) ** 2;
    }
    return e;
  });
  // Beat reactions are fast (rise ~0.15 s, settle ~0.5 s); phrase reshapes, colour cycles, camera
  // glides and the bass-driven rush are slow (a bar or more). Fit the beats on the motion with its
  // slow part removed (minus a 1.5 s running median, plus the overall level), so wanted phrase-scale
  // change neither hides nor fakes a beat reaction.
  const half = Math.round(0.75 * fps);
  const level = median(d);
  const dfit = d.map((x, i) => x - median(d.slice(Math.max(0, i - half), i + half + 1)) + level);
  void phrase;
  void drv;
  const cols = [d.map(() => 1), ...kinds.filter((k) => k.length).map(kernel)];
  const m = cols.length;
  const A = cols.map((ci, i) => cols.map((cj, j) => ci.reduce((acc, x, t) => acc + x * cj[t], 0) + (i === j && i > 0 ? 1e-3 : 0)));
  const y = cols.map((ci) => ci.reduce((acc, x, t) => acc + x * dfit[t], 0));
  for (let i = 0; i < m; i++) {
    let p = i;
    for (let r = i + 1; r < m; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    [y[i], y[p]] = [y[p], y[i]];
    for (let r = i + 1; r < m; r++) {
      const fct = A[r][i] / (A[i][i] || 1e-12);
      for (let c = i; c < m; c++) A[r][c] -= fct * A[i][c];
      y[r] -= fct * y[i];
    }
  }
  const coef = new Array(m).fill(0);
  for (let i = m - 1; i >= 0; i--) {
    let acc = y[i];
    for (let c = i + 1; c < m; c++) acc -= A[i][c] * coef[c];
    coef[i] = acc / (A[i][i] || 1e-12);
  }
  const base = Math.max(coef[0], 1e-4);
  let ci = 1;
  const seen = kinds.map((k) => (k.length ? +(coef[ci++] / base).toFixed(2) : null));
  const env = d.map((_, i) => {
    const t = t0 + i / fps;
    let e = 0;
    // An eased response: rises over ~150 ms and settles over ~half a second (no instant spike).
    for (const te of [...inWin(ev.kicks), ...inWin(ev.snares), ...inWin(ev.leadOnsets)]) if (t >= te) e += ((t - te) / 0.15) * Math.exp(1 - (t - te) / 0.15);
    return e;
  });
  const ma = mean(d);
  const me = mean(env);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < d.length; i++) {
    sab += (d[i] - ma) * (env[i] - me);
    saa += (d[i] - ma) ** 2;
    sbb += (env[i] - me) ** 2;
  }
  // Snaps: frames that change far more than the motion around them (a jump, not a flow). The
  // 98th percentile of each frame's change over the median change in the second around it.
  const local = d.map((x, i) => x / (median(d.slice(Math.max(0, i - 15), i + 16)) + 1e-4));
  const snap = [...local].sort((a, b) => a - b)[Math.floor(local.length * 0.98)] ?? 0;
  // Never static: the quietest one-second stretch must still move.
  let stillest = Infinity;
  for (let i = 0; i + fps <= n; i += 5) stillest = Math.min(stillest, mean(d.slice(i, i + fps)));
  return {
    kick: seen[0],
    snare: seen[1],
    lead: seen[2],
    upper: seen[3],
    d: d.map((x) => +x.toFixed(5)),
    corr: saa && sbb ? +(sab / Math.sqrt(saa * sbb)).toFixed(2) : 0,
    stillest: +stillest.toFixed(4),
    snap: +snap.toFixed(2),
  };
}

try {
  await page.goto(`${server.resolvedUrls.local[0]}?seed=${opt('seed', '1')}`);
  await page.waitForFunction(() => !!window.__psy, null, { timeout: 60000 });
  await page.setInputFiles('input[type=file]', file);
  await page.waitForFunction(() => window.__psy?.stats?.playing === true, null, { timeout: 180000 });
  const ev = await page.evaluate(() => window.__psy.events());
  // --look <id> gates the worlds with that overlay look applied (default: none).
  await page.evaluate((id) => window.__psy.look(id), opt('look', null));
  for (const id of opt('pin').split(',')) {
    const mark = problems.length;
    const out = path.join(outRoot, id);
    await mkdir(out, { recursive: true });
    await page.evaluate((x) => window.__psy.pin(x), id);
    const frames = {};
    // The scene actually on screen: a world that fails to compile silently falls back to another one.
    const shown = new Set();
    for (const v of VARIANTS) {
      await page.evaluate((x) => window.__psy.variant(x), v);
      for (const t of [from + 2, from + 4]) {
        await warm(t);
        const r = await render(t, 1 / 30, MW, MH, [960, 540]);
        // A 1:1 centre crop of the 1920x1080 frame: upscaled internal buffers and aliasing show here.
        if (v === VARIANTS[1] && t === from + 2) {
          const c = await render(t, 0, 8, 8, [960, 540], [480, 270, 960, 540]);
          await writeFile(path.join(out, `${id}-zz-crop1to1.jpg`), Buffer.from(c.image.split(',')[1], 'base64'));
        }
        shown.add(r.scene);
        frames[`${v}@${t}`] = r.rgb;
        await writeFile(path.join(out, `${id}-v${v}-${t}.jpg`), Buffer.from(r.image.split(',')[1], 'base64'));
      }
    }
    await page.evaluate(() => window.__psy.variant(0.47));
    const react = await reactivity(ev);
    // The quiet opening: as the level rises from silence nothing may jolt (no thresholds).
    const quiet = await reactivity(ev, 6, 30, Number(opt('quiet', 3)));
    const cols = Object.values(frames).map(colour);
    const avg = (k) => +mean(cols.map((c) => c[k])).toFixed(3);
    const shape = +mean(VARIANTS.map((v) => structureChange(frames[`${v}@${from + 2}`], frames[`${v}@${from + 4}`]))).toFixed(2);
    const spread = +mean([0, 1, 2].map((i) => structureChange(frames[`${VARIANTS[i]}@${from + 2}`], frames[`${VARIANTS[(i + 1) % 3]}@${from + 2}`]))).toFixed(2);
    // This world's errors: new ones while it ran (except those naming another scene, which the
    // renderer compiles in the background) plus any startup compile error that names it.
    const other = (p) => /\[scene [a-z0-9-]+\]/.test(p) && !p.includes(`[scene ${id}]`);
    const own = [...new Set([...problems.slice(mark).filter((p) => !other(p)), ...problems.slice(0, mark).filter((p) => p.includes(id))])].filter((p) => !/favicon/i.test(p));
    const checks = [
      ['renders this world', shown.size === 1 && shown.has(id), [...shown].join(',')],
      ['compiles cleanly', own.length === 0, own.slice(0, 2).join(' | ').slice(0, 300) || 'ok'],
      ['several hues (>= 2)', avg('hues') >= 2, avg('hues')],
      ['coloured, not grey (>= 0.15)', avg('coloured') >= 0.15, avg('coloured')],
      ['no blow-out (<= 0.04)', avg('clipped') <= 0.04, avg('clipped')],
      ['no grey murk (<= 0.3)', avg('murk') <= 0.3, avg('murk')],
      ['not an empty void (black <= 0.7)', avg('black') <= 0.7, avg('black')],
      // The references are vivid colour on deep darks: a frame with no darks or pastel colour is washed out.
      ['has real darks (>= 0.12)', avg('dark') >= 0.12, avg('dark')],
      ['vivid, not pastel (>= 0.45)', avg('vivid') >= 0.45, avg('vivid')],
      ['shape changes in 2 s (>= 0.15)', shape >= 0.15, shape],
      ['variants differ (>= 0.3)', spread >= 0.3, spread],
      ['never static (>= 0.004)', react.stillest >= 0.004, react.stillest],
      // Smooth reactions: each hit raises the motion over the next half second, and nothing snaps.
      // 'seen' = extra motion at the peak of each eased reaction, from the overlap-aware fit.
      ['kick seen (>= 0.25)', (react.kick ?? 0) >= 0.25, react.kick],
      ['snare seen (>= 0.15)', react.snare === null || react.snare >= 0.15, react.snare],
      ['melody seen (>= 0.2)', react.lead === null || react.lead >= 0.2, react.lead],
      // High melodies and arps rework the fine detail (RULES v7). Fine detail moves fewer pixels.
      ['high melody seen (>= 0.1)', react.upper === null || react.upper >= 0.1, react.upper],
      ['no snaps (<= 2.3)', react.snap <= 2.3, react.snap],
      ['no snaps in the quiet opening (<= 2.3)', quiet.snap <= 2.3, quiet.snap],
      ['follows the music (corr >= 0.3)', react.corr >= 0.3, react.corr],
    ];
    const pass = checks.every((c) => c[1]);
    await writeFile(path.join(out, 'report.json'), JSON.stringify({ id, pass, checks, react, colour: cols }, null, 1));
    execFileSync(process.execPath, ['scripts/sheet.mjs', out, '--cols', '3', '--w', '1500']);
    console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${id}   sheet: ${path.join(out, 'sheet.jpg')}`);
    for (const [name, ok, val] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}: ${val}`);
  }
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
