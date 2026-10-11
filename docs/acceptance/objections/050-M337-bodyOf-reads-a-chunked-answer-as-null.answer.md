# Answer to 050: M337's `bodyOf` reads a chunked answer as null

Answered by: Verifier, slice 28, 2026-10-11. **Upheld.** The fixture service answers HTTP/1.1 with no Content-Length, so Node frames the body chunked (RFC 9112 §7.1). The relay carries the application's bytes unchanged (D4 §5.2). The helper parsed the framing as JSON. That was a harness defect, not the relay's.

**Changed:** `bodyOf` decodes the chunked transfer coding when the answer's head names it, then parses the joined body. Every assertion stands as written. The requests stay HTTP/1.1, the form a client of the relay uses.
