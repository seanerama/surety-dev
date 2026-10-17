-- M6 slice 41 (D7 draft 3 §3.5, §4.5, §5.3, §7.2, §7.3; Appendix A.2, A.3;
-- SEAM.md §§491, 494): what a Designer session's findings become, and the
-- native conventions a design leaves not checkable yet.

-- A Designer's finding (B.12: D3 X2's form with the interface or the
-- requirement it is about), recorded at the settlement of the turn that
-- returned it. A `contract_conflict` or `requirement_conflict` is routed to
-- one owner question (`decision`) and is `open` until the owner answers it;
-- the answer names its route (`change_spec`, with the request it made, or
-- `architect`). A `defect` is recorded and routed nowhere (D7 §4.5 names a
-- route for the two conflicts only). While a finding against an interface
-- is open, a design_approval whose screens use that interface carries the
-- blocker DESIGN_INTERFACE_DISPUTED (§4.5, §7.4).
CREATE TABLE design_findings (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  seq INTEGER NOT NULL,
  run TEXT NOT NULL REFERENCES runs(id),
  turn INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('requirement_conflict', 'contract_conflict', 'defect')),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  message TEXT NOT NULL,
  interface TEXT,
  requirement TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'routed', 'recorded')),
  decision TEXT REFERENCES decisions(id),
  route TEXT CHECK (route IN ('change_spec', 'architect')),
  spec_change_request TEXT REFERENCES spec_change_requests(id),
  routed_at TEXT,
  UNIQUE (project, seq)
);

-- D7 A.3 design_native_obligations: per approved design revision, target,
-- screen and native convention of §5.3's "not checkable" column, recorded
-- `not_checkable_yet` in the approval's effect and bound to that target's
-- human-test requirement (null when the approval has none: approved without
-- criteria, or a requirement the change did not create).
CREATE TABLE design_native_obligations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project TEXT NOT NULL REFERENCES projects(id),
  design_revision TEXT NOT NULL REFERENCES design_revisions(id),
  target TEXT NOT NULL CHECK (target IN ('web', 'android', 'ios', 'macos', 'windows', 'linux')),
  screen TEXT NOT NULL,
  convention TEXT NOT NULL CHECK (convention IN (
    'browser_back', 'keyboard_path', 'system_back', 'safe_area', 'permission_prompt',
    'touch_interaction', 'platform_navigation', 'window_resize', 'menu_entries', 'keyboard_shortcuts')),
  status TEXT NOT NULL CHECK (status IN ('not_checkable_yet')),
  requirement TEXT REFERENCES requirements(id),
  UNIQUE (design_revision, target, screen, convention)
);
