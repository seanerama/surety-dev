# Idea brief

One page the owner fills in before a Spec Assistant session (`spec-assistant-prompt.md`), so that phase 1 ("listen") starts from something written and phase 3 ("explore") has fewer gaps to find. Nothing here is binding: the specification that comes out of the session is what gets approved, and it may contradict this brief wherever the conversation went further.

Under the engine (D6 §3.1) this is also the shape of the **idea record**, `.surety/idea.md`: the Vision session fills these sections from the conversation and closes the file with the identity block at the end of this template, which is the one part of it the engine reads; or the owner creates the project with this brief directly (`surety project create <name> --repo <path> --idea idea-brief.md`) and no Vision session runs.

Write in plain sentences. Leave a line blank rather than guessing; "I don't know yet" is an answer the assistant can work with, and a guess is not.

Copy from the line below into a new file (`idea-brief.md` beside the future `.surety/spec/spec.md`, or anywhere) and paste it as your first message when the assistant asks for the idea.

---

# Idea: [working name]

**Date:** [date]
**Owner:** [name]

## The idea in one paragraph

*[What it is and what it does, as you would tell a friend who asked. Three to six sentences.]*

## Who it is for

*[The kinds of people who would use it, and the situation they are in when they reach for it. If you are the only user for now, say so.]*

## The problem, and what people do today

*[What is hard, slow, risky or impossible now. What people do instead: a tool, a manual process, nothing.]*

## What success looks like

*[How you would know in six months that it worked. Prefer things you could observe or count over feelings.]*

## First version

*[The smallest thing you would call a version 1. Three to seven items.]*

-

## Deliberately out

*[Things you can imagine someone asking for that version 1 will not do.]*

-

## What already exists

*[Prior art, competitors, your own earlier attempts, and what to keep or avoid from each.]*

## Constraints

*[Platforms, languages, budget, dates, services that must or must not be used, data that must stay somewhere. One line each.]*

-

## Sensitive areas

*[Tick what the idea touches, from Surety's fixed list. Each raises the checks required whatever the tier.]*

- [ ] authentication
- [ ] authorization
- [ ] payments and financial data
- [ ] personal data
- [ ] secrets and credential handling
- [ ] data migrations and destructive data operations
- [ ] irreversible external actions

## Where it runs

*[Where it would run and be tested: your machine, a server, a cloud account, a phone. What "working there" would mean.]*

## Risk tier, if you have a view

*[T1 prototype, T2 standard, T3 critical, or "not sure". Foundations section 5.7.]*

## Open questions in my own head

*[Anything you keep going back and forth on. The assistant will ask about these first.]*

-

## Identity

*[The one part of this file the engine reads (D6 §3.1, Appendix B.1): a fenced `yaml` block headed `surety-identity`, with these eight keys and no others; an unknown key, a tier outside the three or an area outside the closed list is reported, not guessed at. The Vision session fills it at the end of the conversation from what you agreed; if you create the project with this brief and no session, fill it yourself. A list may be empty. `sensitive_areas` is `none` or a list of identifiers from Surety's closed list, matching the ticks above: `authentication`, `authorization`, `payments_financial_data`, `personal_data`, `secrets_credentials`, `data_migrations_destructive`, `irreversible_external_actions`. `tier_recommendation` is `T1`, `T2`, `T3` or `unsure`. `environments` names the places in "Where it runs".]*

```yaml surety-identity
name: [working name]
one_line: [what it is and for whom, in one sentence]
users: []
non_goals: []
success_measures: []
sensitive_areas: none
tier_recommendation: unsure
environments: []
```
