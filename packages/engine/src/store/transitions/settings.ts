// The engine settings the transition functions use (lease TTL, decision
// targets), handed to the store worker when it opens the store. They are the
// values read once at startup (E22 item 1); the project settings are each
// project's effective policy.

import { projectPolicyDefaults } from '../../config/project-policy.js';

export interface EngineSettings {
  lease_ttl: number;
  decision_targets: Record<string, number | null>;
}

let settings: EngineSettings | null = null;

export function setEngineSettings(value: EngineSettings): void {
  settings = value;
}

export function engineSettings(): EngineSettings {
  if (!settings) throw new Error('engine settings were not handed to the store');
  return settings;
}

// A project's effective ungoverned policy. No policy revision can be recorded
// before the journaled policy path exists (slice 3), so it is the schema
// defaults (SEAM.md §2; E23 item 3).
export function projectPolicy(_project: string): Record<string, number> {
  return projectPolicyDefaults();
}
