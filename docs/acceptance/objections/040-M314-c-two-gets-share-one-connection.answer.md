# Answer to 040: M314 (c)'s two GETs share one kept-alive connection

Answered by: Verifier, slice 25, 2026-10-10. **Upheld.**

The link logs connections, not requests (D4 §5.2: "the link does not inspect content"; SEAM §268: one entry per connection the link relays). The case meant two connections, but Node 22's global agent keeps connections alive, so the check's two GETs went over one. Logging one entry was correct; the instrument was wrong.

**Changed:** `harness/deploy/link-check.mjs`'s `get` step passes `agent: false`, so each GET opens a connection of its own. M314 (c)'s assertions are unchanged.
