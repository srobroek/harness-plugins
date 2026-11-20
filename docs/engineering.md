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

## Standards

[AGENTS.md](../AGENTS.md) Conventions covers bundles, generated files, vendored `plugins/cad` files, agents, skills, pitfalls and descriptions. Checks enforce most of it. This page adds:

- Renovate (`renovate.json`) extends the `srobroek/harness-kit` preset and adds five regex custom managers. Two read exact PyPI and npm pins in Markdown sources: `uv run --with PKG==VER`, `uvx PKG@VER`, `npx [-y] PKG@X.Y.Z` and `npm:PKG@X.Y.Z`. Two read the same pins in `plugins/<name>/common/.mcp.json`. One reads `REPOMIX_VERSION` in `plugins/repomix/opencode/src/pack.ts`. The Markdown managers select source files only: `docs/` and `lib/`, plugin READMEs, `common/` and `agents.src/`, and `opencode/src/` Markdown. Copies that `harness-kit build` writes are not selected. A package rule disables these managers for the vendored `plugins/cad/common` and `plugins/cad/opencode`. Version pins in skills and docs use the shapes these managers match.
- The preset also moves `@srobroek/harness-kit` (package pin), the `srobroek/harness-kit` workflow tags and the versions quoted in any Markdown file (`srobroek/harness-kit/.github/workflows/<file>.yml@vX.Y.Z`, `@srobroek/harness-kit@X.Y.Z`) in one `harness-kit` group. Renovate does not run `harness-kit build`, so a Renovate PR that changes a source needs `npm run build` on its branch to regenerate the copies; `npm run check` fails until then.
- Approved departures: none recorded. Record each departure here with its reason.

## Commands

AGENTS.md Commands lists every script. `npm run check` is `harness-kit check`: `build --check` for the generated files, then validation of each Claude Code tree. It does not run typecheck, lint, tests or the content checks. The `cad:*` scripts need network.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

- `check` calls the reusable harness-kit workflow, pinned to the same tag as the package. It runs `npm ci`, `harness-kit check`, `bun test` and `tsc`.
- `repo-checks` runs `npm ci`, then lint, `build:check`, `plugin-table:check`, `steering`, `pitfalls`, `agent-roles`, `descriptions`, `concerns`, `scripts/check-release-prepare.ts` (in a temporary checkout, makes the delivery and cad bundles stale, runs each release prepare step and fails if a bundle is still stale), `scripts/check-test-executables.ts` and the Python unit tests of the shipped scripts.
- `cad` runs `cad:check` when `plugins/cad`, `scripts/sync-cad.ts` or the workflow changes.

`.github/workflows/release.yml` runs on pushes to `main`. It calls the harness-kit release workflow, which runs multi-semantic-release (`release.config.mjs`, `.multi-releaserc`) and tags each plugin `<name>--v<version>`. The `prepareCmd` from `scripts/release-preset.mjs` (used by `release.config.mjs` and `plugins/cad/release.config.mjs`) runs `scripts/build.ts <name>` after `harness-kit stamp`, because a bundle can embed its plugin's `package.json` (delivery's receipts carry the version) and the release commit must carry the rebuilt `opencode/dist`. A `feat` or `fix` commit, and with the repository rules a `refactor` or `docs` commit, under `plugins/<name>/` cuts a release. A new plugin needs no manifest entry: any directory under `plugins/` is a workspace package.
