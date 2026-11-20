# AGENTS.md

## Generated files

- `plugins/<name>/package.json` and `plugins/<name>/common/` are sources. The manifests, `.claude-plugin/marketplace.json`, `INVENTORY.md`, `inventory.json` and the copies of `common/` inside each harness tree are output. Never edit output by hand.
- After changing a source, run `npm run build`. Before every commit, run `npm run check`.

## Tooling

- Tooling comes from `@srobroek/harness-kit`, pinned exactly in `package.json` and configured by `harness-kit.json`. Do not copy its scripts into this repository.
- The package version and the workflow tags (`srobroek/harness-kit/.github/workflows/*.yml@vX.Y.Z`) are the same version. Bump them together, run `npm run build`, and commit as `chore(deps): bump @srobroek/harness-kit to X.Y.Z`.
- `bun` must be on `PATH` to run `harness-kit`.

## Commits

Conventional Commits. A release is derived from `feat` and `fix` commits under `plugins/<name>/`.
