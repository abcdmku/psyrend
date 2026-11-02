// Full-resolution stills of one visual through a song, for judging quality by eye.
//   node scripts/stills.mjs --file <wav> --pin <scene id> --at 40,62,95 [--w 1280 --h 540] [--out dir] [--variant 0.1,0.5,0.9] [--look <look id>]
// Each still is rendered after 1.5 s of warm-up at 30 fps, so simulation and morph state are real.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const outDir = opt('out', 'artifacts/stills');
await mkdir(outDir, { recursive: true });
const w = Number(opt('w', 1280));
const h = Number(opt('h', 540));
const server = await createServer({ server: { port: 5199, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
page.on('pageerror', (e) => problems.push(e.message));
try {
  await page.goto(`${server.resolvedUrls.local[0]}?seed=${opt('seed', '1')}`);
  await page.waitForFunction(() => !!window.__psy, null, { timeout: 60000 });
  await page.setInputFiles('input[type=file]', opt('file'));
  await page.waitForFunction(() => window.__psy?.stats?.playing === true, null, { timeout: 180000 });
  const pins = opt('pin', '').split(',').filter(Boolean);
  const variants = opt('variant', '').split(',').filter(Boolean).map(Number);
  const looks = (opt('look', '') || '').split(',').filter(Boolean);
  // --fuse partner:mode[,partner:mode] renders each fusion (amount 0.85).
  const fuses = (opt('fuse', '') || '').split(',').filter(Boolean);
  for (const pin of pins.length ? pins : [null]) for (const v of variants.length ? variants : [null]) for (const lk of looks.length ? looks : [null]) for (const fz of fuses.length ? fuses : [null]) {
    if (pin) await page.evaluate((id) => window.__psy.pin(id), pin);
    if (v !== null) await page.evaluate((x) => window.__psy.variant(x), v);
    // --look <id> renders with that overlay look (default: none).
    await page.evaluate((id) => window.__psy.look(id), lk);
    if (fz) { const [fid, fm] = fz.split(':'); await page.evaluate(([a, b]) => window.__psy.fuse(a, b, 0.85), [fid, Number(fm ?? 0)]); await page.waitForTimeout(3000); }
    if (opt('lookdna')) await page.evaluate((d) => window.__psy.lookDna(d), opt('lookdna').split(',').map(Number));
    for (const t of opt('at', '40').split(',').map(Number)) {
      for (let k = 45; k > 0; k--) await page.evaluate(([tt]) => window.__psy.renderAt(tt, 1 / 30, 8, 8), [t - k / 30]);
      const r = await page.evaluate(([tt, ww, hh]) => window.__psy.renderAt(tt, 1 / 30, 8, 8, true, ww, hh), [t, w, h]);
      const name = `${pin ?? r.scene}${v !== null ? `-v${v}` : ""}${lk ? `-${lk}` : ""}${fz ? `-f${fz.replace(":", "")}` : ""}-${t}.jpg`;
      await writeFile(path.join(outDir, name), Buffer.from(r.image.split(',')[1], 'base64'));
      console.log(path.join(outDir, name));
    }
  }
} finally {
  if (problems.length) console.log(`problems:\n${[...new Set(problems)].slice(0, 10).join('\n')}`);
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
