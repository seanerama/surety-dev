// The UI registers credential *file references*. Values are read by the
// engine, held in its redactor, and never returned or stored in this manifest.
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KEY_REFERENCES, readSecretFile, SecretFileRefused } from '../invoke/keys.js';
import { heldSecret, heldProviderCaps, holdSecret, setProviderCap } from '../records/redact.js';
import { Refusal } from '../refusal.js';

interface Entry { ref: string; path: string; provider_cap_usd: number | null }
const file = (home: string) => join(home, 'provider-credentials.json');
function entries(home: string): Entry[] {
  try {
    const st = lstatSync(file(home));
    if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid?.()) throw new Error('permissions');
    const value: unknown = JSON.parse(readFileSync(file(home), 'utf8'));
    if (!Array.isArray(value) || value.length > KEY_REFERENCES.length || new Set(value.map(e => e.ref)).size !== value.length) throw new Error('shape');
    for (const e of value) if (!KEY_REFERENCES.includes(e.ref) || typeof e.path !== 'string' || !(e.provider_cap_usd === null || (typeof e.provider_cap_usd === 'number' && Number.isFinite(e.provider_cap_usd) && e.provider_cap_usd > 0))) throw new Error('entry');
    return value;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Refusal(409, 'credential_manifest_invalid', 'The saved credential references could not be read safely.', 'Check provider-credentials.json ownership, permissions and format.', {});
  }
}
export function credentialStatus(home: string) {
  const saved = entries(home);
  return KEY_REFERENCES.map(ref => ({ ref, path: saved.find(e => e.ref === ref)?.path ?? null, loaded: heldSecret(ref) !== null, provider_cap_usd: heldProviderCaps()[ref] ?? null }));
}
export function loadSavedCredentials(home: string, overridden: string[] = []): void {
  // Validate all references before making any effective.
  const values = entries(home).filter(e => !overridden.includes(e.ref)).map(e => ({ ...e, value: readSecretFile(e.ref, e.path, home) }));
  for (const e of values) { holdSecret(e.ref, e.value); setProviderCap(e.ref, e.provider_cap_usd); }
}
export function registerCredential(home: string, body: unknown) {
  const invalid = () => new Refusal(400, 'invalid_value', 'Choose a supported credential reference, an existing private key file, and an optional positive provider cap.', 'Only ref, path and provider_cap_usd are accepted; do not paste a secret value into the path field.', {});
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !['ref', 'path', 'provider_cap_usd'].includes(k)) || !KEY_REFERENCES.includes(b.ref as never) || typeof b.path !== 'string') throw invalid();
  const cap = b.provider_cap_usd ?? null;
  if (cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0)) throw invalid();
  let value: string;
  try { value = readSecretFile(String(b.ref), b.path, home); } catch (err) {
    if (!(err instanceof SecretFileRefused)) throw err;
    throw new Refusal(400, 'secret_file_refused', `The credential file cannot be used: ${err.why}.`, 'Choose a regular file owned by your user, mode 600 or 400, outside the engine home, containing one credential line.', { ref: b.ref, path: err.shownPath });
  }
  const saved = entries(home).filter(e => e.ref !== b.ref);
  saved.push({ ref: String(b.ref), path: b.path, provider_cap_usd: cap as number | null });
  const temp = `${file(home)}.${randomUUID()}`;
  try { writeFileSync(temp, JSON.stringify(saved, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, file(home)); }
  finally { try { unlinkSync(temp); } catch { /* renamed, or never created */ } }
  // Keep the former value redacted for any in-flight role output.
  const old = heldSecret(String(b.ref));
  if (old && old !== value) holdSecret(`retired/${randomUUID()}`, old);
  holdSecret(String(b.ref), value);
  setProviderCap(String(b.ref), cap as number | null);
  return { credential: credentialStatus(home).find(e => e.ref === b.ref), qualification_required: true };
}
