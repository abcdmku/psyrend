// Composes PNGs into one labelled contact sheet so many shots can be reviewed at once.
//   node scripts/contact.mjs out.png a.png b.png c.png ... [--cols 3] [--w 1600]
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const cols = Number(opt('cols', 2));
const width = Number(opt('w', 1600));
const [out, ...all] = args;
// Never include previous contact sheets in a new one.
const files = all.filter((f) => !path.basename(f).startsWith('sheet'));
const imgs = await Promise.all(files.map(async (f) => ({ name: path.basename(path.dirname(f)) + '/' + path.basename(f), data: (await readFile(f)).toString('base64') })));
const html = `<body style="margin:0;background:#111;font:12px monospace;color:#ddd;display:grid;grid-template-columns:repeat(${cols},1fr);gap:4px">${imgs
  .map((i) => `<figure style="margin:0"><img style="width:100%;display:block" src="data:image/${i.name.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${i.data}"><figcaption style="padding:2px 4px">${i.name}</figcaption></figure>`)
  .join('')}</body>`;
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width, height: 400 } });
await page.setContent(html);
await page.waitForLoadState('load');
await page.screenshot({ path: out, fullPage: true, ...(out.endsWith('.jpg') ? { type: 'jpeg', quality: 85 } : {}) });
await browser.close();
console.log(out);
