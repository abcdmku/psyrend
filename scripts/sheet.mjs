// Contact sheet: every image in a directory on one labelled grid, for judging visuals side by side.
//   node scripts/sheet.mjs <dir> [--cols 4] [--w 1600] [--out <dir>/sheet.jpg] [--match substring]
import { chromium } from 'playwright';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args[0];
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const cols = Number(opt('cols', 4));
const width = Number(opt('w', 1600));
const out = opt('out', path.join(dir, 'sheet.jpg'));
const match = opt('match', '');
const files = (await readdir(dir)).filter((f) => /\.(jpe?g|png)$/i.test(f) && !f.startsWith('sheet') && f.includes(match)).sort();
const cells = await Promise.all(
  files.map(async (f) => {
    const b64 = (await readFile(path.join(dir, f))).toString('base64');
    const mime = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `<figure><img src="data:${mime};base64,${b64}"><figcaption>${f.replace(/\.\w+$/, '')}</figcaption></figure>`;
  }),
);
const html = `<html><body style="margin:0;background:#111;font:12px sans-serif;color:#ddd">
<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:4px;padding:4px;width:${width}px">${cells.join('')}</div>
<style>figure{margin:0}img{width:100%;display:block}figcaption{padding:2px 4px}</style></body></html>`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: width + 8, height: 400 } });
await page.setContent(html);
await page.waitForLoadState('load');
await writeFile(out, await page.screenshot({ fullPage: true, type: 'jpeg', quality: 85 }));
await browser.close();
console.log(out);
