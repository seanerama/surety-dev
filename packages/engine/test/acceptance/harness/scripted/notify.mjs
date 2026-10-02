// The scripted notification sink (SEAM.md §82). In harness mode the engine's
// external notification channel is this program, in the scripted directory.
// It stands in for an email, Webex or webhook transport and sends nothing
// anywhere. It is the Verifier's code, so how often a notification was
// delivered is recorded by the test side and not by the engine under test.
//
// It is copied into a test's scripted directory and must stay
// self-contained: Node built-ins only, no relative imports.
//
// The engine runs it in one of two ways, each as one process, with an
// argument array and never a shell string:
//
//   node notify.mjs deliver         one line on stdin: a JSON object with at
//                                   least "key" (the notification intent's
//                                   key) and "decision" (the decision's id)
//     exit 0    delivered, and the sink confirms it
//     exit 1    not delivered
//     exit 75   the sink cannot say whether it was delivered
//
//   node notify.mjs lookup <key>    was a notification with this key delivered?
//     exit 0    yes
//     exit 1    no: positively absent
//     exit 75   the sink cannot say
//
// Any other exit, a signal or a timeout is "cannot say" as well.
//
// Files in the scripted directory (the directory this file is in):
//   notify.json           {"deliver": "ok" | "fail" | "unknown", "lookup": "ok" | "unknown"},
//                         written by the test, read here at every call; absent means ok, ok
//   notifications.jsonl   appended here, one line per call:
//                         {"event": "deliver" | "lookup", "key", "decision", "outcome"}
//                         outcome of deliver: "delivered" | "refused" | "unconfirmed"
//                         outcome of lookup:  "found" | "absent" | "unknown"
//
// With "deliver": "unknown" the notification is taken (it counts as
// delivered for a later lookup) and its confirmation is withheld: that is
// the ambiguous delivery an engine must never blindly repeat.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const logFile = join(dir, 'notifications.jsonl');
const UNKNOWN = 75;

const behaviour = () => {
  try {
    return { deliver: 'ok', lookup: 'ok', ...JSON.parse(readFileSync(join(dir, 'notify.json'), 'utf8')) };
  } catch {
    return { deliver: 'ok', lookup: 'ok' };
  }
};

const log = (entry) => appendFileSync(logFile, `${JSON.stringify(entry)}\n`);

const entries = () =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line))
    : [];

const [mode, key] = process.argv.slice(2);

if (mode === 'deliver') {
  let notification;
  try {
    notification = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(2);
  }
  const how = behaviour().deliver;
  const outcome = how === 'ok' ? 'delivered' : how === 'fail' ? 'refused' : 'unconfirmed';
  log({ event: 'deliver', key: notification.key, decision: notification.decision, outcome });
  process.exit(how === 'ok' ? 0 : how === 'fail' ? 1 : UNKNOWN);
} else if (mode === 'lookup') {
  if (behaviour().lookup !== 'ok') {
    log({ event: 'lookup', key, outcome: 'unknown' });
    process.exit(UNKNOWN);
  }
  const found = entries().some((entry) => entry.event === 'deliver' && entry.key === key && entry.outcome !== 'refused');
  log({ event: 'lookup', key, outcome: found ? 'found' : 'absent' });
  process.exit(found ? 0 : 1);
} else {
  process.exit(2);
}
