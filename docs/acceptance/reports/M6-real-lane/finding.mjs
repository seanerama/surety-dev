// M519's findings record (row M519 (j); BS6 §12 "Between the two"; E156 Q5;
// SEAM.md §543): each defect the run found, the step it stopped, whether a
// driver workaround passed that step, and later the commit on `main` that
// fixed it. M535 refuses to start until every finding is resolved by a
// commit the checked-out revision contains, and no M519 step stands passed
// only by a workaround.
//
//   node docs/acceptance/reports/M6-real-lane/finding.mjs <run dir> add --step <step> --what "<the defect>" [--workaround "<what the driver did>"]
//   node docs/acceptance/reports/M6-real-lane/finding.mjs <run dir> resolve <id> --commit <sha>
//   node docs/acceptance/reports/M6-real-lane/finding.mjs <run dir> list
//
// Lines of `<run dir>/observed/findings-M519.jsonl`:
//   {"op": "add", "id": "F<n>", "step", "what", "workaround": <text> | null, "at"}
//   {"op": "resolve", "id", "commit", "at"}
//
// `--workaround` also marks the step in state.json (`workaround: {finding,
// what}`): the runner then counts that step as not passed, whatever its
// status says (a workaround is never carried forward as success). Only a
// rerun of the step on a revision with the fix (SURETY_REAL_RERUN=<step>)
// clears the mark, since a rerun clears the step's whole record. It
// starts nothing and reads no credential.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);
const [runDir, op, ...rest] = args;
const refuse = (why) => {
  process.stderr.write(`finding.mjs: ${why}\nusage: finding.mjs <run dir> add --step <s> --what "<text>" [--workaround "<text>"] | resolve <id> --commit <sha> | list\n`);
  process.exit(2);
};
if (!runDir || !isAbsolute(runDir) || !existsSync(join(runDir, 'state.json'))) refuse('an absolute run directory holding state.json is needed');
const file = join(runDir, 'observed', 'findings-M519.jsonl');
const read = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const flags = (list) => {
  const out = { positional: [] };
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) {
      if (list[i + 1] === undefined) refuse(`${list[i]} needs a value`);
      out[list[i].slice(2)] = list[++i];
    } else out.positional.push(list[i]);
  }
  return out;
};
const append = (entry) => {
  mkdirSync(join(runDir, 'observed'), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

if (op === 'add') {
  const f = flags(rest);
  if (!f.step || !f.what) refuse('add needs --step and --what');
  const id = `F${read().filter((e) => e.op === 'add').length + 1}`;
  append({ op: 'add', id, step: f.step, what: f.what, workaround: f.workaround ?? null, at: new Date().toISOString() });
  if (f.workaround) {
    const statePath = join(runDir, 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.steps ??= {};
    state.steps[f.step] = { ...(state.steps[f.step] ?? { status: 'not_run' }), workaround: { finding: id, what: f.workaround } };
    writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
  }
} else if (op === 'resolve') {
  const f = flags(rest);
  const id = f.positional[0];
  if (!id || !f.commit) refuse('resolve needs <id> and --commit');
  if (!read().some((e) => e.op === 'add' && e.id === id)) refuse(`no finding ${id}`);
  if (!/^[0-9a-f]{7,40}$/.test(f.commit)) refuse('--commit must be a commit id');
  append({ op: 'resolve', id, commit: f.commit, at: new Date().toISOString() });
} else if (op === 'list') {
  process.stdout.write(`${JSON.stringify(read(), null, 2)}\n`);
} else refuse(`unknown operation ${op}`);
