// The driver's record of an owner act it performed on Sean's instruction in
// an M6 real run (rows M519 (i), M535 (l); BS6 §12, §4.1 rule 26; E156 Q6;
// SEAM.md §542). M5's `recordInstruction` in a command of its own.
//
//   node docs/acceptance/reports/M6-real-lane/driver-act.mjs <run dir> <act> \
//     --instruction "<Sean's words, verbatim>" [--step <step>] [--route <route>] \
//     [--decision <id>] [--option <option>]
//
// It appends one line to `<run dir>/observed/driver-acts.jsonl`:
//
//   {"act", "step"?, "route"?, "at", "acted_by": "driver", "on_instruction", "decision"?, "option"?, "entered_via": "driver-act.mjs"}
//
// The instruction is Sean's words as he gave them, quoted, never a
// paraphrase. An act the driver performed without such words is not
// recorded here: it is reported `unknown`. It starts nothing and reads no
// credential. The four central acts of M535 are Sean's own (E156 Q6): a
// driver record of one of them is written, and M535 still fails it.

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const args = process.argv.slice(2);
const [runDir, act] = args;
const refuse = (why) => {
  process.stderr.write(`driver-act.mjs: ${why}\nusage: node docs/acceptance/reports/M6-real-lane/driver-act.mjs <run dir> <act> --instruction "<Sean's words>" [--step <s>] [--route <r>] [--decision <id>] [--option <o>]\n`);
  process.exit(2);
};
if (!runDir || !act || act.startsWith('--')) refuse('a run directory and an act are needed');
if (!isAbsolute(runDir) || !existsSync(join(runDir, 'state.json'))) refuse(`${runDir} is not a real-lane run directory (an absolute path holding state.json)`);
if (!/^[a-z][a-z_]*$/.test(act)) refuse(`"${act}" is not an act name`);
const opts = {};
for (let i = 2; i < args.length; i++) {
  const flag = args[i];
  const value = args[i + 1];
  if (!['--instruction', '--step', '--route', '--decision', '--option'].includes(flag) || value === undefined) refuse(`unknown or incomplete flag ${flag}`);
  opts[flag.slice(2)] = value;
  i++;
}
if (!opts.instruction || opts.instruction.trim().split(/\s+/).length < 2) refuse("--instruction must carry Sean's words, verbatim");
const entry = {
  act,
  ...(opts.step ? { step: opts.step } : {}),
  ...(opts.route ? { route: opts.route } : {}),
  at: new Date().toISOString(),
  acted_by: 'driver',
  on_instruction: opts.instruction,
  ...(opts.decision ? { decision: opts.decision } : {}),
  ...(opts.option ? { option: opts.option } : {}),
  entered_via: 'driver-act.mjs',
};
mkdirSync(join(runDir, 'observed'), { recursive: true, mode: 0o700 });
appendFileSync(join(runDir, 'observed', 'driver-acts.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(entry)}\n`);
