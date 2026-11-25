# Suggested shapes (from the old presets)

Offer the closest shape as a starting point, then customise it to the project. "Shape" selects
language references and capability offers; nothing is imposed. Ask about license, default branch,
forge, release automation and worktrees. The sample limits and timeout values below are examples.

| Shape | Languages | Offer | Notes |
| --- | --- | --- | --- |
| minimal | none | hygiene hooks, `justfile`, toolchain-manager configuration, docs | use the project's existing installer or choose one; mise and `just --list` are options |
| py-lib | Python | Python gates, release | scopes `lib,docs,ci,deps`; worktrees optional |
| rust-cli | Rust (binary) | Rust gates, release | timeout 20 min; scopes `cli,ci,deps`; usage `just run -- --help` |
| go-service | Go | Go gates, release | scopes `api,ci,deps`; usage `just run` |
| ts-service | TypeScript | TS gates, release | scopes `api,web,ci,deps`; usage `just dev`; Better-T-Stack for apps |
| api-service | TypeScript | + OpenAPI contract (`capabilities.md`) | timeout 20 min |
| gitlab-service | Go | GitLab CI instead of GitHub | no `.github/`; `.gitlab-ci.yml` and `.gitlab/` templates |
| polyglot-service | Go + TypeScript | both gates | timeout 20 min; scopes `api,web,ci,deps` |
| desktop-rust-ts | Rust (library core) + TypeScript | both gates | timeout 25 min; scopes `core,ui,ci,deps` |
| monorepo | Go + TypeScript members | per-member CI jobs | timeout 25 min; `references/monorepo.md` |
| web-app | TypeScript | + i18n, a11y; AWS CDK only when the project deploys to AWS | timeout 25 min; dev command `bun run dev`; scopes `web,i18n,a11y,infra,ci,deps` |
| fullstack-web | Go + TypeScript | + i18n, a11y; AWS CDK only when the project deploys to AWS | timeout 25 min; scopes `api,web,i18n,infra,ci,deps` |

When drafting a README, detect and retain the project's existing installer and task runner.
For a new project, offer `mise install && just setup` and `just dev` as examples; use a
language-specific install command such as `uv sync`, `go mod download` or `bun install` when
that matches the selected language and tools.
