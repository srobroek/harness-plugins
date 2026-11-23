import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { FileValue } from "../shared/answers.ts"
import { completionQuery, mimeFor, parsePaths } from "../shared/tui-state.ts"

/** A typed path as a file system path: `~` is the home directory, a relative path is under `base`. */
export function resolvePath(raw: string, base: string): string {
  const home = process.env.HOME ?? ""
  if (raw === "~" || raw.startsWith("~/")) return `${home}${raw.slice(1)}`
  return path.resolve(base, raw)
}

/** Reads the files a file card's path field names (one per line or comma separated), as upload values. */
export function readFiles(text: string, base: string): FileValue[] {
  return parsePaths(text).map((raw) => {
    const resolved = resolvePath(raw, base)
    let bytes: Buffer
    try {
      if (!statSync(resolved).isFile()) throw new Error("not a file")
      bytes = readFileSync(resolved)
    } catch {
      throw new Error(`No such file: ${raw}`)
    }
    return { name: path.basename(resolved), path: raw, mime: mimeFor(resolved), size: bytes.byteLength, data: bytes.toString("base64") }
  })
}

/**
 * Completion candidates for the path being typed (the segment after the last comma or newline): the
 * entries of the directory it names, relative as typed, directories ending in `/`. Hidden entries
 * show only once the segment starts one.
 */
export function findPaths(text: string, base: string): string[] {
  const { query } = completionQuery(text)
  const slash = query.lastIndexOf("/")
  const dir = slash < 0 ? "" : query.slice(0, slash + 1)
  const leaf = query.slice(slash + 1)
  try {
    return readdirSync(resolvePath(dir === "" ? "." : dir, base), { withFileTypes: true })
      .filter((entry) => leaf.startsWith(".") || !entry.name.startsWith("."))
      .map((entry) => `${dir}${entry.name}${entry.isDirectory() ? "/" : ""}`)
  } catch {
    return []
  }
}
