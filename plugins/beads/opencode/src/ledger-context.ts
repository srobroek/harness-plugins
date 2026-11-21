/**
 * Which ledger a gate read, and whether it belongs to the repository the command runs in.
 *
 * A gate that refuses on a ledger the agent did not expect (a parent directory's, a pinned
 * `BEADS_DIR`) is only debuggable when the refusal names that ledger. The readers here are
 * thin; the wording and the mismatch decision are pure.
 *
 * Ledger files are repository data and reach an agent-facing message, so they are read
 * defensively (regular files only, size-capped, never followed through a symlink) and
 * only a short identifier is quoted from them.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { readSmallRegularFile } from "@srobroek/opencode-lib/bounded-read"

export type LedgerContext = {
  /** The directory the walk started from. */
  from: string
  /** The `.beads` directory the walk found. */
  store: string
  /** The issue prefix or database name, when the ledger's files say one. */
  prefix?: string
  retired: boolean
}

/** What a prefix may look like before it is shown to an agent. */
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** The nearest `.beads` at or above `from`, the way the PR-link gate walks. */
export function findLedger(from: string): LedgerContext | undefined {
  const start = resolve(from)
  let current = start
  for (;;) {
    const store = join(current, ".beads")
    if (existsSync(store)) {
      const prefix = ledgerPrefix(store)
      return { from: start, store, retired: isRetired(store), ...(prefix === undefined ? {} : { prefix }) }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function isRetired(store: string): boolean {
  try {
    return lstatSync(join(store, "RETIRED")).isFile()
  } catch {
    return false
  }
}

/** A prefix safe to show an agent: a short ASCII identifier, else undefined. */
export function safePrefix(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_PREFIX.test(value) ? value : undefined
}

/**
 * The `issue-prefix:` value from config.yaml text, parsed line by line in linear time
 * (no backtracking regex over repository-controlled text).
 */
export function configIssuePrefix(config: string): string | undefined {
  for (const line of config.split(/\r?\n/)) {
    if (!line.startsWith("issue-prefix:")) continue
    let value = line.slice("issue-prefix:".length)
    const comment = value.indexOf("#")
    if (comment !== -1) value = value.slice(0, comment)
    value = value.trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1)
    return value
  }
  return undefined
}

/** `issue-prefix:` from config.yaml, else the `dolt_database` name from metadata.json. */
export function ledgerPrefix(store: string): string | undefined {
  const config = readSmallRegularFile(join(store, "config.yaml"))
  if (config !== undefined) {
    const prefix = safePrefix(configIssuePrefix(config))
    if (prefix !== undefined) return prefix
  }
  const metadata = readSmallRegularFile(join(store, "metadata.json"))
  if (metadata !== undefined) {
    try {
      return safePrefix((JSON.parse(metadata) as { dolt_database?: unknown }).dolt_database)
    } catch {}
  }
  return undefined
}

/**
 * One sentence naming the ledger, its prefix and the directory the walk started from.
 * Repository data is JSON-quoted; the remediation sentence after it is fixed text.
 */
export function describeLedger(ledger: LedgerContext): string {
  const prefix = ledger.prefix === undefined ? "" : ` (prefix ${JSON.stringify(ledger.prefix)})`
  const state = ledger.retired ? " It is RETIRED." : ""
  return `Ledger read: ${JSON.stringify(ledger.store)}${prefix}, found by walking up from ${JSON.stringify(ledger.from)}.${state} If that is not this project's ledger, you are in the wrong repository: pass the shell tool's \`workdir\` for the right one.`
}

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Whether two store paths, the second resolved from `cwd` when relative, name one directory. */
export function sameStore(a: string, b: string, cwd: string): boolean {
  return canonical(resolve(cwd, a)) === canonical(resolve(cwd, b))
}

type Foreign = { store: string; ledgerRoot: string }

/**
 * The ledger `store`, canonicalised, when it belongs to another git repository than `cwd`.
 * `identity` maps a directory to its repository (git common dir); an unknown answer, or a
 * command directory outside any repository, is not foreign. A symlinked `.beads` is judged
 * by where it really lives.
 */
function foreignLedger(input: {
  store: string
  cwd: string
  identity: (dir: string) => string | undefined
}): Foreign | undefined {
  const store = canonical(input.store)
  const here = input.identity(input.cwd)
  // Ownership comes from the store itself: a store may be a repository root.
  const there = input.identity(store)
  if (here === undefined || there === undefined) return undefined
  // `repoIdentity` answers the directory itself outside any repository.
  if (here === input.cwd) return undefined
  if (here === there) return undefined
  return { store, ledgerRoot: dirname(store) }
}

const WRONG_PROJECT =
  "pass the shell tool's `workdir` for the right repository (and unset BEADS_DIR) instead of `cd`"

/**
 * The refusal for a `bd` write whose ledger lives in another git repository than the
 * command's directory, or `undefined` when the write is fine.
 *
 * Whether the command itself chose that ledger is the caller's question: this only
 * words the refusal, and the wording names the one override.
 */
export function ledgerRepoMismatch(input: {
  verb: string
  store: string
  cwd: string
  identity: (dir: string) => string | undefined
}): string | undefined {
  const foreign = foreignLedger(input)
  if (foreign === undefined) return undefined
  return `Refused: this \`bd ${input.verb}\` would write to the ledger ${JSON.stringify(foreign.store)}, which belongs to ${JSON.stringify(foreign.ledgerRoot)}, not to the git repository you are in (${JSON.stringify(input.cwd)}), and the command did not choose that ledger (it came from the environment, e.g. an inherited BEADS_DIR). If that is the wrong project, ${WRONG_PROJECT}. If you really mean to write to that ledger, assign BEADS_DIR in the command line itself: \`BEADS_DIR=<path> bd ${input.verb} ...\`.`
}

/**
 * The refusal for a command whose `bd` the gate cannot place (behind a launcher, in a shell
 * string or a substitution), when the ledger it would reach by default is foreign. The
 * gate cannot tell a read from a write there, so it fails closed.
 */
export function unplacedBdRefusal(input: {
  reason: string
  store: string
  cwd: string
  identity: (dir: string) => string | undefined
}): string | undefined {
  const foreign = foreignLedger(input)
  if (foreign === undefined) return undefined
  return `Refused: this command runs \`bd\` where the gate cannot place it (${input.reason}), and the ledger it would reach by default, ${JSON.stringify(foreign.store)}, belongs to ${JSON.stringify(foreign.ledgerRoot)}, not to the git repository you are in (${JSON.stringify(input.cwd)}). Run each \`bd\` as its own simple command, directly, with no launcher, shell string or substitution around it. If that is the wrong project, ${WRONG_PROJECT}. If you really mean to use that ledger, write \`BEADS_DIR=<path> bd <verb> ...\` in the command line itself.`
}
