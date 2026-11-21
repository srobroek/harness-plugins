import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { loadConfig } from "@srobroek/harness-kit"

const root = path.join(import.meta.dir, "..")
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"))

test("harness-kit.json is valid and targets OpenCode and Claude Code", () => {
  const config = loadConfig(root)
  expect(config.harnesses).toEqual(["opencode", "claude"])
  expect(config.marketplace.name).toBe("harness-plugins")
})

/** The package names multi-semantic-release releases: the workspace packages, less `ignorePackages` of .multi-releaserc. */
function releasedPackages(): string[] {
  const dirs = (json("package.json").workspaces as string[]).flatMap((pattern) =>
    pattern.endsWith("/*")
      ? readdirSync(path.join(root, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${pattern.slice(0, -2)}/${entry.name}`)
      : [pattern],
  )
  const ignored = (json(".multi-releaserc").ignorePackages as string[]).map((pattern) => new Bun.Glob(pattern))
  return dirs
    .filter((dir) => existsSync(path.join(root, dir, "package.json")))
    .filter((dir) => !ignored.some((glob) => glob.match(`${dir}/package.json`)))
    .map((dir) => json(`${dir}/package.json`).name as string)
    .sort()
}

// With plugins/* missing from `workspaces`, multi-semantic-release releases no plugin and reports no error.
test("multi-semantic-release discovers every plugin and no other package", () => {
  const plugins = readdirSync(path.join(root, "plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  expect(releasedPackages()).toEqual(plugins)
  expect(plugins).toHaveLength(45)
})

/** The commit-analyzer options of a release config. */
async function analyzerOptions(file: string) {
  const config = (await import(path.join(root, file))).default as { plugins: [string, Record<string, unknown>][] }
  const [, options] = config.plugins.find(([name]) => name === "@semantic-release/commit-analyzer") ?? []
  return options
}

const refactorAndDocs = [
  { type: "refactor", release: "patch" },
  { type: "docs", release: "patch" },
]

test("refactor and docs commits cut a patch, and a breaking change a major", async () => {
  expect((await analyzerOptions("release.config.mjs"))?.releaseRules).toEqual([
    { breaking: true, release: "major" },
    ...refactorAndDocs,
  ])
})

test("cad, below 1.0, treats a breaking change as a minor release and keeps the other rules", async () => {
  expect((await analyzerOptions("plugins/cad/release.config.mjs"))?.releaseRules).toEqual([
    { breaking: true, release: "minor" },
    ...refactorAndDocs,
  ])
})

test("no release config publishes to npm", async () => {
  for (const file of ["release.config.mjs", "plugins/cad/release.config.mjs"]) {
    const config = (await import(path.join(root, file))).default as { plugins: (string | [string])[] }
    const names = config.plugins.map((plugin) => (typeof plugin === "string" ? plugin : plugin[0]))
    expect(names).not.toContain("@semantic-release/npm")
    expect(names).toContain("@semantic-release/github")
  }
})
