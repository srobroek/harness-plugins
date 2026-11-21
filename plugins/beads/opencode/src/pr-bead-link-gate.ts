import { execFileSync } from "node:child_process"
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import {
  commandSegments,
  interpreterCommandString,
  invocation,
  type ParsedCommand,
  type Token,
  tokenize,
} from "@srobroek/opencode-lib/beads-shell"
import { commandWords } from "@srobroek/opencode-lib/command-words"
import { bytesToString, expandAnsiCQuotes, stringToBytes } from "./ansi-c-words.ts"

/**
 * A PR that names no bead is a PR nobody can trace back to a decision.
 *
 * A live ledger requires a Bead, Closes-Bead, or Bead-Id trailer.
 * A regular-file .beads/RETIRED marker opts out the nearest ledger.
 * No-Bead: is not accepted; this marker belongs to the gate, not bd.
 */

const MAX_COMMAND_LENGTH = 64_000
const BEAD_REF = /(?:^|\s)(?:Bead|Closes-Bead|Bead-Id):\s*[A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9]+/i

/**
 * A `gh` API call that hangs must not spend the whole tool_call budget: the harness kills a
 * gate handler at 30s, and two lookups plus the other gates have to fit inside that.
 */
const GH_TIMEOUT_MS = 10_000

/** Flags whose following token is a value, so a `--body` inside one is not the body. */
const VALUE_FLAGS: Record<string, true> = {
  "--title": true,
  "-t": true,
  "--base": true,
  "-B": true,
  "--head": true,
  "-H": true,
  "--repo": true,
  "-R": true,
  "--reviewer": true,
  "-r": true,
  "--assignee": true,
  "-a": true,
  "--label": true,
  "-l": true,
  "--project": true,
  "-p": true,
  "--milestone": true,
  "-m": true,
  "--body-file": true,
  "-F": true,
  "--template": true,
  "-T": true,
}

export const REASON =
  "This PR names no bead. A live ledger requires a Bead: <id>, Closes-Bead: <id>, or Bead-Id: <id> trailer. To opt out, retire the nearest ledger with this gate's regular-file .beads/RETIRED marker; No-Bead: is not accepted."

function withLedger(reason: string, note: LedgerNote | undefined): string {
  const text = note?.()
  return text === undefined ? reason : `${reason} ${text}`
}

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

/**
 * Where the gate read a PR body, so a refusal can say what it looked at. `unreadable` is set
 * instead of `text` when a `--body-file` exists on the command line but its content could not be read.
 */
export type BodyRead = { source: string } & (
  | { text: string; unreadable?: undefined; cause?: undefined }
  | { text?: undefined; unreadable: string; cause?: unknown }
)

/** What reading a `--body-file` found: its text, or why the gate cannot see it (and the error behind that). */
export type BodyFile = { text: string } | { problem: string; cause?: unknown }

/** A refusal: the reason shown, and the underlying error when there was one. */
export type Refusal = { block: true; reason: string; cause?: unknown }

/**
 * The directories a command runs in, outermost first (each relative one resolves against the one
 * before it), or `"unknown"` when one cannot be worked out statically (`env -C "$DIR"`).
 */
export type WorkingDirectories = readonly string[] | "unknown"

/**
 * Reads a `--body-file` path. `directories` are the working directories that wrappers
 * (`env -C DIR`, here or in an enclosing `sh -c`) give the command, outermost first; a relative
 * path resolves against them in order.
 */
export type ReadBodyFile = (path: string, directories: readonly string[]) => BodyFile

/** A directory the gate can resolve statically: no expansion, no `~`, no `-`. */
function literalDirectory(directory: string): boolean {
  return directory !== "-" && !directory.startsWith("~") && !/[$`*?[]/.test(directory)
}

/** Joins what an enclosing command runs in with what this command's wrappers add. */
function effectiveDirectories(enclosing: WorkingDirectories, own: readonly string[]): WorkingDirectories {
  if (enclosing === "unknown" || !own.every(literalDirectory)) return "unknown"
  return [...enclosing, ...own]
}

/** The `--body` value of one `gh pr create` segment; `--body-file` is not read. */
export function bodyOfGhCreate(segment: string): string | null {
  return readBodyOfGhCreate(segment)?.text ?? null
}

/**
 * The body of one `gh pr create` segment and where it came from: null when the segment
 * creates no PR, and null when it creates one whose body is not visible here (`--fill`,
 * an editor session, stdin, or a `--body-file` when `readFile` is not supplied). A `--body-file` that
 * `readFile` cannot read comes back as `unreadable`, never as a silent null.
 */
export function readBodyOfGhCreate(
  segment: string,
  readFile?: ReadBodyFile,
  enclosing: WorkingDirectories = [],
): BodyRead | null {
  const expanded = expandAnsiCQuotes(segment)
  const tokens = invocation(expanded, ["gh", "pr", "create"])
  if (!tokens) return null
  let body: string | null = null
  let file: string | null = null
  for (let i = 3; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    if (!token.quoted && token.value === "--") break
    if (token.quoted) continue
    if (token.value === "--body-file" || token.value === "-F") {
      file = tokens[i + 1]?.value ?? null
      i++
      continue
    }
    if (token.value.startsWith("--body-file=")) {
      file = token.value.slice("--body-file=".length)
      continue
    }
    if (VALUE_FLAGS[token.value]) {
      i++
      continue
    }
    if (token.value === "--body" || token.value === "-b") {
      body = tokens[i + 1]?.value ?? ""
      i++
      continue
    }
    if (token.value.startsWith("--body=")) {
      body = token.value.slice("--body=".length)
      continue
    }
    // Short flags cluster, and `gh` accepts a value attached to the last one:
    // `-db'no bead'` is a draft whose body is `no bead`, not a bodyless call.
    const cluster = /^-([A-Za-z]*)b(=?)(.*)$/.exec(token.value)
    if (cluster && !token.value.startsWith("--")) {
      const attached = cluster[3] ?? ""
      body = attached.length > 0 || cluster[2] === "=" ? attached : (tokens[++i]?.value ?? "")
    }
  }
  if (body !== null) return { text: body, source: "the --body text" }
  if (file !== null && file !== "-" && readFile) {
    const source = `--body-file ${bytesToString(stringToBytes(file))}`
    const directories = effectiveDirectories(enclosing, commandWords(tokenize(expanded).map((token) => token.value)).directories)
    if (directories === "unknown" && !isAbsolute(file)) {
      return { unreadable: "the directory it is relative to cannot be worked out from a wrapper's `--chdir`/`-C` or an enclosing `sh -c`", source }
    }
    const read = readFile(file, directories === "unknown" ? [] : directories)
    return "text" in read ? { text: read.text, source } : { unreadable: read.problem, cause: read.cause, source }
  }
  return null
}

export type RepositoryControl = { kind: "controlled" } | { kind: "uncontrolled" } | { kind: "unknown"; reason: string }

/** What `decideCommand` may read, and where the command runs. */
export type BodyOptions = { readFile?: ReadBodyFile; directories?: WorkingDirectories }

/** Names the ledger the gate read; called only when the gate is about to refuse. */
export type LedgerNote = () => string | undefined

export function decidePrCreate(
  body: string | null,
  active: boolean | RepositoryControl,
  note?: LedgerNote,
  source?: string,
): { block: true; reason: string } | null {
  if (active === false || (typeof active !== "boolean" && active.kind === "uncontrolled")) return null
  if (body === null) return null
  if (BEAD_REF.test(body)) return null
  const looked = source === undefined ? "" : ` Looked at ${source}, not the branch or the title.`
  if (typeof active !== "boolean" && active.kind === "unknown") {
    return {
      block: true,
      reason: withLedger(`${active.reason}. This PR must name a bead while repository control is unknown.${looked}`, note),
    }
  }
  return { block: true, reason: withLedger(`${REASON}${looked}`, note) }
}

/**
 * A `--body-file` the gate cannot read hides the body, so a PR in a gated repository is
 * refused rather than passed unseen.
 */
function decideUnreadableBody(read: BodyRead, active: boolean | RepositoryControl, note?: LedgerNote): Refusal | null {
  if (active === false || (typeof active !== "boolean" && active.kind === "uncontrolled")) return null
  const reason = `Could not read ${read.source}: ${read.unreadable}. The gate cannot check it for a Bead: trailer, so it refuses. Fix the path, or pass the text with --body.`
  return { block: true, reason: withLedger(reason, note), cause: read.cause }
}

/**
 * Blocks when any `gh pr create` in the command carries neither a bead nor a truthful no-bead reason.
 *
 * `active` is resolved per segment and only for a segment whose answer actually depends on it,
 * because resolving it reaches the network and this decides every bash call in the session.
 */
export function decideCommand(
  command: string,
  active: boolean | RepositoryControl | ((segment: string) => boolean | RepositoryControl),
  note?: LedgerNote,
  options: BodyOptions = {},
): Refusal | null {
  if (command.length > MAX_COMMAND_LENGTH) return null
  const segments = commandSegments(command)
  // An earlier segment of a chain may write the body file, so it is read only from a lone command.
  const readFile = segments.length === 1 ? options.readFile : undefined
  for (const segment of segments) {
    const read = readBodyOfGhCreate(segment, readFile, options.directories)
    if (read?.unreadable !== undefined) {
      const refusal = decideUnreadableBody(read, typeof active === "function" ? active(segment) : active, note)
      if (refusal) return refusal
      continue
    }
    const body = read?.text ?? null
    // A segment that creates no PR, and one whose body already names a bead, decide null for
    // every `active`. Resolving `active` ahead of them spent two synchronous `gh` API calls per
    // segment on every bash call, so a slow `gh` exhausted the handler's budget.
    if (body === null || BEAD_REF.test(body)) continue
    const decision = decidePrCreate(body, typeof active === "function" ? active(segment) : active, note, read?.source)
    if (decision) return decision
  }
  return null
}

/**
 * The permission lookup deliberately fails closed: today's catch silently passed, but
 * a bead-linkage gate is safer when an unreadable repository requires operator action.
 */
export function controlledByViewerPermission(permission: unknown): boolean {
  return permission === "WRITE" || permission === "MAINTAIN" || permission === "ADMIN"
}

export function repositoryFromGhCreate(command: string): string | null {
  const tokens = invocation(command, ["gh", "pr", "create"])
  if (!tokens) return null
  let selected: string | null = null
  for (let i = 3; i < tokens.length; i += 1) {
    const token = tokens[i] as Token
    const value = token.value
    if (value === "--repo" || value === "-R") {
      const next = tokens[++i]
      selected = next?.value ?? null
    } else if (value.startsWith("--repo=")) {
      selected = value.slice(7)
    } else if (value.startsWith("-R") && value.length > 2) {
      selected = value.slice(2)
    } else if (/^-[A-Za-z]*R.+$/.test(value) && value.length > 3) {
      selected = value.slice(value.indexOf("R") + 1)
    } else if (value.startsWith("-") && VALUE_FLAGS[value] === true) {
      i += 1
    }
  }
  return selected && /^(?:[^/\s]+\/)?[^/\s]+\/[^/\s]+$/.test(selected) ? selected : null
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
 * The directories a nested script runs in. A child that is the `-c` script of one of the parent's
 * commands (`env --chdir=sub sh -c '...'`) runs where that command's wrappers put it, on top of the
 * parent's own directories. Any other child (a substitution, `eval`, `xargs`, a here-document) has
 * no command to read the wrappers from, so a parent that has wrapper directories makes it "unknown".
 */
function childDirectories(parent: ParsedCommand, child: ParsedCommand, inherited: WorkingDirectories): WorkingDirectories {
  if (inherited === "unknown") return "unknown"
  const words = parent.commands.map((position) => commandWords(position.argv))
  const owner = words.find((entry) => interpreterCommandString(entry.argv) === child.command)
  if (owner) return effectiveDirectories(inherited, owner.directories)
  return words.some((entry) => entry.directories.length > 0) ? "unknown" : inherited
}

/**
 * Decide the whole command line and every recursively executed child. Segments are read
 * from source text, not from joined argv, so a quoted `--body` keeps its spaces. Each child is
 * read in the directory its enclosing wrappers give it, relative to its parent's.
 */
export function decideCommandParsed(
  parsed: ParsedCommand,
  active: boolean | RepositoryControl | ((segment: string) => boolean | RepositoryControl),
  note?: LedgerNote,
  options?: BodyOptions,
): Refusal | null {
  const decision = decideCommand(parsed.command, active, note, options)
  if (decision) return decision
  for (const child of parsed.nested) {
    const directories = childDirectories(parsed, child, options?.directories ?? [])
    const nested = decideCommandParsed(child, active, note, { ...options, directories })
    if (nested) return nested
  }
  return null
}

/**
 * The path `path` names from `cwd` through `directories`, as bytes: `$'\\xff.md'` is a file no UTF-8
 * string can spell. Each byte travels as one Latin-1 character, so `resolve` joins and normalises
 * the parts without ever decoding them.
 */
function resolveBytes(cwd: string, directories: readonly string[], path: string): Buffer {
  const raw = [cwd, ...directories, path].map((part) => stringToBytes(part).toString("latin1"))
  return Buffer.from(resolve(...raw), "latin1")
}

/**
 * Reads a body file relative to `cwd` and any wrapper directories. Only a regular file of at most
 * the command cap is read: the target is opened without blocking (so a FIFO cannot hang the open),
 * the opened descriptor is checked (so a symlink is judged by its target), and the read is bounded.
 * Anything else comes back as a problem the gate reports; it is never read as an empty body.
 */
export function bodyFileReader(cwd: string): ReadBodyFile {
  return (path, directories) => {
    let fd: number | undefined
    try {
      fd = openSync(resolveBytes(cwd, directories, path), constants.O_RDONLY | constants.O_NONBLOCK)
      if (!fstatSync(fd).isFile()) return { problem: "it is not a regular file" }
      const buffer = Buffer.alloc(MAX_COMMAND_LENGTH + 1)
      let length = 0
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, null)
        if (read === 0) break
        length += read
      }
      return length > MAX_COMMAND_LENGTH
        ? { problem: `it is larger than ${MAX_COMMAND_LENGTH} bytes` }
        : { text: buffer.toString("utf8", 0, length) }
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error), cause: error }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}

/**
 * Whether a `gh pr create` segment from `cwd` is subject to the gate: a live ledger and
 * a repository the viewer can write. Resolved only for segments whose body names no bead.
 */
export function repositoryControlFor(segment: string, cwd: string): boolean | RepositoryControl {
  if (!beadsActive(cwd)) return false
  return repositoryControlled(repositoryFromGhCreate(segment) ?? repositoryFromCurrentCheckout(cwd))
}
