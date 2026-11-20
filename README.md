# harness-plugins

Public agent plugins for OpenCode and Claude Code. The repository has no plugins yet. It is set up with [`@srobroek/harness-kit`](https://github.com/srobroek/harness-kit), which generates the per-harness manifests, the Claude marketplace and the inventories from `plugins/<name>/`.

## Layout

```text
plugins/<name>/
  package.json     name, version and the "agent-plugins" key (description, category, harnesses)
  common/          content shared by harnesses: skills/, rules/
  opencode/  claude/   one install tree per harness
.claude-plugin/marketplace.json   generated
INVENTORY.md, inventory.json      generated
harness-kit.json                  generator config
```

## Develop

```sh
npm ci
npm run check     # harness-kit check: generated files are current, Claude plugins validate
bun test
npm run typecheck
```

Edit `plugins/<name>/common/`, then run `npm run build` and commit the generated files. `harness-kit check` fails on any stale file.

## Workflows

- `.github/workflows/ci.yml` calls the reusable `check.yml` of harness-kit: `harness-kit check`, `bun test` and `tsc`.
- `.github/workflows/release.yml` calls the reusable `release.yml` (multi-semantic-release). It runs by hand until the first plugin exists.

Both pin `srobroek/harness-kit` at `@v1.1.0`, the same version as the package in `package.json`. Renovate moves the package and the workflow tags in one pull request, using the preset in `renovate.json`. That pull request needs `npm run build` on its branch before it passes `harness-kit check`.

## License

Apache-2.0.
