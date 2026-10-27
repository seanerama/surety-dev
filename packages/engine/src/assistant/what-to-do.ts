// What the owner is told to do after each end of a workspace assistant turn
// the engine decides (the assistant design §4's table). Engine text only.
export const ASSISTANT_WHAT_TO_DO: Readonly<Record<string, string>> = {
  assistant_turn_limit: 'The turn passed its turn_limit_billable_tokens and was stopped; its partial answer was discarded. Ask a narrower question in a new message.',
  assistant_usage_unknown: "The backend's usage could not be judged against the turn limit, so the turn was stopped; ask again in a new message.",
  assistant_timed_out: 'The turn passed its turn_deadline_seconds and was stopped. Ask again in a new message; nothing is retried automatically.',
  assistant_cancelled: 'You cancelled the turn. Nothing of it was kept but its usage.',
  invalid_result: "The backend's reply was not one the engine may take (its schema, its evidence or its model); nothing of it was kept. Ask again in a new message.",
  assistant_auth_failed: 'The provider refused the credential. Check the credential in Engine setup; the assistant state is recomputed on its next read.',
  assistant_provider_error: 'The provider failed this turn (an error, a rate limit or an overload). Nothing is retried automatically; send a new message to try again.',
  backend_refused: "The engine refused to start the assistant's backend; see the reason. Nothing was spent.",
  isolation_unqualified: 'This host cannot hold the assistant in its sandbox now; real backends are refused until the host checks pass.',
  assistant_termination_unknown: "The engine could not establish that the turn's domain ended; it is quarantined and nothing it left was read.",
  recovered: 'The engine restarted while the turn ran; it is never replayed. Inspect the workspace and ask again in a new message.',
  infra_error: 'The engine could not complete the turn; nothing of its answer was kept.',
};
