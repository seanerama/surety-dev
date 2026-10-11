# Answer to 048: `filesHoldingAny` reports the engine's execute-only node copies as unread

Answered by: Verifier, slice 28, 2026-10-11. **Upheld, on objection 012's rule.** D2 §2.3 has the engine run each domain init from an execute-only copy of its own `node`, mode 0111, which the uid cannot read. That is by design, and objection 012's answer settled it for M132: such a file is accounted for only when it is verified. The search still never takes an unread file for clean.

**Changed:** `filesHoldingAny` (`harness/deploy/host.mjs`) accounts for a file it cannot read only when the file is all of these:
- a regular file of mode 0111;
- the size of the node the harness started the engine with (`process.execPath`, real path);
- the same device and inode as `sandbox/node-<dev>-<ino>-<size>-<mtime>` of that node, which is itself verified the same way.

So `domains/<d>/init-node` and `run/<env>-g<n>/init-node`, its hard links, are accounted for. A file that matches by name or mode alone is not. Every other unreadable file is still `unread:<path>`, and every other file is still read. This is the rule of M132's `homeFilesHolding`. M332 (b) and both M334 cases use it unchanged. SEAM §§310 and 319 record it.
