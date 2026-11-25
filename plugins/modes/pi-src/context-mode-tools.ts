/**
 * context-mode's tool names, for the checks that classify them. They come from the `TOOL_ORDER` list
 * in the installed package's pi bundle when the repository's node_modules has context-mode, else from
 * the fixture recorded from one version. The extension bundle does not import this module.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export type ContextModeTools = { version: string; tools: string[]; source: "installed" | "fixture" }

const ROOT = path.join(import.meta.dir, "..", "..", "..")
const FIXTURE = path.join(import.meta.dir, "fixtures", "context-mode-tools.json")

/** The names in the `TOOL_ORDER` list of context-mode's pi bundle; throws when the bundle has none. */
export function toolOrder(bundle: string): string[] {
  const list = /\bTOOL_ORDER\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(bundle)?.[1]
  if (list === undefined) throw new Error("context-mode's pi bundle has no TOOL_ORDER list")
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] as string)
}

/** context-mode's tools: the installed package's under `root`, else the recorded fixture's. */
export function contextModeTools(root: string = ROOT): ContextModeTools {
  const pkg = path.join(root, "node_modules", "context-mode")
  const bundle = path.join(pkg, "pi", "index.js")
  if (existsSync(bundle)) {
    const { version } = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")) as { version: string }
    return { version, tools: toolOrder(readFileSync(bundle, "utf8")), source: "installed" }
  }
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { version: string; tools: string[] }
  return { version: fixture.version, tools: fixture.tools, source: "fixture" }
}
