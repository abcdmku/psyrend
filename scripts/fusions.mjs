// Stills of fused worlds: each pair in each fusion mode, for judging which relationships work.
//   node scripts/fusions.mjs --file <song> --pairs a+b,c+d [--modes 0,1,2,3,4,5] [--at 62] [--out dir]
// Then: node scripts/sheet.mjs <out> --cols 6
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const MODE_NAMES = ['fold', 'relief', 'interference', 'merge'];
const out = opt('out', 'artifacts/fusions');
await mkdir(out, { recursive: true });
const server = await createServer({ server: { port: 5195, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
try {
  await page.goto(`${server.resolvedUrls.local[0]}?seed=${opt('seed', '1')}`);
  await page.waitForFunction(() => !!window.__psy, null, { timeout: 60000 });
  await page.setInputFiles('input[type=file]', opt('file', 'C:/Users/Borg/Downloads/03 - Bass Face.wav'));
  await page.waitForFunction(() => window.__psy?.stats?.playing === true, null, { timeout: 180000 });
  await page.evaluate(() => window.__psy.look(null));
  const t = Number(opt('at', 62));
  const modes = opt('modes', '0,1,2,3').split(',').map(Number);
  for (const pair of opt('pairs').split(',')) {
    const [a, b] = pair.split('+');
    await page.evaluate((x) => window.__psy.pin(x), a);
    await page.evaluate(() => window.__psy.variant(0.47));
    for (const mode of modes) {
      await page.evaluate(([id, md]) => window.__psy.fuse(id, md, 0.85), [b, mode]);
      for (let k = 45; k > 0; k--) await page.evaluate(([tt]) => window.__psy.renderAt(tt, 1 / 30, 8, 8), [t - k / 30]);
      const r = await page.evaluate(([tt]) => window.__psy.renderAt(tt, 1 / 30, 8, 8, true, 640, 360), [t]);
      const name = `${a}+${b}-${mode}-${MODE_NAMES[mode]}.jpg`;
      await writeFile(path.join(out, name), Buffer.from(r.image.split(',')[1], 'base64'));
      console.log(name);
    }
    await page.evaluate(() => window.__psy.fuse(null));
  }
} finally {
  if (problems.length) console.log(`problems:\n${[...new Set(problems)].slice(0, 8).join('\n')}`);
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
