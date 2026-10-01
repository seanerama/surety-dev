// Locations of the package's non-TypeScript assets, resolved relative to the
// package root at run time (build spec §5).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// dist/paths.js → package root.
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MIGRATIONS_DIR = join(PACKAGE_ROOT, 'migrations');

export const homePaths = (home: string) => ({
  config: join(home, 'config.json'),
  lock: join(home, 'engine.lock'),
  lockGuard: join(home, 'engine.lock.guard'),
  token: join(home, 'api.token'),
  store: join(home, 'store.db'),
});
