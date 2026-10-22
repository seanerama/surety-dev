// Sean's own record of an owner act in an M6 real run (rows M519 (i), M535
// (l); BS6 §12; BS6 §4.1 rule 26; E156 Q6; SEAM.md §542).
//
//   node docs/acceptance/reports/M6-real-lane/owner-act.mjs <run dir> <act>
//
// Sean runs it HIMSELF, in his own terminal, at the act (just before or
// just after it): it refuses unless its standard input and output are both
// a terminal, prints which act it records, and asks him to type, in his own
// words, what he looked at or did. The words are his; nobody else types
// them. It appends one line to `<run dir>/observed/owner-acts.jsonl`:
//
//   {"act", "at", "words", "entered_via": "owner-act.mjs", "tty": true, "uid", "user"}
//
// The runner reads that file and nothing else as evidence that Sean
// performed an act: the store's `human` actor alone never establishes it.
// The four acts Sean performs himself in M535 are `designer_feedback`,
// `preview_inspection`, `combined_approval` and `review_confirmation`; any
// other act of README §3's list may be recorded the same way.
//
// `question_acknowledged` (errata E179; SEAM.md §560) records Sean's own
// acknowledgement of an open owner question he leaves open at the review's
// end: it asks, one line each, for the decision id (dec_…), the requirement
// it affects (R…), its implications and its deferred follow-up, refuses a
// malformed id or key, and adds them to the line as `decision`,
// `requirement`, `implications` and `follow_up`, its `words` naming the
// decision and the requirement. The runner counts it only under E179's
// conditions (the two questions it names, no gate held, dated after the
// question was raised); it answers nothing and resolves nothing.
//
// It writes nothing else, starts nothing, calls no model and reads no
// credential. A rehearsal's run directory is refused: there the harness
// acts and records itself as `rehearsal`.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const ACTS = Object.freeze({
  designer_feedback: "your own turns in the Designer session (what you asked the Designer for, what you saw in its replies)",
  preview_inspection: 'opening the preview through the relay and clicking through the web mockup and the android simulation (what you opened, what you saw)',
  combined_approval: 'the combined approval: design_approval (the logo held) and its spec_change (what you read before answering)',
  review_confirmation: "the review's confirmation: design_verdicts (what you checked on the Alpha before confirming, edits or strikes)",
  spec_session: 'your Spec Writer session',
  spec_approval: 'spec_approval',
  architect_session: "your Architect session",
  architecture_approval: 'architecture_approval',
  plan_approval: 'plan_approval',
  policy_widening: 'a policy_widening confirmation',
  qualify_adapter: 'surety qualify-adapter local_service',
  design_due: 'the design_due answer',
  correction_approval: "a check_correction (the toolchain or the design criteria's checks)",
  review_session: 'your turns in the review-mode Designer session',
  asset_add: 'surety design asset add (your own file for a held slot)',
  asset_submit: 'surety design assets submit',
  asset_approval: 'the asset-only design_approval',
  finding_disposition: 'a finding_disposition answer',
  deploy: 'surety deploy',
  question_acknowledged: 'your acknowledgement, under errata E179, of an open owner question you leave open at the review\'s end (its decision, its requirement, its implications and its deferred follow-up)',
});
const DECISION_ID = /^dec_[0-9A-Z]{26}$/;
const REQUIREMENT_KEY = /^R\d+(\.\d+)*$/;
const MIN_WORDS = 3;

const [runDir, act] = process.argv.slice(2);
const refuse = (why, code = 2) => {
  process.stderr.write(`owner-act.mjs: ${why}\nusage: node docs/acceptance/reports/M6-real-lane/owner-act.mjs <run dir> <act>\nacts: ${Object.keys(ACTS).join(', ')}\n`);
  process.exit(code);
};
if (!runDir || !act) refuse('a run directory and an act are needed');
if (!isAbsolute(runDir)) refuse('the run directory must be an absolute path');
if (!existsSync(join(runDir, 'state.json'))) refuse(`${runDir} is not a real-lane run directory (no state.json)`);
if (!(act in ACTS)) refuse(`"${act}" is not an act this script records`);
let kind = null;
try {
  kind = JSON.parse(readFileSync(join(runDir, 'run-kind.json'), 'utf8'));
} catch {
  kind = null;
}
if (kind?.rehearsal === true) refuse("this is a rehearsal's run directory: there the harness acts, and records itself as the performer");
if (!process.stdin.isTTY || !process.stdout.isTTY) refuse('this records your own words and runs only in your own terminal (standard input and output must be a terminal); nobody else enters them for you');

const rl = createInterface({ input: process.stdin, output: process.stdout });
process.stdout.write(`\nRecording the owner act "${act}": ${ACTS[act]}.\n`);
// E179's acknowledgement: its four fields, each in Sean's own words.
const ask = async (prompt, ok, hint) => {
  for (let tries = 0; tries < 3; tries++) {
    const v = (await rl.question(`${prompt}\n> `)).trim();
    if (ok(v)) return v;
    process.stdout.write(`${hint}\n`);
  }
  rl.close();
  refuse(`nothing was recorded (${hint})`, 1);
};
const enough = (v) => v.split(/\s+/).filter(Boolean).length >= MIN_WORDS;
let extra = {};
if (act === 'question_acknowledged') {
  const decision = await ask('The decision id you acknowledge (dec_…):', (v) => DECISION_ID.test(v), 'A decision id, dec_ and 26 characters.');
  const requirement = await ask('The requirement it affects (R…):', (v) => REQUIREMENT_KEY.test(v), 'A requirement key, such as R10.');
  const implications = await ask(`Its implications, in your own words (at least ${MIN_WORDS} words):`, enough, `At least ${MIN_WORDS} words, please.`);
  const follow_up = await ask(`Its deferred follow-up, in your own words (at least ${MIN_WORDS} words):`, enough, `At least ${MIN_WORDS} words, please.`);
  extra = { decision, requirement, implications, follow_up };
}
if (act !== 'question_acknowledged') process.stdout.write(`In your own words, what did you look at or do? (one line; at least ${MIN_WORDS} words)\n`);
let words = act === 'question_acknowledged' ? `${extra.decision} (${extra.requirement}) acknowledged open: implications: ${extra.implications}; deferred follow-up: ${extra.follow_up}` : '';
for (let tries = 0; tries < 3 && act !== 'question_acknowledged'; tries++) {
  words = (await rl.question('> ')).trim();
  if (words.split(/\s+/).filter(Boolean).length >= MIN_WORDS) break;
  process.stdout.write(`At least ${MIN_WORDS} words, please.\n`);
  words = '';
}
rl.close();
if (!words) refuse('nothing was recorded', 1);

const u = userInfo();
const entry = { act, at: new Date().toISOString(), words, ...extra, entered_via: 'owner-act.mjs', tty: true, uid: u.uid, user: u.username };
mkdirSync(join(runDir, 'observed'), { recursive: true, mode: 0o700 });
appendFileSync(join(runDir, 'observed', 'owner-acts.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
process.stdout.write(`Recorded in ${join(runDir, 'observed', 'owner-acts.jsonl')} at ${entry.at}.\n`);
