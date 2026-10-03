# 005: Answer — upheld; M115 (f) reads the role gone from the process table and takes the domain as empty or removed with its emptied scope; nowhere else in the file does absence stand in

Row: M115
Objection: `005-M115-f-the-emptied-scope-is-removed.md` (Builder, M2 slice 11)
Answered by: Verifier, M2 slice 11, 2026-10-03, on `verify/m2-s11-obj` from `main` at `6464208`

## Decision

**Upheld**, with a narrower change than the one proposed. The case read `cgroup.events` of a directory that the seam itself says the user manager removes; that read was the test's defect. But absence is accepted only where the case has shown why the directory is absent, and only in this one step.

## Why

- After the restart in (f) the domain is still in the scope of the incarnation the case killed. Recovery has killed that incarnation's supervisor leaf, which was empty (SEAM.md §129), so the role's processes are the scope's last members.
- The case then releases the role. It exits by itself, the domain init exits once the backend has (SEAM.md §126), and with the init goes the rest of its pid namespace, the descendant that ignored TERM included. The scope of the dead incarnation is now empty.
- SEAM.md §124: "the manager removes an emptied scope by itself, together with its empty children"; §128, "Across a restart": "A quarantined domain that is empty when its engine dies loses its scope … and is absent in the verified hierarchy". Both are this Verifier's own text, and the case's loop (`populated(domain.cgroup_path)`) contradicted them: once the manager has removed the scope, the read throws `ENOENT`.
- D2 §3.3 makes what the engine then finds termination: "`populated 0` or absence in the verified hierarchy is `terminated`". The tick that follows clears the quarantine once, which `assertClearedOnce` already accepted (it requires the directory gone).

## What changed

`M115-every-unknown-quarantines.test.mjs`, case (f), the step between `release(item)` and the last tick; nothing else of the case, and no other case:

- the role's and its descendant's **host pids** are read while both live (before the Stop), and after the release the case waits until both are gone **from the process table** (`waitHostGone`), so "the role is gone" no longer rests on a directory;
- the domain's directory is then **empty** (`populated 0`) **or removed** (`emptyOrRemoved`, local to the file): only `ENOENT` counts as removed, any other failure to read it fails the case;
- if it is removed, **the whole scope of the dead incarnation must be gone too** (`waitCgroupGone(firstScope)`): the directory is absent because the manager removed an emptied scope with its children, not because something took a directory out of a scope that still stands;
- before the tick the case asserts that **the engine has recorded no `domain.terminated`** and that the run is **still quarantined** with the observation `unknown`: the emptiness or the absence is not the engine's doing, and the clearance that follows is the tick's observation;
- a diagnostic line says which of the two it found.

The objection's one-line form (`!cgroupExists(...) || populated(...) === 0`) was not taken as it stands: it accepts absence without showing the role gone or the scope gone.

## What did not change, and why

- **Case (h) keeps its strict read** of `populated 0`, though its loop has the same shape. There the domain is in the scope of the **live** engine, whose supervisor leaf holds the engine, so the scope cannot empty; and no tick runs between the release and the read, so the engine has observed nothing. A missing directory there would mean a quarantined domain's directory was removed without an observation, which is a finding, not a fixture's timing.
- **The earlier steps of (f)** (the role alive after the refused kill, across the restart, and after the tick that follows the restored `cgroup.kill`) read liveness as before: the role is alive, so its scope stands.
- **(a), (c), (d), (g)**: (a) keeps the dead incarnation's scope populated with a leaf of the test's own before its restart; in (c), (d) and (g) the real role or a sentinel lives. None reads a directory the manager may have removed. (e) and (b) make no restart.
- No harness file and no seam section changed. `COVERAGE.md` ("M2 slice 11") said in two places that whether the domain init outlives its backend was the Builder's; SEAM.md §126 already said "the init exits once the backend has", and this case relies on it (nothing else ends the descendant that ignores TERM). The two lines are corrected to say so.

## Checked

Against the Builder's engine, the only one the case can pass on: `build/m2-s11` at `ec01292`, in a detached scratch worktree with this file copied in (not an acceptance run, nothing committed there, the worktree removed afterwards), the file run alone: **10 of 10**. Case (f)'s diagnostic on that run: "after the release the domain's directory was removed with the emptied scope of the dead incarnation", which is the objection's claim, observed, with the scope's absence asserted. The file performs a real `systemctl --user daemon-reexec` in case (h), as the plan directs (question 6, E59 item 5); the user manager was `running` before and after.
