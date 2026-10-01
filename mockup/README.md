# Surety UI mockup (MVP, accepted 2026-09-30)

Live canvas: https://claude.ai/artifact/BTMrfmXXpLnHezZYfoShMK (private; clickable in Play mode)

Eight desktop screens, 1440x900, one invented project (meet-proxy, T2) in the Section 3.6 example state: production last verified v1.3.0, attempted v1.4.0 partial, observed Degraded.

| File | Screen | Foundations it demonstrates |
|---|---|---|
| Main.dc.html | Projects | Multi-project NOW, measured zero vs unknown cost, Unknown shown as Unknown |
| Overview.dc.html | Project overview | 3.1 five dimensions, 3.6 three facts per environment, E11 nominated candidates only |
| Attention.dc.html | Attention queue | P9 / E9 item schema, consequence per answer, aging and escalation, E13 loosening needs a human |
| Build.dc.html | Build | 3.10 phase plan, run liveness, E7 Pause/Stop/Abandon with consequences, E2 checkpoints and lineage |
| Gate.dc.html | Gate detail | E12 gate function as five inputs, E8 five check states, E13 protected-path delta |
| Environments.dc.html | Environments and releases | 3.6, 3.7 operation identity and reconciliation, 7.7 release lineage, recovery plan |
| Managed.dc.html | Managed | 3.5 activation gate, E5 structured issues and triage, raw reports kept out of prompts |
| Settings.dc.html | Settings | E1 trust table (unqualified version refused), per-role backend and mode, E16b budgets, secrets as references |

Design decisions: grey-green ledger ground; Barlow Condensed for the single loud element (the NOW state word); Atkinson Hyperlegible elsewhere; violet reserved for "waiting on you" so status colors stay the engine's; Unknown drawn as a hatch, never blank; every fact tagged observed / claimed / configured with its age.

Status: accepted for MVP by Sean on 2026-09-30. UI refinement deferred until after the narrow loop runs.
Working product name: Surety (collision-checked 2026-09-30; npm availability not yet checked).
