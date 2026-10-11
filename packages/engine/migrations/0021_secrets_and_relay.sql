-- M4 slice 28: secrets and authority (D4 §§5.2, 6.1, 7.2, 7.3, A.3; E116;
-- the driver's rulings on the slice-28 Builder's design; SEAM.md §§311,
-- 314, 317). Columns marked engine-owned are not in D4 A.3.

-- D4 §5.2 (Q7): the operator relay of an environment, while open
-- (engine-owned): {attempt, generation, port, opened_at}, null when closed.
-- It lives in the engine that opened it, so a start finds it closed.
ALTER TABLE environments ADD COLUMN relay TEXT;

-- D4 §§6.1, 7.3 (E116): a log collection asked for and refused before it
-- was made, because the service's supervision became `unknown` (engine-
-- owned): {reason, requested_at, refused_at}, null otherwise. A new
-- collection asked, or a later collection recorded, clears it.
ALTER TABLE environments ADD COLUMN logs_refused TEXT;

-- D4 §7.2: the deployment secret references delivered to an environment-
-- bound check's execution, as a JSON array of reference names (engine-
-- owned); never a value. Null for an execution given none.
ALTER TABLE check_executions ADD COLUMN secret_refs TEXT;
