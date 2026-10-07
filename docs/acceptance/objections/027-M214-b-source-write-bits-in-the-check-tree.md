# 027: M214 (b) required the check tree's source files to have no write bit, which no copy-free construction can square with a check overwriting an existing source file (E89 item 2, M212 (e))

Row: M214 (b)
Test: packages/engine/test/acceptance/M214-the-check-tree-and-bounded-preparation.test.mjs, case "(b) two executions of one triple at once share one read-only tree ...": `assert.equal(holding[0].mode & 0o222, 0, 'its files are read-only ...')` on the file holding the candidate's unique source
Filed by: Builder, M3 slice 17, 2026-10-07 (for the record: the driver ruled on it during the design, and the Verifier amended the case on `main` in 654278d before this file was written)

## Claim

The check tree's source projection is the lower layer of the workspace's discarded writable overlay (D3 §2.2). E89 item 2, the driver's ruling 1 for slice 17 and M212 (e) require a check to be able to overwrite an existing source file there. When the check opens a lower-layer file for writing, overlayfs checks the overlay inode's mode, which is the lower file's, against the check's own credentials (`ovl_permission` → `generic_permission`). The check has no capabilities, by D2's design. So a file of mode 0444 in the tree is refused with `EACCES`. The Builder observed this in `unshare -Urm` on this host, with a capability-less nested uid. Only three constructions are possible:
- the tree's source files keep their git modes (0644, 0755) on the host;
- every source file is copied into the domain's volatile layer at setup, costing up to `checktree_max_bytes` of domain memory per domain;
- source writes stay refused, which breaks M212 (e) and E89 item 2.

The driver chose the first (design approval, slice 17). As first written, M214 (b) also required the source file holding the candidate's unique bytes to have no write bit, which that choice cannot meet.

What the test should require:
- The read-only mode for the protected input's projection only. Those files stay 0444 or 0555, with 0555 directories.
- For source files, the property the mode was standing in for: what a check writes never reaches the tree. M212's control and the amended (b) assert this.

A write bit on a host file owned by the engine's uid protects nothing against that uid, which may `chmod` it. The tree is protected by being reachable only by the engine, and inside a domain only as an overlay's lower layer, which overlayfs never writes.

## Recorded with it (the driver's ruling on Q11, for the errata)

A protected version whose authorized revision the store does not hold exactly has no recomputable fingerprint. Its fingerprint stays unreadable, and its project's gates carry `PROTECTED_PATH_UNAUTHORIZED` until a new version is applied. The engine does not guess a commit. Migration 0013 backfills the revision only from exact records: an applied version's protected commit operation, and an API-created project's bootstrap commit parent. A project installed some other way before slice 17 is therefore blocked until a protected change is applied, and nothing in M3 re-authorizes an existing version.

## Sources

- D3 §2.2: "The writable overlay ... D3 gives the check a writable overlay whose writes are discarded"; E89 item 2.
- SEAM §198, the control: "A write to an ordinary source file of the candidate ... succeeds in the domain and does not persist: no file under `checktrees/` holds the written bytes".
- D3 §2.4: "Files are made read-only; a tree is immutable". The immutability holds for every execution: no domain can write the tree. The mode bits on the host are not what provides it.
- D2 §2.3: the check (role) code runs without capabilities in a nested user namespace.
