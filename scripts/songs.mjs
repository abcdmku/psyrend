// Print the song-level analysis summary (bpm, intensity, character, genres) for each file given.
//   node scripts/songs.mjs <file> [<file> ...]
import { chromium } from 'playwright';
import { createServer } from 'vite';

const files = process.argv.slice(2);
const server = await createServer({ server: { port: 5193, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'] });
try {
  for (const f of files) {
    const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
    await page.goto(`${server.resolvedUrls.local[0]}?seed=1`);
    await page.waitForFunction(() => !!window.__psy, null, { timeout: 60000 });
    await page.setInputFiles('input[type=file]', f);
    await page.waitForFunction(() => !!window.__psy?.analysis, null, { timeout: 240000 });
    const a = await page.evaluate(() => window.__psy.analysis);
    const c = a.character;
    console.log(`${f.split('/').pop().padEnd(34)} bpm ${a.bpm.toFixed(0).padStart(3)}  int ${a.intensity.toFixed(2)}  loud ${c.loudDb.toFixed(1)} dB  onsets ${c.onsetRate.toFixed(2)}/s  perc ${c.percussive.toFixed(2)}  ${a.genres.join(' ')}  ${a.mood}`);
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
