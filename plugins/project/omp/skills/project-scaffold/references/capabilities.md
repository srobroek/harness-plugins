# Optional capabilities

Offer, never impose. Ask whether the project has the surface at all; skip silently when
it does not. Each capability adds a pinned tool in `mise.toml`, a `justfile` task that
`just check` includes, and a CI job. Pin versions at current stable and tell the user.

## HTTP API contract (OpenAPI)

Ask: does the service expose an HTTP API others consume? Server URL (unknown is normal;
use a visible placeholder), contract version (starts `0.1.0`, version of the contract, not of
OpenAPI), organization for the contact.

- File `openapi.yaml` at the root, `openapi: 3.2.0`, with `info` (title, version,
  description, contact name and repo URL, license when published), `servers`, a `health` tag
  and a worked `/health` `getHealth` example so the gate is green before the first endpoint.
- Tools: Redocly CLI (`@redocly/cli`, mise `npm:@redocly/cli`) and `oasdiff` (mise
  `github:oasdiff/oasdiff`), at the exact versions in `toolchain-api`'s Contract tooling table.
  `vacuum` is the faster lint alternative (single maintainer). Spectral only when the project
  must keep an existing Spectral ruleset.
- Source: the contract is authored in TypeSpec (`@typespec/http`, `@typespec/openapi3`, one
  version with `@typespec/compiler`), and `openapi.yaml` is its emitted, committed output, never
  edited by hand. Set `tspconfig.yaml` as below (`@typespec/openapi3` 1.18.0 supports 3.0.0, 3.1.0 and
  3.2.0, defaults to 3.0.0, and does not seal object schemas by default). The `/health`
  example lives in the TypeSpec source.

  ```yaml
  emit:
    - "@typespec/openapi3"
    - "@typespec/json-schema"   # only when a standalone schema is published
  options:
    "@typespec/openapi3":
      emitter-output-dir: "{project-root}"        # writes openapi.yaml at the root
      openapi-versions: ["3.2.0"]
      seal-object-schemas: true
    "@typespec/json-schema":
      emitter-output-dir: "{project-root}/schema"
      seal-object-schemas: true
  ```

  Without `emitter-output-dir`, TypeSpec writes to `tsp-output/@typespec/openapi3/openapi.yaml`,
  and the tasks below would read a stale file or none (checked with 1.18.0 on 2026-11-25).

  Set the same `seal-object-schemas: true` on both emitters. Run the project's conformance
  gate on 3.2.0 (`toolchain-api`'s Contract tooling table records the 2026-11-25 acceptance
  check; the generator scores were measured on 3.1.0). If a generator fails on 3.2.0, keep `openapi.yaml` (3.2.0) where it
  is and add `tspconfig.oa31.yaml` emitting `openapi-versions: ["3.1.0"]` with
  `emitter-output-dir: "{project-root}/build/openapi-3.1"` for that generator only. Every task below keeps using `openapi.yaml`;
  listing both versions in one config moves it into per-version directories.
- Tasks: `redocly lint openapi.yaml` with a committed `redocly.yaml`, plus the response-status-key and `jsonSchemaDialect` checks of `toolchain-api` gate 4; regenerate and fail on
  `git status --porcelain` over the generated paths; breaking-change check against the PR
  base: `git show origin/main:openapi.yaml > "$base"` then
  `oasdiff breaking --fail-on ERR --severity-levels oasdiff-severity.txt "$base" openapi.yaml`
  with the committed severity file from `toolchain-api` (it promotes `request-property-removed`
  to an error), skipping when the base has no spec; `oasdiff changelog` to print the diff. Add
  the sealed-property schema check and `redocly build-docs` as `toolchain-api`'s Required CI
  gates list them. Fetch full history in CI (`fetch-depth: 0`) and set the baseline ref to the
  PR base branch.
- Framework adapters (oRPC, FastAPI, Hono, NestJS and others) follow one pattern: the
  framework's input and output schemas are the validators and types generated from the
  TypeSpec output (Zod through `@hey-api/openapi-ts`), and the framework serves and calls
  them. The OpenAPI the framework generates from its own code is not the published source; a
  drift check compares it with the committed emitted `openapi.yaml`. With Better-T-Stack and
  `--api orpc` (a recommended TypeScript RPC option), the `@orpc/contract` router's input and
  output schemas are the generated Zod schemas, oRPC serves and calls them, and `@orpc/openapi`
  output is only compared with TypeSpec's (`toolchain-languages`: OpenAPI for HTTP contracts).
- gRPC and ConnectRPC services keep `.proto` as the source for now (Connect stays the
  preferred RPC choice): gates are `buf lint` (`STANDARD`) and
  `buf breaking --against ".git#ref=${BASE_SHA}"` with the fetched PR base SHA, with protovalidate carrying value limits. Revisit and
  switch to TypeSpec-emitted `.proto` when `@typespec/protobuf` reaches 1.0 and emits
  protovalidate rules (`toolchain-api`, gRPC row of the Contract tooling table).

## i18n (Inlang / Paraglide)

Ask: which locales ship? Base locale (default `en`)? Where does the Inlang project live
(`project.inlang` at the root, or `apps/web/project.inlang` in a monorepo)?

- `project.inlang/settings.json`: `baseLocale`, `locales` (must include the base), `modules`
  with the Inlang message-format plugin module URL (pin its version; the old default was
  `https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4/dist/index.js`), and
  `"plugin.inlang.messageFormat": { "pathPattern": "./messages/{locale}.json" }`.
- Catalogs in `messages/<locale>.json` next to the project directory, starting with
  `{ "$schema": "https://inlang.com/schema/inlang-message-format", "hello_world": "Hello, world" }`.
- A catalog parity check (node script run by `just i18n`) fails when a shipped locale lacks
  its catalog or keys the base has. Node pinned in mise for it.
- Only the base catalog is written at setup; each other locale fails the check until its
  catalog exists, which is intended.

## Accessibility (axe on named routes)

Ask: which surfaces (name, base URL) and routes should be scanned, and which command starts
the dev server and its URL? With no routes yet, record scanning as a gap rather than faking a
route.

- Isolated `.a11y/` package: `package.json` with `@axe-core/playwright` and
  `@playwright/test`, `playwright.a11y.config.ts` (`testDir ./tests`, `testMatch **/*.pw.ts`,
  `webServer` from `web-servers.json`, `reuseExistingServer: !process.env.CI`), a test that
  visits every surface route and asserts `new AxeBuilder({ page }).analyze()` has no
  violations, `surfaces.json` `[{name, baseURL, routes}]`, `web-servers.json`
  `[{command, url, cwd}]`.
- Tasks: install deps with `cd .a11y && bun install --frozen-lockfile`; browser with
  `bunx playwright install chromium` (add `--with-deps` on Linux and CI); run
  `cd .a11y && bunx playwright test --config playwright.config.ts --pass-with-no-tests`
  (use the config file name you actually created). Bun pinned in mise.
- Keep `.a11y/node_modules/` ignored, and exclude its JSON data files from the formatter.

## Infrastructure: AWS CDK (TypeScript)

Ask first whether Terraform or OpenTofu is the baseline (`toolchain-infrastructure`); CDK
only when application code and AWS constructs are tightly coupled. If chosen:

- Destination `infrastructure/` (repo-relative, ask if different). Generate with the
  CDK's own init, at least a stable `aws-cdk` version: `bunx aws-cdk@<x.y.z> init app
  --language typescript` in an empty scratch directory, then move the result in and drop what
  an npm-package template adds that this repo does not need (its own git repo, duplicate
  lockfiles). Do not template CDK code by hand.
- Tasks: install (`cd infrastructure && bun install --frozen-lockfile`), `synth`
  (`bun run cdk synth`), `diff` (`bun run cdk diff --fail-on=broadening`, needs a read-only AWS
  role, so CI only). The local gate is synth with `cdk-nag` packs applied to the app, plus
  the template assertions; `cdk diff` and `cfn-lint` on `cdk.out` run beside synth in CI.
  Concern tools: `aws-guidance` (`references/cdk.md`).
- Never bootstrap or deploy unless the user asks in this conversation. Credentials for it
  come from `project-secrets` (AWS section), not from files.
- Keep CDK's tests out of the root TypeScript config (exclude `infrastructure/` in the root
  `tsconfig.json` and Biome includes).
