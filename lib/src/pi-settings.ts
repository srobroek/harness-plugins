/**
 * A plugin's options on pi: the object under the plugin's own top-level key in pi's user settings
 * file, `<agentDir>/settings.json`, in the shape the plugin's OpenCode `options` block takes.
 *
 * pi passes an extension no options. It accepts keys it does not know in `settings.json` and keeps
 * them when it rewrites the file. This reads the user file alone, never through `pi.getSettings()`,
 * which merges in a project's `.pi/settings.json`: project settings are repository content, and a
 * repository must not loosen a gate.
 */

import { readFileSync } from "node:fs"

/** pi's settings file in its agent directory. */
export const PI_SETTINGS_FILE = "settings.json"

export type PiPluginSettings = {
  /** The object under the plugin's key; empty when the file or the key is missing or unusable. */
  options: Readonly<Record<string, unknown>>
  /** Set when the file or the key exists but could not be used, so the defaults apply. */
  warning?: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * The options under key `plugin` of the settings file at `path`. A missing file or key gives no
 * options and no warning. An unreadable file, one that is not a JSON object, or a key whose value
 * is not an object gives no options and a warning `<plugin>: …; <fallback>.`.
 */
export function loadPiPluginSettings(path: string, plugin: string, fallback: string): PiPluginSettings {
  const unusable = (problem: string): PiPluginSettings => ({ options: {}, warning: `${plugin}: ${problem}; ${fallback}.` })
  const unread = `so its "${plugin}" key was not read`
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { options: {} }
    return unusable(`${path} could not be read, ${unread}`)
  }
  let settings: unknown
  try {
    // pi strips a byte-order mark before it parses the file.
    settings = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    return unusable(`${path} is not valid JSON, ${unread}`)
  }
  if (!isObject(settings)) return unusable(`${path} is not a JSON object, ${unread}`)
  const value = settings[plugin]
  if (value === undefined) return { options: {} }
  if (!isObject(value)) return unusable(`the "${plugin}" key in ${path} is not an object`)
  return { options: value }
}
