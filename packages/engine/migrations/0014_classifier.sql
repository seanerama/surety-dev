-- M3 slice 19, the classifier (D3 §3.3; K8; T10; SEAM.md §218). The column
-- is engine-owned: it is not in D3 A.3.
--
-- A Reviewer's approval carries no decision and no effect intent, so what it
-- was bound to is kept on the proposal: the correction manifest as it stood
-- when the approval was recorded. Immediately before the application begins,
-- and when it is replayed after a restart, the binding is read again; any
-- difference withdraws the approval. Null for a proposal no Reviewer
-- approved, and once an approval is withdrawn.
ALTER TABLE protected_proposals ADD COLUMN approval_binding TEXT;
