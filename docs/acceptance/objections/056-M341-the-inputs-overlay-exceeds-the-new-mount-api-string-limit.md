# 056: the check profile's immutable-input overlay cannot be mounted on a host whose `mount(8)` uses the fd-based mount API

Row: M341 (and every row whose check domain has a protected input projection beside an existing `src/.surety`)
Test: packages/engine/test/acceptance/M341-a-service-at-its-limits.test.mjs (exhaust lane, mini-hp01 only); the fixture `hostDeployable` in packages/engine/test/acceptance/harness/deploy/host.mjs
Filed by: Verifier, M4 (the M341 diagnosis Sean's driver asked for), 2026-10-11

This is a Verifier's objection against the engine, not against a test: the engine builds a mount its own mount tool cannot perform on the designated exhaustion host, so M341 cannot pass there until the engine changes. The test and the harness were not worked around (M4 build spec §4, "If the engine is at fault, file an objection with the evidence instead of working around it"). The one harness change made is a fail-fast: `hostDeployable` now fails in seconds, quoting the engine's own stderr, where it used to tick for the file's whole 600 s timeout.

## Claim

The `check` profile's **immutable input namespace** (D3 §2.2, §2.3: "each entry of the check's input manifest, at its workspace pathname: read-only, in an immutable input namespace") is built, when the candidate source also holds a directory of the same top name, as a lower-only overlay of two layers (`src/checks/profile.ts`, `buildCheckPlan`):

```
b.line('surety-inputs', target, 'overlay', `lowerdir=${esc(overlayPath(projected))}:${esc(overlayPath(join(input.source, top)))},userxattr,ro,nosuid,nodev`);
```

and the domain init performs every plan line with util-linux: `run(tools.mount, ['--all', '--fstab', fstab])` (`src/invoke/domain-init.ts`, `setup()`).

Since util-linux 2.39/2.40, libmount performs a mount through the kernel's fd-based mount API (`fsopen`/`fsconfig`/`fsmount`) when the kernel offers it, passing each `key=value` option as one `fsconfig(FSCONFIG_SET_STRING)` call. The kernel bounds such a string at 256 bytes including its terminator. The engine's `lowerdir=` value for the inputs overlay is the two projection paths joined by `:`; on mini-hp01 it is **407 bytes**, and the engine's own path components alone (`checktrees/proj_<26>/<40 hex>-pv_<26>/inputs/<32 hex>/.surety` plus `checktrees/proj_<26>/<40 hex>-pv_<26>/src/.surety`, 128 + 95 characters before either home prefix) exceed the bound with any `SURETY_HOME` of 16 characters or more. So the inputs overlay can never mount through a current util-linux on a current kernel, whatever the home. The kernel logs nothing (the refusal happens in `fsconfig`, before overlayfs), `mount(8)` prints its generic `wrong fs type, bad option, bad superblock` text, the init reports `setup_failed`, and the engine records the execution `interrupted` ("the domain ended with neither a started nor an exec_failed report") and retries it until `check_infra_retries_max`.

What I believe the engine should guarantee: every mount the check profile plans is one its own tool performs on a qualified host. The plan it builds today is not. Which remedy is a design decision for Sean (the Builder's paths); the ones verified on mini-hp01 are in "Remedies" below.

## Evidence

### The symptom (the driver's run, main `ae302a8`, mini-hp01, 2026-10-11 18:06 UTC)

`node scripts/run-tests.mjs acceptance --lane exhaust`: M133, M130 (f) (g) and M205 (g) passed 12 of 12; M341 was cancelled by the runner's 600 s file timeout with no subtest reported, its engine left in its scope (`~/surety-exhaust/m4-exhaust-3.log`; `test-results/acceptance-lane-exhaust-2026-10-11T18-06-07-749Z.log`).

Its leftover home (`~/surety-exhaust/tmp/surety-acc-s2-8CdT0f/home`, still on the host) read with the pinned node and `better-sqlite3`, read-only:

- `environments`: 0 rows. The file never left `hostDeployable`'s `before` hook: the Builder's run was accepted and the candidate nominated at 18:07:02, and the fixture then ticked for the candidate's workspace checks (`acc`, `smoke`) to be recorded, a wait with a 600 s bound of its own, until the runner's 600 s cancelled the file.
- `check_executions`: 6 rows, `acc` and `smoke` three times each (`nomination`, then `recovery` generations 2 and 3, `infra_retries` 0, 1, 2), every one `status = interrupted`, `started_at = null`, `init_reports = []`, `result = null`; `check_results`: 0 rows.
- `events`: six `check.interrupted`, each `{"from":"collecting","why":"the domain ended with neither a started nor an exec_failed report"}`; the matching `domain.terminated` evidence `{"populated":0,"absent":false,"term_sent":false,"kill_written":false}`; `domain.launch_authorized` present for each, so the launch was granted and the init ran.
- The Builder's `role` domain of the same engine, 500 ms earlier, ended `clean` with `report: received`: the sandbox mechanism itself works on the host; only the check profile's plan fails.
- `execution_domains.mount_plan` of a check domain, the one line the role plan has no counterpart of:

```
{"target":"/surety/workspace/.surety","kind":"overlay","source":"/home/smahoney/surety-exhaust/tmp/surety-acc-s2-8CdT0f/home/checktrees/proj_01M4P2B3RFNHX3Z1SXF84FYXAE/f18bc7821a7f529308b17c967e294cb24a731112-pv_01M4P2B3RGYER1PBJ6NKDC1NY7/inputs/710963fa36cb8e37a96e4f7a7daa4fc4/.surety:/home/smahoney/surety-exhaust/tmp/surety-acc-s2-8CdT0f/home/checktrees/proj_01M4P2B3RFNHX3Z1SXF84FYXAE/f18bc7821a7f529308b17c967e294cb24a731112-pv_01M4P2B3RGYER1PBJ6NKDC1NY7/src/.surety","options":["ro","nosuid","nodev"]}
```

### The engine's own account (my run, same host, same commit, with the fail-fast harness, 18:26:55 UTC, `~/surety-exhaust/m341-verify-1.log`)

The fixture failed its `before` hook after 5.7 s, quoting the engine's stderr:

```
{"log":"error","at":"2026-10-11T18:27:01.024Z","what":"check launch","execution":"cx_01M4P3FPK78RX33WQ52P1Y8RAP","detail":"the sandbox could not be built: /usr/bin/mount --all --fstab /home/smahoney/surety-exhaust/tmp/surety-acc-s2-rV8jaB/home/domains/dom_01M4P3FQ0YC1WE4AXKGT9Q06A8/vol/.fstab: mount: /home/smahoney/surety-exhaust/tmp/surety-acc-s2-rV8jaB/home/domains/dom_01M4P3FQ0YC1WE4AXKGT9Q06A8/root/surety/workspace/.surety: wrong fs type, bad option, bad superblock on surety-inputs, missing codepage or helper program, or other error.\n       dmesg(1) may have more information after failed mount system call. (...)"}
```

`journalctl -k` (read-only) for the same seconds holds only overlayfs's usual `xino=off` fallbacks for the `/surety/workspace` overlay; no overlayfs error for `surety-inputs`: the refusal came before overlayfs saw the request. The run left no unit and no directory; the five containers were up before and after.

### The host

mini-hp01: kernel `7.1.9-arch1-2`; `mount from util-linux 2.42.2 (libmount 2.42.2: ... fd-based-mount ...)`; `/home` on btrfs. The workstation where every sandbox-lane row passes: kernel `6.6.87.2-microsoft-standard-WSL2`, `util-linux 2.39.3` without the `fd-based-mount` feature, so it performs the same plan through the legacy `mount(2)`, whose options page is bounded at 4096 bytes.

### Trials in an unprivileged user and mount namespace of my own on mini-hp01 (no unit, no container, directories under `~/surety-exhaust/tmp`, removed after)

With the leftover home's real projection directories as the two lowers, the engine's exact line through `mount --all --fstab`, inside the launcher's namespace set (`unshare --user --map-root-user --mount --pid --net --ipc --uts --cgroup --fork --propagation private`) and inside a plain `unshare -Urm`, with and without `userxattr`, lowers in either order: **fails** every time with the same text. Nested inside a freshly mounted `/surety/workspace` overlay as the init does it, or over a plain tmpfs directory: the same.

Bisection of what matters:

| lower layers | result |
|---|---|
| real `inputs/<h>/.surety` : real `src/.surety` (407 bytes) | fails |
| real `inputs/<h>/.surety` : a short synthetic `src/.surety` (about 280 bytes) | fails |
| a short synthetic `inputs` : real `src/.surety` (about 240 bytes) | mounts |
| `cp -a` copies of both real directories under a short path | mounts |
| the real directories through a bind mount at a short path | mounts |
| the real directories, the legacy `mount(2)` called directly (python ctypes) with the 407-byte value | mounts |
| the real directories, `mount(8)` with `LIBMOUNT_FORCE_MOUNT2=always` (libmount's switch to the legacy API), direct and via `--all --fstab` | mounts |
| the real directories, `lowerdir+=A,lowerdir+=B` (one layer per option; kernel 6.5 and later), direct and via `--all --fstab` | mounts |

Threshold, with synthetic directories padded so that the `lowerdir=` value has an exact length: 200, 240 and 254 bytes mount; 255, 256, 257 and 300 bytes fail. That is the kernel's 256-byte bound on an `fsconfig` string, terminator included.

### Why M205 passes on the same host, and why no sandbox-lane row showed this

`buildCheckPlan` takes the two-layer overlay only when the candidate source also has the input's top directory: `if (existsSync(join(input.source, top))) b.line('surety-inputs', ..., 'overlay', lowerdir=A:B ...) else b.bind(projected, { target, noTarget: true })`. M205 never changes the project's policy, so its source projection has no `.surety` directory (the protected `.surety/checks/` is projected into `inputs/` and absent from `src/`), and the engine takes the plain bind. `hostDeployable` changes policy (`deploy_auto_retries_max`, M341's `service_memory_max` and `service_tasks_max`, `identity_observation_every`), the engine commits `.surety/policy.json` into the repository, `src/.surety` then exists, and the engine takes the overlay. Every sandbox-lane row that uses `hostDeployable` passes on the workstation because its `mount(8)` still uses the legacy API. Neither the H11 probe (D2 §7, "an overlay with its upper layer on it") nor the start-up overlay trial mounts a lower-only overlay with two long layers, so qualification does not see it.

## Sources

- D3 §2.2 (`docs/design/sdlc-design-D3-checks.md`), the `check` profile's mount table: "`/surety/workspace`: an overlay: lower layer the candidate-source projection of the check tree (§2.4), read-only; upper layer on the domain's volatile filesystem" and "each entry of the check's input manifest, at its workspace pathname: read-only, in an **immutable input namespace**; protected content not in the manifest is absent". The design asks for the namespace, not for one mount form; the two-layer overlay is the engine's construction (`src/checks/profile.ts`, `buildCheckPlan`, the `surety-inputs` line).
- D2 §2.3 (`docs/design/sdlc-design-D2-backends-and-isolation.md`): "The launcher builds the role's root from a **mount plan** the engine resolves and validates before each launch". A plan validated before launch that its own tool then cannot perform is a plan the validation does not cover.
- D2 §7 H6 and H11 (same file, the qualification table): H6 records util-linux's version ("util-linux 2.39.3" on the design's workstation); H11 trials "a tmpfs with `size` and `nr_inodes` limits, and an overlay with its upper layer on it". No probe trials a lower-only overlay of two layers, which is the form that fails.
- M4 build spec §4.1 (`docs/spec/M4-build-spec.md`), lane rule: "`exhaust`: service limits, on `mini-hp01` only." The exhaustion host is the one host where the engine must run this profile with util-linux 2.42; it is also the Alpha deployment host's class (D4).
- `src/invoke/domain-init.ts`, `setup()`: `run(tools.mount, ['--all', '--fstab', fstab])` for the first and the late fstab; a failure is sent as `setup_failed` and the init exits 70. `src/checks/run.ts`, `setupFailed`: the detail goes to `log()` (stderr) only; `decideResult`: "neither a started nor an exec_failed report" ends the execution `interrupted`, and `interruptExecution` registers the recovery retry in the same transaction.
- Kernel, as measured above rather than quoted: a `FSCONFIG_SET_STRING` value of 255 bytes or more is refused with `EINVAL` before overlayfs's parser runs (nothing in the kernel log; the 254/255 threshold), which matches the 256-byte copy bound in `fs/fsopen.c` to my reading; overlayfs's per-layer `lowerdir+=` option (kernel 6.5 and later, `Documentation/filesystems/overlayfs.rst`) exists so that a list of layers need not fit one option string, and it mounted the real directories here.

## Remedies (for Sean and the Builder; each verified to mount the real directories on mini-hp01)

1. Plan the inputs overlay as `lowerdir+=<projected>,lowerdir+=<source top>` (kernel 6.5 and later; H-probe the form at qualification). The plan's recorded `entries` and the fingerprint parse `lowerdir=` today (`src/invoke/sandbox/mounts.ts`, `planEntries`), so the parser changes with it.
2. Or make the init's `mount` use the legacy API (`LIBMOUNT_FORCE_MOUNT2=always` in the environment of `run(tools.mount, ...)`), which keeps the plan text unchanged and removes the 256-byte bound for every option, at the cost of depending on a libmount environment variable.
3. Shortening paths does not suffice: the engine's own components exceed the bound with any realistic home.

Whichever is chosen, a qualification probe (H11's neighbour) should mount a lower-only overlay of two layers whose joined paths exceed 256 bytes, so a host where the form fails is `isolation_unqualified` rather than a host where every check is `interrupted`.

## What this objection does not claim

M341's own assertions (a) to (c) were not reached and are not shown right or wrong here; nothing of the service domain, the OOM kill or the task limit was exercised. M341 keeps failing on mini-hp01 until the engine changes; the file now fails in seconds with the engine's reason in its message instead of running out the lane's timeout.
