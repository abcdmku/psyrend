// A filmstrip of one continuous playthrough (no seeks between frames), for judging motion that
// single stills can't show: the endless zoom, camera framing changes, morphing, overlays.
//   node scripts/filmstrip.mjs --file <song> --pin <world> [--from 40] [--dur 8] [--every 1] [--look <id>]
//        [--variant 0.47] [--out artifacts/film/<world>]
// Renders at 30 fps from --from for --dur seconds and saves a frame every --every seconds, then a
// contact sheet (sheet.jpg) in time order.
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
const pin = opt('pin');
const out = opt('out', `artifacts/film/${pin}`);
await mkdir(out, { recursive: true });
const from = Number(opt('from', 40));
const dur = Number(opt('dur', 8));
const every = Number(opt('every', 1));
const server = await createServer({ server: { port: 5192, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
try {
  await page.goto(`${server.resolvedUrls.local[0]}?seed=${opt('seed', '1')}`);
  await page.waitForFunction(() => !!window.__psy, null, { timeout: 60000 });
  await page.setInputFiles('input[type=file]', opt('file', 'C:/Users/Borg/Downloads/03 - Bass Face.wav'));
  await page.waitForFunction(() => window.__psy?.stats?.playing === true, null, { timeout: 180000 });
  if (pin) await page.evaluate((id) => window.__psy.pin(id), pin);
  await page.evaluate((v) => window.__psy.variant(v), Number(opt('variant', 0.47)));
  await page.evaluate((id) => window.__psy.look(id), opt('look', null));
  // One continuous run: warm up, then step frame by frame, saving every `every` seconds.
  const fps = 30;
  for (let t = from - 2; t < from; t += 1 / fps) await page.evaluate(([tt]) => window.__psy.renderAt(tt, 1 / 30, 8, 8), [t]);
  const n = Math.round(dur * fps);
  const stride = Math.max(1, Math.round(every * fps));
  for (let i = 0; i <= n; i++) {
    const t = from + i / fps;
    const save = i % stride === 0;
    const r = await page.evaluate(([tt, s]) => window.__psy.renderAt(tt, 1 / 30, 8, 8, s, 640, 360), [t, save]);
    if (save) await writeFile(path.join(out, `t${t.toFixed(2).padStart(7, '0')}.jpg`), Buffer.from(r.image.split(',')[1], 'base64'));
  }
  execFileSync(process.execPath, ['scripts/sheet.mjs', out, '--cols', '4', '--w', '1600']);
  console.log(path.join(out, 'sheet.jpg'));
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
