// Model names and Claude Code's aliases (D6 A.7, E139 Q6).

// Whether `seen` is the model `requested` names: the same name, or, for one
// of Claude Code's aliases (`opus`, `sonnet`, `haiku`), a model of that
// family (`claude-opus-…`).
export function sameModel(requested: string, seen: string): boolean {
  if (seen === requested) return true;
  return /^[a-z]+$/.test(requested) && seen.split(/[-.@:/]/).includes(requested);
}

// The model a real launch passes (the driver's ruling (c), 2026-10-13): the
// role's `model_<role>`; where that is an alias of the family the entry was
// qualified with, the entry's own model, so that the launch runs the model
// the qualification established.
export function launchModel(requested: string, entryModel: string): string {
  return sameModel(requested, entryModel) ? entryModel : requested;
}
