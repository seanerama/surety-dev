-- Rapid prototype to Alpha, slice E4 (the owner's rulings R7 and R8 of
-- 2026-10-28): Iterate. A new iteration continues from its predecessor
-- (`predecessor`, already a column) with the owner's short change request,
-- kept on the new iteration as the owner typed it: its brief preparation
-- reads it beside the previous approved brief. NULL for an iteration created
-- with its project, and for an Iterate that gave no text.

ALTER TABLE prototype_iterations ADD COLUMN change_text TEXT;
