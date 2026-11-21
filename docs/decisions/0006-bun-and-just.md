# 0006. bun for installs and scripts, never npm; just as task runner

## Context

The repository ran its tests and scripts under bun but installed with `npm ci`
and ran package scripts with `npm run`. That meant two package managers, a
`package-lock.json` next to a bun toolchain, and no single entry point that runs
every CI gate locally. The `overrides` field (`effect` pinned to the root
version) must still dedupe to one copy of `effect`.

## Decision

- Install with `bun install --frozen-lockfile`; the lockfile is `bun.lock`.
  Run package scripts with `bun run <script>`. Do not use npm in this
  repository, in its workflows or in its docs.
- `justfile` is the task runner. It has one recipe per `package.json` script,
  plus recipes for the checks CI runs outside scripts. `just verify` runs
  every CI gate in order.
- `@srobroek/harness-kit` 1.5.0 and its workflow tags move together. Its
  reusable check workflow installs with `bun install --frozen-lockfile`.
- Out of scope: `npx -y pkg@x.y.z` pins in skills and `.mcp.json`. They tell end
  users how to run third-party tools, and Renovate matches their shape.

## Status

Accepted.

## Consequences

- `bun pm ls --all` shows one `effect` (4.1.5), so bun honours `overrides`.
- Contributors need `bun` and `just` (both in `.mise.toml`).
- Renovate updates `bun.lock` natively.
- Recipes duplicate script names; a new script needs a recipe, and `verify`
  must list a new CI gate.
