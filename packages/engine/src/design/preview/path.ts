// Where the engine's design preview server lives (D7 §5.7; SEAM.md §§499,
// 500): `preview/server.js` of the engine's install, as a real path, the
// same on the host and in the service domain that binds it read-only.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function previewServerPath(): string {
  return realpathSync(fileURLToPath(new URL('./server.js', import.meta.url)));
}
