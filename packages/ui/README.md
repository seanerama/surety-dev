# @surety/ui

Zero-build HTML and JS served from `public/` (O9). The UI is a client of the engine's local API and holds no state; it imports only the engine's published API schema (O8).

Nothing is implemented here. The UI is not part of M1. The accepted MVP design is in [docs/mockup/](../../docs/mockup/). M1 needs only a minimal served test shell for the browser bootstrap test (acceptance row M68), which belongs to the acceptance harness, not to this package.
