-- The store order of facts the engine compares (DECISIONS item 51; Sean's
-- go of 2026-11-24: "Use a shared, durable ordering source for each
-- comparison, such as the event sequence for both facts. For historical
-- records without enough evidence to establish order, make the fallback
-- explicit."). Where the engine decided which of two facts came first by
-- comparing two `tx.at` wall-clock stamps written by different
-- transactions, a host clock that steps back (SEAM.md §23, §425) inverted
-- the answer. Each fact compared now records its place in the store's one
-- order, the event `seq` (events.seq, unique and strictly increasing; one
-- writer, immediate transactions), in the transaction that writes it:
--
--   an event fact      the seq of the event its own transaction emits for
--                      it (operation.finalized, ...);
--   a position fact    the highest event seq when the row is written
--                      (Tx.storeOrder(); as execution_domains.supervision_lost_seq,
--                      migration 0028): the fact follows every event up to
--                      it and precedes every later one.
--
-- A position fact p is before an event fact E exactly when p < E, after it
-- exactly when p >= E, whatever the two wall-clock stamps say, equal
-- milliseconds included.
--
-- Rows written before this migration carry NULL: no order was recorded and
-- none is inferred here. Where a comparison meets one, the engine compares
-- the recorded timestamps as before and names that basis
-- (`timestamp_fallback`) in what it serves or records; it never presents
-- that comparison as store order.
--
-- Finding 2, what ended an observation (store/transitions/observe.ts
-- observationEndedBy): the observation's position against the
-- teardown's or deployment's finalization event.
ALTER TABLE observation_history ADD COLUMN seq INTEGER;
ALTER TABLE operations ADD COLUMN finalized_seq INTEGER;

-- Finding 1, a refused policy Alpha request reconsidered
-- (store/transitions/deploy.ts reopenableWait, resultComing,
-- invalidatedByChange): what a check's executions and results were as at
-- the candidate's latest `alpha_authorize` evaluation, read by the
-- evaluation's own gate.evaluated event seq against each fact's position:
-- registered by then (created_seq < seq), ended at or after it
-- (finished_seq, else its result's created_seq, >= seq), a result recorded
-- by then, invalidated after it (invalidated_seq >= seq).
ALTER TABLE gate_evaluations ADD COLUMN seq INTEGER;
ALTER TABLE check_executions ADD COLUMN created_seq INTEGER;
ALTER TABLE check_executions ADD COLUMN finished_seq INTEGER;
ALTER TABLE check_results ADD COLUMN created_seq INTEGER;
ALTER TABLE check_results ADD COLUMN invalidated_seq INTEGER;
-- The latest reconsideration of a policy request recorded `not_issued`,
-- made again because what refused it only waited (reopenableWait), as
-- canonical JSON {"evaluation", "order_basis", "at"}: the evaluation read
-- and whether its comparisons were by store order (`seq`) or, a row
-- lacking its order, by the recorded timestamps (`timestamp_fallback`).
-- NULL: never reconsidered on that route.
ALTER TABLE deployment_requests ADD COLUMN reconsidered TEXT;

-- Finding 3, a finding owed to the owner (store/transitions/findings.ts
-- askUndispositioned): a completed review of the finding's candidate
-- reported after the finding exactly when the review run's run.ended seq
-- is greater than the finding's position.
ALTER TABLE runs ADD COLUMN finished_seq INTEGER;
ALTER TABLE findings ADD COLUMN created_seq INTEGER;
