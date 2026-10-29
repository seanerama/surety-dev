// GET /v1/adapters/:adapter (SHAPES.md §1): what the local_service adapter
// can do on this engine and host, read, never probed: its version, the
// qualification in force (the store's), the runtime a configuration may pin
// here (the engine's own node, by path, SHA-256 and version), the modes a
// configuration may name, the engine's static server, and the outputs it
// hosts or packages. Any other adapter name is 404. A read: nothing is
// written, run or started.

import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';

import { Refusal } from '../refusal.js';
import type { Runtime } from '../runtime.js';
import { ADAPTERS } from '../store/transitions/deploy.js';
import { adapterVersion } from './qualification.js';
import { CONFIG_MODES, STATIC_ENTRY_DEFAULT, staticServer } from './static-site.js';
import { SERVING_CHECK_KEY } from './serving-install.js';
import { SERVING_COMMAND, SERVING_DESCRIPTION, SERVING_KIND } from '../checks/schema.js';
import { SERVING_STATEMENT } from '../store/transitions/serving.js';

// The outputs local_service hosts, and those the engine also packages.
export const ADAPTER_OUTPUTS = Object.freeze([
  { kind: 'node_service', hosted: true },
  { kind: 'static_site', hosted: true, downloadable: true },
]);

let runtimeHash: { key: string; sha256: string } | null = null;
async function nodeSha256(path: string): Promise<string> {
  const st = statSync(path);
  const key = `${path}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  if (runtimeHash?.key === key) return runtimeHash.sha256;
  const sha256 = await new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
  runtimeHash = { key, sha256 };
  return sha256;
}

export async function adapterRead(rt: Runtime, adapter: string): Promise<Record<string, unknown>> {
  if (!(ADAPTERS as readonly string[]).includes(adapter)) {
    throw new Refusal(404, 'not_found', `No adapter ${JSON.stringify(adapter)} is known to this engine.`, `Read GET /v1/adapters/${ADAPTERS[0]}.`, { adapter });
  }
  const qualification = await rt.read<{ status: string; id: string | null; at: string | null }>('adapter.read', { adapter });
  const node = process.execPath;
  const server = staticServer();
  return {
    adapter,
    adapter_version: adapterVersion(adapter),
    qualification,
    runtime: { path: node, sha256: await nodeSha256(node), version: process.version },
    modes: [...CONFIG_MODES],
    static: {
      server: { path: server.path, sha256: server.sha256 },
      entry_default: STATIC_ENTRY_DEFAULT,
      // The engine's serving check (SHAPES.md §3), proposed by the engine
      // for a project configured in static mode (deploy/serving-install.ts).
      serving_check: { kind: SERVING_KIND, key: SERVING_CHECK_KEY, command: SERVING_COMMAND, gate_kinds: ['alpha_complete'], description: SERVING_DESCRIPTION, records: SERVING_STATEMENT },
    },
    outputs: ADAPTER_OUTPUTS.map((o) => ({ ...o })),
  };
}
