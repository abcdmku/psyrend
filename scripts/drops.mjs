// Does a world rush when the bass drops? For each pinned world: picture motion in the 6 s after
// each drop over the 4 s before it, and how closely motion follows the bass level.
//   node scripts/drops.mjs --file <song> --pin a,b,c [--drops 2]
// Prints the song's sections and drops first. Bars: drop rush >= 1.8; bass corr >= 0.3.
import { chromium } from 'playwright';
import { createServer } from 'vite';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const server = await createServer({ server: { port: 5196, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const diff = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length / 255;
};
const corr = (a, b) => {
  const ma = mean(a);
  const mb = mean(b);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
};
try {
  await page.goto(`${server.resolvedUrls.local[0]}?seed=${opt('seed', '1')}`);
  await page.waitForFunction(() => !!window.__psy, null, { timeout: 60000 });
  await page.setInputFiles('input[type=file]', opt('file'));
  await page.waitForFunction(() => window.__psy?.stats?.playing === true, null, { timeout: 180000 });
  const ev = await page.evaluate(() => window.__psy.events());
  console.log('sections:', ev.sections.map((s) => `${s.start.toFixed(0)}s e${(s.energy ?? 0).toFixed(2)}`).join('  '));
  console.log('drops:', ev.drops.map((d) => d.toFixed(1)).join(', ') || 'none');
  const drops = ev.drops.slice(0, Number(opt('drops', 2)));
  await page.evaluate(() => window.__psy.look(null));
  for (const id of opt('pin').split(',')) {
    await page.evaluate((x) => window.__psy.pin(x), id);
    await page.evaluate(() => window.__psy.variant(0.47));
    const rows = [];
    for (const d of drops) {
      const from = d - 4;
      for (let k = 45; k > 0; k--) await page.evaluate(([t]) => window.__psy.renderAt(t, 1 / 30, 8, 8), [from - k / 30]);
      const motion = [];
      const bass = [];
      let prev = null;
      for (let i = 0; i < 300; i++) {
        const t = from + i / 30;
        const r = await page.evaluate(([tt]) => window.__psy.renderAt(tt, 1 / 30, 96, 54), [t]);
        motion.push(prev ? diff(r.rgb, prev) : 0);
        bass.push(await page.evaluate(() => window.__psy.music?.()?.bass ?? 0).catch(() => 0));
        prev = r.rgb;
      }
      const before = mean(motion.slice(1, 120));
      const after = mean(motion.slice(120, 300));
      rows.push(`drop ${d.toFixed(1)}s: rush ${(after / Math.max(before, 1e-4)).toFixed(2)} (motion ${(before * 100).toFixed(2)} -> ${(after * 100).toFixed(2)})${bass.some((b) => b > 0) ? `, bass corr ${corr(motion, bass).toFixed(2)}` : ''}`);
    }
    console.log(`${id}: ${rows.join(' | ') || 'no drops'}`);
  }
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
