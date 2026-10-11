// The variables an environment-bound check is given (D4 §§5.2, 7.2; SEAM.md
// §§311, 335), named in one place so that what the runner sets
// (checks/run.ts) and what the Verifier's package says it sets
// (checks/guide.ts) cannot differ. Pure.

// A target's address in a check's environment (D4 §5.2):
// `SURETY_TARGET_<NAME>=http://127.0.0.1:<port>`, the target's name upper-cased
// with anything but a letter or a digit as `_`.
export const targetVariable = (target: string): string => `SURETY_TARGET_${target.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

// A deployment secret's variable in a check's environment (SEAM.md §311):
// `deploy/<name>` → SURETY_SECRET_<NAME>.
export const checkSecretVariable = (ref: string): string => `SURETY_SECRET_${ref.slice(ref.indexOf('/') + 1).toUpperCase()}`;
