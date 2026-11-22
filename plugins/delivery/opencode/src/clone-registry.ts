/**
 * Which other repositories a session's repository has landed into, so its turn-end retry, its
 * idle-hook holds and its gc can find those receipts: they live under the target repository's key,
 * not the session's.
 *
 * One file per session repository, `<receipts root>/.clones/<session key>.json`, holding the
 * target's key and canonical checkout root, newest first. An entry only says where to look: the
 * root is observed again, and must still have the recorded key, before anything is read there.
 *
 * Updates are serialized under a lease lock beside the file and replace it by rename, so a reader
 * never sees half a file and no writer drops another's entry. An entry whose repository still has
 * pending receipts is never dropped to stay under {@link MAX_CLONES}.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { withLease } from "@srobroek/opencode-lib/lease-lock"
import { receiptDirectory } from "./landing-receipt.ts"

export type CloneEntry = { key: string; root: string }

/** Entries with nothing pending beyond this many are dropped, oldest first. */
export const MAX_CLONES = 32

const KEY = /^[0-9a-f]{16}$/

/** How long an update waits for another writer's lock. */
const LOCK_WAIT_MS = 10_000

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

/**
 * `entry` first, any older entry for its key dropped. Past {@link MAX_CLONES}, the oldest entries
 * with nothing `pending` are dropped; one with pending receipts stays, whatever the count. Pure.
 */
export function withClone(entries: readonly CloneEntry[], entry: CloneEntry, pending: (entry: CloneEntry) => boolean = () => false): CloneEntry[] {
  const next = [entry, ...entries.filter((known) => known.key !== entry.key)]
  const drop = new Set<CloneEntry>()
  for (let index = next.length - 1; index > 0 && next.length - drop.size > MAX_CLONES; index--) {
    const candidate = next[index] as CloneEntry
    if (!pending(candidate)) drop.add(candidate)
  }
  return next.filter((known) => !drop.has(known))
}

export function readClones(env: NodeJS.ProcessEnv, sessionKey: string): CloneEntry[] {
  try {
    return parseClones(readFileSync(registryFile(env, sessionKey), "utf8"))
  } catch {
    return []
  }
}

/** Add `entry` under the registry's lock; throws when the lock cannot be taken or the file written. */
export async function addClone(
  env: NodeJS.ProcessEnv,
  sessionKey: string,
  entry: CloneEntry,
  pending: (entry: CloneEntry) => boolean,
  options: { waitMs?: number } = {},
): Promise<void> {
  const file = registryFile(env, sessionKey)
  mkdirSync(join(receiptDirectory(env), ".clones"), { recursive: true })
  const result = await withLease(`${file}.lock`, { owner: "delivery clone registry", waitMs: options.waitMs ?? LOCK_WAIT_MS }, () => {
    const current = readClones(env, sessionKey)
    if (current[0]?.key === entry.key && current[0].root === entry.root) return
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(withClone(current, entry, pending))}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  })
  if (result.kind === "failed") throw new Error(`the clone registry ${file} could not be updated: ${result.reason}`)
}
