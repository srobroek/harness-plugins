/**
 * A plugin's options file in pi's agent directory (`<agentDir>/<plugin>.json`).
 *
 * pi passes an extension no options, so a plugin that takes any reads them from this
 * file, in the shape its OpenCode `options` block takes.
 */

import { readFileSync } from "node:fs"

export type PiOptionsFile = {
  /** The file's top-level object; empty when the file is missing, unreadable, not JSON or not an object. */
  options: Readonly<Record<string, unknown>>
  /** Set when the file exists but could not be used, so the defaults apply. */
  warning?: string
}

/**
 * The options at `path`. A missing file gives no options and no warning; an unreadable or
 * malformed one gives no options and a warning `<plugin>: <path> … ; <fallback>.`.
 */
export function loadPiOptionsFile(path: string, plugin: string, fallback: string): PiOptionsFile {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { options: {} }
    return { options: {}, warning: `${plugin}: ${path} could not be read; ${fallback}.` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { options: {}, warning: `${plugin}: ${path} is not valid JSON; ${fallback}.` }
  }
  return { options: raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {} }
}
