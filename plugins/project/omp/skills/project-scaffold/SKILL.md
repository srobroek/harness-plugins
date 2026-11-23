---
name: project-scaffold
description: Scaffold a project with its language tools after project and governance decisions are approved. Use new-project for OMP project tooling.
---
# Project scaffold

This OMP variant adapts project setup and language guidance to OMP. Keep plugin, skill, and MCP
setup in `new-project` to avoid maintaining host setup in two places.

Instructions, not a script. Interview the user, then set the project up with each language's own
tools. Never copy template trees by hand. Keep what the user already has in an existing
repository unless they ask to change it.

Preferences live in other skills; load them by id instead of restating them here:
`toolchain-guide` (routes to `toolchain-stack-defaults`, `toolchain-languages`,
`toolchain-frontend`, `toolchain-infrastructure`, `toolchain-quality-observability`,
`ci-github-actions`, `ops-toolchain-cache-policy`, `ops-no-global-cargo-target`,
`shell-language`), `architecture-guide`, `quality-code-design`, `license-picker`.
Where neither this skill nor those say what to use, ask the user. Do not invent a pick.

## 1. Interview

Ask in rounds using OMP's `ask` tool. Skip what the argument or repository already answers.
Check the target first: `git rev-parse --is-inside-work-tree` and `git ls-files | head` tell
greenfield from existing; an existing repository follows `references/brownfield.md`.

1. Shape: purpose in one sentence and the project name; app, library, CLI, service, worker or
desktop app; language(s); one package or a monorepo. Offer the closest suggested shape from
`references/shapes.md` (minimal, py-lib, rust-cli, go-service, ts-service, api-service,
gitlab-service, polyglot-service, desktop-rust-ts, monorepo, web-app, fullstack-web) and
customise from there.
2. Governance and forge (`references/governance.md`): CODEOWNERS owner, security contact,
conduct contact (omit the file without one), license, public or private, GitHub or GitLab,
self-hosted hostname, default branch `main`.
3. Capabilities (`references/capabilities.md`), only those that apply: HTTP API contract,
i18n locales, accessibility-scanned routes, infrastructure (AWS CDK).
4. Delivery: CI and hook options and release flow (`references/ci-hooks.md`; none,
release-please, or semantic-release per `trunk-dev-release-setup`), Renovate or Dependabot.
5. Workflow: beads, speckit, journeys, parallel agents with worktrees (`references/worktrees.md`),
secrets needed?
6. Defaults gate: take current pins and defaults (job timeout 15 min, large-file limit 512 KB,
README install `mise install && just setup`, dev command `just dev`) or customise. Ask once; do
not interrogate each value.

Read the plan back (name, shape, languages, layout, tools and pinned versions, capabilities,
files you will create) and wait for approval before writing. Where an answer is unknown and not
essential, leave a visible placeholder (for example `@TODO-owner`) and list it in the final
report instead of inventing a value.

## 2. Create the repository

1. Run `git init -b main` in the new directory. Add a language-appropriate `.gitignore`; extend
the language's generated file rather than replacing it.
2. Pin tools with mise: `mise use <tool>@<version>` writes `mise.toml`. Ask for versions or take
current stable and say which. mise pins runtimes and CLI tools; language files pin the rest
(`rust-toolchain.toml`, `go.mod`, `requires-python`, `package.json` `packageManager`).
3. Add a `justfile` with a `just check` gate and `just fmt` / `just test` recipes. `check` runs
no formatter in write mode. Follow `references/justfile.md`; select the task runner from
`toolchain-stack-defaults`.
4. Run the language setup from `references/<lang>.md`: `rust.md`, `python.md`, `go.md`,
`typescript.md`. For several languages or packages, use `references/monorepo.md`.
5. Commit an explicit formatter config for each language (`references/formatters.omp.md`): Ruff
in `pyproject.toml`, `biome.json` or `.oxfmtrc.json`. Keep one formatter per file type and its
check in the gate.
6. Add the license through `license-picker`; a published project also gets REUSE (`reuse
annotate` headers, `LICENSES/`, `REUSE.toml`, `reuse lint` in the required CI gate). Add a short
`README.md` with purpose, install, usage, and `just check`.
7. Decide project secret handling and load `project-secrets` for fnox configuration. Skip it
when the project has no secrets.

## 3. Docs and agent instructions

Follow `architecture-docs-files`; use `references/layout.omp.md` for the OMP layout. Write the
smallest useful `CONTRIBUTING.md`, `docs/stack.md`, `docs/architecture.md`, `docs/engineering.md`,
and `AGENTS.md`. `AGENTS.md` carries commands and links to docs. Add `docs/operations.md` and
`docs/product.md` only when needed.

- `docs/stack.md`: languages, package manager, frameworks, quality tools, as decided.
- `docs/architecture.md`: system shape and boundaries; top-level layout from
  `architecture-top-level`. A one-paragraph stub is fine early.
- `docs/engineering.md` (always create it): stack with toolchain versions, layout and dependency
direction, standards and approved departures with reasons, how to build, test and lint, release;
commit and branch rules (`trunk-dev-guide`). A later stack change updates it in the same PR.
- `AGENTS.md`: commands to build, test and check; layout pointers into `docs/`; project rules.
Keep it short and link to `docs/` instead of copying. Add instruction files for other harnesses
only when the project uses them.
- `CONTRIBUTING.md` only for a project others contribute to.

For OMP project configuration, local plugins, skills, and MCP servers, follow `new-project`.
Project-local skills install to `.agents/skills/<name>/SKILL.md` through the `agents` provider.

## 4. Tracking and workflow (if chosen)

- Beads: load `beads-setup` (it needs a git `origin` first; use `bd init --skip-hooks` on the
work laptop, see the steering file linked from the global AGENTS.md).
- SpecKit: `speckit-setup` (needs `bd`). Journeys: `journey-init`.
- Release: `trunk-dev-release-setup`; release-please is the GitHub alternative.
- CI on GitHub: `ci-github-actions` (one `ci-gate` job, pinned actions, least permissions) plus
the language's CI notes in its plugin skills.
- Branch protection, the merge queue and CI lanes on GitHub: load `delivery-git-workflow` and
read its `repo-setup-parallel-agents.md` reference.
- Worktrees: `references/worktrees.md` (the `worktrunk` plugin). For Rust, never set a global
`CARGO_TARGET_DIR` (`ops-no-global-cargo-target`); caches follow `ops-toolchain-cache-policy`.
- Hooks, CI jobs, release-please and Renovate defaults to offer: `references/ci-hooks.md`. Wire
hooks into `just check` so CI and local agree.

## 5. Pick plugins

Load `references/plugins.omp.md` for OMP project tooling. Recommend by project languages and
workflow, show the shortlist with one line each, and install only what the user accepts.

## 6. First commit and verify

1. Run the full gate (`just check`, or the language commands) and fix it until green. A tool that
cannot run is "not run", never a pass. Review and rerun if a hygiene hook rewrites files.
2. Validate the project config for each selected harness, discover skills, and confirm plugins
load.
3. Stage specific files, review changes, then commit once: `chore: scaffold <name>` (Conventional
Commits). Do not push or create the remote repository unless asked. When creating a GitHub
repository, set its merge settings (`references/governance.md`, Forge).
4. Report what was created, versions chosen, commands to run, and open decisions.

Checklist: git initialised; tools pinned; gate green; license set; `README.md`, `AGENTS.md`,
`docs/stack.md` and `docs/engineering.md` written and linked; formatter config committed;
`.gitignore` covers build output and `.env`; no secrets committed; tooling as agreed; one commit.
