// The derivation of two-board-plan.json (row M646; harness/wcp/README.md).
// The saved plan of the walkthrough (~/surety-evidence/
// workshop-cut-planner-walkthrough.md l.53: a 3 mm blade, two 400 mm pieces
// on a 1,000 mm board, the quantity raised to three, a 500 mm board added
// for the unplaced one), made with iteration 1's own public/js/planner.mjs
// and saved with its own public/js/store.mjs (17f0a3d, materialized from
// this fixture), into a storage object of ours. The unit key is added as
// a88fa57's store.mjs names it (UNIT_KEY 'cutPlanner.unit'; 17f0a3d's store
// has no unit), millimetres as the walkthrough's plan was entered.
//
//   node derive-two-board-plan.mjs <scratch directory>   prints the JSON
//
// `derive(scratch)` is what a test calls to compare with the checked-in file.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REV, codeAt, writeTree } from './index.mjs';

class Storage {
  constructor() {
    this.m = new Map();
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    this.m.set(String(k), String(v));
  }
  removeItem(k) {
    this.m.delete(k);
  }
}

export async function derive(scratch) {
  const dir = join(scratch, `wcp-derive-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeTree(dir, codeAt(REV.iteration1, scratch));
  const P = await import(pathToFileURL(join(dir, 'public/js/planner.mjs')).href);
  const S = await import(pathToFileURL(join(dir, 'public/js/store.mjs')).href);
  let plan = P.emptyPlan();
  plan = P.setBlade(plan, 3);
  plan = P.addBoard(plan, 1000);
  plan = P.addPiece(plan, { lengthMm: 400, quantity: 2, label: '' });
  plan = P.updatePiece(plan, plan.pieces[0].id, { quantity: 3 });
  plan = P.addBoard(plan, 500);
  const storage = new Storage();
  const saved = S.savePlan(plan, storage);
  if (!saved.ok) throw new Error(`iteration 1's store did not save the plan: ${saved.message}`);
  if (JSON.stringify(S.loadPlan(storage)) !== JSON.stringify(plan)) throw new Error("iteration 1's store did not reload the plan it saved");
  const layout = P.computeLayout(plan);
  return { storage: { ...Object.fromEntries(storage.m), 'cutPlanner.unit': 'mm' }, layout };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { storage } = await derive(process.argv[2] ?? process.env.TMPDIR ?? '/tmp');
  process.stdout.write(`${JSON.stringify(storage, null, 2)}\n`);
}
