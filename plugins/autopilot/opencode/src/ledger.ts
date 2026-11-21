/**
 * Which beads ledger (`.beads` directory) a run owns. The decisions are pure; the file system is
 * behind `LedgerHost`, so tests drive them without a disk.
 */

import { realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { sessionPinFor } from "@srobroek/opencode-lib/beads-store"
import { readBounded } from "@srobroek/opencode-lib/bounded-read"
import type { Scope } from "./args.ts"

export type LedgerHost = {
  /** The ledger a session in `directory` resolves with no inherited `BEADS_DIR`, or `undefined`. */
  sessionLedger(directory: string): string | undefined
  /** Whether `path` is a ledger directory. */
  isLedger(path: string): boolean
  /** The canonical spelling of `path`. */
  canonical(path: string): string
  /** The text of the `routes.jsonl` in `ledger`, if it has one. */
  readRoutes(ledger: string): string | undefined
}

export type LedgerResult = { ok: true; ledger: string } | { ok: false; error: string }

/** The prefix of a bead id: `opencode-plugins-74r.2` -> `opencode-plugins`. */
export function beadPrefix(id: string): string | undefined {
  const base = id.replace(/(\.\d+)+$/, "")
  const dash = base.lastIndexOf("-")
  return dash > 0 ? base.slice(0, dash) : undefined
}

/** `routes.jsonl` as prefix (without its trailing dash) -> path, relative to the checkout that holds the ledger. */
export function parseRoutes(text: string): Map<string, string> {
  const routes = new Map<string, string>()
  for (const line of text.split("\n")) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const { prefix, path } = (value ?? {}) as { prefix?: unknown; path?: unknown }
    if (typeof prefix === "string" && prefix !== "" && typeof path === "string" && path !== "") routes.set(prefix.replace(/-$/, ""), path)
  }
  return routes
}

/** The ledger `ledger`'s routes assign to `prefix`, `null` when none does, or `undefined` when the route leads nowhere. */
function routedLedger(ledger: string, prefix: string, host: LedgerHost): string | null | undefined {
  const text = host.readRoutes(ledger)
  const path = text === undefined ? undefined : parseRoutes(text).get(prefix)
  if (path === undefined) return null
  const target = host.canonical(join(resolve(dirname(ledger), path), ".beads"))
  return host.isLedger(target) ? target : undefined
}

/**
 * The ledger a run arms on: the explicit one (a ledger directory or the checkout holding it), else
 * the one a bead scope's prefix routes to, else the session directory's. Never a guess: an explicit
 * path or a route that is no ledger refuses.
 */
export function resolveLedger(input: { explicit?: string; scope: Scope; directory: string }, host: LedgerHost): LedgerResult {
  if (input.explicit !== undefined && input.explicit.trim() !== "") {
    const path = resolve(input.directory, input.explicit.trim())
    for (const candidate of [path, join(path, ".beads")]) if (host.isLedger(candidate)) return { ok: true, ledger: host.canonical(candidate) }
    return { ok: false, error: `setup.ledger ${input.explicit} is not a beads ledger (a .beads directory, or the checkout that holds one)` }
  }
  const session = host.sessionLedger(input.directory)
  if (session === undefined) return { ok: false, error: `no beads ledger found for ${input.directory}; pass setup.ledger` }
  const base = host.canonical(session)
  if (input.scope.kind !== "bead") return { ok: true, ledger: base }
  const prefix = beadPrefix(input.scope.id)
  const routed = prefix === undefined ? null : routedLedger(base, prefix, host)
  if (routed === undefined) return { ok: false, error: `the route for ${input.scope.id} in ${base} leads to no ledger; pass setup.ledger` }
  return { ok: true, ledger: routed ?? base }
}

/** Why a write naming `beadId` would leave `ledger`, or `undefined` when it stays. */
export function foreignBead(ledger: string, beadId: string, host: LedgerHost): string | undefined {
  const prefix = beadPrefix(beadId)
  if (prefix === undefined) return undefined
  const routed = routedLedger(ledger, prefix, host)
  if (routed === null || routed === ledger) return undefined
  return routed === undefined ? `${beadId} routes to no ledger` : `${beadId} belongs to ${routed}, not this run's ledger ${ledger}`
}

/** The environment a `bd` run for `ledger` gets: its ledger, whatever the session inherited. */
export const ledgerEnv = (ledger: string): Record<string, string> => ({ BEADS_DIR: ledger })

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The real file system. */
export const fsLedgerHost: LedgerHost = {
  sessionLedger: (directory) => sessionPinFor(directory),
  isLedger: (path) => isAbsolute(path) && isDir(path) && (isDir(join(path, "embeddeddolt")) || readBounded(join(path, "metadata.json")).kind === "text" || readBounded(join(path, "config.yaml")).kind === "text"),
  canonical: (path) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  },
  readRoutes: (ledger) => {
    const read = readBounded(join(ledger, "routes.jsonl"))
    return read.kind === "text" ? read.text : undefined
  },
}
