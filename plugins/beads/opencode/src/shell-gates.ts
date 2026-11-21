/**
 * The beads plugin's one `shell` decision: every gate sees the same parse, in a fixed
 * order, and the rewrites compose only after every gate allowed.
 *
 * Order: binary-hook guard, gate admission, parse failure, `bd edit`, update-close,
 * close, unclaim, actor, foreign-ledger write, PR bead link, embedded-write runner rewrite, subagent actor
 * prefix. The store pin is not a command rewrite on OpenCode: `shell.create.before`
 * sets `BEADS_DIR` in the child's environment.
 */

import {
  bdInvocations,
  decideActorParsed,
  flagEnabled,
  globalValue,
  isMutatingInvocation,
} from "@srobroek/opencode-lib/bd-actor-gate"
import {
  decideEmbeddedWrite,
  type EmbeddedWriteRunnerLookup,
  embeddedWriteRunner,
  planEmbeddedWrites,
  resolveBdTargets,
  writeWaitFromOptions,
} from "@srobroek/opencode-lib/bd-embedded-write-lock"
import { type Gate, gateEnabled, type Options } from "@srobroek/opencode-lib/beads-host"
import { type ParsedCommand, parse } from "@srobroek/opencode-lib/beads-shell"
import { repoIdentity } from "@srobroek/opencode-lib/beads-store"
import { decideBdCloseParsed } from "./bd-close-gate.ts"
import { decideBdUnclaimParsed } from "./bd-unclaim-gate.ts"
import { decideBdUpdateCloseParsed } from "./bd-update-close-gate.ts"
import { protectBinaryHookCommands } from "./binary-hooks.ts"
import { admitBdMutation, type GateAdmitter } from "./gate-admission.ts"
import { describeLedger, findLedger, ledgerRepoMismatch, sameStore } from "./ledger-context.ts"
import { decideCommandParsed, type RepositoryControl, repositoryControlFor } from "./pr-bead-link-gate.ts"

/**
 * One budget for the whole call. OpenCode has no hook timeout, but a gate that waits
 * forever stalls the turn, so admission and every gate draw on the same deadline.
 */
export const TOOL_CALL_BUDGET_MS = 25_000

export type ShellDecision =
  | { kind: "block"; gate: string; cause: string; resolution: string }
  | { kind: "allow"; command: string; advisories: string[] }

export type ShellGateDeps = {
  options: Options | undefined
  /** The actor a subagent writes under, prefixed onto every shell call; `undefined` in a main session. */
  actor: string | undefined
  /** The environment the child shell starts from, with this plugin's store pin applied. */
  env: NodeJS.ProcessEnv
  admitter: GateAdmitter
  callID: string
  deadline: number
  runnerLookup?: () => EmbeddedWriteRunnerLookup
  repositoryControl?: (segment: string, cwd: string) => boolean | RepositoryControl
  /** The store `options.store` pins, when the project configured one: a deliberate ledger choice, never refused as foreign. */
  configuredStore?: string
}

const BINARY_HOOKS_NOTE = "# Beads hooks skipped to keep the existing (binary) Git hooks intact."

function block(gate: Gate | "bash-gates", cause: string, resolution = "inspect the command and retry"): ShellDecision {
  return { kind: "block", gate, cause, resolution }
}

/** `bd edit` opens `$EDITOR` and hangs a non-interactive session. */
export function hasBdEdit(parsed: ParsedCommand): boolean {
  return bdInvocations(parsed.command).some(
    (invocation) => invocation.verb === "edit" && !flagEnabled(invocation.args, ["--help", "-h"]),
  ) || parsed.nested.some(hasBdEdit)
}

/**
 * The fixed prefix every subagent shell call starts with. `bd` resolves its actor as
 * `--actor`, then BEADS_ACTOR, then BD_ACTOR, so the prefix clears an inherited BEADS_ACTOR and
 * exports BD_ACTOR, the lowest choice. Whatever the agent sets later in its own command wins by
 * normal shell order and bd precedence; no parse decides whether to inject.
 */
export function withActorPrefix(command: string, actor: string): string {
  return `unset BEADS_ACTOR; export BD_ACTOR='${actor.replaceAll("'", "'\\''")}'; ${command}`
}

/** The environment a subagent command starts from once the actor prefix has run. */
export function actorEnvironment(env: NodeJS.ProcessEnv, actor: string | undefined): NodeJS.ProcessEnv {
  if (actor === undefined) return env
  const { BEADS_ACTOR: _cleared, ...rest } = env
  return { ...rest, BD_ACTOR: actor }
}

/** Global flags that name the store themselves; the advisory does not follow them. */
const TARGET_SELECTORS = ["-C", "--directory", "--db", "--database"]

/**
 * The refusal for an issue write in the command that lands in the ledger of another git
 * repository, unless the command line itself chose that ledger.
 *
 * Targets come from the write planner, so this sees the same `cd`, `export`, `unset` and
 * command-local `BEADS_DIR` state as the lock. A `BEADS_DIR` the command assigns (an
 * `export` or a prefix) is a deliberate choice and passes; one that arrives through the
 * environment, such as a variable inherited from the shell that started the server, does
 * not. The plugin's own configured store (`options.store`) is a deliberate choice too.
 * Reads and verbs that are not issue writes (`init`, `bootstrap`, `config set`) never
 * refuse. A command the planner cannot place passes here; the lock refuses it.
 */
export function ledgerWriteRefusal(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { configuredStore?: string; identity?: (dir: string) => string | undefined } = {},
): string | undefined {
  const { configuredStore, identity = repoIdentity } = options
  let refusal: string | undefined
  planEmbeddedWrites(command, cwd, env, {
    classify: false,
    observe: ({ invocation, store, cwd: dir, beadsDir, beadsDirAssigned }) => {
      if (refusal !== undefined || !isMutatingInvocation(invocation)) return
      if (beadsDirAssigned) return
      if (flagEnabled(invocation.globals, ["--global"])) return
      if (TARGET_SELECTORS.some((name) => globalValue(invocation.globals, [name]) !== undefined)) return
      if (configuredStore !== undefined && beadsDir !== undefined && sameStore(beadsDir, configuredStore, dir)) return
      const target = store ?? findLedger(dir)?.store
      if (target !== undefined) refusal = ledgerRepoMismatch({ verb: invocation.verb, store: target, cwd: dir, identity })
    },
  })
  return refusal
}

/** Decide one `shell` call. Never throws: an unexpected error is a parse refusal. */
export async function decideShell(command: string, cwd: string, deps: ShellGateDeps): Promise<ShellDecision> {
  try {
    return await decide(command, cwd, deps)
  } catch (error) {
    return block(
      "bash-gates",
      `command could not be parsed (${error instanceof Error ? error.message : String(error)})`,
      "split the command or run the mutation as a plain single command",
    )
  }
}

async function decide(original: string, cwd: string, deps: ShellGateDeps): Promise<ShellDecision> {
  const { options, deadline } = deps
  const on = (gate: Gate): boolean => gateEnabled(options, gate)
  const advisories: string[] = []
  let command = original
  let hooksSkipped = false

  if (on("binary-git-hooks")) {
    const hookGuard = protectBinaryHookCommands({ command }, command, cwd)
    if (hookGuard?.kind === "block") return block("binary-git-hooks", hookGuard.reason)
    if (hookGuard?.kind === "rewrite" && typeof hookGuard.input.command === "string") {
      command = hookGuard.input.command
      hooksSkipped = true
    }
  }

  // Every gate judges a write where the lock runs it: one positional resolution, shared.
  const targets = resolveBdTargets(command, cwd, deps.env)

  if (on("beads-gate-admission")) {
    const admission = await admitBdMutation(command, cwd, deps.env, deps.admitter, deadline, undefined, targets)
    if (admission?.block === true)
      return block(
        "beads-gate-admission",
        admission.reason,
        "retry the command; verification continues and the next attempt waits on the same read",
      )
    if (admission?.notice !== undefined) advisories.push(admission.notice)
  }

  const parsed = parse(command)
  if (parsed.unknown)
    return block(
      "bash-gates",
      "command could not be parsed",
      "split the command or run the mutation as a plain single command",
    )

  if (on("bd-editor-gate") && hasBdEdit(parsed))
    return block(
      "bd-editor-gate",
      "`bd edit` opens $EDITOR and hangs a non-interactive session",
      'set the field directly with `bd update ID --<field> ...`, or add prose with `bd comment ID "TEXT"`; never export EDITOR=true, which records nothing',
    )

  if (on("bd-update-close-gate")) {
    const updateClose = decideBdUpdateCloseParsed(parsed)
    if (updateClose !== undefined) return block("bd-update-close-gate", updateClose.reason)
  }

  if (on("bd-close-gate")) {
    try {
      const close = await decideBdCloseParsed(parsed, cwd, deadline, deps.env, targets)
      if (close !== undefined)
        return block(
          "bd-close-gate",
          close.reason,
          "resolve the gate with `bd gate check` or `bd gate resolve <gate-id>`, then retry",
        )
    } catch (error) {
      return block(
        "bd-close-gate",
        error instanceof Error ? error.message : String(error),
        "retry after the Beads lookup is available; the close was refused without gate proof",
      )
    }
  }

  if (on("bd-unclaim-gate")) {
    const unclaim = decideBdUnclaimParsed(parsed)
    if (unclaim !== undefined)
      return block("bd-unclaim-gate", unclaim.reason, "retry with `bd unclaim <id> --if-assignee <your actor>`")
  }

  // Only a subagent has an injected actor to lose. A main session chooses its own actor, so
  // there is nothing for the gate to attribute and it stays silent.
  if (on("bd-actor-gate") && deps.actor !== undefined) {
    const env = actorEnvironment(deps.env, deps.actor)
    const decision = decideActorParsed(parsed, env)
    // A subagent's calls start with the plugin's actor prefix, so reaching a refusal here means
    // the command itself cleared or blanked the actor. This gate guards against forgetting
    // attribution, not against deliberate evasion, so it only warns.
    if (decision.kind === "block") advisories.push(decision.reason)
    else if (decision.kind === "advisory") advisories.push(decision.text)
  }

  const crossRepo = on("bd-embedded-write-lock")
    ? ledgerWriteRefusal(command, cwd, deps.env, { configuredStore: deps.configuredStore })
    : undefined
  if (crossRepo !== undefined) return block("bd-embedded-write-lock", crossRepo, "use the right `workdir`, or assign BEADS_DIR in the command line itself, then retry")

  if (on("pr-bead-link-gate")) {
    const control = deps.repositoryControl ?? repositoryControlFor
    const decision = decideCommandParsed(
      parsed,
      (segment) => control(segment, cwd),
      () => {
        const ledger = findLedger(cwd)
        return ledger === undefined ? undefined : describeLedger(ledger)
      },
    )
    if (decision) return block("pr-bead-link-gate", decision.reason, "add the bead trailer to the PR body and retry")
  }

  if (on("bd-embedded-write-lock")) {
    const embedded = await decideEmbeddedWrite(
      parsed,
      cwd,
      deps.env,
      deps.callID,
      deadline,
      deps.runnerLookup ?? embeddedWriteRunner,
      writeWaitFromOptions(options),
      targets.plan,
    )
    if (embedded?.kind === "block") return block("bd-embedded-write-lock", embedded.reason)
    if (embedded?.kind === "rewrite") command = embedded.command
  }

  // The actor prefix goes on after the runner rewrite so the executed command keeps it.
  if (deps.actor !== undefined) command = withActorPrefix(command, deps.actor)
  if (hooksSkipped && command !== original) {
    command = `${BINARY_HOOKS_NOTE}\n${command}`
    advisories.push("Hooks were skipped to keep the existing (binary) Git hooks intact.")
  }
  return { kind: "allow", command, advisories }
}
