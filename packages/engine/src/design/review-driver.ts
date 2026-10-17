// The review's main-thread steps (D7 §10.2, §10.3): what a review-mode
// session's close reads of its review file. Filled by the review's slice.

import type { Runtime } from '../runtime.js';
import type { SaveFacts } from '../sessions/session.js';

export async function reviewRaise(_rt: Runtime, _facts: SaveFacts): Promise<Record<string, unknown> | null> {
  return null;
}
