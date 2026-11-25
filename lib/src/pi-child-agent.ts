/**
 * Whether a pi tool call runs in a pi-subagents child session of one named agent, for the
 * Pi extensions that hold an agent to its prompt's limits.
 *
 * pi-subagents opens a native child's system prompt with `<active_agent name="<agent>"/>` and
 * names the child session after the selected agent (`<agent>` or `<agent>: <task>`). `isChild`
 * comes from the session header's `parentSession`, so a main session is never matched.
 */

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function isPiChildAgent(agent: string, systemPrompt: string, sessionName: string | undefined, isChild: boolean): boolean {
  if (!isChild) return false
  const tag = new RegExp(`<active_agent\\s+name=["']${escapeRegExp(agent)}["']\\s*/>`)
  return tag.test(systemPrompt) || sessionName === agent || sessionName?.startsWith(`${agent}: `) === true
}
