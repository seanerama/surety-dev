// The event types the engine emits (D1 §12.1, A.6), each with what emits it:
// the transition module that writes it. The set is closed: Tx.emit takes no
// other type, and the executable contract (contract/) states this table.

export const EVENT_OWNERS = {
  'engine.started': 'store/transitions/engine.ts',
  'engine.mode_changed': 'store/transitions/engine.ts',
  'engine.tick': 'store/transitions/engine.ts',
  // D6 K1 (M5 slice 37; SEAM.md §430): one per requesting transition.
  'scheduler.tick_requested': 'store/transitions/tick-requests.ts',
  // D6 A.2 (§7.6; N01): the host observed for a project at its start or an engine start.
  'host.observed': 'plan/pace.ts',
  'engine.quarantine': 'store/transitions/runs.ts',
  'api.act': 'store/transitions/audit.ts',
  'project.created': 'store/transitions/project.ts',
  'project.registered': 'store/transitions/finalize.ts',
  'project.paused': 'store/transitions/project.ts',
  'project.resumed': 'store/transitions/project.ts',
  'project.rebound': 'store/transitions/project.ts',
  'work.created': 'store/transitions/work.ts',
  'work.claimed': 'store/transitions/work.ts',
  'work.advanced': 'store/transitions/work.ts',
  'work.integrated': 'store/transitions/work.ts',
  'work.complete': 'store/transitions/work.ts',
  'work.held': 'store/transitions/work.ts',
  // M5 slice 37 (N01; the driver's ruling Q3; SEAM.md §§427, 431): a hold's
  // interval, and a stage work item's milestone met.
  'work.hold_began': 'store/transitions/work.ts',
  'work.hold_ended': 'store/transitions/work.ts',
  'work.dependency_met': 'scheduler/milestones.ts',
  'work.resumed': 'store/transitions/work.ts',
  'work.parked': 'store/transitions/work.ts',
  'work.cancelled': 'store/transitions/work.ts',
  'run.created': 'store/transitions/runs.ts',
  'run.claimed': 'store/transitions/runs.ts',
  'run.started': 'store/transitions/runs.ts',
  'run.heartbeat': 'store/transitions/runs.ts',
  'run.validating': 'store/transitions/runs.ts',
  'run.finalizing': 'store/transitions/runs.ts',
  'run.ended': 'store/transitions/runs.ts',
  'run.quarantined': 'store/transitions/runs.ts',
  'domain.terminated': 'store/transitions/runs.ts, store/transitions/deploy.ts',
  'domain.quarantined': 'store/transitions/runs.ts',
  // D6 A.2 (K2; N01; SEAM.md §432): a domain's memory peak, before its termination.
  'domain.peak_recorded': 'store/transitions/runs.ts',
  'decision.raised': 'store/transitions/decisions.ts',
  'decision.answered': 'store/transitions/decisions.ts',
  'decision.consumed': 'store/transitions/decisions.ts',
  'decision.invalidated': 'store/transitions/decisions.ts',
  'operation.intended': 'store/transitions/journal.ts, store/transitions/deploy.ts',
  'operation.attempt_started': 'store/transitions/journal.ts, store/transitions/deploy.ts',
  'operation.succeeded': 'store/transitions/journal.ts, store/transitions/deploy.ts',
  'operation.failed': 'store/transitions/journal.ts, store/transitions/deploy.ts',
  'operation.partial': 'store/transitions/journal.ts, store/transitions/deploy.ts',
  'operation.ambiguous': 'store/transitions/journal.ts, store/transitions/deploy.ts',
  'operation.finalized': 'store/transitions/journal.ts, store/transitions/deploy.ts',
  'revision.recorded': 'store/transitions/repo.ts',
  'candidate.nominated': 'store/transitions/finalize.ts',
  'candidate.superseded': 'store/transitions/finalize.ts',
  'repo.out_of_band': 'store/transitions/repo.ts',
  'repo.reconciled': 'store/transitions/finalize.ts, store/transitions/intents.ts, store/transitions/queue.ts, store/transitions/repo.ts',
  'policy.changed': 'store/transitions/finalize.ts, store/transitions/project.ts',
  'git.journal_intended': 'store/transitions/journal.ts',
  'git.journal_applied': 'store/transitions/journal.ts',
  'git.journal_confirmed': 'store/transitions/journal.ts',
  'git.journal_ambiguous': 'store/transitions/journal.ts',
  'git.journal_finalized': 'store/transitions/journal.ts',
  'invocation.receipt': 'store/transitions/runs.ts',
  'invocation.status': 'store/transitions/runs.ts',
  'invocation.usage': 'store/transitions/runs.ts',
  'ledger.row': 'store/transitions/ledger.ts',
  // The workspace assistant's turns (the assistant design §§1.3, 4).
  'assistant.turn_admitted': 'store/transitions/assistant.ts',
  'assistant.turn_started': 'store/transitions/assistant.ts',
  'assistant.turn_ended': 'store/transitions/assistant.ts',
  'assistant.cancel_requested': 'store/transitions/assistant.ts',
  'ledger.correction': 'store/transitions/ledger.ts',
  'record.written': 'store/transitions/records.ts',
  'record.expired': 'store/transitions/records.ts',
  'record.secret_found': 'store/transitions/records.ts',
  'record.missing': 'store/transitions/records.ts',
  'run.proposal_captured': 'store/transitions/accept.ts',
  'decision.escalated': 'store/transitions/queue.ts',
  'protected.proposed': 'store/transitions/protected.ts',
  'protected.classified': 'store/transitions/protected.ts',
  'protected.approved': 'store/transitions/protected.ts',
  'protected.rejected': 'store/transitions/queue.ts',
  'protected.applied': 'store/transitions/protected.ts',
  'protected.unauthorized_detected': 'store/transitions/gates.ts',
  'protected.fingerprint_recomputed': 'store/transitions/protected.ts',
  'check.result': 'store/transitions/baseline.ts',
  'gate.scope_built': 'store/transitions/gates.ts',
  'gate.evaluated': 'store/transitions/gates.ts',
  'authorization.issued': 'store/transitions/gates.ts',
  'authorization.consumed': 'store/transitions/deploy.ts',
  'authorization.superseded': 'store/transitions/gates.ts',
  'finding.raised': 'store/transitions/findings.ts',
  'finding.severity_changed': 'store/transitions/queue.ts',
  'finding.dispositioned': 'store/transitions/queue.ts',
  // M546 (INK2-2): a Reviewer's proposal the owner's standing answer already gave, recorded against it, no question raised.
  'finding.proposal_standing': 'store/transitions/findings.ts',
  // H1 (E171 item 5; SEAM.md §552): a Reviewer's own fix on a finding naming no check, refused; nothing dispatched.
  'finding.fix_refused': 'store/transitions/findings.ts',
  // S1 (E172 item 7; SEAM.md §555): a Reviewer's disposition on a finding the owner dispositioned, refused; the finding as he left it, nothing registered.
  'finding.disposition_refused': 'store/transitions/findings.ts',
  'finding.resolved': 'store/transitions/gates.ts, store/transitions/work.ts',
  'finding.reopened': 'store/transitions/protected.ts, store/transitions/queue.ts',
  // The driver's ruling on loop run 1: a finding's check its own proposal did not bring into effect.
  'finding.check_unbound': 'store/transitions/protected.ts',
  'assessment.proposed': 'store/transitions/findings.ts',
  'assessment.assessed': 'store/transitions/findings.ts',
  'assessment.approved': 'store/transitions/queue.ts',
  'assessment.rejected': 'store/transitions/findings.ts, store/transitions/queue.ts',
  'signoff.recorded': 'store/transitions/findings.ts',
  // D6 §5.8 (B06): a phase sign-off bound to a replaced plan generation or a
  // superseded candidate, refused and not recorded.
  'signoff.refused': 'store/transitions/findings.ts',
  'intent.recorded': 'store/transitions/queue.ts',
  'intent.executing': 'store/transitions/intents.ts, store/transitions/protected.ts',
  'intent.done': 'store/transitions/protected.ts',
  'intent.invalidated': 'store/transitions/queue.ts',
  'notification.queued': 'store/transitions/queue.ts',
  'notification.sending': 'store/transitions/notify.ts',
  'notification.delivered': 'store/transitions/notify.ts',
  'notification.failed': 'store/transitions/notify.ts',
  'notification.unknown': 'store/transitions/notify.ts',
  'environment.observed': 'store/transitions/environments.ts, store/transitions/observe.ts',
  // D4 A.5, the deployment (M4 slice 23).
  'environment.configured': 'store/transitions/deploy.ts',
  'environment.config_secrets_changed': 'store/transitions/deploy.ts',
  'environment.verified': 'store/transitions/deploy.ts',
  'artifact.sealed': 'store/transitions/deploy.ts',
  'artifact.failed': 'store/transitions/deploy.ts',
  // SHAPES.md §4: a candidate's downloadable package, recorded once.
  'deliverable.built': 'store/transitions/deliverable.ts',
  'adapter.qualified': 'store/transitions/deploy.ts',
  'adapter.qualification_lapsed': 'store/transitions/deploy.ts',
  'candidate.advanced': 'store/transitions/deploy.ts',
  'deploy.journal_intended': 'store/transitions/deploy.ts',
  'deploy.journal_applied': 'store/transitions/deploy.ts',
  'deploy.journal_confirmed': 'store/transitions/deploy.ts',
  'deploy.journal_ambiguous': 'store/transitions/deploy.ts',
  'deploy.journal_finalized': 'store/transitions/deploy.ts',
  'deploy.capability_refused': 'store/transitions/deploy.ts',
  'deploy.launch_authorized': 'store/transitions/deploy.ts',
  'deploy.round_registered': 'store/transitions/deploy.ts',
  'deploy.round_superseded': 'store/transitions/deploy.ts',
  'deploy.orchestration_deadline': 'store/transitions/deploy.ts',
  'deploy.service_exited': 'store/transitions/deploy.ts',
  'deploy.preempted': 'store/transitions/deploy.ts',
  'environment.out_of_band': 'store/transitions/observe.ts',
  'environment.observation_missed': 'store/transitions/observe.ts',
  // D4 §5.2 (Q7), the operator relay (M4 slice 28; the driver's ruling).
  'environment.relay_opened': 'store/transitions/deploy.ts',
  'environment.relay_closed': 'store/transitions/deploy.ts',
  'engine.backup': 'store/transitions/engine.ts',
  // D2 A.5, the trust table's part. The egress and secret events join with
  // the sandbox lane's later slices, which emit them.
  'host.qualified': 'store/transitions/trust.ts',
  'host.qualification_lapsed': 'store/transitions/trust.ts',
  'qualification.proposed': 'store/transitions/trust.ts',
  'qualification.authorized': 'store/transitions/trust.ts',
  'qualification.finished': 'store/transitions/trust.ts',
  'trust.proposed': 'store/transitions/trust.ts',
  'trust.activated': 'store/transitions/trust.ts',
  'trust.revoked': 'store/transitions/trust.ts',
  // D2 A.5, the boundary's part (M2 slice 11).
  'domain.placed': 'store/transitions/boundary.ts, store/transitions/deploy.ts',
  'domain.launch_authorized': 'store/transitions/boundary.ts',
  'domain.launch_closed': 'store/transitions/boundary.ts, store/transitions/deploy.ts',
  'run.lease_regranted': 'store/transitions/boundary.ts',
  // D2 A.5, the sandbox's part (M2 slice 12).
  'domain.egress_refused': 'store/transitions/boundary.ts',
  // D2 A.5, the secret screen (M2 slice 13).
  'evidence.secret_refused': 'store/transitions/boundary.ts',
  // D3 A.6, check executions (M3 slice 15).
  'check.registered': 'store/transitions/checks.ts',
  'check.launched': 'store/transitions/checks.ts',
  'check.quarantined': 'store/transitions/checks.ts',
  'check.interrupted': 'store/transitions/checks.ts',
  'check.cancelled': 'store/transitions/checks.ts',
  'check.lease_regranted': 'store/transitions/checks.ts',
  // D6 A.2 (M5 slice 31): the idea record, the sessions, the products'
  // approvals and the plan's publication.
  'baseline.idea_recorded': 'store/transitions/project.ts, sessions/decisions.ts',
  'baseline.spec_approved': 'spec/approval.ts',
  'baseline.architecture_approved': 'plan/bundle.ts',
  'baseline.roadmap_revised': 'plan/bundle.ts',
  'baseline.plan_approved': 'plan/bundle.ts',
  'baseline.plan_refused': 'plan/bundle.ts',
  'plan.checked': 'plan/bundle.ts',
  'plan.published': 'store/transitions/work.ts',
  'plan.generation_refused': 'plan/bundle.ts',
  'session.allocated': 'sessions/session.ts',
  'session.turn_started': 'sessions/session.ts',
  // A Designer turn held on the day limits and released (the driver's
  // decision on objection 156).
  'session.turn_held': 'sessions/session.ts',
  'session.turn_released': 'sessions/session.ts',
  'session.turn_ended': 'sessions/session.ts',
  'session.turn_settled': 'sessions/session.ts',
  'session.saved': 'sessions/session.ts',
  'session.closed': 'sessions/session.ts',
  // D6 §§4, 5.6, 5.8, 6.2, 6.8 (M5 slice 31b): readiness, completion, the
  // replan's publication, the specification change, the policy's request.
  'phase.authoring_ready': 'store/transitions/protected.ts, store/transitions/work.ts',
  'phase.completion_bound': 'plan/phase.ts',
  'baseline.phase_complete': 'plan/phase.ts',
  'spec.change_requested': 'spec/change.ts',
  'spec.change_proposed': 'spec/change.ts',
  'spec.change_approved': 'spec/change.ts',
  'spec.change_failed': 'spec/change.ts',
  // D6 §4.5 (M5 slice 36): the rejection keeping its side ref; an
  // obligation resolved; the Verifier's applicability assessment.
  'spec.change_rejected': 'spec/change.ts',
  'check.obligation_resolved': 'spec/change.ts, plan/deferral.ts',
  // D6 A.2 (B07; SEAM.md §428): a deferral's obligation recorded.
  'check.obligation_recorded': 'plan/deferral.ts',
  'spec.assessment_recorded': 'spec/change.ts',
  'deploy.requested_by_policy': 'store/transitions/deploy.ts',
  // D6 §8 (M5 slice 32): the adoption, the confirmations, the conformance
  // stage's binding and its integration at publication.
  'project.adopted': 'adopt/records.ts',
  'requirement.confirmed': 'adopt/records.ts',
  'conformance.source_bound': 'adopt/conformance.ts',
  'stage.conformance_integrated': 'adopt/conformance.ts',
  'conformance.alpha_barrier_opened': 'plan/phase.ts',
  // D7 A.2 (M6): the design's events.
  'design.inventory_derived': 'design/store.ts',
  'design.checked': 'design/store.ts',
  'design.proposed': 'design/store.ts',
  'design.approved': 'design/approval.ts',
  'design.rejected': 'design/approval.ts',
  'design.ready': 'design/approval.ts',
  'design.stale': 'design/store.ts',
  'design.waived': 'design/due.ts',
  'design.asset_added': 'design/approval.ts',
  'design.assets_approved': 'design/approval.ts',
  'design.preview_deployed': 'design/preview.ts',
  'design.preview_torn_down': 'design/preview.ts',
  'design.preview_requested': 'design/preview.ts',
  'design.preview_failed': 'design/preview.ts',
  'design.review_recorded': 'design/review.ts',
  'design.review_requested': 'design/review.ts',
  'design.verdicts_confirmed': 'design/review.ts',
  'design.asset_bound': 'design/approval.ts',
  // H5 (E171 item 5; SEAM.md §553): an unrecorded review's file moved to reviews/refused/.
  'design.review_refused': 'design/review-refused.ts',
  // Rapid prototype, slice E1 (migration 0044; R7): an iteration created,
  // its Alpha reached, and a torn-down Alpha's candidate set back.
  'prototype.iteration_created': 'store/transitions/prototype.ts',
  'prototype.iteration_alpha_ready': 'store/transitions/prototype.ts',
  'candidate.alpha_withdrawn': 'store/transitions/prototype.ts',
  // The owner's ruling of 2026-10-29: a newer deployment replaced the
  // candidate's in its environment (its claim of current availability
  // withdrawn, its history kept).
  'candidate.alpha_replaced': 'store/transitions/prototype.ts',
  // Slice E2 (R4, R8): an iteration ended by a limit, by the owner's Stop or
  // Discard, and its limits following a policy change (a raised one
  // reopening it).
  'prototype.iteration_limit_reached': 'store/transitions/prototype.ts',
  'prototype.iteration_stopped': 'store/transitions/prototype.ts',
  'prototype.iteration_discarded': 'store/transitions/prototype.ts',
  'prototype.iteration_limits_changed': 'store/transitions/prototype.ts',
  // Slice E3 (R1, R3, R5): the preparation authorized or declined, its run
  // failed, the brief prepared (its spec_approval raised), approved or
  // rejected, the first plan asked for and published by the prototype
  // policy or routed to the owner, and the iteration's status following the
  // owner's open questions and the work's failures.
  'prototype.preparation_authorized': 'prototype/brief.ts',
  'prototype.preparation_declined': 'prototype/brief.ts',
  'prototype.preparation_failed': 'prototype/brief.ts',
  'prototype.brief_prepared': 'prototype/brief.ts',
  'prototype.brief_approved': 'prototype/brief.ts',
  'prototype.brief_rejected': 'prototype/brief.ts',
  'prototype.first_plan_requested': 'prototype/brief.ts',
  'prototype.plan_policy_authorized': 'prototype/brief.ts',
  'prototype.plan_routed_to_owner': 'prototype/brief.ts',
  'prototype.iteration_status_changed': 'prototype/brief.ts',
  // Slice E4 (R7, R8): an iteration iterated (the new one continuing from
  // it), and a candidate that is not the open iteration's own refused as its
  // Alpha (a predecessor's deployment never satisfies it).
  'prototype.iteration_iterated': 'prototype/iterate.ts',
  'prototype.alpha_not_attributed': 'store/transitions/prototype.ts',
  // Slice E5 (gap 4): a stopped iteration resumed by the owner's deliberate
  // POST …/iterations/:i/resume.
  'prototype.iteration_resumed': 'store/transitions/prototype.ts',
  // The owner's instruction of 2026-10-29 (the static-preview shapes, §5):
  // one per evaluation of whether the environments can host the output.
  'deployment.compatibility_evaluated': 'deploy/compatibility.ts',
} as const;

export type EventType = keyof typeof EVENT_OWNERS;

export const EVENT_TYPES = Object.keys(EVENT_OWNERS) as EventType[];
