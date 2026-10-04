#!/usr/bin/env node
// `surety` command. `serve` runs the engine (D1 §1.1); every other command is
// refused until it exists.

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { EXIT, serve } from './engine.js';
import { CONTRACT_EXIT, runContractCommand } from './contract/command.js';
import { STORE_EXIT, StoreCommandRefused, backupStore, restoreStore } from './store/backup.js';
import { ENGINE_VERSION } from './index.js';
import { closeInheritedDescriptors } from './invoke/descriptors.js';
import { holdEnvironmentKeys } from './invoke/keys.js';
import { parseQualify, sendQualify } from './trust/qualify-command.js';
import { configureHarness, setHarnessSwitches, setProbeOverrides } from './testing/seam.js';

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
let hostChecksMode: string | null = null;
const harnessOnly: string[] = [];
for (let i = 0; i < args.length; i++) {
  const flag = args[i]!;
  if (flag === '--harness') {
    harness = true;
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
    flag === '--harness-collect-bounds'
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
const harnessProblem = configureHarness(harness, barrierValues, scriptedDir, probeValues, hostChecksMode, hostCheckValues);
if (harnessProblem !== null) usage(harnessProblem);
const overrideProblem = harness ? setProbeOverrides(probeOverrideValues) : null;
if (overrideProblem !== null) usage(overrideProblem);
const switchProblem = setHarnessSwitches({ templateVersions: templateVersionValues, hostId: hostIdValue, mechanismVariant: mechanismVariantValue, collectBounds: collectBoundsValue });
if (switchProblem !== null) usage(switchProblem);

const home = process.env.SURETY_HOME;
if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
try {
  if (!statSync(home).isDirectory()) usage('SURETY_HOME is not a directory');
} catch {
  usage('SURETY_HOME does not exist');
}

// The provider keys (invoke/keys.ts): outside the test mode, held from the
// engine's environment and removed from it; in the test mode the harness
// holds keys and the variables are only removed.
{
  const keys = harness ? { held: [], problems: [] } : holdEnvironmentKeys(process.env);
  if (harness) for (const name of Object.keys(process.env)) if (name.startsWith('SURETY_SECRET_')) delete process.env[name];
  for (const problem of keys.problems) process.stderr.write(`surety ${ENGINE_VERSION}: ${problem}\n`);
}

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
// [--egress <host>]... [--deadline <kind>=<seconds>]...` (D2 §7.2): asks the
// engine running on $SURETY_HOME to propose a qualification attempt. The
// engine's answer is printed as it came (one JSON line on stdout for 201,
// on stderr otherwise, exit status 7). Nothing runs until a person answers
// the attempt's qualification_approval.
async function qualifyCommand(argv: string[]): Promise<never> {
  const parsed = parseQualify(argv);
  if (typeof parsed === 'string') usage(parsed);
  const home = process.env.SURETY_HOME;
  if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
  try {
    const { status, text } = await sendQualify(home, parsed.body);
    if (status === 201) {
      process.stdout.write(`${text.trim()}\n`);
      process.exit(0);
    }
    process.stderr.write(`${text.trim()}\n`);
    process.exit(7);
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ code: 'engine_unreachable', reason: `The engine could not be asked: ${(err as Error)?.message ?? String(err)}.`, what_to_do: 'Start the engine on this SURETY_HOME and ask again.', subject: {} })}\n`,
    );
    process.exit(7);
  }
}
