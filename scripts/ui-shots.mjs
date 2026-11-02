// Screenshots of the UI states: start screen, and playback with the info + scene panels open.
//   node scripts/ui-shots.mjs [--out artifacts/ui]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';

const outIdx = process.argv.indexOf('--out');
const out = outIdx > 0 ? process.argv[outIdx + 1] : 'artifacts/ui';
await mkdir(out, { recursive: true });
const server = await createServer({ server: { port: 5198, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url);
  await page.waitForFunction(() => !!window.__psy, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/start.jpg`, type: 'jpeg', quality: 88 });
  await page.getByText('Play demo track').click();
  await page.waitForFunction(() => window.__psy?.stats?.playing === true, null, { timeout: 60000 });
  await page.evaluate(() => window.__psy.seek(40));
  await page.waitForTimeout(1500);
  await page.keyboard.press('i');
  await page.keyboard.press('s');
  await page.mouse.move(800, 450);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/playing.jpg`, type: 'jpeg', quality: 88 });
  await page.waitForTimeout(3500);
  await page.keyboard.press('Escape');
  await page.keyboard.press('h');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/clean.jpg`, type: 'jpeg', quality: 88 });
} finally {
  await browser.close();
  await server.close();
}
console.log('ok');
