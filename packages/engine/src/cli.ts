#!/usr/bin/env node
// `surety` command. `serve` runs the engine (D1 §1.1); every other command is
// refused until it exists.

import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { EXIT, serve } from './engine.js';
import { ENGINE_VERSION } from './index.js';
import { type BarrierSpec, parseBarrierFlag } from './testing/seam.js';

function usage(message: string): never {
  process.stderr.write(`surety ${ENGINE_VERSION}: ${message}\n`);
  process.exit(EXIT.usage);
}

const [command, ...args] = process.argv.slice(2);

if (command === '--version' || command === '-v') {
  process.stdout.write(`${ENGINE_VERSION}\n`);
  process.exit(0);
}
if (command !== 'serve') {
  usage(command === undefined ? 'no command given' : `"${command}" is not implemented in this revision`);
}

// Harness flags are accepted only together with --harness (SEAM.md §1).
let harness = false;
let migrationsDir: string | null = null;
const barriers: BarrierSpec[] = [];
const harnessOnly: string[] = [];
for (let i = 0; i < args.length; i++) {
  const flag = args[i]!;
  if (flag === '--harness') {
    harness = true;
  } else if (flag === '--harness-migrations' || flag === '--harness-barrier') {
    const value = args[++i];
    if (value === undefined) usage(`${flag} needs a value`);
    harnessOnly.push(flag);
    if (flag === '--harness-migrations') {
      migrationsDir = isAbsolute(value) ? value : resolve(value);
    } else {
      const spec = parseBarrierFlag(value, barriers.length);
      if (!spec) usage(`unknown barrier or action in ${flag} ${value}`);
      if (barriers.some((b) => b.name === spec.name)) usage(`barrier ${spec.name} is armed twice`);
      barriers.push(spec);
    }
  } else {
    usage(`unknown flag ${flag}`);
  }
}
if (!harness && harnessOnly.length > 0) usage(`${harnessOnly[0]} is accepted only with --harness`);

const home = process.env.SURETY_HOME;
if (!home || !isAbsolute(home)) usage('SURETY_HOME must name an absolute directory');
try {
  if (!statSync(home).isDirectory()) usage('SURETY_HOME is not a directory');
} catch {
  usage('SURETY_HOME does not exist');
}

await serve({ home, harness, migrationsDir, barriers });
