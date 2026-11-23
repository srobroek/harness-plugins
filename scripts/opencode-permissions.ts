// The OpenCode V2 `permissions:` list as the agent translators read it: rules matched by action
// glob, last match wins, `*` as the resource meaning every resource.

export type Effect = "allow" | "deny" | "ask"
export type Rule = { action: string; resource: string; effect: Effect }

/** The action or resource that matches everything. */
export const ANY = "*"

/** Whether a rule's action glob (`*` matches any run of characters) names `action`. */
export function actionMatches(pattern: string, action: string): boolean {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(action)
}

/** The rules of an agent's `permissions` value, or a thrown error naming `where` when one is malformed. */
export function readRules(where: string, value: unknown): Rule[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${where}: permissions must be a list`)
  return value.map((entry, index) => {
    const rule = entry as Record<string, unknown>
    const { action, resource, effect } = rule ?? {}
    if (typeof action !== "string" || typeof resource !== "string" || !["allow", "deny", "ask"].includes(String(effect)))
      throw new Error(`${where}: permissions[${index}] needs a string action and resource and an allow, deny or ask effect`)
    return { action, resource, effect: effect as Effect }
  })
}

/** `allow read` for an unrestricted rule, `ask read(*.env)` for a restricted one. */
export const describeRule = (rule: Rule) =>
  rule.resource === ANY ? `${rule.effect} ${rule.action}` : `${rule.effect} ${rule.action}(${rule.resource})`

/**
 * The rules that decide a group of actions, by OpenCode's last-match-wins order: `base` is the
 * last unrestricted rule naming one of them (undefined when none does), and `after` holds the
 * resource-restricted rules that follow it, the only ones that still override it.
 */
export function groupRules(rules: readonly Rule[], actions: readonly string[]): { base?: Rule; after: Rule[] } {
  const matching = rules.filter((rule) => actions.some((action) => actionMatches(rule.action, action)))
  const baseIndex = matching.findLastIndex((rule) => rule.resource === ANY)
  return { ...(baseIndex === -1 ? {} : { base: matching[baseIndex] }), after: matching.slice(baseIndex + 1) }
}
