# D2 insertion draft: optional eBPF observation

**Status:** proposal, 2026-10-03; **approved by Sean the same day as an optional, qualification-only prototype (errata E57)**: no runtime dependency, the loader a checked host requirement Sean sets up, a feasibility run under root before any Verifier or Builder work. Not implementation authorization beyond that scope. Section numbers refer to [D2 draft 1](sdlc-design-D2-backends-and-isolation.md); this companion does not edit it.

**Purpose:** use kernel observations to strengthen qualification evidence and diagnose process, filesystem and network behavior. Start with the scripted backend in the real sandbox. Keep this a small qualification aid, not another required production subsystem.

## Proposed insertion points

### After §3.8: “3.9 Optional execution observer”

> An optional host observer uses eBPF to record selected process creation, exec and exit events, file-access attempts with their results, and network connection attempts with their results. Observation covers the supervisor's launcher interval and the execution domain; filtering only after domain placement is insufficient. Events are attributed to the engine incarnation, invocation and domain through engine-established process/cgroup identity, never through role-supplied environment markers alone. PID and cgroup identifier reuse MUST NOT transfer attribution to another invocation.
>
> Observation does not authorize launch, establish termination, pass checks or measure model tokens. The launch fence and cgroup boundary remain authoritative. Missing events are not evidence of absence. Collector interruption, event loss or missing required hooks marks the affected observation interval incomplete.

This supports review B01/B05 and the probe weaknesses in [Astra's D2 review §8](../reviews/D2/sdlc-review-D2-Astra.md). It does not replace those amendments.

### Extend §§2.1 and 6: observer trust and host support

> The observer is a separate trusted host component outside role domains. Its loader receives only the privileges required by the selected hooks; neither the Node engine nor role processes receive BPF-loading privileges. Its interface accepts no arbitrary program or tracing target from a role. Collection is restricted to Surety's registered execution scope and uses bounded buffers and output. Credentials, file contents, environment values and full command arguments are not collected; identifying metadata is redacted before durable publication.
>
> Observer availability is reported separately from sandbox qualification. An unavailable optional observer does not invalidate an otherwise qualified host. A qualification test that relies on observer evidence cannot pass when the observer or required hook is unavailable; it needs another independently qualified witness or remains unestablished.

Read-only inspection found BPF, BTF, tracing and cgroup-BPF support configured on this WSL2 kernel, with `bpftool` and `bpftrace` installed. Unprivileged BPF is disabled. No program was loaded; attachment and event delivery remain to be tested. A small `bpftrace` prototype is sufficient to assess feasibility before choosing a production collector.

### Extend §§7.1–7.2: independent qualification witnesses

> Selected containment probes correlate an engine-known action with a kernel-observed attempt and outcome. The fixture establishes that its target exists and that the permitted control succeeds. A liveness marker or claimed transcript alone does not establish the attempt. Instrumentation must distinguish relevant syscall variants and asynchronous connection outcomes; an initial nonblocking-connect result is not final connection success or denial. A test fails to establish its claim if its observation interval is incomplete.

Prioritize P4/P5's resolved Git metadata, P6/P8's connections, and P16's detached descendants. Trace the delayed-launch reproduction separately. eBPF cannot make a wrong target or invalid positive control into a valid test.

### Extend Appendix A and Appendix B: evidence and tests

Use the existing `qualification_evidence` record kind. Declare an observer evidence envelope containing collector version, kernel identity, hook set, capture scope, invocation/domain bindings, capture interval, loss counters and completeness status. Keep detailed events in bounded records, not a new database row per syscall. No new public API or dashboard is needed for the first slice.

Add these assertions to the nearest existing sandbox-lane tests:

| Test focus | Required observable result |
|---|---|
| Attempt versus claim | A backend that merely prints “denied” fails; an actual attempt and matched result are observed. |
| Attribution | Supervisor-to-domain placement, detached descendants and reused identifiers retain correct invocation attribution. |
| Late launch | Observation reveals a delayed launcher; the boundary independently refuses its cancelled authorization. |
| Lost observation | Forced buffer loss or collector exit makes dependent evidence incomplete, never a successful negative. |
| Collection limits | Bounded output, redaction and process filtering hold under a noisy scripted workload. |

## Decision for Sean

Approve an **optional, qualification-only prototype** as the initial scope. Production monitoring and BPF-based enforcement remain separate decisions. Retain D2's existing runtime-dependency rule; any loader or tracing tool is an explicitly checked host/test requirement. The Verifier pins the assertions before the Builder implements them, under the existing E31/E48 procedure. No paid model calls are needed for this first slice.
