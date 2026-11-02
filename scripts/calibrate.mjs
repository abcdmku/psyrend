// Turn motion measurements (scripts/motion.mjs --json) into per-world motion gains in
// src/scenes/motionGain.ts. Uses a reference song measured with the current gains; each world's gain
// is nudged so its median optical speed lands on MOTION_TARGET. Rerun motion + calibrate to iterate.
//   node scripts/calibrate.mjs artifacts/motion/bassface.json
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/scenes/motionGain.ts';
const src = readFileSync(file, 'utf8');
const target = Number(/MOTION_TARGET = ([\d.]+)/.exec(src)[1]);
const table = /const GAIN: Record<string, number> = (\{[^}]*\});/.exec(src)[1];
const gains = JSON.parse(table.replace(/'/g, '"').replace(/,\s*}/, '}').replace(/([{,]\s*)([a-z0-9-]+):/g, '$1"$2":') || '{}');
const { out } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const [id, rows] of Object.entries(out)) {
  const v = med(rows.map((r) => r.speed));
  const old = gains[id] ?? 1;
  // Partial step (exponent 0.8): not all of a world's motion scales with the morph speed.
  const g = Math.min(3, Math.max(0.3, old * (target / Math.max(v, 1e-3)) ** 0.8));
  gains[id] = +g.toFixed(2);
  console.log(id.padEnd(22), 'speed', v.toFixed(3), 'gain', old, '->', gains[id]);
}
const body = Object.keys(gains).sort().map((k) => `  '${k}': ${gains[k]},`).join('\n');
writeFileSync(file, src.replace(/const GAIN: Record<string, number> = \{[^}]*\};/, `const GAIN: Record<string, number> = {\n${body}\n};`));
