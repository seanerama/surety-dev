#!/usr/bin/env node
// `surety` command. Scaffold only: it reports its version and refuses every
// other command, so nothing can mistake this revision for a working engine.

import { ENGINE_VERSION } from './index.js';

const [command] = process.argv.slice(2);

if (command === '--version' || command === '-v') {
  process.stdout.write(`${ENGINE_VERSION}\n`);
  process.exit(0);
}

process.stderr.write(
  `surety ${ENGINE_VERSION}: ${command === undefined ? 'no command given' : `"${command}" is not implemented in this revision`}\n`,
);
process.exit(2);
