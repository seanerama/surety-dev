// The `surety contract` commands (SEAM.md §94): print the engine's contract,
// check this engine's contract or a document, and generate Appendix A.

import { readFileSync } from 'node:fs';

import { generateAppendix } from './appendix.js';
import { checkContract } from './check.js';
import { exportContract } from './document.js';

// 8: the contract checked is not valid. 6: the command could not do its work
// (an unreadable file).
export const CONTRACT_EXIT = { ok: 0, failed: 6, refused: 8 } as const;

export function runContractCommand(sub: 'export' | 'check' | 'appendix', file: string | null): { status: 'ok' | 'refused' | 'failed'; stdout: string; stderr: string } {
  if (sub === 'export') return { status: 'ok', stdout: `${JSON.stringify(exportContract(), null, 2)}\n`, stderr: '' };
  let doc: unknown;
  if (file === null) doc = exportContract();
  else {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      return { status: 'failed', stdout: '', stderr: `${JSON.stringify({ code: 'contract_unreadable', reason: `The contract file could not be read: ${(err as Error).message}.`, what_to_do: 'Name a readable file.', subject: { file } })}\n` };
    }
    try {
      doc = JSON.parse(text);
    } catch {
      if (sub === 'appendix') {
        return { status: 'failed', stdout: '', stderr: `${JSON.stringify({ code: 'contract_unreadable', reason: 'The contract file is not JSON.', what_to_do: 'Give a contract document.', subject: { file } })}\n` };
      }
      const result = { valid: false, findings: [{ check: 'structural', path: [], message: 'The contract file is not JSON.' }], checked: ['lexical', 'structural'], not_checked: ['lifecycle_traces', 'route_behaviour'] };
      return { status: 'refused', stdout: `${JSON.stringify(result)}\n`, stderr: '' };
    }
  }
  if (sub === 'appendix') return { status: 'ok', stdout: generateAppendix(doc), stderr: '' };
  const result = checkContract(doc);
  return { status: result.valid ? 'ok' : 'refused', stdout: `${JSON.stringify(result)}\n`, stderr: '' };
}
