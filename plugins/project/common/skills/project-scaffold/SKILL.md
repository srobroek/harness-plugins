---
name: project-scaffold
description: "Scaffold a project with its language tools after approval. Use new-project for OMP project tooling."
---

# Project scaffold

Instructions, not a script. Interview the user, then set the project up with each
language's own tools. Never copy template trees by hand. Keep what the user already
has in an existing repository unless they ask to change it.

For harness configuration, installed plugins or packages, project-local skills, MCP servers, and reloading, use the `new-project` skill and its active-harness guidance. Do not duplicate host setup here.

Preferences live in other skills; load them by id instead of restating them here:
`toolchain-guide` (routes to `toolchain-stack-defaults`, `toolchain-languages`,
`toolchain-frontend`, `toolchain-infrastructure`, `toolchain-quality-observability`,
`ci-github-actions`, `ops-toolchain-cache-policy`, `ops-no-global-cargo-target`,
`shell-language`), `architecture-guide`, `quality-code-design`, `license-picker`.
Where neither this skill nor those say what to use, ask the user. Do not invent a pick.

## 1. Interview

Ask in rounds through the host's user-interaction tool when available; otherwise ask in the conversation. Skip what the argument or repository already answers. Check the target first: `git rev-parse --is-inside-work-tree` and `git ls-files | head` tell greenfield from existing; an existing repository follows `references/brownfield.md`.

1. Shape: purpose in one sentence and the project name; app, library, CLI, service, worker
   or desktop app; language(s); one package or a monorepo. Offer the closest suggested
   shape from `references/shapes.md` (minimal, py-lib, rust-cli, go-service, ts-service,
   api-service, gitlab-service, polyglot-service, desktop-rust-ts, monorepo, web-app,
   fullstack-web) and customise from there.
2. Governance and forge (`references/governance.md`): CODEOWNERS owner, security contact,
   conduct contact (omit the file without one), license, public or private, GitHub or
   GitLab, self-hosted hostname, default branch `main`.
3. Capabilities (`references/capabilities.md`), only those that apply: HTTP API contract,
   i18n locales, accessibility-scanned routes, infrastructure (AWS CDK).
4. Delivery: CI and hook options and release flow (`references/ci-hooks.md`; none,
   release-please, or semantic-release per `trunk-dev-release-setup`), Renovate or Dependabot.
5. Workflow: beads, speckit, journeys, parallel agents with worktrees
   (`references/worktrees.md`), secrets needed?
6. Defaults gate: take current pins and defaults (job timeout 15 min, large-file limit
   512 KB, README install `mise install && just setup`, dev command `just dev`) or customise.
   Ask once; do not interrogate each value.

Read the plan back (name, shape, languages, layout, tools and pinned versions, capabilities,
files you will create) and wait for approval before writing anything. Where an answer is
unknown and not essential, leave a visible placeholder (for example `@TODO-owner`) and list it
in the final report instead of inventing a value.

## 2. Create the repository

1. Directory and `git init -b main`. Add a `.gitignore` for the languages (the
   language's own init usually writes one; extend it, do not replace it).
2. Pin tools with mise: `mise use <tool>@<version>` writes `mise.toml`. Ask the user
   for versions or take current stable and say which. mise pins runtimes and CLI
   tools; the language's own file pins the rest (`rust-toolchain.toml`, `go.mod`,
   `requires-python`, `package.json` `packageManager`).
3. Add a `justfile` with the quality gate as one `just check` recipe (the commands
   from the language reference) and `just fmt` / `just test`. `check` runs no formatter in
   write mode; the hygiene hooks may rewrite files, so rerun it (`references/justfile.md`). Task runner choice is
   `toolchain-stack-defaults`; a larger monorepo may want `moon` (ask).
4. Run the language setup from `references/<lang>.md`: `rust.md`, `python.md`,
   `go.md`, `typescript.md`. Several languages or packages: `references/monorepo.md`.
5. Formatter config: commit an explicit formatter config for each language (`formatters.md`; the OMP guidance is `formatters.omp.md`). Prefer the language's native config, such as Ruff in `pyproject.toml`, `biome.json` or `.oxfmtrc.json`, and use one formatter per file type.
6. Add the license through `license-picker`; a published project also gets REUSE
   (`license-picker`'s REUSE reference: `reuse annotate` headers, `LICENSES/`,
   `REUSE.toml`, `reuse lint` in the required CI gate). Then a short `README.md` (what,
   install, usage, how to run `just check`).
7. Secrets: decide project secrets handling and load the `project-secrets` skill
   (fnox.toml with 1Password vault refs, local sync cache, GitHub Actions push
   targets, AWS leases). Skip it when the project has no secrets.

Tree and file contents: `references/layout.md` (`layout.omp.md` for OMP). Follow
`architecture-docs-files`: write the smallest useful `CONTRIBUTING.md`, `docs/stack.md`,
`docs/architecture.md`, `docs/engineering.md`, and `AGENTS.md` for the project.
`AGENTS.md` carries commands and links to the docs. Add `docs/operations.md` and
`docs/product.md` only when needed.
1. `docs/stack.md`: languages, package manager, frameworks, quality tools, as decided.
2. `docs/architecture.md`: system shape and boundaries; top-level layout from
   `architecture-top-level`. A one-paragraph stub is fine early.
3. `docs/engineering.md` (always create it): stack with toolchain versions, layout and
   dependency direction, standards and approved departures with reasons, how to build, test
   and lint, release; commit and branch rules (`trunk-dev-guide`). A later stack change
   updates it in the same PR.
4. `AGENTS.md`: commands to build, test and check; layout pointers into `docs/`; project
   rules. Keep it short and link to `docs/` instead of copying. Other harness instruction
   files may be needed for other coding agents; choose only those the project uses.
5. `CONTRIBUTING.md` only for a project others contribute to.

## 4. Harness project tooling

Follow `new-project` for harness configuration, project-local plugins or packages, skills, and MCP servers. Add project skills only in the active harness's documented project-local skills directory.

## 5. Tracking and workflow (if chosen)

- Beads: load `beads-setup` (it needs a git `origin` first; use `bd init --skip-hooks`
  on the work laptop, see the steering file linked from the global AGENTS.md).
- SpecKit: `speckit-setup` (needs `bd`). Journeys: `journey-init`.
- Release: `trunk-dev-release-setup`; release-please is the GitHub alternative.
- CI on GitHub: `ci-github-actions` (one `ci-gate` job, pinned actions, least
  permissions) plus the language's CI notes in its plugin skills.
- Branch protection, the merge queue and the CI lanes on GitHub: load `delivery-git-workflow`
  and read its `repo-setup-parallel-agents.md` reference.
- Worktrees: `references/worktrees.md` (the `worktrunk` plugin). For Rust, never set a global
  `CARGO_TARGET_DIR` (`ops-no-global-cargo-target`); caches follow `ops-toolchain-cache-policy`.
- Hooks, CI jobs, release-please and Renovate defaults to offer: `references/ci-hooks.md`.
  Wire hooks into `just check` so CI and local agree.

## 6. Pick plugins

Load `references/plugins.md`: it explains OpenCode plugin setup. For other harnesses, use their package documentation and follow `new-project` for configuration, skills, and MCP servers. Recommend by the project's languages and workflow, show the shortlist with one line each, install only what the user accepts.

## 7. First commit and verify

1. Run the full gate (`just check`, or the language commands) and fix it until green.
   A tool that cannot run is "not run", never a pass. The hygiene fixer hooks may rewrite
   files and fail the first run; review the diff and rerun until it passes.
2. Start project checks for the selected harnesses: validate their config, discover the new
   skills, and confirm plugins load.
3. Stage specific files, review the changes, then commit once:
   `chore: scaffold <name>` (Conventional Commits). Do not push or create the remote
   repository unless the user asked; offer it. When you create a GitHub repository, set its
   merge settings (`references/governance.md`, Forge).
4. Report: what was created, versions chosen, commands to run, open decisions.

Checklist before reporting: git initialised; tools pinned; gate green; license set;
`README.md`, `AGENTS.md`, `docs/stack.md`, `docs/engineering.md` written and linked from
`AGENTS.md`; formatter config committed; `.gitignore` covers build output and `.env`; no
secrets committed; plugins and harness configuration as agreed; one commit.
