// Where the engine's serving check program lives (SHAPES.md §3):
// `checks/programs/static-serving.mjs` of the engine's install, as a real
// path, bound read-only at that path into the check's domain.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function servingProgramPath(): string {
  return realpathSync(fileURLToPath(new URL('./static-serving.mjs', import.meta.url)));
}

// Imported so that the program is compiled with the engine (tsconfig
// includes `.ts` files and what they import); its description, as the
// program states it, for the developer tests to compare with the engine's.
export { DESCRIPTION as SERVING_PROGRAM_DESCRIPTION } from './static-serving.mjs';
