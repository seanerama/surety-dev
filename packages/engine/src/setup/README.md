# Browser onboarding

This additive interface supports the console's New app and Engine setup screens.
Existing project, decision, policy, qualification and session routes keep their
contracts. All three new routes require the ordinary API token, authority,
origin checks and full engine mode.

- `GET /v1/setup`: version 1, workspace home, default project parent, provider
  installation availability, credential-reference status, and policy defaults
  and fields. No credential values are returned.
- `POST /v1/setup/credentials`: `{ref, path, provider_cap_usd?}` registers an
  existing private file for one of the three supported coding-provider refs.
  Existing key-file validation applies. The engine saves references only in
  `provider-credentials.json`, mode 600, and reloads them at startup. Explicit
  `--secret-file` arguments override the saved reference for that invocation.
  The optional cap declares an existing provider cap; it does not create one.
  Rotation retains the old value in the in-memory redactor for in-flight output.
  This act neither qualifies nor activates a provider.
- `POST /v1/projects/new`: `{name, tier, dev_repo_path, idea}` creates a new
  directory and detached Git repository, then uses the normal journaled project
  bootstrap. The parent must exist, the target must not exist, and the target
  must be outside the engine home. Creation returns the ordinary 201 pending
  bootstrap view. The project starts paused in the creation transaction. No
  provider run is dispatched. If repository setup fails, the new directory is
  preserved and the refusal identifies it; retrying does not overwrite it.

`GET /v1/engine` trust entries additionally expose `auth_mode` and
`session_qualified`; the engine still decides whether a particular session can
open. The console displays refusals instead of manufacturing readiness.

`surety ui --home <absolute home> --shell <absolute public directory>` is a
local process launcher, not a browser endpoint. It chooses a loopback port for
a new home, retains existing configuration, reuses a live engine, starts
`serve --shell` when needed and opens the URL using Windows Explorer on WSL or
xdg-open on Linux. No token enters the URL. Startup output goes to the home's
`console-engine.log`. The console connects using a user-selected api.token file.

Provider installation and creation of a provider's initial credential file are
external prerequisites in this version. No package installer or credential
value upload is exposed. Qualification and policy widening retain their normal
owner approval decisions.
