-- M3 slice 17: the protected inputs (D3 §§1.3, 1.5, 2.2, 2.4; L6, B01; Q11;
-- SEAM.md §§195 to 202). Columns marked engine-owned are not in D3 A.3.

-- L6, Q11 (engine-owned): the scheme a version's `fingerprint` is recorded
-- under. `pairs`, the mode-free [path, blob id] scheme every version recorded
-- before slice 17 holds; `manifest`, L6's [path, type, mode, object id]
-- manifest; `unreadable`, the migration could not recompute it from its
-- authorized tree (the column then keeps the value it had, which nothing
-- compares). No comparison crosses schemes: a version not under `manifest`
-- compares with nothing, and its project's gates carry
-- PROTECTED_PATH_UNAUTHORIZED. At each engine start every version not under
-- `manifest` is recomputed again (Q11 (a)).
ALTER TABLE protected_versions ADD COLUMN fingerprint_scheme TEXT NOT NULL DEFAULT 'pairs'
  CHECK (fingerprint_scheme IN ('pairs', 'manifest', 'unreadable'));

-- Q11 (engine-owned): the commit whose tree the version's set was authorized
-- from: for the initial version, the integration branch's commit the set was
-- read at; for an applied version, the protected commit. Null when the store
-- does not hold it exactly; such a version's fingerprint cannot be recomputed
-- and stays unreadable (no guessing).
ALTER TABLE protected_versions ADD COLUMN authorized_revision TEXT;

-- What a store written before slice 17 holds exactly: an applied version's
-- protected commit, from its application's commit operation; and the initial
-- version of a project created through the API, from its bootstrap commit
-- operation, whose parent is the commit the set was read at.
UPDATE protected_versions SET authorized_revision = (
  SELECT json_extract(o.finalizer_inputs, '$.sha') FROM operations o
  WHERE o.kind = 'git_commit' AND o.project = protected_versions.project
    AND json_extract(o.finalizer_inputs, '$.purpose') = 'protected'
    AND json_extract(o.finalizer_inputs, '$.version') = protected_versions.id
  ORDER BY o.rowid LIMIT 1
) WHERE proposal IS NOT NULL;

UPDATE protected_versions SET authorized_revision = (
  SELECT json_extract(o.finalizer_inputs, '$.parent') FROM operations o
  WHERE o.kind = 'git_commit' AND o.project = protected_versions.project
    AND json_extract(o.finalizer_inputs, '$.purpose') = 'bootstrap'
  ORDER BY o.rowid LIMIT 1
) WHERE proposal IS NULL AND change_kind = 'initial';
