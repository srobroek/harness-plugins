// Runs the release's prepareCmd for one plugin with a throwaway version, then checks that no bundle is stale.
// The release commit carries whatever the prepare step leaves in the plugin directory, so a stale bundle here
// means the commit on main would be stale. It rewrites tracked files; run it in CI, on a disposable checkout.
//
//   CI=true bun scripts/check-release-prepare.ts [plugin]   default plugin: delivery, the one whose bundle embeds its version

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

const VERSION = "99.0.0"
const root = path.resolve(import.meta.dir, "..")
const plugin = process.argv[2] ?? "delivery"

if (!process.env.CI) throw new Error("check-release-prepare rewrites tracked files; run it in CI or set CI=true on a disposable checkout")

// multi-semantic-release uses a package's own release.config.mjs in place of the root one.
const own = path.join(root, "plugins", plugin, "release.config.mjs")
const configFile = existsSync(own) ? own : path.join(root, "release.config.mjs")
const { default: releaseConfig } = (await import(configFile)) as { default: { plugins: unknown[] } }
const exec = releaseConfig.plugins.find((entry) => Array.isArray(entry) && entry[0] === "@semantic-release/exec")
if (!Array.isArray(exec)) throw new Error(`${configFile} has no @semantic-release/exec plugin`)
const prepareCmd = String((exec[1] as { prepareCmd: string }).prepareCmd).replaceAll("$" + "{nextRelease.version}", VERSION)

const run = (command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, PATH: `${root}/node_modules/.bin:${process.env.PATH}` } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run("bash", ["-c", prepareCmd], path.join(root, "plugins", plugin))
run("bun", ["scripts/build.ts", "--check", plugin], root)
console.log(`release prepare for ${plugin}@${VERSION} leaves its bundles current`)
