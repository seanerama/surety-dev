#!/usr/bin/env node
// `surety` command. `serve` runs the engine (D1 §1.1); every other command is
// refused until it exists.

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { EXIT, serve } from './engine.js';
import { CONTRACT_EXIT, runContractCommand } from './contract/command.js';
import { STORE_EXIT, StoreCommandRefused, backupStore, restoreStore } from './store/backup.js';
import { ENGINE_VERSION } from './index.js';
import { closeInheritedDescriptors } from './invoke/descriptors.js';
import { SecretFileRefused, holdSecretFiles, parseRefValue } from './invoke/keys.js';
import { parseQualify, sendQualify } from './trust/qualify-command.js';
import { parseEnv, sendEnv } from './deploy/env-command.js';
import { parseDesignCommand } from './design/design-command.js';
import { deployTimeoutMs, parseDeploy } from './deploy/deploy-command.js';
import { paceLines, parsePace, parseSession, settledText, turnOf } from './sessions/session-command.js';
import { configureHarness, setHarnessSwitches, setPackageOmit, setProbeOverrides, setRealLane } from './testing/seam.js';

function usage(message: string): never {
  process.stderr.write(`surety ${ENGINE_VERSION}: ${message}\n`);
  process.exit(EXIT.usage);
}

// Nothing the engine was started with beyond its standard streams reaches
// a helper, a launcher, an init or a role (D2 §§2.2, 2.3; A.6 P14).
closeInheritedDescriptors();

const [command, ...args] = process.argv.slice(2);

if (command === '--version' || command === '-v') {
  process.stdout.write(`${ENGINE_VERSION}\n`);
  process.exit(0);
}
if (command === 'store') {
  await storeCommand(args);
}
if (command === 'contract') {
  await contractCommand(args);
}
if (command === 'qualify') {
  await qualifyCommand(args);
}
if (command === 'env') {
  await envCommand(args);
}
if (command === 'design') {
  await envCommand(args, parseDesignCommand);
}
if (command === 'qualify-adapter') {
  await qualifyAdapterCommand(args);
}
if (command === 'deploy') {
  await deployCommand(args);
}
if (command === 'project') {
  await projectCommand(args);
}
if (command === 'spec') {
  await specCommand(args);
}
if (command === 'session') {
  await sessionCommand(args);
}
if (command === 'pace') {
  await paceCommand(args);
}
if (command !== 'serve') {
  usage(command === undefined ? 'no command given' : `"${command}" is not implemented in this revision`);
}

// Harness flags are accepted only together with --harness (SEAM.md §1). The
// command line parses them and hands them to the seam (SEAM.md §7); a
// migrations directory reaches the engine as an ordinary parameter.
let harness = false;
let migrationsDir: string | null = null;
let scriptedDir: string | null = null;
let shellDir: string | null = null;
let homeFsType: string | null = null;
const barrierValues: string[] = [];
const probeValues: string[] = [];
const hostCheckValues: string[] = [];
const probeOverrideValues: string[] = [];
const templateVersionValues: string[] = [];
let hostIdValue: string | null = null;
let mechanismVariantValue: string | null = null;
let collectBoundsValue: string | null = null;
let checktreesMaxBytesValue: string | null = null;
let hostChecksMode: string | null = null;
let runnerSelfTestValue: string | null = null;
const selfTestCaseValues: string[] = [];
let checkProfileVariantValue: string | null = null;
let checkDomainLimitsValue: string | null = null;
let classifierVersionValue: string | null = null;
let deployAdapterValue: string | null = null;
let artifactFreeBytesValue: string | null = null;
let clockOffsetValue: string | null = null;
const adapterQualificationCaseValues: string[] = [];
let engineBuildVariantValue: string | null = null;
const adapterVersionValues: string[] = [];
let serviceProfileVariantValue: string | null = null;
const hostFactUnreadValues: string[] = [];
let profileMaximaValue: string | null = null;
const packageOmitValues: string[] = [];
const harnessOnly: string[] = [];
// The provider keys by reference (invoke/keys.ts; SEAM.md §160), accepted
// with or without --harness; and the test mode for the real lane (SEAM.md
// §164), accepted only with --harness.
const secretFiles: { ref: string; path: string }[] = [];
const providerCaps: { ref: string; usd: number }[] = [];
let realLane = false;
for (let i = 0; i < args.length; i++) {
  const flag = args[i]!;
  if (flag === '--harness') {
    harness = true;
  } else if (flag === '--harness-real-lane') {
    harnessOnly.push(flag);
    realLane = true;
  } else if (flag === '--secret-file' || flag === '--provider-cap-usd') {
    const value = args[++i];
    if (value === undefined) usage(`${flag} needs a value`);
    const parsed = parseRefValue(flag, value);
    if (typeof parsed === 'string') usage(parsed);
    if (flag === '--secret-file') {
      if (secretFiles.some((f) => f.ref === parsed.ref)) usage(`--secret-file names ${parsed.ref} twice`);
      secretFiles.push({ ref: parsed.ref, path: parsed.value });
    } else {
      if (!parsed.ref.endsWith('/api_key')) usage('--provider-cap-usd is for an API key only: a subscription token has no dollar cap');
      const usd = Number(parsed.value);
      if (!/^\d+(\.\d+)?$/.test(parsed.value) || !Number.isFinite(usd) || usd <= 0) usage('--provider-cap-usd takes <ref>=<a positive number of US dollars>');
      if (providerCaps.some((c) => c.ref === parsed.ref)) usage(`--provider-cap-usd names ${parsed.ref} twice`);
      providerCaps.push({ ref: parsed.ref, usd });
    }
  } else if (
    flag === '--harness-migrations' ||
    flag === '--harness-barrier' ||
    flag === '--harness-scripted' ||
    flag === '--harness-probe' ||
    flag === '--harness-shell' ||
    flag === '--harness-home-fstype' ||
    flag === '--harness-host-checks' ||
    flag === '--harness-host-check' ||
    flag === '--harness-isolation-probe' ||
    flag === '--harness-template-version' ||
    flag === '--harness-host-id' ||
    flag === '--harness-mechanism-variant' ||
    flag === '--harness-collect-bounds' ||
    flag === '--harness-checktrees-max-bytes' ||
    flag === '--harness-runner-self-test' ||
    flag === '--harness-runner-self-test-case' ||
    flag === '--harness-check-profile-variant' ||
    flag === '--harness-check-domain-limits' ||
    flag === '--harness-classifier-version' ||
    flag === '--harness-deploy-adapter' ||
    flag === '--harness-artifact-free-bytes' ||
    flag === '--harness-clock-offset' ||
    flag === '--harness-adapter-qualification-case' ||
    flag === '--harness-engine-build-variant' ||
    flag === '--harness-adapter-version' ||
    flag === '--harness-service-profile-variant' ||
    flag === '--harness-host-fact-unread' ||
    flag === '--harness-profile-maxima' ||
    flag === '--harness-package-omit'
  ) {
    const value = args[++i];
    if (value === undefined) usage(`${flag} needs a value`);
    harnessOnly.push(flag);
    if (flag === '--harness-migrations') {
      migrationsDir = isAbsolute(value) ? value : resolve(value);
    } else if (flag === '--harness-scripted') {
      scriptedDir = isAbsolute(value) ? value : resolve(value);
    } else if (flag === '--harness-probe') {
      probeValues.push(value);
    } else if (flag === '--harness-shell') {
      // The shell reaches the engine as an ordinary parameter: a directory of
      // static files to serve (SEAM.md §90).
      shellDir = isAbsolute(value) ? value : resolve(value);
    } else if (flag === '--harness-host-checks') {
      // Whether the host checks run at start (SEAM.md §114).
      hostChecksMode = value;
    } else if (flag === '--harness-host-check') {
      hostCheckValues.push(value);
    } else if (flag === '--harness-isolation-probe') {
      // A probe of the start-up suite made to miss its target, fail its
      // control, leave its negative unattempted or not run (M2 plan §2.3).
      probeOverrideValues.push(value);
    } else if (flag === '--harness-template-version') {
      templateVersionValues.push(value);
    } else if (flag === '--harness-host-id') {
      hostIdValue = value;
    } else if (flag === '--harness-mechanism-variant') {
      mechanismVariantValue = value;
    } else if (flag === '--harness-collect-bounds') {
      collectBoundsValue = value;
    } else if (flag === '--harness-checktrees-max-bytes') {
      // checktrees_max_bytes below its configured range (SEAM.md §200).
      checktreesMaxBytesValue = value;
    } else if (flag === '--harness-runner-self-test') {
      // SEAM.md §208: the runner self-test at this harness start.
      runnerSelfTestValue = value;
    } else if (flag === '--harness-runner-self-test-case') {
      selfTestCaseValues.push(value);
    } else if (flag === '--harness-check-profile-variant') {
      checkProfileVariantValue = value;
    } else if (flag === '--harness-check-domain-limits') {
      // SEAM.md §212: check domain limits below their configured minimums.
      checkDomainLimitsValue = value;
    } else if (flag === '--harness-classifier-version') {
      // SEAM.md §217: the running classifier reports this version.
      classifierVersionValue = value;
    } else if (flag === '--harness-deploy-adapter') {
      // SEAM.md §247: the scripted deployment adapter (the default) or the real one.
      deployAdapterValue = value;
    } else if (flag === '--harness-artifact-free-bytes') {
      // SEAM.md §260: the free bytes artifact admission takes for the home.
      artifactFreeBytesValue = value;
    } else if (flag === '--harness-clock-offset') {
      // SEAM.md §274: the controlled clock starts this many seconds ahead.
      clockOffsetValue = value;
    } else if (flag === '--harness-adapter-qualification-case') {
      // SEAM.md §323: a case of this start's adapter qualifications forced.
      adapterQualificationCaseValues.push(value);
    } else if (flag === '--harness-engine-build-variant') {
      // SEAM.md §324: the engine build this start records and compares.
      engineBuildVariantValue = value;
    } else if (flag === '--harness-adapter-version') {
      // SEAM.md §324: the engine's local_service version for this start.
      adapterVersionValues.push(value);
    } else if (flag === '--harness-service-profile-variant') {
      // SEAM.md §324: the service profile's fingerprint for this start.
      serviceProfileVariantValue = value;
    } else if (flag === '--harness-host-fact-unread') {
      // SEAM.md §328: this start records that host fact as unread.
      hostFactUnreadValues.push(value);
    } else if (flag === '--harness-profile-maxima') {
      // SEAM.md §427: every role (or check) domain of this start admitted at this maximum.
      profileMaximaValue = value;
    } else if (flag === '--harness-package-omit') {
      // Row M442 (b): a package element left out of every role package.
      packageOmitValues.push(value);
    } else if (flag === '--harness-home-fstype') {
      // Replaces the detection of the home's filesystem, not the judgement
      // (SEAM.md §88).
      homeFsType = value;
    } else {
      barrierValues.push(value);
    }
  } else {
    usage(`unknown flag ${flag}`);
  }
}
if (!harness && harnessOnly.length > 0) usage(`${harnessOnly[0]} is accepted only with --harness`);
// The real lane's journey runs with the host checks (SEAM.md §164).
if (realLane && hostChecksMode === 'unrun') usage('--harness-real-lane runs the host checks: it is not accepted with --harness-host-checks unrun');
if (realLane) hostChecksMode = 'run';
const harnessProblem = configureHarness(harness, barrierValues, scriptedDir, probeValues, hostChecksMode, hostCheckValues);
if (harnessProblem !== null) usage(harnessProblem);
const overrideProblem = harness ? setProbeOverrides(probeOverrideValues) : null;
if (overrideProblem !== null) usage(overrideProblem);
const omitProblem = harness ? setPackageOmit(packageOmitValues) : null;
if (omitProblem !== null) usage(omitProblem);
const switchProblem = setHarnessSwitches({
  templateVersions: templateVersionValues,
  hostId: hostIdValue,
  mechanismVariant: mechanismVariantValue,
  collectBounds: collectBoundsValue,
  checktreesMaxBytes: checktreesMaxBytesValue,
  runnerSelfTest: runnerSelfTestValue,
  selfTestCases: selfTestCaseValues,
  checkProfileVariant: checkProfileVariantValue,
  checkDomainLimits: checkDomainLimitsValue,
  classifierVersion: classifierVersionValue,
  deployAdapter: deployAdapterValue,
  artifactFreeBytes: artifactFreeBytesValue,
  clockOffset: clockOffsetValue,
  adapterQualificationCases: adapterQualificationCaseValues,
  engineBuildVariant: engineBuildVariantValue,
  adapterVersions: adapterVersionValues,
  serviceProfileVariant: serviceProfileVariantValue,
  hostFactsUnread: hostFactUnreadValues,
  profileMaxima: profileMaximaValue,
});
if (switchProblem !== null) usage(switchProblem);

const home = process.env.SURETY_HOME;
if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
try {
  if (!statSync(home).isDirectory()) usage('SURETY_HOME is not a directory');
} catch {
  usage('SURETY_HOME does not exist');
}

// The provider keys (invoke/keys.ts; SEAM.md §160): read and held before
// anything is written; a file that may not be used refuses the start.
try {
  holdSecretFiles(secretFiles, providerCaps, home);
} catch (err) {
  if (!(err instanceof SecretFileRefused)) throw err;
  process.stderr.write(
    `${JSON.stringify({
      code: 'secret_file_refused',
      reason: `The secret file ${err.shownPath} for ${err.ref} cannot be used: ${err.why}.`,
      what_to_do: 'Name a regular file of your own, mode 600 or 400, outside the engine home, holding the credential on one line, and start again.',
      subject: { ref: err.ref, path: err.shownPath },
    })}\n`,
  );
  process.exit(EXIT.config);
}
setRealLane(harness && realLane);

try {
  await serve({ home, migrationsDir, shellDir, homeFsType });
} catch (err) {
  // serve() handles every failure from the listener on; anything that reaches
  // here stopped the start before it, and is reported as the one refusal line.
  process.stderr.write(
    `${JSON.stringify({
      code: 'home_unusable',
      reason: `The engine could not start: ${(err as Error)?.message ?? String(err)}.`,
      what_to_do: 'Check that the engine home is a writable directory and start again.',
      subject: { path: '.' },
    })}\n`,
  );
  process.exit(6);
}

// `surety store backup [--database-only]` and `surety store restore --from
// <dir> --bind <project>=<path>...` (SEAM.md §59), against $SURETY_HOME while
// no engine holds it. The last line on stdout is a JSON object; a refusal is
// one JSON line on stderr, with exit status 7 (3 while an engine holds the
// home).
async function storeCommand(argv: string[]): Promise<never> {
  const [sub, ...rest] = argv;
  const home = process.env.SURETY_HOME;
  if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
  try {
    if (sub === 'backup') {
      const unknown = rest.find((a) => a !== '--database-only');
      if (unknown !== undefined) usage(`unknown flag ${unknown} for store backup`);
      const done = await backupStore(home, { databaseOnly: rest.includes('--database-only') });
      process.stdout.write(`${JSON.stringify(done)}\n`);
      process.exit(STORE_EXIT.ok);
    }
    if (sub === 'restore') {
      let from: string | null = null;
      const bind = new Map<string, string>();
      for (let i = 0; i < rest.length; i++) {
        const flag = rest[i]!;
        const value = rest[++i];
        if (value === undefined) usage(`${flag} needs a value`);
        if (flag === '--from') from = isAbsolute(value) ? value : resolve(value);
        else if (flag === '--bind') {
          const at = value.indexOf('=');
          const path = value.slice(at + 1);
          if (at <= 0 || !isAbsolute(path)) usage('--bind takes <project id>=<absolute repository path>');
          bind.set(value.slice(0, at), path);
        } else usage(`unknown flag ${flag} for store restore`);
      }
      if (from === null) usage('store restore needs --from <backup directory>');
      const done = await restoreStore(home, { from, bind });
      process.stdout.write(`${JSON.stringify(done)}\n`);
      process.exit(STORE_EXIT.ok);
    }
    usage(sub === undefined ? 'store needs a command: backup or restore' : `"store ${sub}" is not a store command`);
  } catch (err) {
    if (err instanceof StoreCommandRefused) {
      process.stderr.write(`${JSON.stringify(err.refusal.body())}\n`);
      process.exit(err.status);
    }
    process.stderr.write(
      `${JSON.stringify({ code: 'store_command_failed', reason: `The store command failed: ${(err as Error)?.message ?? String(err)}.`, what_to_do: 'Check the engine home and the backup, and run it again.', subject: {} })}\n`,
    );
    process.exit(STORE_EXIT.refused);
  }
}

// `surety contract export`, `surety contract check [--file <path>]` and
// `surety contract appendix [--file <path>]` (SEAM.md §94). They need no
// engine home and no running engine.
async function contractCommand(argv: string[]): Promise<never> {
  const [sub, ...rest] = argv;
  let file: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--file' && rest[i + 1] !== undefined && sub !== 'export') file = rest[++i]!;
    else usage(`unknown argument ${rest[i]} for contract ${sub ?? ''}`);
  }
  if (sub !== 'export' && sub !== 'check' && sub !== 'appendix') usage(sub === undefined ? 'contract needs a command: export, check or appendix' : `"contract ${sub}" is not a contract command`);
  const done = runContractCommand(sub, file);
  const status = done.status === 'refused' ? CONTRACT_EXIT.refused : done.status === 'failed' ? CONTRACT_EXIT.failed : CONTRACT_EXIT.ok;
  if (done.stderr !== '') process.stderr.write(done.stderr);
  // Exit once stdout has taken everything: a pipe is written asynchronously,
  // and an exit before that would cut the document short.
  await new Promise<void>((resolve) => process.stdout.write(done.stdout, () => resolve()));
  process.exit(status);
}

// `surety qualify <backend> --mode one_shot_headless --model <model>
// [--egress <host>]... [--canary-deadline <kind>=<seconds>]...` (D2 §7.2): asks the
// engine running on $SURETY_HOME to propose a qualification attempt. The
// engine's answer is printed as it came (one JSON line on stdout for 201,
// a refusal on stderr in its form, exit status 1; no engine running, exit
// status 1). Nothing runs until a person answers
// the attempt's qualification_approval.
// `surety env …` (deploy/env-command.ts; SEAM.md §§313, 317): one request
// to the running engine's environment routes, its answer printed.
async function envCommand(argv: string[], parse: (argv: string[]) => ReturnType<typeof parseEnv> = parseEnv): Promise<never> {
  const parsed = parse(argv);
  if (typeof parsed === 'string') usage(parsed);
  const home = process.env.SURETY_HOME;
  if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
  try {
    const { status, text } = await sendEnv(home, parsed);
    let shown: string;
    try {
      shown = JSON.stringify(JSON.parse(text));
    } catch {
      shown = text.trim().replace(/\n/g, ' ');
    }
    if (status >= 200 && status < 300) {
      process.stdout.write(`${shown}\n`);
      process.exit(0);
    }
    process.stderr.write(`${status} ${shown}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ code: 'engine_unreachable', reason: `The engine could not be asked: ${(err as Error)?.message ?? String(err)}.`, what_to_do: 'Start the engine on this SURETY_HOME and ask again.', subject: {} })}\n`,
    );
    process.exit(1);
  }
}

// `surety deploy <candidate> --env <environment> --project <project>` (D4 §1
// item 4, Q3, A.8; SEAM.md §335; deploy/deploy-command.ts): the operator's
// deployment request, one POST to the running engine. A 2xx answer (issued
// 201, coalesced 200) is printed as one line of JSON, exit 0; any other
// answer as `<status> <body>` on standard error, exit 1; a usage problem
// exits 2 before anything is asked.
async function deployCommand(argv: string[]): Promise<never> {
  const parsed = parseDeploy(argv);
  if (typeof parsed === 'string') usage(parsed);
  const home = process.env.SURETY_HOME;
  if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
  try {
    const { status, text } = await sendEnv(home, parsed, deployTimeoutMs(home));
    let shown: string;
    try {
      shown = JSON.stringify(JSON.parse(text));
    } catch {
      shown = text.trim().replace(/\n/g, ' ');
    }
    if (status >= 200 && status < 300) {
      process.stdout.write(`${shown}\n`);
      process.exit(0);
    }
    process.stderr.write(`${status} ${shown}\n`);
    process.exit(1);
  } catch (err) {
    // No answer in time: the engine may still be preparing the request, and
    // the same request again is answered by it (J3), never doubled.
    if ((err as { timedOut?: unknown })?.timedOut === true) {
      process.stderr.write(
        `${JSON.stringify({ code: 'engine_no_answer', reason: `The engine did not answer the deployment request in time: ${(err as Error).message}. The request may still be in progress.`, what_to_do: 'Run the same surety deploy again: while that deployment is pending the engine answers with it and creates nothing more.', subject: {} })}\n`,
      );
      process.exit(1);
    }
    process.stderr.write(
      `${JSON.stringify({ code: 'engine_unreachable', reason: `The engine could not be asked: ${(err as Error)?.message ?? String(err)}.`, what_to_do: 'Start the engine on this SURETY_HOME and ask again.', subject: {} })}\n`,
    );
    process.exit(1);
  }
}

// `surety project adopt <name> --repo <path> --branch <b> --tier <T>
// [--idea <file>]` (D6 §8.1 step 1, A.8; SEAM.md §377): one POST of
// /v1/projects/adopt to the engine of $SURETY_HOME. A 2xx answer is printed
// as one line of JSON, exit 0; any other answer as `<status> <body>` on
// standard error, exit 1. The idea file's text is sent as the owner's own,
// never interpolated into a command.
async function projectCommand(argv: string[]): Promise<never> {
  const [sub, name, ...rest] = argv;
  if (sub !== 'adopt') usage('project takes adopt: surety project adopt <name> --repo <path> --branch <b> --tier <T> [--idea <file>]');
  if (name === undefined || name.startsWith('-')) usage('project adopt needs a name');
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (!['--repo', '--branch', '--tier', '--idea'].includes(flag) || value === undefined) usage(`unknown or incomplete argument ${flag} for project adopt`);
    if (flag in flags) usage(`${flag} is given twice`);
    flags[flag] = value!;
  }
  for (const f of ['--repo', '--branch', '--tier']) if (!(f in flags)) usage(`project adopt needs ${f}`);
  const repo = flags['--repo']!;
  if (!isAbsolute(repo)) usage('--repo takes an absolute path');
  const body: Record<string, unknown> = { name, tier: flags['--tier'], dev_repo_path: repo, integration_branch: flags['--branch'] };
  if (flags['--idea'] !== undefined) {
    try {
      body.idea = readFileSync(flags['--idea'], 'utf8');
    } catch (err) {
      usage(`--idea ${flags['--idea']} could not be read: ${(err as Error).message}`);
    }
  }
  const home = process.env.SURETY_HOME;
  if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
  try {
    const { status, text } = await sendEnv(home, { method: 'POST', path: '/v1/projects/adopt', body }, 300_000);
    let shown: string;
    try {
      shown = JSON.stringify(JSON.parse(text));
    } catch {
      shown = text.trim().replace(/\n/g, ' ');
    }
    if (status >= 200 && status < 300) {
      process.stdout.write(`${shown}\n`);
      process.exit(0);
    }
    process.stderr.write(`${status} ${shown}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ code: 'engine_unreachable', reason: `The engine could not be asked: ${(err as Error)?.message ?? String(err)}.`, what_to_do: 'Start the engine on this SURETY_HOME and ask again.', subject: {} })}\n`,
    );
    process.exit(1);
  }
}

// `surety spec change-request --project <p> --file <path>` (D6 §4.2, A.8;
// SEAM.md §417): the owner's change request, one POST of
// /v1/projects/:p/spec/change-requests to the engine of $SURETY_HOME with the
// file's text as the owner's own, never interpolated into a command. A 2xx
// answer is printed as one line of JSON, exit 0; any other answer as
// `<status> <body>` on standard error, exit 1; a usage problem exits 2.
async function specCommand(argv: string[]): Promise<never> {
  const [sub, ...rest] = argv;
  if (sub !== 'change-request') usage('spec takes change-request: surety spec change-request --project <p> --file <path>');
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (!['--project', '--file'].includes(flag) || value === undefined) usage(`unknown or incomplete argument ${flag} for spec change-request`);
    if (flag in flags) usage(`${flag} is given twice`);
    flags[flag] = value!;
  }
  for (const f of ['--project', '--file']) if (!(f in flags)) usage(`spec change-request needs ${f}`);
  let text = '';
  try {
    text = readFileSync(flags['--file']!, 'utf8');
  } catch (err) {
    usage(`--file ${flags['--file']} could not be read: ${(err as Error).message}`);
  }
  const home = process.env.SURETY_HOME;
  if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
  try {
    const { status, text: answer } = await sendEnv(home, { method: 'POST', path: `/v1/projects/${encodeURIComponent(flags['--project']!)}/spec/change-requests`, body: { text } });
    let shown: string;
    try {
      shown = JSON.stringify(JSON.parse(answer));
    } catch {
      shown = answer.trim().replace(/\n/g, ' ');
    }
    if (status >= 200 && status < 300) {
      process.stdout.write(`${shown}\n`);
      process.exit(0);
    }
    process.stderr.write(`${status} ${shown}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ code: 'engine_unreachable', reason: `The engine could not be asked: ${(err as Error)?.message ?? String(err)}.`, what_to_do: 'Start the engine on this SURETY_HOME and ask again.', subject: {} })}\n`,
    );
    process.exit(1);
  }
}

// `surety qualify-adapter <adapter>` (D4 §2.6, A.8; SEAM.md §322): the
// client of POST /v1/adapters/:a/qualify on the engine of $SURETY_HOME. It
// waits for the run to end, prints the answer's JSON, and exits 0 only when
// the adapter is qualified; 1 otherwise, or on any other answer.
async function qualifyAdapterCommand(argv: string[]): Promise<never> {
  const [adapter, ...rest] = argv;
  if (adapter === undefined || adapter.startsWith('-')) usage('qualify-adapter needs an adapter: surety qualify-adapter local_service');
  if (rest.length > 0) usage(`unknown argument ${rest[0]} for qualify-adapter`);
  const home = process.env.SURETY_HOME;
  if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
  try {
    const { status, text } = await sendEnv(home, { method: 'POST', path: `/v1/adapters/${encodeURIComponent(adapter)}/qualify`, body: {} }, 1_800_000);
    let body: unknown = null;
    let shown: string;
    try {
      body = JSON.parse(text);
      shown = JSON.stringify(body);
    } catch {
      shown = text.trim().replace(/\n/g, ' ');
    }
    if (status === 200) {
      process.stdout.write(`${shown}\n`);
      process.exit((body as { qualified?: unknown } | null)?.qualified === true ? 0 : 1);
    }
    process.stderr.write(`${status} ${shown}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ code: 'engine_unreachable', reason: `The engine could not be asked: ${(err as Error)?.message ?? String(err)}.`, what_to_do: 'Start the engine on this SURETY_HOME and ask again.', subject: {} })}\n`,
    );
    process.exit(1);
  }
}

async function qualifyCommand(argv: string[]): Promise<never> {
  const parsed = parseQualify(argv);
  if (typeof parsed === 'string') usage(parsed);
  const home = process.env.SURETY_HOME;
  if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
  try {
    const { status, text } = await sendQualify(home, parsed.body);
    const oneLine = (t: string): string => {
      try {
        return JSON.stringify(JSON.parse(t));
      } catch {
        return t.trim().replace(/\n/g, ' ');
      }
    };
    if (status === 201) {
      process.stdout.write(`${oneLine(text)}\n`);
      process.exit(0);
    }
    process.stderr.write(`${oneLine(text)}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ code: 'engine_unreachable', reason: `The engine could not be asked: ${(err as Error)?.message ?? String(err)}.`, what_to_do: 'Start the engine on this SURETY_HOME and ask again.', subject: {} })}\n`,
    );
    process.exit(1);
  }
}

// The engine could not be asked: a refusal on standard error, exit 1.
function unreachable(err: unknown): never {
  process.stderr.write(
    `${JSON.stringify({ code: 'engine_unreachable', reason: `The engine could not be asked: ${(err as Error)?.message ?? String(err)}.`, what_to_do: 'Start the engine on this SURETY_HOME and ask again.', subject: {} })}\n`,
  );
  process.exit(1);
}

// A function declaration, so that the commands dispatched at the top of
// this module can call it before this point is reached.
function shownBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text.trim().replace(/\n/g, ' ');
  }
}

// `surety session …` (BS5 §3; src/sessions/session-command.ts).
async function sessionCommand(argv: string[]): Promise<never> {
  const parsed = parseSession(argv);
  if (typeof parsed === 'string') usage(parsed);
  const home = process.env.SURETY_HOME;
  if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
  let answer: { status: number; text: string };
  try {
    answer = await sendEnv(home, parsed.request);
  } catch (err) {
    unreachable(err);
  }
  if (answer.status < 200 || answer.status >= 300) {
    process.stderr.write(`${answer.status} ${shownBody(answer.text)}\n`);
    process.exit(1);
  }
  if (parsed.waitMs === null) {
    process.stdout.write(`${shownBody(answer.text)}\n`);
    process.exit(0);
  }
  // `say`: the turn admitted, wait for it to settle and show the reply.
  let admitted: { run?: unknown; turn?: unknown };
  try {
    admitted = JSON.parse(answer.text) as { run?: unknown; turn?: unknown };
  } catch {
    admitted = {};
  }
  if (typeof admitted.turn !== 'number') {
    process.stdout.write(`${shownBody(answer.text)}\n`);
    process.stderr.write('The engine did not say which turn it admitted; read it with surety session show.\n');
    process.exit(1);
  }
  process.stderr.write(`Turn ${admitted.turn} admitted; waiting for the role's reply.\n`);
  const show = { method: 'GET' as const, path: `/v1/projects/${encodeURIComponent(parsed.project)}/sessions/${encodeURIComponent(parsed.run!)}`, body: null };
  const until = performance.now() + parsed.waitMs;
  for (;;) {
    try {
      const view = await sendEnv(home, show);
      if (view.status >= 200 && view.status < 300) {
        const t = turnOf(JSON.parse(view.text), admitted.turn);
        if (t && t.state !== 'running') {
          const out = settledText(t);
          (out.ok ? process.stdout : process.stderr).write(`${out.text}\n`);
          process.exit(out.ok ? 0 : 1);
        }
      }
    } catch {
      // the engine between answers: asked again below
    }
    if (performance.now() > until) {
      process.stderr.write(`Turn ${admitted.turn} has not settled in the time waited; it may still be running. Read it with: surety session show ${parsed.run} --project ${parsed.project}\n`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// `surety pace [--json]` (D6 §7.6): the pace read, as JSON or as one line per figure.
async function paceCommand(argv: string[]): Promise<never> {
  const parsed = parsePace(argv);
  if (typeof parsed === 'string') usage(parsed);
  const home = process.env.SURETY_HOME;
  if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
  let answer: { status: number; text: string };
  try {
    answer = await sendEnv(home, parsed.request);
  } catch (err) {
    unreachable(err);
  }
  if (answer.status < 200 || answer.status >= 300) {
    process.stderr.write(`${answer.status} ${shownBody(answer.text)}\n`);
    process.exit(1);
  }
  if (parsed.json) {
    process.stdout.write(`${answer.text.trim()}\n`);
    process.exit(0);
  }
  let value: unknown;
  try {
    value = JSON.parse(answer.text);
  } catch {
    process.stderr.write('The pace read did not parse as JSON.\n');
    process.exit(1);
  }
  process.stdout.write(`${paceLines(value).join('\n')}\n`);
  process.exit(0);
}
