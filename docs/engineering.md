# Engineering

This page records the stack, layout and standards for `srobroek/harness-plugins`. [AGENTS.md](../AGENTS.md) holds the agent rules and the command list. This page links to it instead of repeating it.

## Stack

The repository is a workspace of OpenCode V2 plugins written in TypeScript, and most plugins also ship a Claude Code tree. A server entry (`opencode/src/index.ts`) default-exports `Plugin.define({ id, setup })` from `@opencode/plugin`. A TUI entry (`opencode/src/tui.tsx`) uses the TUI API and has its own shape; `statusline` has only that entry. No plugin uses the V1 API (`@opencode-ai/plugin`).

| Tool | Version | Source |
| --- | --- | --- |
| bun | 1.4.4 | `.mise.toml`, `bun-version` in `.github/workflows/ci.yml` |
| TypeScript | 7.0.2 | `package.json` |
| Biome | 2.6.8 | `package.json`; linter only, the formatter is off (`biome.json`) |
| `@opencode/plugin`, `client`, `theme` | 2.3.2 | `package.json` |
| `@opentui/core`, `@opentui/solid` | 0.9.3 | `package.json` |
| `solid-js` | 1.9.19 | `package.json` |
| `effect` | 4.1.4 | `package.json` |
| `smol-toml` | 1.9.1 | `lib/package.json`; `lib` and `safety` read TOML with it |
| `jsonc-parser` | 3.3.1 | `package.json`; `model-roles` edits JSONC config files with it |
| `spdx-expression-parse` | 5.0.0 | `package.json`; `code-challenge` parses SPDX licence expressions with it (types: `@types/spdx-expression-parse` 4.0.0) |
| `@srobroek/harness-kit` | 1.4.0 | `package.json`, workflow tags in `.github/workflows` |

`smol-toml` is a runtime `dependency` of `lib`, so it ships in the bundles that import it.

The build leaves these modules external (`HOST_MODULES` in `scripts/build.ts`): `@opencode/plugin`, `effect`, `@opentui/*` and `solid-js`, with their subpaths. OpenCode supplies them at runtime. `@opencode/client` and `@opencode/theme` are not on that list. AGENTS.md has the pinning rule for the `@opentui/*` and `solid-js` host modules.

The TypeScript config extends the harness-kit base, which is strict and adds `noUncheckedIndexedAccess` and `moduleResolution: bundler`. The repository config adds `verbatimModuleSyntax`. Tests run under `bun test` with the preload `scripts/test-preload.ts` (see `bunfig.toml`).

## Layout

```
plugins/<name>/     one plugin per directory, a workspace package
lib/                @srobroek/opencode-lib, shared helpers, internal
shared/             agent bodies that several plugins ship
scripts/            build, generators and repository checks
tests/              tests that span plugins
docs/               design notes, decisions and this file
examples/           example projects included in typecheck
```

A plugin has `package.json`, `agents.src/` or `common/` (skills, agents, formulas), and one directory per harness: `opencode/` with `src/`, a committed `dist/` and one shim per entry declared in `agent-plugins.entries` (`index.js` for a server entry, `tui.js` for a TUI entry), and `claude/` where the plugin ships to Claude Code. AGENTS.md Generated files says which of these are sources.

## Dependency direction

Intended rules:

- Plugins import `lib` as `@srobroek/opencode-lib/<module>`. The build inlines `lib` into each plugin's bundle, because OpenCode installs a plugin from its own directory. So `lib` exists at build time only.
- Runtime `dependencies` of a bundle sit in the root `package.json` or in `lib/package.json`, because workspace packages do not exist at runtime.
- `lib` imports no plugin.
- `scripts/` and `tests/` may import from `lib/src` and from any plugin.
- Shared code goes into `lib`.

Current exceptions, found by searching relative imports under `plugins/*/opencode/src`: none in plugin source. Two edges run from scripts and tests into plugins:

- `scripts/agent-profiles.test.ts` imports `plugins/agent-efficiency/opencode/src/lean.ts`.
- `tests/agent-fallbacks.test.ts` and `tests/formulas.test.ts` import plugin source, for example `plugins/beads/opencode/src/subagent-routing.ts`. A test that spans plugins belongs in `tests/`.

Move new shared code into `lib` instead of adding another edge.

`lib/src/session-lanes.ts` holds the lane session helpers (`laneSessions`, `moveSessionsHome`, `isSessionNotFound`) that `subagent-worktree` uses.

`plugins/autopilot` owns two kinds of state. Run state (`state.<N>.json` generations, `journal.jsonl`, `summary.md`) lives under `<git common dir>/opencode-scratch/autopilot/<run-id>/`. The armed-session index lives in plugin storage (`armed/<sessionID>`). On load, the plugin re-arms from storage. `/autopilot resume` re-binds a run to a new session from its latest state generation. Its tick is an OpenCode automation (a code action created through `tools.opencode.automation_create` that calls `autopilot_status`). An in-process timer covers hosts where that call fails. A run owns one beads ledger, resolved at arm (`resolveLedger` in `plugins/autopilot/opencode/src/ledger.ts`): the `ledger` setup field if given (a `.beads` directory or the checkout holding one), else the ledger a bead scope's id prefix routes to in the session ledger's `routes.jsonl` (path relative to the checkout holding that ledger), else the session directory's ledger (`sessionPinFor`, which ignores an inherited `BEADS_DIR`). A path or route that is no ledger refuses the arm. The ledger is stored in the run state (`ledger`, optional so earlier state files still decode; such a run falls back to the session directory's ledger) and every plugin `bd` call gets it as `BEADS_DIR` in the spawned process's environment, as does the write lock. A write that names a bead whose prefix routes to another ledger is refused. Its own `bd` writes take the embedded-store lock from `lib/src/bd-embedded-write-lock.ts`. Every run state transition holds the lease lock from `lib/src/lease-lock.ts` at `<run-id>/run.lock`, for liveness only. Lease releases check the owner token. State files are versioned and created exclusively: a write of generation N+1 writes its own temporary file and `link`s it to `state.<N+1>.json`, which fails with `EEXIST` when that generation exists. The losing writer journals an issue and the call returns `stale`; nothing is ever overwritten, and there is no write lock or age-based clearing. Readers take the highest generation and validate it with `effect/Schema` (the host's `effect`); a corrupt latest generation is a blocker, never skipped. After a successful link the writer prunes all but the latest five generations. `state.json` is a symlink to the latest generation for people reading the directory; the plugin never reads it. A stop passes through a `stopping` phase until `summary.md` and the handoff bead both exist. Ticks carry a binding token, so a resumed run's old automation goes stale. While a run is armed, its permission hook denies every `ask` and journals it as a blocker, with two exceptions that turn an `ask` into an allow and touch no other effect. An `external_directory` ask for exactly `<root>/*` is allowed when `<root>` is a writer lane's linked, non-primary worktree that `ctx.worktree.list` shows for the project, recorded at a tick with its real path, device and inode (the `worktrees` field of the run state), still a plain directory (`lstat`, not a symlink) with the same device, inode and real path, and free of `*` and `?`; both sides are compared by `realpath`. An `autopilot_merge` ask for `<pr>@<sha>` is allowed under `--allow merge`; the tool then requires a GitHub review `APPROVED` on that head by someone other than the PR author (comments never count), all check runs and statuses green plus every required context (unreadable branch protection or rulesets refuse, and so does a merge-queue ruleset), and a `method` the repository allows. It re-reads the PR's base and head just before merging and refuses on drift, then merges with `gh api -X PUT .../pulls/{n}/merge -f sha=... -f merge_method=...` as an argument array (never `gh pr merge`, so no auto-merge and no `--admin`). Success needs `merged: true` and a `sha`; any non-2xx response is a refusal journaled with its status and message. A final re-read must show a `MERGED` PR at the reviewed head with a merge commit. The decisions are pure functions in `plugins/autopilot/opencode/src/policy.ts`. The approval and check judgments are in `lib/src/pr-approval.ts`, which `delivery` also uses; `delivery` keeps its comment-verdict support behind that module's `commentVerdict` option, and autopilot runs the strict mode (review-only approval, `requireKnown` required contexts, `requireBoth` protection and rulesets).

## Standards

[AGENTS.md](../AGENTS.md) Conventions covers bundles, generated files, vendored `plugins/cad` files, agents, skills, pitfalls and descriptions. Checks enforce most of it. This page adds:

- Renovate (`renovate.json`) extends the `srobroek/harness-kit` preset and adds five regex custom managers. Two read exact PyPI and npm pins in Markdown sources: `uv run --with PKG==VER`, `uvx PKG@VER`, `npx [-y] PKG@X.Y.Z` and `npm:PKG@X.Y.Z`. Two read the same pins in `plugins/<name>/common/.mcp.json`. One reads `REPOMIX_VERSION` in `plugins/repomix/opencode/src/pack.ts`. The Markdown managers select source files only: `docs/` and `lib/`, plugin READMEs, `common/` and `agents.src/`, and `opencode/src/` Markdown. Copies that `harness-kit build` writes are not selected. A package rule disables these managers for the vendored `plugins/cad/common` and `plugins/cad/opencode`. Version pins in skills and docs use the shapes these managers match.
- The preset also moves `@srobroek/harness-kit` (package pin), the `srobroek/harness-kit` workflow tags and the versions quoted in any Markdown file (`srobroek/harness-kit/.github/workflows/<file>.yml@vX.Y.Z`, `@srobroek/harness-kit@X.Y.Z`) in one `harness-kit` group. Renovate does not run `harness-kit build`, so a Renovate PR that changes a source needs `npm run build` on its branch to regenerate the copies; `npm run check` fails until then.
- Approved departures:
  - `code-challenge` names its tool `challenge_setup`, not `code_challenge_setup` as `<name>_<verb>` would give. The skill's other two tools, `challenge_lib_facts` and `challenge_scan`, share the same `challenge_` namespace, so one short prefix (reserved in `RESERVED_TOOL_PREFIXES`) covers the family and the agents' permission rules.

## code-challenge

`plugins/code-challenge` is OpenCode only (`harnesses: ["opencode"]`). It challenges existing code for simplification, performance, stability, hand-rolled code and structure, and plans only: it edits no source file.

- Ownership: the plugin owns the `code-challenge` skill (twelve lens references, the report and decisions JSON Schemas, intake, scoring and run-storage rules), the `/code-challenge` command, the `challenge_setup` and `challenge_lib_facts` tools, nine beads formulas and the `code-challenger` and `refactor-challenger` agents. `challenge_scan` is planned in a later pull request.
- Run storage: every run writes under `<git-dir>/code-challenge/<run-id>/`, outside the working tree (`intake.json`, `scan.json`, `findings.json`, `research.json`, `verdicts.json`, `decisions.jsonl`, `report.json`, `report.md`). `decisions.jsonl` is append-only. The directory is never committed.
- Formulas: `challenge_setup` copies `code-challenge` (the full run), `mol-challenge-<phase>` for the seven phases and `mol-challenge-lens` into `.beads/formulas/`. The lead agent sequences the phases, dispatches subagents and writes every file, bead and log line. Only `mol-challenge-lens/analyse-lens` (to `code-challenger`) and `mol-challenge-refute/attack-findings` (to `refactor-challenger`) route to a subagent. Both agents are read-only; each routed step lists `requires_actions` and a test checks the agent's permissions allow them.
- `challenge_setup` resolves the target workspace from the invoking session's directory and fails when it cannot read that session.

### code-challenge `challenge_lib_facts`

`plugins/code-challenge/opencode/src/lib-facts/` registers the `challenge_lib_facts` tool (`registerLibFacts(ctx)`). It returns facts about 1 to 6 packages (npm, PyPI, crates.io, Go) and no verdicts, and uses `fetch` with no HTTP library.

- External sources, all HTTPS: `api.deps.dev` (v3, and v3alpha for dependents), `registry.npmjs.org`, `api.npmjs.org`, `pypi.org`, `pypistats.org`, `crates.io`, `proxy.golang.org`, `api.osv.dev` (`querybatch`) and `api.github.com`. Each source can fail alone; the failure is listed in the package's `missing`.
- OSV is never cached. An OSV reply with a wrong result count, a continuation token or a malformed vulnerability list is a failure, so the CVE gate reads `null` instead of passing.
- GitHub token boundary: the tool runs `gh auth token` itself (5 s timeout) and sends the token only as the `Authorization` header of requests to `api.github.com`. It is never logged, returned or cached. Redirects are followed by hand and only within the original host. Repository URLs come from publisher metadata, so only recognised github.com forms are used, `owner` and `repo` must match GitHub's charset, and each part is `encodeURIComponent`-ed into the path.
- Input limits: package names are checked per ecosystem (no `?`, `#`, `..`, control characters or backslashes; at most 214 characters) and versions must be plain version strings.
- Cache: one JSON file per request under `$XDG_CACHE_HOME/opencode/code-challenge/lib-facts` (`~/.cache/...` by default), 7-day TTL. GitHub replies are reduced to the public figures the tool reports before they are stored, and a cached value of any other shape is a miss. File names carry a schema version (`v2-`); files of any other version are never read and the sweep deletes them. A file over 256 KiB (measured in UTF-8 bytes) is neither written nor read, and an entry that fails its shape check is deleted. An expired entry is deleted on read, and the first write of each call sweeps expired files and trims the directory to 2000 entries.
- Request limits: 6 requests in flight, a 10 s timeout each, 5 MiB per reply (checked while streaming, before `JSON.parse`) and 3 same-host redirects.
- Licence gate: `ALLOWED_LICENCES` in `licence.ts` lists permissive and weak-copyleft SPDX ids. `spdx-expression-parse` evaluates expressions with grouping, `AND` and `OR`; it is a small, widely used parser (the one `npm` tooling uses) and replaces a hand-written grammar that mishandled parentheses. It is inlined into the bundle like `jsonc-parser`.

## Commands

AGENTS.md Commands lists every script. `npm run check` is `harness-kit check`: `build --check` for the generated files, then validation of each Claude Code tree. It does not run typecheck, lint, tests or the content checks. The `cad:*` scripts need network.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

- `check` calls the reusable harness-kit workflow, pinned to the same tag as the package. It runs `npm ci`, `harness-kit check`, `bun test` and `tsc`.
- `repo-checks` runs `npm ci`, then lint, `build:check`, `plugin-table:check`, `steering`, `pitfalls`, `agent-roles`, `descriptions`, `concerns`, `scripts/check-release-prepare.ts` (in a temporary checkout, makes the delivery and cad bundles stale, runs each release prepare step and fails if a bundle is still stale), `scripts/check-test-executables.ts` and the Python unit tests of the shipped scripts.
- `cad` runs `cad:check` when `plugins/cad`, `scripts/sync-cad.ts` or the workflow changes.

`.github/workflows/release.yml` runs on pushes to `main`. It calls the harness-kit release workflow, which runs multi-semantic-release (`release.config.mjs`, `.multi-releaserc`) and tags each plugin `<name>--v<version>`. The `prepareCmd` from `scripts/release-preset.mjs` (used by `release.config.mjs` and `plugins/cad/release.config.mjs`) runs `scripts/build.ts <name>` after `harness-kit stamp`, because a bundle can embed its plugin's `package.json` (delivery's receipts carry the version) and the release commit must carry the rebuilt `opencode/dist`. A `feat` or `fix` commit, and with the repository rules a `refactor` or `docs` commit, under `plugins/<name>/` cuts a release. A new plugin needs no manifest entry: any directory under `plugins/` is a workspace package.
