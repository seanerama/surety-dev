# SDLC-X: the rough idea

**Status:** Reconstructed 2026-09-30. The original idea file was a 0-byte placeholder. This text is rebuilt from the restatement of the rough spec in `sdlc-review-claude.md` §0 and §7, which both reviews were written against. It is a record of the starting point, not a current specification; the agreed foundations supersede it.

---

A new agentic-first SDLC harness, successor to spec-driven-devops and Verity, that:

- is a **product with its own UI** and per-project settings;
- uses **Claude Code and Codex CLI as headless coding back ends**;
- runs **local-git-first** with local testing, and **graduates to GitHub later**, at beta;
- tracks a project through lifecycle states: **idea → spec → developing → alpha deployed → beta deployed (also called "staging deployed" in the original list) → live → live managed**;
- presents screens for **vision, spec, architect, build, alpha / beta / live status, and managed**;
- holds per-project settings for **secrets, model-per-role, autonomy, deployment strategy, and token limits**;
- treats beta as a **scrubbed public repository** produced from the private development repository;
- adds a **mechanic** for the live phase that watches production and feeds issues back to development.

Motivation recorded at the time: SDD was fast but self-graded; Verity added independent testing and lifecycle management but "testing went overboard," GitHub was mandatory, Actions on private repos was too expensive, and role boundaries overlapped. The goal was to keep SDD's speed and Verity's assurance while removing the self-grading, the uniform over-testing, and any dependency on paid CI.

Known issue in the original as noted by the reviews: the state list said "staging deployed" while the definitions said "beta deployed." Resolved in foundations v1.0 §3.3: Beta names the milestone, staging names the environment.
