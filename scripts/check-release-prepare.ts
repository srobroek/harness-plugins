// Runs a plugin's release prepareCmd with a throwaway version in a temporary checkout of HEAD, then checks that
// no bundle or OMP output is stale. The release commit carries whatever the prepare step leaves in the plugin directory,
// so stale generated output here means the commit on main would be stale.

// The output is made stale first, so the check passes only when prepare regenerates it. The checkout is a detached git
// worktree under the system temp directory, removed whether the probe passes or fails; the real checkout is not touched,
// and the script fails if its `git status` or index changes. It checks committed files: commit first.

//   bun scripts/check-release-prepare.ts [plugin...]   default: delivery (embeds its version), cad, and eli5 (OMP)
//

import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const VERSION = "99.0.0"
const root = path.resolve(import.meta.dir, "..")
const plugins = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["delivery", "cad", "eli5"]

/** Runs a command and throws, keeping spawn's own error (a missing executable) as the cause. */
function exec(command: string, args: string[], options: { cwd: string; inherit?: boolean; env?: NodeJS.ProcessEnv }): string {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env, encoding: "utf8", stdio: options.inherit ? "inherit" : "pipe" })
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? `exited ${result.status}: ${result.stderr ?? ""}`
    throw new Error(`${command} ${args.join(" ")} ${detail}`, { cause: result.error })
  }
  return result.stdout ?? ""
}
const git = (...args: string[]) => exec("git", args, { cwd: root })
// Status plus the index entries (mode, blob, stage, path), so a staged file that changes content shows.
const state = () => `${git("status", "--porcelain")}\n${git("ls-files", "--stage")}`

function run(command: string, args: string[], cwd: string, tree: string) {
  const env = { ...process.env, PATH: `${tree}/node_modules/.bin:${process.env.PATH}` }
  exec(command, args, { cwd, env, inherit: true })
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
  let failure: unknown
  try {
    git("worktree", "add", "--detach", "--quiet", tree, "HEAD")
    symlinkSync(path.join(root, "node_modules"), path.join(tree, "node_modules"))
    const pluginRoot = path.join(tree, "plugins", plugin)
    appendFileSync(path.join(pluginRoot, "opencode/dist/index.js"), "// stale\n")
    const packageJson = JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8")) as {
      version: string
      "agent-plugins": { harnesses: string[] }
    }
    const hasOmp = packageJson["agent-plugins"].harnesses.includes("omp")
    if (hasOmp) appendFileSync(path.join(pluginRoot, "omp", "skills", plugin, "SKILL.md"), "\n<!-- stale -->\n")
    run("bash", ["-c", await prepareCommand(tree, plugin)], pluginRoot, tree)
    run("bun", ["scripts/build.ts", "--check", plugin], tree, tree)
    if (hasOmp) {
      const marketplace = JSON.parse(readFileSync(path.join(tree, ".omp-plugin", "marketplace.json"), "utf8")) as {
        plugins: Array<{ name: string; source: string; version: string }>
      }
      const entry = marketplace.plugins.find((item) => item.name === plugin)
      if (entry?.source !== `./plugins/${plugin}/omp` || entry.version !== VERSION) {
        throw new Error(`OMP marketplace entry for ${plugin} does not match its stamped version`)
      }
      for (const output of [
        path.join(pluginRoot, "omp/package.json"),
        path.join(pluginRoot, "omp/.omp-plugin/plugin.json"),
      ]) {
        if (!existsSync(output)) throw new Error(`release prepare did not generate ${path.relative(tree, output)}`)
      }
      const skill = path.join(pluginRoot, "omp/skills", plugin, "SKILL.md")
      if (!existsSync(skill) || readFileSync(skill, "utf8").includes("<!-- stale -->")) {
        throw new Error(`release prepare did not regenerate ${path.relative(tree, skill)}`)
      }
    }
  } catch (error) {
    failure = error
  }
  // Cleanup always runs; its own failure is reported unless the probe already failed, whose error comes first.
  try {
    git("worktree", "remove", "--force", tree)
  } catch (error) {
    failure ??= error
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
  if (failure !== undefined) throw failure
  if (state() !== before) throw new Error("the probe changed the real checkout")
  console.log(`release prepare for ${plugin}@${VERSION} rebuilds its stale bundle`)
}

for (const plugin of plugins) await probe(plugin)
