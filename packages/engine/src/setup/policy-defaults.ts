import { projectEffectiveDefaults, projectOptionSpecs, unconfiguredBackendKeys } from '../config/project-policy.js';
import { BACKEND_ROLE_KEYS, PROJECT_POLICY, REAL_BACKEND_NAMES } from '../config/schema.js';

// GET /v1/setup's policy defaults (the owner's production-defaults ruling of
// 2026-10-27). A `backend_<role>` key with no default is absent from
// `policy_defaults`, never filled in; `policy_defaults_state` says whether
// any is, and `backend_defaults` says, role by role, which backend is the
// default or that the role is unconfigured and a real provider needs
// configuring.
export function policyDefaults() {
  const defaults = projectEffectiveDefaults();
  const fields = projectOptionSpecs();
  const unconfigured = unconfiguredBackendKeys(defaults);
  const roles = Object.fromEntries(
    Object.entries(BACKEND_ROLE_KEYS).map(([role, key]) => {
      const value = defaults[key];
      return [role, typeof value === 'string' ? { key, state: 'default', default: value } : { key, state: 'unconfigured', default: null }];
    }),
  );
  const choices = [...((fields[Object.values(BACKEND_ROLE_KEYS)[0]!]?.values ?? REAL_BACKEND_NAMES) as readonly string[])];
  return {
    policy_defaults: defaults,
    policy_fields: { ...PROJECT_POLICY, ...fields },
    policy_defaults_state: unconfigured.length === 0 ? 'complete' : 'provider_unconfigured',
    backend_defaults: {
      state: unconfigured.length === 0 ? 'default' : 'unconfigured',
      provider_required: unconfigured.length > 0,
      message:
        unconfigured.length === 0
          ? null
          : `No provider is configured: ${unconfigured.join(', ')} ${unconfigured.length === 1 ? 'has' : 'have'} no default, and the engine substitutes none. Configure a real provider (${REAL_BACKEND_NAMES.join(' or ')}) for each role: qualify it on this host, have its trust entry activated, and set the role's backend in the project's policy. Until then every run and session of such a role is refused.`,
      choices,
      roles,
    },
  };
}
