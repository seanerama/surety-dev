# 008: M125 (a)/(b) requires the host to read the domain init's `/proc/<pid>/environ`, which cannot hold together with M117 (b)'s `/proc/1/fd` refused to the role, the two being one kernel uid

Row: M125 (with M117)
Test: packages/engine/test/acceptance/M125-handover.test.mjs, case "(a) argv and (b) environment: …", the loop over `engineSide` (lines 123 to 130: "host-read: /proc/<pid>/environ of … can be read …; unknown is not absence")
Filed by: Builder, M2 slice 12, 2026-10-03

## Claim

Every assertion of the case before that loop passes on `build/m2-s12` (the stand-in launched by the init, its argv the template's, the hostile text only in `/surety/context/prompt.md`, its environment exactly the allowed names with the grant's secret and the markers, no parent-only sentinel and no token). The loop then requires the host to read `/proc/<pid>/environ` of every other member of the domain. For the domain init it cannot:

```
error: 'host-read: /proc/16392/environ of /.init/node /.init/init.js init can be read (EACCES); unknown is not absence'
```

The init is made non-dumpable on purpose (slice 11; D2 §2.3 and A.6 P13: "init's channel cannot be opened"; M117 (b), accepted: "`/proc/1/fd` unreadable", which SEAM.md §127 reads as `refused` (`EACCES`)), and the role and the host are the same kernel uid (D2 §2.2: no dedicated role user). For a non-dumpable task the kernel owns its `/proc/<pid>` files by the root of the task's user namespace, or by the global root where that root is unmapped; `/proc/<pid>/environ` is mode 0400 and `/proc/<pid>/fd` mode 0500, and `/proc/<pid>/fd` is guarded by that ownership alone (`proc_fd_permission`: the mode bits, no ptrace check). So:

- if the init's `/proc` files are owned by the global root (the slice-11 build, the init a non-root uid in a user namespace whose root is unmapped), the role cannot list `/proc/1/fd` (M117 (b) passes) and the host, uid 1000 in the initial namespace without `CAP_DAC_READ_SEARCH` there, cannot read the init's `environ` (this case fails);
- if they are owned by kernel uid 1000 (the init made root of a namespace that maps it to 1000), the host reads the init's `environ` (it holds `CAP_SYS_PTRACE` over that namespace as its owner), but the role, also kernel uid 1000, passes the same ownership check and lists `/proc/1/fd` (M117 (b) and the probe suite's P2 and P13 fail). I built and ran this on a scratch engine: the host read the init's environment (`PATH, LANG, NODE_OPTIONS`) and the role listed `/proc/1/fd`.

There is no third owner with one kernel uid, and the role cannot be told apart from the host by a mode bit. A `hidepid` mount of the sandbox's `/proc` would hide pid 1 from the role and break the guard every acting probe relies on (`/proc/1/comm`, SEAM.md §§127, 141). I have kept the slice-11 structure (M117 (b) holds), so this case fails at the loop.

## Proposed change

Treat an `EACCES` on `/proc/<pid>/environ` of the domain init as what it is: an environment no process of uid 1000 can read, the role included. For example, for a member whose `/proc/<pid>/cmdline` (mode 0444, readable) names `/.init/init.js`, require either the environment read and free of the secret and the sentinels, or the read refused with `EACCES` and `/proc/<pid>/status` showing it in another user namespace than the host's (its `environ` is then unreadable to the role as well); keep the strict read for every other member (the launcher's `unshare`, readable today: `PATH, LANG`). Alternatively Sean decides that the host-read of the init's environment outranks M117 (b), and the slice-11 case changes instead.

## Sources

- M2 plan §3.4 M125 (b): "the init's and the forwarder's environments, read from the host's `/proc`, hold neither the secret nor the sentinels"; §3.3 M117 (b): "`/proc/1/fd` unreadable".
- D2 §2.3: "the domain init's control channel is unreachable from role code by inheritance or through `/proc`"; A.6 P2, P13.
- SEAM.md §127 (M117 (b): `/proc/1/fd` is `refused` (`EACCES`)), §139 ("an environment the host cannot read fails the case").
