// Sean's teardown of a run directory's Alpha (M5 slice 38; README §4; SEAM.md
// §456; M2 of the slice-38 review). It reads the run home's prefix and asks
// the run home's engine to tear `alpha` down, and does nothing else: no
// model, no session, no other step of the journey. A unit is stopped only by
// the engine's teardown of `alpha`, by its exact name; nothing by pattern.
//
//   SURETY_REAL_RERUN=<m5a_teardown | m5r_teardown> <the file's own variables> \
//   node docs/acceptance/reports/M5-real-lane/teardown.mjs <M443 | M444>
//
// It needs the same SURETY_REAL_* variables as the journey's file (the run
// directory, the credential's reference, the pinned binary, the file's own
// confirmation), because the engine starts with them; it calls no model.
// The teardown is recorded as its step (`m5a_teardown`, `m5r_teardown`)
// where the run directory allows it, else in observed/; the steps before it
// keep their records, and the steps after it are left as they are.

import { checkHome, markRunKind, CONFIRM_PHRASE_M443, CONFIRM_PHRASE_M444, drain, m5Engine, teardownStep } from '../../../../packages/engine/test/acceptance/harness/real/m5-lane.mjs';
import { realPreflight, stepValue } from '../../../../packages/engine/test/acceptance/harness/real/lane.mjs';

const row = process.argv[2];
if (row !== 'M443' && row !== 'M444') {
  process.stderr.write('usage: node docs/acceptance/reports/M5-real-lane/teardown.mjs <M443 | M444>\n');
  process.exit(2);
}
// No `order`: a rerun named here clears exactly the teardown step, never the steps after it.
const ctx = realPreflight({ confirm: row === 'M443' ? CONFIRM_PHRASE_M443 : CONFIRM_PHRASE_M444 });
checkHome(ctx);
markRunKind(ctx);
const name = row === 'M443' ? 'm5a_teardown' : 'm5r_teardown';
const { project } = stepValue(ctx, row === 'M443' ? 'm5a_create' : 'm5r_adopt');
const fx = await m5Engine(ctx);
let code = 0;
try {
  await fx.engine.post(`/v1/projects/${project}/resume`, {});
  const out = await teardownStep(ctx, row, name, project, fx);
  process.stdout.write(`${JSON.stringify({ step: name, applied: out?.applied ?? null, left: out?.left ?? null })}\n`);
} catch (err) {
  process.stderr.write(`${err?.message ?? err}\n`);
  code = 1;
} finally {
  await drain(ctx, fx, [project]).catch(() => null);
  await fx.engine.stop();
}
process.exit(code);
