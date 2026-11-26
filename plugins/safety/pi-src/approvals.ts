/**
 * How safety on pi settles a check that asks, and the `/safety` command that steers it. In `deny`
 * mode, the default, such a call is refused under a short refusal ID, and the user can permit that
 * one refusal's command once with `/safety allow <id>`; in `ask` mode a dialog decides. Mode,
 * refusals and permits live in one extension instance's memory: a new session, a reload and a
 * subagent child each start clean.
 */

import { randomInt } from "node:crypto"

/** How a check that asks is settled: refused, or put to the user in a dialog. */
export type ApprovalMode = "deny" | "ask"

/** How long a refusal can be allowed, and then how long its permit waits for the command. */
export const PERMIT_MS = 30 * 60 * 1000

/** `safety.approvals` in pi's settings: `"ask"` opens dialogs; anything else refuses. */
export function readApprovalMode(value: unknown): ApprovalMode {
  return value === "ask" ? "ask" : "deny"
}

/** A `bash` call as the gates saw it: the command after any rewrite, and the session directory. */
export type Call = { command: string; cwd: string }

/** A `/safety` reply, shown with `ctx.ui.notify`. */
export type Notice = { text: string; level: "info" | "warning" | "error" }

/** Refusal IDs are four characters of the RFC 4648 base32 alphabet, which has no 0, 1, 8 or 9. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"

export const SUBCOMMANDS = ["ask", "deny", "allow"] as const

export const COMMAND_DESCRIPTION = "Show or switch safety approvals (ask|deny), or allow one refused command once"

export const NO_UI_COMMAND =
  "safety: /safety does nothing in a session without a UI (print or JSON mode, or a subagent child). There every command a check asks about is refused."

export const NOTHING_TO_ALLOW = "safety: no refused command in the last 30 minutes is waiting to be allowed."

export const USAGE =
  "safety: use /safety to show the approval mode, /safety ask or /safety deny to switch it, /safety allow to list refused commands, or /safety allow <id> to permit one once."

const MODE_EFFECT: Record<ApprovalMode, string> = {
  deny: "a command a check asks about is refused under an ID, and /safety allow <id> permits that command once.",
  ask: "a command a check asks about opens a dialog.",
}

export type Approvals = {
  /** How this session settles asks: the settings value until `/safety ask|deny` changes it. */
  readonly mode: ApprovalMode
  /** Notes a call refused in `deny` mode and returns its refusal ID. A pending refusal of the same call keeps its ID. */
  refuse(call: Call): string
  /** Whether `call` is the command of an allowed, unexpired refusal. A match spends that permit. */
  spend(call: Call): boolean
  /** `/safety <args>`, typed by the user. A session without a UI changes nothing. */
  command(args: string, hasUI: boolean): Notice
  /** Drops every refusal and permit and restores the settings mode, at session end. */
  reset(): void
}

type Refusal = Call & { id: string; refusedAt: number; state: "refused" | "allowed" | "spent"; allowedUntil: number }

const minutes = (ms: number) => (ms < 60_000 ? "under a minute" : `${Math.floor(ms / 60_000)} min`)

export function createApprovals(configured: ApprovalMode, now: () => number = Date.now): Approvals {
  let mode = configured
  // Every refusal of the session by ID. Spent ones stay, so no ID is issued twice.
  const refusals = new Map<string, Refusal>()

  const pending = (refusal: Refusal) => refusal.state === "refused" && now() < refusal.refusedAt + PERMIT_MS
  const allowed = (refusal: Refusal) => refusal.state === "allowed" && now() < refusal.allowedUntil
  const matches = (refusal: Refusal, call: Call) => refusal.command === call.command && refusal.cwd === call.cwd
  const find = (test: (refusal: Refusal) => boolean) => [...refusals.values()].find(test)

  const newId = () => {
    for (;;) {
      const id = Array.from({ length: 4 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("")
      if (!refusals.has(id)) return id
    }
  }

  const status = (): Notice => {
    const lines = [`safety: approvals are ${mode} in this session (settings: ${configured}): ${MODE_EFFECT[mode]}`]
    for (const refusal of refusals.values())
      if (allowed(refusal))
        lines.push(`Allowed once (${refusal.id}), expiring in ${minutes(refusal.allowedUntil - now())}, in ${refusal.cwd}:\n${refusal.command}`)
    return { text: lines.join("\n"), level: "info" }
  }

  const list = (): Notice => {
    const open = [...refusals.values()].filter(pending)
    if (open.length === 0) return { text: NOTHING_TO_ALLOW, level: "warning" }
    const lines = open.map((refusal) => `${refusal.id}, refused ${minutes(now() - refusal.refusedAt)} ago, in ${refusal.cwd}:\n${refusal.command}`)
    return { text: ["safety: refused commands; /safety allow <id> permits one once:", ...lines].join("\n"), level: "info" }
  }

  const allow = (given: string): Notice => {
    const id = given.toLowerCase()
    const refusal = refusals.get(id)
    if (refusal === undefined) return { text: `safety: no refusal ${given} in this session; /safety allow lists them.`, level: "error" }
    if (refusal.state === "spent") return { text: `safety: refusal ${id} was allowed once already, and its command ran.`, level: "error" }
    if (allowed(refusal)) return { text: `safety: refusal ${id} is allowed already and waits for its command.`, level: "info" }
    if (!pending(refusal))
      return { text: `safety: refusal ${id} expired after 30 minutes; let the agent run the command again for a new ID.`, level: "error" }
    refusal.state = "allowed"
    refusal.allowedUntil = now() + PERMIT_MS
    return { text: `safety: allowing ${id} once, within 30 minutes, in ${refusal.cwd}:\n${refusal.command}`, level: "info" }
  }

  return {
    get mode() {
      return mode
    },
    refuse(call) {
      const known = find((refusal) => pending(refusal) && matches(refusal, call))
      if (known !== undefined) {
        known.refusedAt = now()
        return known.id
      }
      const id = newId()
      refusals.set(id, { ...call, id, refusedAt: now(), state: "refused", allowedUntil: 0 })
      return id
    },
    spend(call) {
      const permit = find((refusal) => allowed(refusal) && matches(refusal, call))
      if (permit === undefined) return false
      permit.state = "spent"
      return true
    },
    command(args, hasUI) {
      if (!hasUI) return { text: NO_UI_COMMAND, level: "error" }
      const [verb = "", ...rest] = args.trim().split(/\s+/)
      if (verb === "" && rest.length === 0) return status()
      if ((verb === "ask" || verb === "deny") && rest.length === 0) {
        mode = verb
        return { text: `safety: approvals are ${mode} for this session: ${MODE_EFFECT[mode]}`, level: "info" }
      }
      if (verb === "allow" && rest.length === 0) return list()
      if (verb === "allow" && rest.length === 1) return allow(rest[0] as string)
      return { text: USAGE, level: "error" }
    },
    reset() {
      mode = configured
      refusals.clear()
    },
  }
}
