import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { agentIds, registerAgents } from "@srobroek/opencode-lib/agent-files"
import { mcpGrant } from "@srobroek/opencode-lib/agent-tools"
import { contentPaths } from "@srobroek/opencode-lib/content-plugin"
import { registerSkills } from "@srobroek/opencode-lib/skill-files"
import { COMMAND, COMMAND_DESCRIPTION, challengePrompt } from "./command.ts"
import { runSetup, SETUP_DESCRIPTION, SETUP_INPUT, SETUP_TOOL } from "./formulas.ts"
import { registerLibFacts } from "./lib-facts/index.ts"
import { referenceReadRules } from "./read-grant.ts"
import { registerScanTool } from "./scan/index.ts"
import { sessionDirectory } from "./session-directory.ts"
import { registerValidateTool } from "./validate.ts"

export { COMMAND, challengePrompt, parseInvocation, SKILL } from "./command.ts"
export { FORMULAS, installFormulas, SETUP_DESCRIPTION, SETUP_TOOL } from "./formulas.ts"
export { DEPTHS, LENSES, PHASES } from "./lenses.ts"
export { LIB_FACTS_TOOL } from "./lib-facts/index.ts"
export { SCAN_TOOL } from "./scan/index.ts"
export { VALIDATE_TOOL } from "./validate.ts"

export const ID = "srobroek.code-challenge"

export async function setupCodeChallenge(ctx: Context, moduleUrl: string) {
  const { skills, agents } = contentPaths(moduleUrl)
  const registrations: { dispose: () => Promise<void> }[] = []
  const cleanup = async () => {
    for (const registration of registrations.reverse()) await registration.dispose()
  }
  const directory = (sessionID: string) => sessionDirectory(ctx, sessionID, SETUP_TOOL)
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
          execute: (input, context) =>
            runSetup(input, { directory: () => directory(context.sessionID) }, async (target, force) => {
              await assert(context, SETUP_TOOL, [target], { workspace: target, force })
            }),
        })
      }),
    )
    registrations.push(await registerLibFacts(ctx))
    registrations.push(await registerValidateTool(ctx))
    registrations.push({ dispose: await registerScanTool(ctx) })
    registrations.push(
      await ctx.command.transform((editor) =>
        editor.add({
          name: COMMAND,
          description: COMMAND_DESCRIPTION,
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
        await registerAgents(ctx.agent, agents, referenceReadRules(moduleUrl), mcpGrant((ctx.options as Record<string, unknown> | undefined)?.tools, agentIds(agents))),
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
