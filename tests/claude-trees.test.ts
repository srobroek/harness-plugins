import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// A Claude Code plugin is installed from its claude/ directory alone, so every file in it may only name
// files that sit in that tree. The old plugins shipped their whole directory, so a reference to a
// directory that now lives only in common/ or opencode/ breaks silently at run time.

const PLUGINS = path.resolve(import.meta.dir, "../plugins")

/** Plugin-root directories whose contents a Claude Code file would need in its own tree. */
const ROOT_DIRS = ["formulas", "instructions", "templates", "examples", "scripts", "fixtures", "hooks", "assets"]
const TEXT = /\.(md|json|py|sh|mjs|toml|ya?ml)$/

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? (entry.name === "dist" ? [] : walk(path.join(directory, entry.name))) : [path.join(directory, entry.name)],
  )

const trees = readdirSync(PLUGINS)
  .filter((plugin) => existsSync(path.join(PLUGINS, plugin, "claude")))
  .map((plugin) => ({ plugin, tree: path.join(PLUGINS, plugin, "claude") }))

const files = (tree: string) => walk(tree).filter((file) => TEXT.test(file))

type Reference = { file: string; text: string; target: string }

/** `${CLAUDE_PLUGIN_ROOT}/<path>` in any file: relative to the tree root. */
function pluginRootReferences(tree: string): Reference[] {
  return files(tree).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+[A-Za-z0-9_-])/g)].map((match) => ({
      file: path.relative(tree, file),
      text: match[0],
      target: path.join(tree, match[1] as string),
    })),
  )
}

/** Markdown links to a relative path: relative to the file. */
function relativeLinks(tree: string): Reference[] {
  return files(tree)
    .filter((file) => file.endsWith(".md"))
    .flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/\]\((?!https?:|mailto:|#|\/)([^)\s#]+)(?:#[^)\s]*)?\)/g)].map((match) => ({
        file: path.relative(tree, file),
        text: match[0],
        target: path.resolve(path.dirname(file), match[1] as string),
      })),
    )
}

/**
 * Mentions of a plugin-root directory (`formulas/`, `${CLAUDE_PLUGIN_ROOT}/formulas/`) that the plugin ships in
 * another tree but not in this one. A mention that names a directory of the skill itself (`templates/`) is fine.
 */
function missingRootDirectories(plugin: string, tree: string): Reference[] {
  const others = [path.join(PLUGINS, plugin, "common"), path.join(PLUGINS, plugin, "opencode")]
  const found: Reference[] = []
  for (const file of files(tree)) {
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(new RegExp(`(?<![A-Za-z0-9_./-])(?:\\$\\{CLAUDE_PLUGIN_ROOT\\}/)?(${ROOT_DIRS.join("|")})/(?![A-Za-z0-9_.-]*\\.)`, "g"))) {
      const directory = match[1] as string
      const local = [path.dirname(file), tree].some((base) => existsSync(path.join(base, directory)))
      if (!local && others.some((other) => existsSync(path.join(other, directory)))) {
        found.push({ file: path.relative(tree, file), text: match[0], target: path.join(tree, directory) })
      }
    }
  }
  return found
}

const show = (references: Reference[]) => references.map((reference) => `${reference.file}: ${reference.text}`)

test("there are Claude Code trees to check", () => {
  expect(trees.length).toBeGreaterThan(10)
})

describe.each(trees)("$plugin claude tree", ({ plugin, tree }) => {
  test("every ${CLAUDE_PLUGIN_ROOT} path exists in the tree", () => {
    expect(show(pluginRootReferences(tree).filter((reference) => !existsSync(reference.target)))).toEqual([])
  })

  test("every relative Markdown link resolves inside the tree", () => {
    expect(show(relativeLinks(tree).filter((reference) => !existsSync(reference.target)))).toEqual([])
  })

  test("no file names a plugin-root directory that only another tree ships", () => {
    expect(show(missingRootDirectories(plugin, tree))).toEqual([])
  })
})
