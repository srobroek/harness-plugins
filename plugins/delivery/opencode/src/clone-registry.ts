/**
 * Which other repositories a session's repository has landed into, so its turn-end retry and
 * its gc can find those receipts: they live under the target repository's key, not the session's.
 *
 * One file per session repository, `<receipts root>/.clones/<session key>.json`, holding the
 * target's key and canonical checkout root, newest first. An entry only says where to look: the
 * root is observed again, and must still have the recorded key, before anything is read there.
 *
 * Writes replace the file by rename, so a reader never sees half a file. Two writers that race
 * can each drop the other's new entry; that costs a missed retry (an explicit `delivery_cleanup`
 * still works, and the next landing there adds it again), never a removal.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { receiptDirectory } from "./landing-receipt.ts"

export type CloneEntry = { key: string; root: string }

/** At most this many repositories are kept; the oldest go first. */
export const MAX_CLONES = 32

const KEY = /^[0-9a-f]{16}$/

export function registryFile(env: NodeJS.ProcessEnv, sessionKey: string): string {
  if (!KEY.test(sessionKey)) throw new Error(`repo.key: observed ${JSON.stringify(sessionKey)}, expected 16 hex characters`)
  return join(receiptDirectory(env), ".clones", `${sessionKey}.json`)
}

/** The entries of a registry file's text; anything malformed is dropped. Pure. */
export function parseClones(text: string): CloneEntry[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): CloneEntry[] => {
    const { key, root } = (entry ?? {}) as { key?: unknown; root?: unknown }
    return typeof key === "string" && KEY.test(key) && typeof root === "string" && isAbsolute(root) ? [{ key, root }] : []
  })
}

/** `entry` first, any older entry for its key dropped, capped at {@link MAX_CLONES}. Pure. */
export function withClone(entries: readonly CloneEntry[], entry: CloneEntry): CloneEntry[] {
  return [entry, ...entries.filter((known) => known.key !== entry.key)].slice(0, MAX_CLONES)
}

export function readClones(env: NodeJS.ProcessEnv, sessionKey: string): CloneEntry[] {
  try {
    return parseClones(readFileSync(registryFile(env, sessionKey), "utf8"))
  } catch {
    return []
  }
}

export function addClone(env: NodeJS.ProcessEnv, sessionKey: string, entry: CloneEntry): void {
  const file = registryFile(env, sessionKey)
  const current = readClones(env, sessionKey)
  if (current[0]?.key === entry.key && current[0].root === entry.root) return
  mkdirSync(join(receiptDirectory(env), ".clones"), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(withClone(current, entry))}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}
