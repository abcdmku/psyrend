// How fast each world visibly moves at given song moments, as an optical-flow estimate:
// speed ~ sum|dI/dt| / sum|grad I| (pixels per frame, independent of contrast), reported in screen
// heights per second. Used to calibrate worlds against each other and against the music.
//   node scripts/motion.mjs --pin a,b,c [--file song] [--at 30,60,90] [--dur 3] [--json out.json]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const file = opt('file', 'C:/Users/Borg/Downloads/03 - Bass Face.wav');
const ats = opt('at', '30,60,90').split(',').map(Number);
const dur = Number(opt('dur', 3));
const W = 192;
const H = 108;
const fps = 30;

const server = await createServer({ server: { port: 5194, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 960, height: 540 } })).newPage();
// Luminance box-downsampled 3x (to 64x36): the gradient estimate stays linear up to about a
// coarse pixel per frame (~0.8 screen heights per second), where the full-size one saturates.
const DS = 3;
const CW = W / DS;
const CH = H / DS;
const lum = (rgb) => {
  const l = new Float32Array(CW * CH);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      l[Math.floor(y / DS) * CW + Math.floor(x / DS)] += (rgb[i] * 0.25 + rgb[i + 1] * 0.65 + rgb[i + 2] * 0.1) / 255 / (DS * DS);
    }
  return l;
};
function flow(a, b) {
  let dt = 0;
  let gr = 0;
  for (let y = 1; y < CH - 1; y++)
    for (let x = 1; x < CW - 1; x++) {
      const i = y * CW + x;
      dt += Math.abs(b[i] - a[i]);
      const gx = (a[i + 1] - a[i - 1] + b[i + 1] - b[i - 1]) / 4;
      const gy = (a[i + CW] - a[i - CW] + b[i + CW] - b[i - CW]) / 4;
      gr += Math.hypot(gx, gy);
    }
  return gr > 1e-6 ? dt / gr : 0;
}
const med = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
const out = {};
try {
  await page.goto(`${server.resolvedUrls.local[0]}?seed=1`);
  await page.waitForFunction(() => !!window.__psy, null, { timeout: 60000 });
  await page.setInputFiles('input[type=file]', file);
  await page.waitForFunction(() => window.__psy?.stats?.playing === true, null, { timeout: 240000 });
  if (opt('pace')) await page.evaluate((x) => window.__psy.pace(x), Number(opt('pace')));
  const pins = (opt('pin') ?? (await page.evaluate(() => window.__psy.scenes())).join(',')).split(',');
  for (const id of pins) {
    await page.evaluate((i) => window.__psy.pin(i), id);
    await page.evaluate(() => window.__psy.variant(0.47));
    if (opt('look')) await page.evaluate((lk) => window.__psy.look(lk), opt('look'));
    const row = [];
    for (const t0 of ats) {
      for (let t = t0 - 2; t < t0; t += 1 / fps) await page.evaluate(([tt]) => window.__psy.renderAt(tt, 1 / 30, 8, 8), [t]);
      let prev = null;
      const v = [];
      const ev = [];
      let e = 0;
      for (let k = 0; k < dur * fps; k++) {
        const r = await page.evaluate(([tt]) => window.__psy.renderAt(tt, 1 / 30, 192, 108), [t0 + k / fps]);
        const m = await page.evaluate(() => window.__psy.music());
        e += m.energy;
        const l = lum(r.rgb);
        if (prev) v.push(flow(prev, l));
        ev.push([+m.lead.toFixed(2), +m.upper.toFixed(2), +m.kick.toFixed(2), +m.energySlow.toFixed(2)]);
        prev = l;
      }
      // coarse pixels/frame at 36 rows -> screen heights per second
      // --trace keeps the per-frame speed (screen heights/s) and [lead, upper, kick, energySlow].
      row.push({ t: t0, speed: +((med(v) * fps) / CH).toFixed(3), energy: +(e / (dur * fps)).toFixed(2), ...(opt('trace') ? { v: v.map((x) => +((x * fps) / CH).toFixed(3)), ev } : {}) });
    }
    out[id] = row;
    console.log(id.padEnd(22), row.map((r) => `${String(r.t).padStart(4)}s e${r.energy.toFixed(2)} v${r.speed.toFixed(3)}`).join('   '));
  }
  if (opt('json')) await writeFile(opt('json'), JSON.stringify({ file, out }, null, 1));
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
