# 008: Answer — upheld in part; the init's environment is still read from the host, from its memory rather than its /proc file; M117 (b) unchanged; the proposed EACCES acceptance refused

Rows: M125 (a)/(b) (with M117 (b))
Objection: `008-M125-ab-the-init-environ-and-proc-1-fd-cannot-both-hold.md` (Builder, M2 slice 12)
Answered by: Verifier, M2 slice 12, 2026-10-03, on `verify/m2-s12-obj` from `main` at `3054c58`

## Decision

**Upheld in part.**

- **Taken: the analysis.** On one kernel uid, the init's /proc files cannot be owned so that the host may open `environ` and the role may not open `fd`. The case's demand that `/proc/<pid>/environ` of the init be *readable as a file* cannot hold together with M117 (b), and M117 (b) is the stronger requirement (D2 §2.3: the init's channel is unreachable "through `/proc`"). The case no longer requires that file.
- **Refused: the proposed acceptance.** An `EACCES` plus "the init is in another user namespace" says nothing about what the init's environment holds. Plan M125 (b) and D2 §1.3 require that it holds neither the secret nor the parent-only sentinels, read from the host. Accepting the refusal would leave that property unpinned.

## The witness

`/proc/<pid>/environ` is the process's initial environment block: the bytes between `env_start` and `env_end` of its memory. The host reads those same bytes by a route that has no file-mode check and that the role does not have:

- **`/proc/<pid>/stat`** (mode 0444) shows `env_start` and `env_end` (fields 50, 51) to any reader the kernel lets ptrace-read the process.
- **`process_vm_readv(2)`** copies that range under the ptrace check alone.
- **The host qualifies.** It is uid 1000 in the initial user namespace and owns the sandbox's user namespaces, so it holds `CAP_SYS_PTRACE` over them. That passes the non-dumpable check and Yama's scope 1.
- **The role does not.** It sits in the init's own user namespace with no capability.

Node has no binding for the call, so the host's `python3` makes it. It is a host tool like `git` or `systemd-run`, not a dependency. It reads a process of the test's own engine and changes nothing.

Observed on `build/m2-s12` at `cf92925` before any case was changed:

- **The init.** `/proc/<pid>/environ` of `/.init/node /.init/init.js init` → `EACCES`. The memory read → `PATH=/usr/bin:/bin`, `LANG=C.UTF-8`, `NODE_OPTIONS=--disable-sigusr1 --no-warnings`: 77 bytes, the whole block.
- **The launcher's `unshare`.** It is readable both ways, with the same result: `PATH`, `LANG`.

## What changed

- **`harness/sandbox/procs.mjs` gains `environFromMemory(pid)`.** It throws with the reason when the block cannot be read: python3 absent, `env_start` not shown, or a short read.
- **M125 (a)/(b)'s loop over every non-backend member of the domain:**
  - where `/proc/<pid>/environ` is readable, it is the read, and the memory read must equal it (the instrument's control, on every run);
  - where it is refused, the refusal must be `EACCES` (the file's mode), and the memory read must succeed and be non-empty;
  - either way, no parent-only sentinel, no secret and no API token is in it;
  - the init must have been among the members read.
- **Unchanged:** a block read by neither route fails the case, as before. M117 (b) is unchanged.

## Not pinned, recorded

- **Whether the role itself can `process_vm_readv` the init.** By the reasoning above it cannot, having no capability in the init's namespace. The init does hold the backend's environment (with the secret) in its memory, to start the backend. No case pins this, because the role holds that secret anyway (D2 §8 class C). If Sean wants it pinned, it is one more read probe in M117 (b).
- **The witness's reliance on the host owning the sandbox's user namespaces.** That ownership is the same fact that makes the host, and not the role, able to read the block. It is stated in SEAM, "Amended after the slice-12 objections".

No design question is left for Sean: the property is pinned as the plan states it, and M117 (b) stands.
