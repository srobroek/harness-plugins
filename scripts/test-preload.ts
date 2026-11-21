/**
 * `bun test` preload (see `bunfig.toml`).
 *
 * Git: tests run real `git` in scratch repositories, and the developer's global and
 * system config would otherwise apply there: commit signing, system-wide hooks
 * (`core.hooksPath`), credential helpers and filters each start extra programs per
 * command, and they are absent in CI. A child started through `node:child_process`,
 * `Bun.$` or with `env: process.env` inherits these settings, so those tests see the
 * config-free Git that CI has. `Bun.spawn` and `Bun.spawnSync` without `env` start the
 * child in the environment the process started with and do not see them. A test or
 * production path that builds its own environment still controls it.
 *
 * Beads: the OpenCode server, and so a test process, can inherit `BEADS_*` and `BD_*`
 * variables (`BEADS_DIR`, `BEADS_ACTOR`, `BD_ACTOR`, `BEADS_DB`, `BD_SOCKET`,
 * `BEADS_DOLT_SERVER_*`, ...) from another project's shell. They carry that project's
 * ledger, actor or dolt server routing, so a test that runs a real `bd` would act on it.
 * Every variable with those prefixes is deleted before any test runs; a test that needs
 * one sets it itself. Tests that start a real `bd` also build the child environment with
 * `scrubbedBeadsEnv` (`lib/src/testing.ts`), so they stay safe without this preload.
 *
 * Solid: `@opentui/solid/preload` imports Babel when it registers its JSX transform,
 * which costs seconds per test process even when no file has JSX. This registers the
 * same transform for the same files and imports it on the first file that needs it.
 */

import { devNull } from "node:os"
import { isBeadsEnvKey } from "@srobroek/opencode-lib/testing"
import { type OnLoadArgs, type OnLoadResult, plugin } from "bun"

process.env.GIT_CONFIG_GLOBAL = devNull
process.env.GIT_CONFIG_NOSYSTEM = "1"
for (const key of Object.keys(process.env)) if (isBeadsEnvKey(key)) delete process.env[key]

/**
 * The files `@opentui/solid`'s Bun plugin handles: JSX sources, and the `solid-js`
 * server builds it swaps for the client builds. A file this matches that the upstream
 * plugin no longer handles fails loudly in {@link load}.
 */
const SOLID_FILES = /(?:\.[cm]?[jt]sx|[/\\]node_modules[/\\]solid-js[/\\](?:store[/\\])?dist[/\\]server\.js)(?:[?#].*)?$/

type Handler = { filter: RegExp; callback: (args: OnLoadArgs) => OnLoadResult | Promise<OnLoadResult> }

let handlers: Promise<Handler[]> | undefined

/** The upstream plugin's onLoad handlers, recorded by running its setup against a stub. */
async function upstream(): Promise<Handler[]> {
  const { createSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  const recorded: Handler[] = []
  const build = { onLoad: (options: { filter: RegExp }, callback: Handler["callback"]) => void recorded.push({ filter: options.filter, callback }) }
  await createSolidTransformPlugin().setup(build as never)
  return recorded
}

async function load(args: OnLoadArgs): Promise<OnLoadResult> {
  handlers ??= upstream()
  const handler = (await handlers).find(({ filter }) => filter.test(args.path))
  if (handler === undefined) throw new Error(`test-preload: @opentui/solid has no transform for ${args.path}`)
  return handler.callback(args)
}

plugin({
  name: "solid-transform-on-demand",
  setup(build) {
    build.onLoad({ filter: SOLID_FILES }, load)
  },
})
