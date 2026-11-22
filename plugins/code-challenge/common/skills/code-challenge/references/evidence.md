# Evidence rule

Every finding carries one evidence tier. Without a tier and a locator (`path:line`), a finding does not exist.

| Tier | Meaning | Examples |
|---|---|---|
| `proven` | A reader can confirm it from a tool result or a quoted fact, without trusting you | a failing test, the count of callers from LSP references, a registry or OSV record, an analyzer hit confirmed by a reachability search |
| `measured` | A number from a command run on this code | benchmark with noise, install size, call count, build time |
| `hypothesis` | Argued from reading; not confirmed | plausible hot path, a branch you could not exercise, a fit not yet checked against call sites |

Rules:
- MUST Put the command or the source (URL, file and line) in `evidence.detail` or `evidence.command`.
- MUST Mark a performance, speed, size or memory claim `measured` or `hypothesis`; never `proven`.
- NOT Upgrade a tier because several lenses agree. Agreement is not evidence.
- NOT Report an analyzer hit alone as `proven`; analyzers have false positives (dynamic dispatch, macros, generated code, framework conventions).
- An analyzer hit for a rule that the repository does not enable is tagged "rule not enabled in repo" and still needs its own evidence. Respect the repository's suppressions (`# noqa`, `//nolint`, `eslint-disable`, per-file ignores): a suppression with a reason is a decision, not a finding.
- A finding that changes a public signature, wire format, config key or documented behaviour sets `changes_contract: true` and never carries `blast_radius: low`. "Public" is the public surface in [intake-questions.md](intake-questions.md): an export that is not an entry point, a registered surface or documented, and has no importer outside its module tree, is internal; removing it changes no contract.
