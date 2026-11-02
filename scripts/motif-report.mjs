// Reads a motion.mjs --trace JSON and reports how each world answers events.
//   node scripts/motion.mjs --pin a,b --file "C:/Users/Borg/Downloads/Sewer Underground.mp3" --at 16 --dur 4 --trace 1 --json m.json
//   node scripts/motif-report.mjs m.json
// base: median speed before the first event (screen heights/s); peak: highest speed after it;
// ratio: peak/base; jump: the largest one-frame rise relative to the frames around it (a snap reads > 4).
import { readFileSync } from 'node:fs';
const { out } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const [id, rows] of Object.entries(out)) {
  for (const r of rows) {
    const v = r.v;
    const first = r.ev.findIndex((e) => e[0] > 0.2 || e[1] > 0.2 || e[2] > 0.2);
    const pre = v.slice(0, Math.max(5, first - 1));
    const base = [...pre].sort((a, b) => a - b)[Math.floor(pre.length / 2)] ?? 0;
    const post = v.slice(Math.max(0, first - 1));
    const peak = Math.max(...post);
    let jump = 0;
    for (let i = 2; i < v.length - 2; i++) {
      const around = (v[i - 2] + v[i + 2]) / 2;
      jump = Math.max(jump, v[i] / Math.max(around, base, 0.02));
    }
    console.log(`${id.padEnd(24)} t${r.t} base ${base.toFixed(3)} peak ${peak.toFixed(3)} ratio ${(peak / Math.max(base, 0.01)).toFixed(1)} jump ${jump.toFixed(1)}`);
  }
}
