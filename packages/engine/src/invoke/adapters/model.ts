// Model names and Claude Code's aliases (D6 A.7 "an active entry's model";
// E139 Q6; the review's M1, 2026-10-13).

// A model name as a command line takes it: never empty, never an option,
// no whitespace or control character.
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
export const isModelName = (v: unknown): v is string => typeof v === 'string' && MODEL_NAME.test(v);

// The family token of a Claude model id, `claude-<family>-…`, or null.
export function familyOf(model: string): string | null {
  return /^claude-([a-z]+)-/.exec(model)?.[1] ?? null;
}

// Whether the entry's (or an observed) model `seen` is the model `requested`
// names: the same name, or, for an alias (one lower-case word), a model whose
// family token is that word. `claude`, or any word that is not the family
// token, names nothing.
export function sameModel(requested: string, seen: string): boolean {
  if (seen === requested) return true;
  return /^[a-z]+$/.test(requested) && familyOf(seen) === requested;
}
