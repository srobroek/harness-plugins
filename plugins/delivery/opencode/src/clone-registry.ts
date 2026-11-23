/**
 * Which other repositories a session's repository has landed into, so its turn-end retry, its
 * idle-hook holds and its gc can find those receipts: they live under the target repository's key,
 * not the session's.
 *
 * One file per session repository, `<receipts root>/.clones/<session key>.json`, holding the
 * target's key and canonical checkout root, newest first. An entry only says where to look: the
 * root is observed again, and must still have the recorded key, before anything is read there.
 *
 * An entry may also name the receipts the session landed there (`receiptIds`), the target's git
 * common directory, its `owner/name` and when it was added. Such an entry is dropped once every one of
 * its receipts is settled and the target's landing records are collected. The file is a JSON list of
 * `{key, root}` objects, as 0.10.5 wrote it: those fields are optional, so an older file reads as it
 * did, and its entries (no `receiptIds`) are kept by the count rule alone.
 *
 * Updates are serialized under a lease lock beside the file and replace it by rename, so a reader
 * never sees half a file and no writer drops another's entry. An entry whose repository still has
 * pending receipts is never dropped to stay under {@link MAX_CLONES}. An update refuses, and leaves
 * the file as it is, when the file exists but cannot be read or parsed.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { withLease } from "@srobroek/opencode-lib/lease-lock"
import { receiptDirectory } from "./landing-receipt.ts"

export type CloneEntry = {
  key: string
  root: string
  /** The target's git common directory, where its claims and landing records live. */
  commonDir?: string
  /** The target's `owner/name`. */
  repo?: string
  /** The receipts this session landed there that are not yet settled. Absent on an entry an older version wrote. */
  receiptIds?: string[]
  addedAt?: number
}

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
  return entriesOf(text) ?? []
}

/** The entries of a registry file's text, or null when the text is not a JSON list. Malformed entries are dropped. Pure. */
function entriesOf(text: string): CloneEntry[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  return raw.flatMap((entry): CloneEntry[] => {
    const { key, root, commonDir, repo, receiptIds, addedAt } = (entry ?? {}) as Record<string, unknown>
    if (typeof key !== "string" || !KEY.test(key) || typeof root !== "string" || !isAbsolute(root)) return []
    return [
      {
        key,
        root,
        ...(typeof commonDir === "string" && isAbsolute(commonDir) ? { commonDir } : {}),
        ...(typeof repo === "string" ? { repo } : {}),
        ...(Array.isArray(receiptIds) && receiptIds.every((id) => typeof id === "string") ? { receiptIds: receiptIds as string[] } : {}),
        ...(typeof addedAt === "number" ? { addedAt } : {}),
      },
    ]
  })
}

/**
 * `entry` merged into the known entry for its key: the new root and details win, and the receipt ids
 * are the union. An entry without ids (older) stays without: it says "look at every pending receipt",
 * which a list of some would narrow. Pure.
 */
export function mergeClone(known: CloneEntry | undefined, entry: CloneEntry): CloneEntry {
  if (known === undefined) return entry
  const ids = known.receiptIds === undefined || entry.receiptIds === undefined ? undefined : [...new Set([...known.receiptIds, ...entry.receiptIds])]
  const { receiptIds: _ids, ...rest } = entry
  return { ...rest, ...(ids === undefined ? {} : { receiptIds: ids }) }
}

/** The entry for `key` without `ids`; null when it listed receipts and none is left. An entry with no list is unchanged. Pure. */
export function withoutReceipts(entry: CloneEntry, ids: ReadonlySet<string>): CloneEntry | null {
  if (entry.receiptIds === undefined) return entry
  const left = entry.receiptIds.filter((id) => !ids.has(id))
  return left.length === 0 ? null : { ...entry, receiptIds: left }
}

/**
 * `entry` first, any older entry for its key dropped. Past {@link MAX_CLONES}, the oldest entries
 * with nothing `pending` are dropped; one with pending receipts stays, whatever the count. Pure.
 */
export function withClone(entries: readonly CloneEntry[], entry: CloneEntry, pending: (entry: CloneEntry) => boolean = () => false): CloneEntry[] {
  const next = [mergeClone(entries.find((known) => known.key === entry.key), entry), ...entries.filter((known) => known.key !== entry.key)]
  const drop = new Set<CloneEntry>()
  for (let index = next.length - 1; index > 0 && next.length - drop.size > MAX_CLONES; index--) {
    const candidate = next[index] as CloneEntry
    if (!pending(candidate)) drop.add(candidate)
  }
  return next.filter((known) => !drop.has(known))
}

/**
 * The registry's entries for discovery. An absent file is the empty list; any other read failure, or
 * text that is not a JSON list, throws (the read or parse failure as `cause`), so a caller never mistakes an
 * unreadable registry for one with no clones.
 */
export function readClones(env: NodeJS.ProcessEnv, sessionKey: string): CloneEntry[] {
  const file = registryFile(env, sessionKey)
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    // ENOTDIR: a path component is a file, so no registry file can exist there (a write fails, a read finds nothing).
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return []
    throw new Error(`the clone registry ${file} cannot be read (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
  return entriesIn(file, text, "")
}

/**
 * The registry file as an update must see it: absent (no file) is empty, and any other read
 * failure, or text that is not a JSON list, is an error naming the cause, so the update never
 * replaces entries it could not read.
 */
function loadForUpdate(file: string): CloneEntry[] {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new Error(`the clone registry ${file} cannot be read (${error instanceof Error ? error.message : String(error)}); it was left unchanged`, {
      cause: error,
    })
  }
  return entriesIn(file, text, "; it was left unchanged")
}

/**
 * The entries of the registry `file`'s `text`: text that is not JSON throws with the parse error as
 * `cause`, and JSON that is not a list throws too. `note` ends each message.
 */
function entriesIn(file: string, text: string, note: string): CloneEntry[] {
  try {
    JSON.parse(text)
  } catch (error) {
    throw new Error(`the clone registry ${file} cannot be parsed (${error instanceof Error ? error.message : String(error)})${note}`, {
      cause: error,
    })
  }
  const entries = entriesOf(text)
  if (entries === null) throw new Error(`the clone registry ${file} cannot be parsed as a JSON list${note}`)
  return entries
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
    const current = loadForUpdate(file)
    const merged = mergeClone(current[0]?.key === entry.key ? current[0] : undefined, entry)
    if (current[0]?.key === entry.key && JSON.stringify(current[0]) === JSON.stringify(merged)) return
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(withClone(current, entry, pending))}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  })
  if (result.kind === "failed") throw leaseFailure(file, result)
}

/** The error for a lease that could not be taken. */
function leaseFailure(file: string, result: { reason: string; cause?: unknown }): Error {
  return new Error(`the clone registry ${file} could not be updated: ${result.reason}`, { cause: result.cause })
}

/** Drop the entry for `key` under the registry's lock; the file is deleted when it was the last. Throws as {@link addClone} does. */
export async function removeClone(env: NodeJS.ProcessEnv, sessionKey: string, key: string, options: { waitMs?: number } = {}): Promise<void> {
  const file = registryFile(env, sessionKey)
  const result = await withLease(`${file}.lock`, { owner: "delivery clone registry", waitMs: options.waitMs ?? LOCK_WAIT_MS }, () => {
    const current = loadForUpdate(file)
    if (!current.some((entry) => entry.key === key)) return
    const next = current.filter((entry) => entry.key !== key)
    if (next.length === 0) {
      rmSync(file, { force: true })
      return
    }
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  })
  if (result.kind === "failed") throw leaseFailure(file, result)
}

/**
 * Settle receipts of the entry for `key` under the registry's lock: it loses `ids`, and goes when none
 * is left. An entry with no list, or no entry, is unchanged. Throws like {@link addClone}.
 */
export async function settleReceipts(
  env: NodeJS.ProcessEnv,
  sessionKey: string,
  key: string,
  ids: ReadonlySet<string>,
  options: { waitMs?: number } = {},
): Promise<void> {
  const file = registryFile(env, sessionKey)
  const result = await withLease(`${file}.lock`, { owner: "delivery clone registry", waitMs: options.waitMs ?? LOCK_WAIT_MS }, () => {
    const current = loadForUpdate(file)
    const next = current.flatMap((entry) => (entry.key === key ? (withoutReceipts(entry, ids) ?? []) : [entry]))
    if (JSON.stringify(next) === JSON.stringify(current)) return
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  })
  if (result.kind === "failed") throw leaseFailure(file, result)
}
