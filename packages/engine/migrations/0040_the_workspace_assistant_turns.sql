-- The workspace assistant's turns (the assistant design §§1.3, 4): one row per
-- admitted turn, keyed by its invocation (the receipt the admission wrote in
-- the same transaction), binding it to the owner's conversation and message
-- intent. A turn is never replayed: an intent names at most one turn, and a
-- turn the engine did not see end (a restart) is ended `recovered`, its
-- owner message left unknown.
--
--   status       admitted (receipt and domain written, nothing launched yet),
--                running (dispatched by the scheduler's tick), ended;
--   outcome      the turn's end once ended (§4's failure classes);
--   reason       the engine's code for that end (assistant_turn_limit,
--                assistant_timed_out, assistant_cancelled, invalid_result,
--                backend_refused, ...), and reason_text its words;
--   cancel_requested_at  the owner's cancel, recorded before the engine
--                cancels;
--   reply        the validated, redacted reply ({text, cited_evidence,
--                links}) of a completed turn; null otherwise.
CREATE TABLE assistant_turns (
  invocation TEXT PRIMARY KEY REFERENCES invocation_receipts(id),
  created_at TEXT NOT NULL,
  conversation TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'ended')),
  outcome TEXT CHECK (outcome IN ('completed', 'failed', 'refused', 'stopped', 'timed_out', 'recovered')),
  reason TEXT,
  reason_text TEXT,
  cancel_requested_at TEXT,
  reply TEXT,
  ended_at TEXT,
  CHECK ((status = 'ended') = (outcome IS NOT NULL)),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  UNIQUE (conversation, intent_id)
);

CREATE TRIGGER assistant_turns_no_delete BEFORE DELETE ON assistant_turns
BEGIN SELECT RAISE(ABORT, 'assistant_turns: a turn is ended, never deleted'); END;
CREATE TRIGGER assistant_turns_ended_final BEFORE UPDATE ON assistant_turns
WHEN OLD.status = 'ended'
BEGIN SELECT RAISE(ABORT, 'assistant_turns: an ended turn does not change'); END;
CREATE TRIGGER assistant_turns_of_the_assistant BEFORE INSERT ON assistant_turns
BEGIN
  SELECT RAISE(ABORT, 'assistant_turns: a turn is a workspace assistant invocation''s')
  WHERE COALESCE((SELECT account FROM invocation_receipts WHERE id = NEW.invocation), '') <> 'workspace_assistant';
END;
