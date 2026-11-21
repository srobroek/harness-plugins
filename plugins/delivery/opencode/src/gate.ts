/**
 * Which `delivery_land` and `delivery_cleanup` calls need no confirmation prompt of their own.
 *
 * A prompt is the host's answer to "may this agent do something irreversible". Two calls carry
 * their own proof, so delivery's extra prompt (`confirmDelivery`) would add nothing:
 *
 * - a land whose validated input sets `expectHeadSha`, `requireApproval: true` and
 *   `requireGreenChecks: true`: the tool proves an approval artifact and green checks for that
 *   exact head before it merges, and refuses to merge any other head;
 * - a cleanup that read a landing receipt, verified it, and is about to remove exactly the
 *   worktree and branch that receipt names.
 *
 * Both decisions read validated tool input or proofs the tool made, never model-provided text.
 * They only decide whether delivery adds a prompt: a configured `deny` or `ask` rule is still
 * evaluated by the host and wins.
 */

/** The input of a gated land: exact head bound, approval and checks both required. */
export function landGate(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false
  const { expectHeadSha, requireApproval, requireGreenChecks } = input as Record<string, unknown>
  return typeof expectHeadSha === "string" && expectHeadSha.trim() !== "" && requireApproval === true && requireGreenChecks === true
}

/** What `cleanupDelivery` hands `authorize` once every proof has passed. */
export type CleanupAuthorization = {
  worktree: string
  branch: string
  pr: number
  /** The worktree it will remove is the receipt's own: same path, on the receipt's branch. */
  receiptBound?: boolean
}

/** A cleanup that acts on a verified receipt and removes only what the receipt names. */
export function cleanupGate(request: Partial<CleanupAuthorization>): boolean {
  return (
    request.receiptBound === true &&
    typeof request.worktree === "string" &&
    request.worktree.trim() !== "" &&
    typeof request.branch === "string" &&
    request.branch.trim() !== "" &&
    Number.isInteger(request.pr) &&
    (request.pr as number) > 0
  )
}

/**
 * The calls currently inside `permission.assert` that decided to be gated. The evaluate hook sees
 * only action, resources and effect, so the tool registers the call before it asserts and the hook
 * looks it up. A resource that an ungated call is also asserting at that moment is never skipped.
 */
export type GateRegistry = {
  /** Register an in-flight assert; call the returned function when it settles. */
  enter(action: string, resource: string, gated: boolean): () => void
  /** True when every resource has a gated assert in flight and no ungated one. */
  skips(action: string, resources: ReadonlyArray<string>): boolean
}

export function createGateRegistry(): GateRegistry {
  const counts = new Map<string, { gated: number; ungated: number }>()
  const key = (action: string, resource: string) => `${action}\u0000${resource}`
  return {
    enter(action, resource, gated) {
      const id = key(action, resource)
      const entry = counts.get(id) ?? { gated: 0, ungated: 0 }
      if (gated) entry.gated += 1
      else entry.ungated += 1
      counts.set(id, entry)
      let done = false
      return () => {
        if (done) return
        done = true
        if (gated) entry.gated -= 1
        else entry.ungated -= 1
        if (entry.gated === 0 && entry.ungated === 0) counts.delete(id)
      }
    },
    skips(action, resources) {
      return (
        resources.length > 0 &&
        resources.every((resource) => {
          const entry = counts.get(key(action, resource))
          return entry !== undefined && entry.gated > 0 && entry.ungated === 0
        })
      )
    },
  }
}
