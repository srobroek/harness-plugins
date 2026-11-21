import { resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { agentIds, registerAgents } from "@srobroek/opencode-lib/agent-files"
import { mcpGrant } from "@srobroek/opencode-lib/agent-tools"
import { contentPaths } from "@srobroek/opencode-lib/content-plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { COMMAND, challengePrompt } from "./command.ts"
import { installFormulas, SETUP_TOOL } from "./formulas.ts"
import { registerLibFacts } from "./lib-facts/index.ts"
import { registerValidateTool } from "./validate.ts"

export { COMMAND, challengePrompt, parseInvocation, SKILL } from "./command.ts"
export { FORMULAS, installFormulas, SETUP_TOOL } from "./formulas.ts"
export { DEPTHS, LENSES, PHASES } from "./lenses.ts"
export { LIB_FACTS_TOOL } from "./lib-facts/index.ts"
export { VALIDATE_TOOL } from "./validate.ts"

export const ID = "srobroek.code-challenge"

export const SETUP_DESCRIPTION =
  "Copy the code-challenge beads formulas into a beads workspace's .beads/formulas/.\n" +
  "Covers the code-challenge full run and the mol-challenge-<phase> formulas, so bd mol pour finds them. Identical " +
  "copies stay; divergent ones are refused unless force=true; symlinked paths are always refused."

const SETUP_INPUT = {
  type: "object",
  properties: {
    workspace: { type: "string", description: "Beads workspace root (contains .beads/); default the session directory" },
    force: { type: "boolean", description: "Overwrite code-challenge formulas that differ from the shipped ones" },
  },
  additionalProperties: false,
} as const

export async function setupCodeChallenge(ctx: Context, moduleUrl: string) {
  const { skills, agents } = contentPaths(moduleUrl)
  const registrations: { dispose: () => Promise<void> }[] = []
  const cleanup = async () => {
    for (const registration of registrations.reverse()) await registration.dispose()
  }
  // Fail closed: a session we cannot resolve must not make the tool write into the plugin's own base directory.
  const directory = async (sessionID: string): Promise<string> => {
    const session = await ctx.session.get({ sessionID }).catch((cause: unknown) => {
      throw new Error(`${SETUP_TOOL}: cannot read session ${sessionID} to find its directory`, { cause })
    })
    const found = session.location?.directory
    if (typeof found !== "string" || found === "")
      throw new Error(`${SETUP_TOOL}: session ${sessionID} has no directory`)
    return found
  }
  const assert = (context: ToolContext, action: string, resources: string[], metadata: Record<string, unknown>) =>
    ctx.permission.assert({
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
      action,
      resources,
      save: resources,
      metadata,
    } as never)

  try {
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: SETUP_TOOL,
          description: SETUP_DESCRIPTION,
          input: SETUP_INPUT,
          execute: async (input, context) => {
            const { workspace, force } = (input ?? {}) as { workspace?: unknown; force?: unknown }
            if (workspace !== undefined && (typeof workspace !== "string" || workspace === ""))
              return { content: `${SETUP_TOOL}: workspace must be a non-empty string`, metadata: { ok: false } }
            const cwd = await directory(context.sessionID)
            const target = resolve(cwd, typeof workspace === "string" ? workspace : ".")
            await assert(context, SETUP_TOOL, [target], { workspace: target, force: force === true })
            const result = installFormulas(target, cwd, force === true)
            return {
              content: result.ok ? result.text : `${SETUP_TOOL}: ${result.text}`,
              metadata: { ok: result.ok, copied: result.copied, unchanged: result.unchanged },
            }
          },
        })
      }),
    )
    registrations.push(await registerLibFacts(ctx))
    registrations.push(await registerValidateTool(ctx))
    registrations.push(
      await ctx.command.transform((editor) =>
        editor.add({
          name: COMMAND,
          description: "challenge code for simplification, performance and structure: [auto] [quick|standard|deep] [target]",
          execute: async (input) => {
            await ctx.session.prompt({
              sessionID: input.sessionID,
              ...input.prompt,
              text: challengePrompt(input.prompt.text ?? ""),
              delivery: input.delivery,
            } as never)
          },
        }),
      ),
    )
    if (skills.length > 0) registrations.push(await registerSkills(ctx.skill, skills))
    if (agents.length > 0)
      registrations.push(
        await registerAgents(ctx.agent, agents, [], mcpGrant((ctx.options as Record<string, unknown> | undefined)?.tools, agentIds(agents))),
      )
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}

export default Plugin.define({
  id: ID,
  setup: (ctx) => setupCodeChallenge(ctx, import.meta.url),
})
