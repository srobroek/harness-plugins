// Runs a plugin's release prepareCmd with a throwaway version in a temporary checkout of HEAD, then checks that
// no bundle is stale. The release commit carries whatever the prepare step leaves in the plugin directory, so a
// stale bundle here means the commit on main would be stale.
//
// The bundle is made stale first (a line appended to its dist), so the check passes only when the prepare step
// rebuilds it, for a plugin whose bundle embeds its version and for one whose bundle does not.
// The checkout is a detached git worktree under the system temp directory, removed in a `finally`; the real
// checkout is not touched, and the script fails if its `git status` or index changes. It checks committed files: commit first.
//
//   bun scripts/check-release-prepare.ts [plugin...]   default: delivery (embeds its version) and cad (own release config)

import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const VERSION = "99.0.0"
const root = path.resolve(import.meta.dir, "..")
const plugins = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["delivery", "cad"]

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout
}
const state = () => `${git("status", "--porcelain")}\n${git("diff", "--cached", "--name-only")}`

function run(command: string, args: string[], cwd: string, tree: string) {
  const env = { ...process.env, PATH: `${tree}/node_modules/.bin:${process.env.PATH}` }
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`)
}

/** The prepareCmd of the release config multi-semantic-release uses for the plugin: its own file replaces the root one. */
async function prepareCommand(tree: string, plugin: string): Promise<string> {
  const own = path.join(tree, "plugins", plugin, "release.config.mjs")
  const file = existsSync(own) ? own : path.join(tree, "release.config.mjs")
  const { default: config } = (await import(file)) as { default: { plugins: unknown[] } }
  const exec = config.plugins.find((entry) => Array.isArray(entry) && entry[0] === "@semantic-release/exec")
  if (!Array.isArray(exec)) throw new Error(`${file} has no @semantic-release/exec plugin`)
  return String((exec[1] as { prepareCmd: string }).prepareCmd).replaceAll("$" + "{nextRelease.version}", VERSION)
}

async function probe(plugin: string) {
  const before = state()
  const tree = mkdtempSync(path.join(tmpdir(), "release-prepare-"))
  try {
    git("worktree", "add", "--detach", "--quiet", tree, "HEAD")
    symlinkSync(path.join(root, "node_modules"), path.join(tree, "node_modules"))
    appendFileSync(path.join(tree, "plugins", plugin, "opencode/dist/index.js"), "// stale\n")
    run("bash", ["-c", await prepareCommand(tree, plugin)], path.join(tree, "plugins", plugin), tree)
    run("bun", ["scripts/build.ts", "--check", plugin], tree, tree)
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: root })
    rmSync(tree, { recursive: true, force: true })
    spawnSync("git", ["worktree", "prune"], { cwd: root })
  }
  if (state() !== before) throw new Error("the probe changed the real checkout")
  console.log(`release prepare for ${plugin}@${VERSION} rebuilds its stale bundle`)
}

for (const plugin of plugins) await probe(plugin)
