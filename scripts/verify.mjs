// Drives the real app in GPU-backed Chrome: plays the synthesized demo, pins each
// scene, captures screenshots and reports frame stats and any WGSL/console errors.
//
//   node scripts/verify.mjs                      # all scenes, default times
//   node scripts/verify.mjs --scenes a,b --times 20,50 --out artifacts/shots
//   node scripts/verify.mjs --auto               # auto-directed run, one shot every few seconds
//   --variants 0,0.33,0.66  forces each scene's variant seed in turn
//   --looks all|a,b  [--look-scene id] [--look-dna a,b,c,d]  renders each post look over one scene
//   --look none  judges scenes without any post look (other post stays on)
//   --file <audio path>  load a real track instead of the demo; --from/--until/--every for --auto
//   --layout id --layers a,b --camera id --background id   force composed-visual parts
//   flags: --nopost  --post k=v,k=v  --scale 0.5  --w 1920 --h 1080  --vsync  --headed  --postdump
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const outDir = opt('out', 'artifacts/shots');
const times = opt('times', '15,48,62').split(',').map(Number);
const width = Number(opt('w', 1280));
const height = Number(opt('h', 720));
const settle = Number(opt('settle', 1500));
await mkdir(outDir, { recursive: true });

// No HMR / file watching: edits elsewhere in the tree must not reload the page mid-run.
const server = await createServer({ server: { port: 5199, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  channel: opt('channel', 'chrome'),
  headless: !flag('headed'),
  args: [
    '--enable-unsafe-webgpu',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--use-angle=d3d11',
    '--autoplay-policy=no-user-gesture-required',
    // Uncapped by default to stress frame-rate independence; --vsync for display-rate behaviour.
    ...(flag('vsync') ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit']),
  ],
});
// Always close the browser and server, even on failure: crashed runs leak Chrome temp profiles.
const shutdown = async () => {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
};
process.on('SIGINT', () => shutdown().then(() => process.exit(130)));
process.on('SIGTERM', () => shutdown().then(() => process.exit(143)));

const problems = [];
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /error|warning/i.test(t)) problems.push(`[console.${m.type()}] ${t}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

  const q = new URLSearchParams(opt('file') ? {} : { demo: '1' });
  if (opt('scale')) q.set('scale', opt('scale'));
  if (flag('nopost')) q.set('nopost', '1');
  for (const k of ['layout', 'layers', 'camera', 'background', 'material']) if (opt(k)) q.set(k, opt(k));
  for (const kv of (opt('post', '') || '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    q.set(`post.${k}`, v);
  }
  await page.goto(`${url}?${q}`);
  if (opt('file')) {
    await page.waitForFunction(() => !!window.__psy, null, { timeout: 60000 });
    await page.setInputFiles('input[type=file]', opt('file'));
  }
  await page.waitForFunction(() => window.__psy?.stats?.playing === true, null, { timeout: 180000 });
  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return a ? `${a.info.vendor} ${a.info.architecture} ${a.info.description}` : 'none';
  });
  console.log(`adapter: ${adapter}`);
  if (flag('analysis')) console.log('analysis:', JSON.stringify(await page.evaluate(() => window.__psy.analysis), null, 1));
  if (flag('cues')) console.log('cues:', JSON.stringify(await page.evaluate(() => window.__psy.cues())));
  const allScenes = await page.evaluate(() => window.__psy.scenes());
  const scenes = opt('scenes') ? opt('scenes').split(',') : allScenes;
  const errors = await page.evaluate(() => window.__psy.stats.errors);
  for (const e of errors) problems.push(`[scene ${e.id}] ${e.message}`);

  const snap = async (name) => {
    const file = path.join(outDir, `${name}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 88 });
    const s = await page.evaluate(() => window.__psy.stats);
    if (flag('postdump')) console.log(JSON.stringify(await page.evaluate(() => window.__psy.post())));
    console.log(`${name}: fps=${s.fps} gpu=${s.gpuMs.toFixed(2)}ms scale=${s.scale.toFixed(2)} render=${s.render.w}x${s.render.h} scene=${s.scene} t=${s.time.toFixed(1)}`);
  };

  // Seek early by the settle time, then pause so the frame shows (about) the requested song time.
  const capture = async (t, name) => {
    await page.evaluate(async (tt) => {
      window.__psy.seek(tt);
      await window.__psy.play();
    }, Math.max(0, t - settle / 1000));
    await page.waitForTimeout(settle);
    await page.evaluate(() => window.__psy.pause());
    await page.waitForTimeout(120);
    await snap(name);
    await page.evaluate(() => window.__psy.play());
  };

  for (const e of await page.evaluate(() => window.__psy.lookErrors())) problems.push(`[look ${e.id}] ${e.message}`);
  if (opt('look') === 'none') await page.evaluate(() => window.__psy.look(null));
  if (opt('look-dna')) await page.evaluate((d) => window.__psy.lookDna(d), opt('look-dna').split(',').map(Number));
  if (opt('looks')) {
    const all = await page.evaluate(() => window.__psy.looks());
    const list = opt('looks') === 'all' ? all : opt('looks').split(',');
    const base = opt('look-scene', 'kaleido-temple');
    await page.evaluate((s) => window.__psy.pin(s), base);
    for (const id of list) {
      await page.evaluate((l) => window.__psy.look(l), id);
      for (const t of times) await capture(t, `look-${id}-${t}`);
    }
    for (const e of await page.evaluate(() => window.__psy.lookErrors())) problems.push(`[look ${e.id}] ${e.message}`);
  } else if (flag('auto')) {
    await page.evaluate(() => window.__psy.pin(null));
    const every = Number(opt('every', 6));
    const until = Number(opt('until', 135));
    for (let t = Number(opt('from', 2)); t < until; t += every) await capture(t, `auto-${String(t).padStart(3, '0')}`);
  } else {
    for (const id of scenes) {
      if (!allScenes.includes(id)) {
        problems.push(`scene ${id} not loaded`);
        continue;
      }
      await page.evaluate((s) => window.__psy.pin(s), id);
      const variants = opt('variants') ? opt('variants').split(',').map(Number) : [null];
      for (const v of variants) {
        await page.evaluate((vv) => window.__psy.variant(vv), v);
        for (const t of times) await capture(t, v === null ? `${id}-${t}` : `${id}-v${v}-${t}`);
      }
      await page.evaluate(() => window.__psy.variant(null));
    }
  }
  console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n${[...new Set(problems)].join('\n')}` : '\nno problems');
  process.exitCode = problems.length ? 1 : 0;
} catch (err) {
  console.error(err);
  console.log([...new Set(problems)].slice(0, 20).join(String.fromCharCode(10)));
  process.exitCode = 2;
} finally {
  await shutdown();
}
