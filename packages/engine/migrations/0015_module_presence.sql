-- M3 slice 20, validation scope (D3 §4.1, A.3; SEAM.md §224). A candidate's
-- module presence: the modules with at least one tracked path at its
-- revision, read with engine git and recorded as ancestry is. Null while
-- unread. The JSON is {modules: [module id], read_at, basis}; `basis`
-- (engine-owned, not in A.3) is the hash of the module definitions the read
-- was made under, so a read under other definitions counts as unread.
ALTER TABLE candidates ADD COLUMN module_presence TEXT;
