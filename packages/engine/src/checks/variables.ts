// The variables an environment-bound check is given (D4 §§5.2, 7.2; SEAM.md
// §§311, 335), named in one place so that what the runner sets
// (checks/run.ts) and what the Verifier's package says it sets
// (checks/guide.ts) cannot differ. Pure.

// A target's address in a check's environment (D4 §5.2):
// `SURETY_TARGET_<NAME>=http://127.0.0.1:<port>`, the target's name upper-cased
// with anything but a letter or a digit as `_`.
export const TARGET_PREFIX = 'SURETY_TARGET_';
export const TARGET_NAME_RULE = "<NAME> is the target's name upper-cased, any character but a letter or digit as _";
export const targetVariable = (target: string): string => `${TARGET_PREFIX}${target.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
// The value the runner sets for each target (checks/run.ts): the service's
// address on the check domain's loopback.
export const targetValue = (port: number | string): string => `http://127.0.0.1:${port}`;

// A deployment secret's variable in a check's environment (SEAM.md §311):
// `deploy/<name>` → SURETY_SECRET_<NAME>.
export const SECRET_PREFIX = 'SURETY_SECRET_';
export const SECRET_NAME_RULE = "<NAME> is the reference's name after deploy/, upper-cased";
export const checkSecretVariable = (ref: string): string => `${SECRET_PREFIX}${ref.slice(ref.indexOf('/') + 1).toUpperCase()}`;
