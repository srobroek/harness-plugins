---
name: lang-typescript-quality
description: Use to run TypeScript/JavaScript install, lint, format, tsc or tsc -b, and test checks with the project toolchain.
metadata:
  opencode/autoinvoke: false
  omp/autoinvoke: false
---
# TypeScript Quality

Sources: [tsc CLI](https://www.typescriptlang.org/docs/handbook/compiler-options.html) and [project references](https://www.typescriptlang.org/docs/handbook/project-references.html) (checked with tsc 7.0), [`bun --filter`](https://bun.com/docs/pm/filter), [pnpm filtering](https://pnpm.io/filtering), [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces), [Biome CLI](https://biomejs.dev/reference/cli/).

Run checks from the package or workspace root, the directory with `package.json`. Stop at the
first failure, fix it, rerun that step, then continue. Prefer the project's own scripts when it
defines them; otherwise:

| Step | Command |
|---|---|
| Install | `bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `npm ci`, or `yarn install --immutable` |
| Lint and format check | `biome check .`; use `eslint .` or `prettier --check .` only for a named gap such as type-aware rules Biome lacks, Vue or Angular templates |
| Type check | `tsc -b` when `tsconfig.json` has `references`, otherwise `tsc --noEmit` |
| Test | Project test script (`bun test`, `vitest run`, `npm test`, …) |
| Coverage | `vitest run --coverage` (`v8`), or `bun test --coverage --coverage-reporter=lcov` (lines and functions only) |
| Fix | `biome check --write PATHS`, or `eslint --fix PATHS` and `prettier --write PATHS` when requested |

- After an edit that spans files or changes an exported signature, run the type check once before
  handing back: the project's typecheck script, else `tsc --noEmit -p .` or `tsc -b` for project
  references.
- Run tools through the project's package manager (`bunx`, `pnpm exec`, `npx`, `yarn`). Do not
  download a tool the project does not already have.
- `tsc --noEmit` on a root config with `"files": []` and `references` checks nothing and passes;
  use `tsc -b`. `tsc -b` builds referenced projects in dependency order and skips up-to-date ones.
- Strict is on by default since TypeScript 6.0. Do not loosen compiler options to make a check
  pass. See `lang-typescript-types` for useful flags.
- TypeScript 7's native compiler has no stable programmatic API. Validate framework checkers and
  embedded-language tooling before migration; keep TypeScript 6 compatibility when needed. Run a
  framework-aware checker, not only `tsc`.
- Run configured Knip for unused files, exports and dependencies. `unimported` is deprecated;
  `ts-prune`, `ts-unused-exports` and `depcheck` are stale.
- Set Biome `noExcessiveCognitiveComplexity` to error with `maxAllowedComplexity` 15; its default
  severity is information. Do not add a second complexity gate.
- Run `bun audit` or `npm audit` on every PR and on a schedule. Review before `bun audit fix`;
  use `osv-scanner` for several ecosystems.
- Run `stryker run --mutate <changed files>` incrementally on pull requests and fully on a schedule.
  See `lang-typescript-testing` for the Bun runner and its limits.
- For public APIs, run `api-extractor` against the committed `.api.md` report, `attw --pack .`,
  and `publint` on every PR. API Extractor, TypeDoc, typescript-eslint and the Bun Stryker runner
  need the TypeScript 6 API; keep a `@typescript/typescript6` alias (or `typescript@^6`) beside 7.
- Use TypeDoc with warnings as errors; use API Documenter when the API report is the contract.
- Detect missing tools through the libraries' `testing.md` or `quality.md`, recommend the install
  command, and ask before adding a dependency or changing a lockfile. When a tool is not approved,
  report the step as not run.
- A test runner that finds no tests did not test anything; report it, do not call it a pass.
- Fix mode on `.` rewrites unrelated files. Pass touched paths, review the diff, and revert
  incidental rewrites.

## Workspaces

Narrow to the touched package, then run the whole workspace before handing off a change to shared
code:

```sh
bun run --filter '@shop/api' test          # bun; also --filter './packages/api'
pnpm --filter @shop/api test               # pnpm; --filter '@shop/api...' adds its dependencies
pnpm --filter '...[origin/main]' test      # pnpm: packages changed since origin/main and their dependents
npm test --workspace packages/api          # npm
tsc -b packages/api                        # type-checks api and referenced projects
```

## CI

Set up the runtime with `oven-sh/setup-bun` or `actions/setup-node` (`cache:` set to the package
manager). Install with the frozen-lockfile command, then run each check. Keep the same steps in
the same order, one step per row. Workflow structure, the required `ci-gate` job and action
pinning are the `toolchain` plugin's `ci-github-actions` skill.

A missing `package.json`, `tsconfig.json` or tool means that step did not run. Report it as not
run, never as a pass. Read failures as the project's actual toolchain output; do not invent extra
linters.
