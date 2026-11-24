---
name: project-scaffold
description: Scaffold a project with its language tools after project and governance decisions are approved.
---
# Project scaffold

Instructions, not a script. Interview the user, then set the project up with each language's own tools. Never copy template trees by hand. Keep what the user already has in an existing repository unless they ask to change it.

For Pi configuration, installed packages, project-local skills, prompt templates, MCP servers, and reloading, load the `new-project` skill. Do not duplicate its harness setup here.

Preferences live in other skills; load them by id instead of restating them here: `toolchain-guide` (routes to `toolchain-stack-defaults`, `toolchain-languages`, `toolchain-frontend`, `toolchain-infrastructure`, `toolchain-quality-observability`, `ci-github-actions`, `ops-toolchain-cache-policy`, `ops-no-global-cargo-target`, `shell-language`), `architecture-guide`, `quality-code-design`, `license-picker`. Where neither this skill nor those say what to use, ask the user. Do not invent a pick.

## 1. Interview

Ask in rounds through Pi's built-in `question` tool. Skip what the argument or repository already answers. Check the target first: `git rev-parse --is-inside-work-tree` and `git ls-files | head` tell greenfield from existing; an existing repository follows `references/brownfield.md`.

1. Shape: purpose in one sentence and the project name; app, library, CLI, service, worker or desktop app; language(s); one package or a monorepo. Offer the closest suggested shape from `references/shapes.md` (minimal, py-lib, rust-cli, go-service, ts-service, api-service, gitlab-service, polyglot-service, desktop-rust-ts, monorepo, web-app, fullstack-web) and customise from there.
2. Governance and forge (`references/governance.md`): CODEOWNERS owner, security contact, conduct contact (omit the file without one), license, public or private, GitHub or GitLab, self-hosted hostname, default branch `main`.
3. Capabilities (`references/capabilities.md`), only those that apply: HTTP API contract, i18n,
   accessibility, and infrastructure (AWS CDK only for AWS projects).
4. Delivery: CI and hook options and release flow (`references/ci-hooks.md`); ask which forge
   and release tooling apply (for example GitHub Actions or GitLab CI), then offer Renovate or
   Dependabot.
5. Workflow: ask whether the project needs Beads, SpecKit, journeys, or parallel agents with
   worktrees (`references/worktrees.md`); ask whether secrets are needed.
6. Defaults gate: offer documented defaults when they fit; otherwise match existing tooling or
   ask. Ask once; do not interrogate each value.

Read the plan back (name, shape, languages, layout, tools and pinned versions, capabilities, files you will create) and wait for approval before writing anything. Where an answer is unknown and not essential, leave a visible placeholder (for example `@TODO-owner`) and list it in the final report instead of inventing a value.

## 2. Create the repository

1. Create the repository and `.gitignore` with the language's documented tools; extend generated
   files rather than replacing them.
2. Preserve an existing toolchain manager. For a new project, offer mise, npm, Homebrew and pipx
   as applicable, then use the manager the user selects. Pin runtimes in their language files.
3. Add a `justfile` with the quality gate as one `just check` recipe (the commands from the language reference) and `just fmt` / `just test`. `check` runs no formatter in write mode; the hygiene hooks may rewrite files, so rerun it (`references/justfile.md`). Task runner choice is `toolchain-stack-defaults`; a larger monorepo may want `moon` (ask).
4. Run the language setup from `references/<lang>.md`: `rust.md`, `python.md`, `go.md`, `typescript.md`. Several languages or packages: `references/monorepo.md`.
5. Formatter config: commit an explicit formatter config for each language (`formatters.md`; its Pi-specific variant documents Pi's setup). Prefer the language's native config, such as Ruff in `pyproject.toml`, `biome.json` or `.oxfmtrc.json`, and use one formatter per file type.
6. Add the license through `license-picker`; a published project also gets REUSE (`license-picker`'s REUSE reference: `reuse annotate` headers, `LICENSES/`, `REUSE.toml`, `reuse lint` in the required CI gate). Then a short `README.md` (what, install, usage, how to run `just check`).
7. Secrets: decide project secrets handling and load the `project-secrets` skill (fnox.toml with 1Password vault refs, local sync cache, GitHub Actions push targets, AWS leases). Skip it when the project has no secrets.

Tree and file contents: `references/layout.md` (the Pi variant).

## 3. Pi project tooling

Follow `new-project` for Pi project packages, skills, prompt templates, and MCP servers. Project-local skills use `.pi/skills/<id>/SKILL.md`; project prompt templates use `.pi/prompts/<name>.md`. Project settings and MCP configuration live in `.pi/settings.json` and `.pi/mcp.json`. Review project resources before granting project trust.

## 4. Tracking and workflow (if chosen)

- Beads: load `beads-setup` after confirming the repository does not already use another tracker. If its git hooks are managed by another tool, use `bd init --skip-hooks`.
- SpecKit: `speckit-setup` (needs `bd`). Journeys: `journey-init`.
- For GitHub-specific branch protection, merge queues and CI lanes, load `delivery-git-workflow` and read its `repo-setup-parallel-agents.md` reference.
- Worktrees: `references/worktrees.md` (the `worktrunk` plugin). For Rust, never set a global `CARGO_TARGET_DIR` (`ops-no-global-cargo-target`); caches follow `ops-toolchain-cache-policy`.
- Hooks, CI jobs, release-please and Renovate defaults to offer: `references/ci-hooks.md`. Wire hooks into `just check` so CI and local agree.

## 5. First commit and verify

1. Run the full gate (`just check`, or the language commands) and fix it until green. A tool that cannot run is "not run", never a pass. The hygiene fixer hooks may rewrite files and fail the first run; review the diff and rerun until it passes.
2. Start project checks for the selected harnesses: validate their config, discover skills, and confirm packages load.
3. Stage specific files, review the changes, then commit once: `chore: scaffold <name>` (Conventional Commits). Do not push or create the remote repository unless the user asked; offer it. When you create a GitHub repository, set its merge settings (`references/governance.md`, Forge).
4. Report: what was created, versions chosen, commands to run, open decisions.

Checklist before reporting: git initialised; tools pinned; gate green; license set; `README.md`, `AGENTS.md`, `docs/stack.md`, `docs/engineering.md` written and linked from `AGENTS.md`; formatter config committed; `.gitignore` covers build output and `.env`; no secrets committed; packages and harness configuration as agreed; one commit.
