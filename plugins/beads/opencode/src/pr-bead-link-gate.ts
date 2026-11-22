import { execFileSync } from "node:child_process"
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import type { ParsedCommand } from "@srobroek/opencode-lib/beads-shell"
import { ACCEPTED_FORMS, beadIn, MAX_BODY_BYTES, mayCreatePr, type ReadFile, readPrCreate, TRAILER_RULE } from "./pr-create-form.ts"

/**
 * A PR that names no bead is a PR nobody can trace back to a decision.
 *
 * A live ledger requires a Bead, Closes-Bead, or Bead-Id trailer.
 * A regular-file .beads/RETIRED marker opts out the nearest ledger.
 * No-Bead: is not accepted; this marker belongs to the gate, not bd.
 *
 * The gate reads one exact form of `gh pr create` (`pr-create-form.ts`) and refuses every other
 * command that may reach it, so it never has to agree with bash about what a command means.
 */

/**
 * A `gh` API call that hangs must not spend the whole tool_call budget: the harness kills a
 * gate handler at 30s, and two lookups plus the other gates have to fit inside that.
 */
const GH_TIMEOUT_MS = 10_000

export const REASON =
  "This PR names no bead. A live ledger requires a Bead: <id>, Closes-Bead: <id>, or Bead-Id: <id> trailer. To opt out, retire the nearest ledger with this gate's regular-file .beads/RETIRED marker; No-Bead: is not accepted."

const OPT_OUT =
  "To opt out, retire the nearest ledger with this gate's regular-file .beads/RETIRED marker; No-Bead: is not accepted."

export function beadsActive(dir: string): boolean {
  let current = resolve(dir)
  for (;;) {
    const beads = join(current, ".beads")
    if (existsSync(beads)) {
      try {
        return !lstatSync(join(beads, "RETIRED")).isFile()
      } catch {
        return true
      }
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

export type RepositoryControl = { kind: "controlled" } | { kind: "uncontrolled" } | { kind: "unknown"; reason: string }

/** Names the ledger the gate read; called only when the gate is about to refuse. */
export type LedgerNote = () => string | undefined

/**
 * The permission lookup deliberately fails closed: today's catch silently passed, but
 * a bead-linkage gate is safer when an unreadable repository requires operator action.
 */
export function controlledByViewerPermission(permission: unknown): boolean {
  return permission === "WRITE" || permission === "MAINTAIN" || permission === "ADMIN"
}

export type RepositoryView = { nameWithOwner?: unknown; isFork?: unknown; parent?: { nameWithOwner?: unknown } | null }

export function repositoryFromView(view: RepositoryView): string | null {
  if (typeof view.nameWithOwner !== "string") return null
  if (view.isFork === true) return typeof view.parent?.nameWithOwner === "string" ? view.parent.nameWithOwner : null
  if (view.isFork === false) return view.nameWithOwner
  return null
}

export function repositoryFromCurrentCheckout(cwd: string): string | null {
  try {
    const raw = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner,isFork,parent"], {
      cwd,
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      // Only stdin is closed, so a `gh` that wants to prompt fails instead of hanging;
      // stderr stays piped because `repositoryControlled` reports it as the refusal's cause.
      stdio: ["ignore", "pipe", "pipe"],
    })
    return repositoryFromView(JSON.parse(raw) as RepositoryView)
  } catch {
    return null
  }
}

export function repositoryControlled(repo: string | null): RepositoryControl {
  if (!repo)
    return {
      kind: "unknown",
      reason: "Repository permission could not be determined because the repository could not be identified",
    }
  try {
    const permission = execFileSync(
      "gh",
      ["repo", "view", repo, "--json", "viewerPermission", "--jq", ".viewerPermission"],
      {
        encoding: "utf8",
        timeout: GH_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim()
    return controlledByViewerPermission(permission) ? { kind: "controlled" } : { kind: "uncontrolled" }
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    return { kind: "unknown", reason: `Repository permission could not be determined: ${failure}` }
  }
}

/**
 * Whether the `gh pr create` that `repo` names (or the checkout at `cwd`, when it names none) is
 * subject to the gate: a live ledger and a repository the viewer can write. Resolved only when
 * the command does not already prove a bead, because it reaches the network.
 */
export function repositoryControlFor(repo: string | null, cwd: string): boolean | RepositoryControl {
  if (!beadsActive(cwd)) return false
  return repositoryControlled(repo ?? repositoryFromCurrentCheckout(cwd))
}

/**
 * Reads the body file `path` (already bare, relative and free of `..`) relative to `cwd`.
 *
 * The directory must be what it says: its real path equals the lexical one, so no component is a
 * symlink. The file is opened without following a symlink and without blocking (a FIFO cannot hang
 * the open), the opened descriptor must be a regular file of at most `MAX_BODY_BYTES`, and its
 * bytes must be UTF-8 without a NUL. A BOM is kept, so it stays in front of a trailer it would hide.
 */
export function readBodyFile(cwd: string): ReadFile {
  return (path) => {
    let fd: number | undefined
    try {
      const directory = resolve(realpathSync(cwd), dirname(path))
      if (realpathSync(directory) !== directory) return { ok: false, reason: "its directory is or goes through a symlink" }
      fd = openSync(join(directory, basename(path)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = fstatSync(fd)
      if (!stat.isFile()) return { ok: false, reason: "it is not a regular file" }
      if (stat.size > MAX_BODY_BYTES) return { ok: false, reason: `it is larger than ${MAX_BODY_BYTES} bytes` }
      const buffer = Buffer.alloc(MAX_BODY_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null)
        if (read === 0) break
        length += read
      }
      if (length > MAX_BODY_BYTES) return { ok: false, reason: `it is larger than ${MAX_BODY_BYTES} bytes` }
      const bytes = buffer.subarray(0, length)
      if (bytes.includes(0)) return { ok: false, reason: "it holds a NUL byte" }
      try {
        return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }
      } catch {
        return { ok: false, reason: "it is not valid UTF-8" }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      return { ok: false, reason: `it could not be opened as a regular file${code === undefined ? "" : ` (${code})`}` }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}

export type PrBeadLinkDeps = {
  /** The repository's control, asked only when the command does not already name a bead. `false` means no ledger. */
  control: (repo: string | null, cwd: string) => boolean | RepositoryControl
  note?: LedgerNote
}

export type PrBeadLinkDecision = { block: true; reason: string; resolution: string }

/**
 * Blocks a command that may create a PR unless it is an exact `gh pr create` form that names a
 * bead. Where the repository has no ledger, or the viewer cannot write to it, nothing is refused.
 */
export function decidePrBeadLink(parsed: ParsedCommand, cwd: string, deps: PrBeadLinkDeps): PrBeadLinkDecision | null {
  if (!mayCreatePr(parsed)) return null
  const read = readPrCreate(parsed.command, readBodyFile(cwd))
  if (read.kind === "form" && beadIn(read.body.text) !== undefined) return null
  const control = deps.control(read.kind === "form" ? read.repo : null, cwd)
  if (control === false || (control !== true && control.kind === "uncontrolled")) return null
  const subject =
    read.kind === "form"
      ? `${REASON} Looked at ${read.body.source}, not the branch or the title.`
      : `This command may create a PR in a form the bead gate cannot read exactly: ${read.rule}. ${OPT_OUT}`
  const unknown =
    control !== true && control.kind === "unknown"
      ? `${control.reason}. A PR must name a bead, in an exact form, while repository control is unknown. `
      : ""
  const note = deps.note?.()
  return {
    block: true,
    reason: `${unknown}${subject}${note === undefined ? "" : ` ${note}`}`,
    resolution: `${ACCEPTED_FORMS} ${TRAILER_RULE}`,
  }
}
