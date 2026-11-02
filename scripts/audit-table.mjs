// Summarises audit-all.sh output: one row per visual, sorted by how well it answers the music.
//   node scripts/audit-table.mjs artifacts/audit-scenes.jsonl artifacts/audit-layers.jsonl
import { readFileSync } from 'node:fs';

const rows = process.argv
  .slice(2)
  .flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean))
  .map((l) => JSON.parse(l))
  .filter((x) => x.r);
const v = (o) => (o?.lift == null ? null : o.lift);
// Responsiveness: the best of the drum lifts plus the lead-note lift, so a visual must answer both rhythm and melody.
const score = (r) => Math.max(v(r.kick) ?? 1, v(r.snare) ?? 1) - 1 + ((v(r.lead) ?? 1) - 1);
rows.sort((a, b) => score(b.r) - score(a.r));
const f = (x) => (x == null ? '  -  ' : x.toFixed(2).padStart(5));
console.log('kind   id                         kick  snare   hat  lead  bass   corr  motion  bright');
for (const x of rows) {
  const r = x.r;
  console.log(
    `${x.kind.padEnd(6)} ${x.id.padEnd(26)} ${f(v(r.kick))} ${f(v(r.snare))} ${f(v(r.hat))} ${f(v(r.lead))} ${f(v(r.bass))} ${f(r.corr)}  ${f(r.motion)}  ${f(r.brightness)}`,
  );
}
const pass = rows.filter((x) => Math.max(v(x.r.kick) ?? 0, v(x.r.snare) ?? 0) >= 1.5 && (v(x.r.lead) ?? 0) >= 1.3);
console.log(`\n${rows.length} visuals; answer drums (lift >= 1.5) and melody (>= 1.3): ${pass.length}`);
console.log(`answer drums: ${rows.filter((x) => Math.max(v(x.r.kick) ?? 0, v(x.r.snare) ?? 0) >= 1.5).length}; answer melody: ${rows.filter((x) => (v(x.r.lead) ?? 0) >= 1.3).length}`);
