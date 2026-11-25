/**
 * Beads gates pi adds beyond the OpenCode plugin's shell gates:
 *
 * - claim before work: `bd close`/`done`, `bd update` (other than a claim) and `bd comment` /
 *   `bd comments add` on a bead need that bead `in_progress` under this session's actor or one
 *   of its descendants', so a parent may still close the bead its child worked;
 * - close with evidence: a close needs a `--reason` (or `--reason-file`) that carries checkable
 *   evidence (a command, a changed path, a commit or PR, or a test result);
 * - a pi-subagents child edits files in a Beads checkout only while it holds a claim there.
 *
 * Every lookup fails closed: when bd cannot answer, the work is refused, not let through.
 */

import { existsSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { flagEnabled } from "@srobroek/opencode-lib/bd-actor-gate"
import type { BdTargets } from "@srobroek/opencode-lib/bd-embedded-write-lock"
import { parse, parsedInvocations } from "@srobroek/opencode-lib/beads-shell"
import { readBounded } from "@srobroek/opencode-lib/bounded-read"
import { DEFAULT_GIT_WRAPPERS, gitWrapperPattern } from "@srobroek/opencode-lib/git-wrappers"
import { lookupSite } from "../opencode/src/bd-close-gate.ts"
import { type BdRun, envelopeData, lifecycleBdEnvironment, parseTrailingJson } from "../opencode/src/gate-admission.ts"
import { actorCovers } from "./pi-session.ts"

/** A refusal in the shell gates' shape: the gate, what is wrong and what to do. */
export type WorkRefusal = { gate: string; cause: string; resolution: string }

export const CLAIM_GATE = "bd-claim-gate"
export const EVIDENCE_GATE = "bd-close-evidence-gate"
export const WRITE_CLAIM_GATE = "write-claim-gate"

/** The work a gated invocation does to the beads it names. */
export type WorkVerb = "close" | "update" | "comment"

/** Where a close reads its reason: the text on the command line, or a file it names. */
export type CloseReason = { kind: "text"; text: string } | { kind: "file"; path: string }

/** One gated `bd` invocation: the beads it works on and where its lookup runs. */
export type WorkSite = {
  verb: WorkVerb
  /** The bead ids exactly as the command names them (bd also accepts a unique short id). */
  ids: string[]
  /** Words in an id position that the shell rewrites before bd sees them. */
  dynamic: string[]
  /** `-C`/`--db`/`--directory` words (and `--global`) to replay on the lookup. */
  dbArgs: string[]
  /** A command-local `BEADS_DIR=`, which reaches this `bd` alone. */
  beadsDir?: string
  /** The reasons a close gives, in order; empty for other verbs. */
  reasons: CloseReason[]
  /** What names this invocation among the command's resolved write targets. */
  shape: { verb: string; args: string[]; globals: string[] }
}

/** Global flags of `bd` that take a value (bd 1.3.1 `--help`). */
const GLOBAL_VALUE_FLAGS: Readonly<Record<string, true>> = {
  "--actor": true,
  "--database": true,
  "--db": true,
  "-C": true,
  "--directory": true,
  "--dolt-auto-commit": true,
  "--mem-profile": true,
}

/** The flags that take a value, per verb (bd 1.3.1 `--help`): `-a` and `-f` differ between verbs. */
const VERB_VALUE_FLAGS: Readonly<Record<WorkVerb, Readonly<Record<string, true>>>> = {
  close: { "--reason": true, "-r": true, "--reason-file": true, "--session": true },
  update: {
    "--acceptance": true,
    "--add-label": true,
    "--append-notes": true,
    "--assignee": true,
    "-a": true,
    "--await-id": true,
    "--body-file": true,
    "--defer": true,
    "--description": true,
    "-d": true,
    "--design": true,
    "--design-file": true,
    "--due": true,
    "--estimate": true,
    "-e": true,
    "--external-ref": true,
    "--if-assignee": true,
    "--if-status": true,
    "--metadata": true,
    "--notes": true,
    "--parent": true,
    "--priority": true,
    "-p": true,
    "--remove-label": true,
    "--session": true,
    "--set-labels": true,
    "--set-metadata": true,
    "--spec-id": true,
    "--status": true,
    "-s": true,
    "--title": true,
    "--type": true,
    "-t": true,
    "--unset-metadata": true,
  },
  comment: { "--file": true, "-f": true, "--author": true, "-a": true },
}

const DB_FLAGS: Readonly<Record<string, true>> = { "--db": true, "-C": true, "--directory": true }

/** A word the shell rewrites: a parameter, command or arithmetic expansion, or a backtick. */
const DYNAMIC = /[$`]/

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** The gated verb an invocation is, and how many positional words precede its ids. */
function workVerb(verb: string, args: readonly string[], verbAt: number): { verb: WorkVerb; skip: number } | undefined {
  switch (verb) {
    case "close":
    case "done":
      return { verb: "close", skip: 0 }
    case "update":
      // A claim is how work starts; bd itself refuses one on a bead another actor holds.
      return flagEnabled(args.slice(verbAt + 1), ["--claim"]) ? undefined : { verb: "update", skip: 0 }
    case "comment":
      return { verb: "comment", skip: 0 }
    case "comments": {
      const sub = args.slice(verbAt + 1).find((word) => !word.startsWith("-"))
      return sub === "add" ? { verb: "comment", skip: 1 } : undefined
    }
    default:
      return undefined
  }
}

/** Every gated invocation in `command`, nested children included. An unparseable command has none here. */
export function workSites(command: string): WorkSite[] {
  const parsed = parse(command)
  if (parsed.unknown) return []
  const sites: WorkSite[] = []
  for (const invocation of parsedInvocations(parsed)) {
    if (invocation.verb === undefined) continue
    const { args, globals } = invocation
    if (flagEnabled(globals, ["--help", "-h"]) || flagEnabled(args, ["--help", "-h"])) continue
    const verbAt = globals.length
    const kind = workVerb(invocation.verb, args, verbAt)
    if (kind === undefined) continue
    const valueFlags = VERB_VALUE_FLAGS[kind.verb]
    const dbArgs: string[] = []
    for (let i = 0; i < verbAt; i++) {
      const token = args[i] ?? ""
      const flag = token.split("=", 1)[0] ?? ""
      if (DB_FLAGS[flag] === true) {
        dbArgs.push(token)
        if (!token.includes("=") && args[i + 1] !== undefined) dbArgs.push(args[++i] as string)
      } else if (token === "--global") dbArgs.push(token)
      else if (GLOBAL_VALUE_FLAGS[flag] === true && !token.includes("=")) i++
    }
    const positionals: string[] = []
    const reasons: CloseReason[] = []
    for (let i = verbAt + 1; i < args.length; i++) {
      const token = args[i] ?? ""
      if (!token.startsWith("-") || token === "-") {
        positionals.push(token)
        continue
      }
      const flag = token.split("=", 1)[0] ?? token
      const inline = token.includes("=")
      const value = inline ? token.slice(flag.length + 1) : args[i + 1]
      if (DB_FLAGS[flag] === true) {
        dbArgs.push(token)
        if (!inline && value !== undefined) dbArgs.push(value)
      } else if (token === "--global") dbArgs.push(token)
      if (kind.verb === "close" && (flag === "--reason" || flag === "-r")) reasons.push({ kind: "text", text: value ?? "" })
      if (kind.verb === "close" && flag === "--reason-file") reasons.push({ kind: "file", path: value ?? "" })
      if (!inline && (valueFlags[flag] === true || GLOBAL_VALUE_FLAGS[flag] === true)) i++
    }
    const named = positionals.slice(kind.skip)
    // A comment's first positional is the bead; the rest is its text.
    const idWords = kind.verb === "comment" ? named.slice(0, 1) : named
    const beadsDir = leadingAssignment(invocation.position.argv, "BEADS_DIR")
    sites.push({
      verb: kind.verb,
      ids: idWords.filter((word) => !DYNAMIC.test(word)),
      dynamic: idWords.filter((word) => DYNAMIC.test(word)),
      dbArgs,
      ...(beadsDir === undefined ? {} : { beadsDir }),
      reasons,
      shape: { verb: invocation.verb, args: args.slice(verbAt + 1), globals },
    })
  }
  return sites
}

/** The value of the last `NAME=` assignment a command position starts with. */
function leadingAssignment(argv: readonly string[], name: string): string | undefined {
  const end = argv.findIndex((word) => !ASSIGNMENT.test(word))
  return argv
    .slice(0, end < 0 ? argv.length : end)
    .findLast((word) => word.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

/**
 * Evidence a close reason can carry, after the bar `rule://beads-evidence` sets: the command run,
 * the file path changed, or the test result. Restating the title matches none of them.
 */
const EVIDENCE: readonly RegExp[] = [
  /`[^`\n]+`/, // a quoted command or path
  /(?:^|[\s("'=:])(?:\.{1,2}|~)?\/[\w@.+-]+/, // a rooted path: /tmp/x, ./x, ../x, ~/x
  /\b[\w@.+-]+\/[\w@.+-]+\/[\w@.+/-]*/, // a path two directories deep: plugins/beads/x
  /\b[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|md|json|jsonl|ya?ml|toml|sh|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|css|scss|html|sql|txt|lock|xml|gradle|tf)\b/i,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i, // a commit
  /\bhttps?:\/\/\S+/i,
  /(?:^|[\s(])(?:#|!)\d+\b|\b(?:PR|MR|pull request|merge request)\s*[#!]?\d+\b/i,
  /\b\d+\s+(?:pass(?:ed|es|ing)?|fail(?:ed|s|ures?|ing)?|tests?|specs?|checks?|errors?)\b/i,
  /\bexit(?:ed)?\s+(?:code\s+|status\s+)?\d+\b/i,
  /\bgo\s+(?:test|build|vet|run)\b/,
]

/** A command run with its subcommand (`bun test`, `git push`), where git is any of `gitWrappers`. */
const commandEvidence = (gitWrappers: readonly string[]): RegExp =>
  new RegExp(
    `\\b(?:bun|bunx|npm|npx|pnpm|yarn|cargo|pytest|python3?|uv|just|make|tsc|biome|eslint|gh|${gitWrapperPattern(gitWrappers)}|bd|wt|pi)\\s+[\\w-]+`,
  )

/** Whether a reason carries at least one piece of checkable evidence; `gitWrappers` name the git commands. */
export function hasCheckableEvidence(text: string, gitWrappers: readonly string[] = DEFAULT_GIT_WRAPPERS): boolean {
  return text.trim() !== "" && (EVIDENCE.some((pattern) => pattern.test(text)) || commandEvidence(gitWrappers).test(text))
}

const EVIDENCE_RESOLUTION =
  'give the close a factual --reason naming the evidence, for example `bd close ID --reason "bun test x.test.ts: 12 pass; changed src/x.ts"`, or --reason-file with that text'

/** Why a close's reasons do not meet the evidence bar, or `undefined` when they do; `gitWrappers` name the git commands. */
export function closeEvidenceRefusal(
  reasons: readonly CloseReason[],
  cwd: string,
  gitWrappers: readonly string[] = DEFAULT_GIT_WRAPPERS,
): string | undefined {
  if (reasons.length === 0) return "bd close has no --reason, so the close records no evidence"
  for (const reason of reasons) {
    if (reason.kind === "file") {
      if (reason.path === "" || reason.path === "-" || DYNAMIC.test(reason.path))
        return "bd close reads its --reason-file from stdin or a path the shell computes, so its evidence cannot be checked first"
      const read = readBounded(resolve(cwd, reason.path))
      if (read.kind !== "text") return `bd close --reason-file ${JSON.stringify(reason.path)} is not a small readable file`
      if (!hasCheckableEvidence(read.text, gitWrappers)) return `the reason in ${JSON.stringify(reason.path)} carries no checkable evidence`
      continue
    }
    if (!hasCheckableEvidence(reason.text, gitWrappers))
      return `the close reason ${JSON.stringify(reason.text.slice(0, 120))} carries no checkable evidence (a command run, a changed path, a commit or PR, or a test result)`
  }
  return undefined
}

/** One bead as `bd show --json` reports it. */
export type IssueRow = { id: string; status: string; assignee: string }

/** The issues in bd's `--json` output (envelope or bare), or `undefined` when it is not an issue list. */
export function issueRows(output: string): IssueRow[] | undefined {
  const data = envelopeData(parseTrailingJson(output))
  if (data === null) return []
  const list = Array.isArray(data) ? data : data !== undefined && typeof data === "object" ? [data] : undefined
  if (list === undefined) return undefined
  const rows: IssueRow[] = []
  for (const item of list) {
    const row = item as { id?: unknown; status?: unknown; assignee?: unknown } | null
    if (row === null || typeof row !== "object" || typeof row.id !== "string" || typeof row.status !== "string") return undefined
    rows.push({ id: row.id, status: row.status, assignee: typeof row.assignee === "string" ? row.assignee.trim() : "" })
  }
  return rows
}

/** The row bd returned for a requested id: the same id, or the full id of a short one. */
function rowFor(rows: readonly IssueRow[], id: string): IssueRow | undefined {
  return rows.find((row) => row.id === id) ?? rows.find((row) => row.id.endsWith(`-${id}`))
}

/** The beads among `ids` this actor may not work on, each with why; empty when it may work on all. */
export function unclaimedBeads(actor: string, ids: readonly string[], rows: readonly IssueRow[]): string[] {
  const refused: string[] = []
  for (const id of ids) {
    const row = rowFor(rows, id)
    if (row === undefined) refused.push(`${id} (not found)`)
    else if (row.status !== "in_progress") refused.push(`${row.id} (${row.status}${row.assignee === "" ? "" : `, ${row.assignee}`})`)
    else if (row.assignee === "") refused.push(`${row.id} (in_progress, unassigned)`)
    else if (!actorCovers(actor, row.assignee)) refused.push(`${row.id} (held by ${row.assignee})`)
  }
  return refused
}

export type WorkGateDeps = {
  /** This session's actor. */
  actor: string
  /** The environment the command's shell starts from, store pin applied. */
  env: NodeJS.ProcessEnv
  deadline: number
  run: BdRun
  /** The command's write targets, as the write lock resolves them. */
  targets: BdTargets
  /** Command names a close reason may cite as git (the `gitWrappers` option); only `git` when absent. */
  gitWrappers?: readonly string[]
}

/** Decide the claim and evidence gates for one bash command; `undefined` lets it through. */
export async function decideBeadWork(command: string, cwd: string, deps: WorkGateDeps): Promise<WorkRefusal | undefined> {
  const sites = workSites(command)
  for (const site of sites) {
    const named = `bd ${site.shape.verb}`
    if (site.dynamic.length > 0)
      return {
        gate: CLAIM_GATE,
        cause: `${named} names its bead through ${site.dynamic.join(", ")}, which the shell computes, so its claim cannot be checked first`,
        resolution: "name the bead id literally",
      }
    if (site.ids.length === 0)
      return { gate: CLAIM_GATE, cause: `${named} names no bead id, so its claim cannot be checked`, resolution: "name the bead id literally" }
  }
  for (const site of sites) {
    if (site.verb !== "close") continue
    const target = deps.targets.get(site.shape)
    const where = target !== undefined && !("unresolved" in target) ? target.cwd : cwd
    const refusal = closeEvidenceRefusal(site.reasons, where, deps.gitWrappers)
    if (refusal !== undefined) return { gate: EVIDENCE_GATE, cause: refusal, resolution: EVIDENCE_RESOLUTION }
  }
  for (const site of sites) {
    const named = `bd ${site.shape.verb}`
    let lookup: { cwd: string; env: NodeJS.ProcessEnv }
    try {
      lookup = lookupSite(site, cwd, deps.env, deps.targets.get(site.shape))
    } catch {
      return {
        gate: CLAIM_GATE,
        cause: `${named} selects its store only at run time, so its claim cannot be checked first`,
        resolution: "run the bd command from the checkout it belongs to, without a shell-computed BEADS_DIR",
      }
    }
    const result = await deps.run(
      lookup.cwd,
      [...site.dbArgs, "show", ...site.ids, "--json"],
      deps.deadline,
      lifecycleBdEnvironment(lookup.cwd, lookup.env),
    )
    if ("failure" in result)
      return {
        gate: CLAIM_GATE,
        cause: `the claim on ${site.ids.join(", ")} could not be read (${result.failure})`,
        resolution: "retry once bd answers; the command was refused without proof of the claim",
      }
    const rows = issueRows(result.output)
    if (rows === undefined)
      return {
        gate: CLAIM_GATE,
        cause: `bd show printed no issue list for ${site.ids.join(", ")}, so the claim cannot be checked`,
        resolution: "retry once bd answers; the command was refused without proof of the claim",
      }
    const refused = unclaimedBeads(deps.actor, site.ids, rows)
    if (refused.length > 0)
      return {
        gate: CLAIM_GATE,
        cause: `${named} works on ${refused.join(", ")}, which this session (${deps.actor}) has not claimed`,
        resolution:
          "claim the bead first with `bd update ID --claim`; a bead another session holds is worked and closed by that session or a session above it",
      }
  }
  return undefined
}

/** The nearest existing directory at or above the target of a file write. */
export function existingDirectory(path: string): string {
  let dir = dirname(path)
  for (;;) {
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) return dir
    } catch {
      // Treat an unreadable entry like a missing one and keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
}

/** The bd call asking whether `actor` holds any claim: one row is enough. */
export const heldClaimArgs = (actor: string): string[] => [
  "list",
  "--assignee",
  actor,
  "--status",
  "in_progress",
  "--limit",
  "1",
  "--json",
]

/** Whether bd's answer to {@link heldClaimArgs} lists a claim, or `undefined` when it is unreadable. */
export function holdsClaim(output: string): boolean | undefined {
  const rows = issueRows(output)
  return rows === undefined ? undefined : rows.length > 0
}

/** The refusal for a child's file write in `store` while it holds no claim there. */
export function writeClaimRefusal(path: string, store: string, actor: string, failure?: string): WorkRefusal {
  return failure === undefined
    ? {
        gate: WRITE_CLAIM_GATE,
        cause: `this subagent (${actor}) holds no claim in ${store}, so it may not change ${path} yet`,
        resolution: "claim your bead with `bd update ID --claim` before editing files in this checkout",
      }
    : {
        gate: WRITE_CLAIM_GATE,
        cause: `whether this subagent (${actor}) holds a claim in ${store} could not be read (${failure})`,
        resolution: "retry once bd answers; the write was refused without proof of a claim",
      }
}
