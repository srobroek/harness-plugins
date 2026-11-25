# TypeScript

Load `lang-typescript` (router) for quality, testing, packaging, types and profiling
detail, and `toolchain-frontend` for the framework pick.

## Apps and monorepos: use Better-T-Stack

For web, full-stack, native or backend TypeScript apps and monorepos, offer
create-better-t-stack (https://www.better-t-stack.dev/docs/cli) as one scaffold option; otherwise
use the project's existing generator or ask which approach the user wants. For a new library,
CLI or script, offer the existing language toolchain or `bun init` as one option.

1. Check the live contract for the selected generator instead of trusting this file: for
   Better-T-Stack, run `bun create better-t-stack@latest schema --name createInput`
   (or `bunx create-better-t-stack@latest ...`), and `--help`.
2. Choose options with the user, one question each, recommended first. The CLI flags:
   `--frontend` (`tanstack-router`, `react-router`, `tanstack-start`, `next`, `nuxt`,
   `svelte`, `solid`, `astro`, native variants, `none`), `--backend` (`hono`, `express`,
   `fastify`, `elysia`, `convex`, `self`, `none`), `--runtime` (`bun`, `node`, `workers`),
   `--api` (`trpc`, `orpc`, `none`), `--database` (`sqlite`, `postgres`, `mysql`,
   `mongodb`, `none`), `--orm` (`drizzle`, `prisma`, `mongoose`, `none`), `--db-setup`,
   `--auth` (`better-auth`, `clerk`, `none`), `--payments`, `--addons` (`biome`, `oxlint`,
   `turborepo`, `nx`, `lefthook`, `husky`, `tauri`, `pwa`, `starlight`, `fumadocs`, `mcp`,
   `skills`, ...), `--examples`, `--web-deploy`, `--server-deploy`, `--package-manager`.
   Defaults to propose for a new project: `--package-manager bun`, `--runtime bun`, addon
   `biome` (the preferred linter/formatter), and `--git`. Check the repository first; preserve
   its package manager, runtime and lint/format setup. For a new project, present npm, pnpm or
   Bun and Biome, ESLint/Prettier or Oxlint as alternatives; offer the project's existing
   tools when available. Framework preference by surface is in `toolchain-frontend` (React +
   Vite for SPAs, Next.js for SSR, Astro for content); map it to the closest option and say
   when Better-T-Stack lacks it (for example React + Vite). Ask about auth, payments, database
   and deploy target; do not guess.
3. If Better-T-Stack is selected, dry-run first, show the result, then create:

   ```sh
   bun create better-t-stack@latest my-app --frontend tanstack-router --backend hono \
     --runtime bun --api orpc --database postgres --orm drizzle --auth better-auth \
     --addons biome --package-manager bun --no-install --disable-analytics --dry-run
   ```

   Re-run without `--dry-run`, then install with the selected package manager. `create-json` takes
   the same fields as one JSON object when flag quoting gets awkward. Use
   `--directory-conflict error` in an existing directory. Later additions: `create-better-t-stack
   add --addons ...` or `add --package <name>`. It writes `bts.jsonc` with the reproducible
   command; commit it.
4. Never pass `--yolo`. `--db-setup` providers can create cloud resources: keep `manual`
   unless the user opts in.
5. Layer common steps such as a toolchain manager, task runner, docs, `AGENTS.md` and hooks;
   match the existing project or ask the user which to adopt. Better-T-Stack already writes a
   git repo unless `--no-git`.

## Plain TypeScript (library, CLI, script)

For a new project, offer mise, npm, Homebrew or pipx where they apply; preserve the existing
installer if the project already uses one. `mise use bun@latest`, `bun init` and installing
TypeScript, Bun types and Biome are one option, not a requirement.

## Preferred tools and libraries

| Need | Pick |
| --- | --- |
| Package manager | Bun (`bun add`/`bun remove`) is one option; preserve the project's existing choice, or ask the user to choose Bun, npm or pnpm. |
| Lint + format | Biome is one default option (`biome check`); use existing tools or ask whether to choose Biome, ESLint with Prettier, or Oxlint. Avoid overlapping mandatory lint. `Knip` (`bunx knip`) for unused files, exports and dependencies, in the gate |
| Types | `tsc --noEmit` (`tsc -b` with project references), `strict` plus `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (`lang-typescript-types`) |
| Tests | Vitest (`vitest run`) or `bun test`; keep one runner. `msw` for HTTP mocks. Coverage: Vitest v8 coverage or `bun test --coverage` |
| Property | `fast-check` |
| Mutation | Stryker (`vitest-runner` on Node; `@hughescr/stryker-bun-runner` or the command runner on Bun), incremental |
| Fuzz | Jazzer.js on Node (not covered by ClusterFuzzLite); skip on Bun-only projects without a Node target |
| API break (libraries only) | `attw` + `publint` + API Extractor |
| Docs | TypeDoc (libraries) |
| Validation | Zod at runtime boundaries; OpenAPI for HTTP contracts |
| Server state / UI | TanStack Query for server state; shadcn/ui and Base UI with React (`toolchain-frontend`) |

Versions: the concerns tables in `lang-typescript-libraries` (`references/testing.md`, `references/quality.md`) name each tool, its minimum version and its install command. Follow the install policy in `toolchain-languages` (`references/concerns.md`): detect, recommend, ask before installing. Do not repeat versions here.

CLI framework, HTTP framework outside Better-T-Stack, and logging: ask the user.

TypeScript 7 has a native compiler but no stable programmatic API. Validate framework
checkers and embedded-language tools before migrating; retain their TypeScript 6
compatibility path when needed, not just a passing `tsc` run.

## Gate (`just check`)

For the gate, use the selected package manager, formatter/linter, type checker, test runner and
dependency checker. Preserve the project's existing CI action and lockfile conventions; Bun,
Biome and `oven-sh/setup-bun` are examples for projects that choose them. `.gitignore` should
cover `node_modules/`, `dist/` and `.env*`.
