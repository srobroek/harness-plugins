import { homedir } from "node:os"
import { Plugin } from "@opencode/plugin"
import {
  COMMAND_ACTION,
  COMMAND_QUESTION,
  displayArgv,
  localStoreDeps,
  SECRET_STORE_DESCRIPTION,
  SECRET_STORE_INPUT,
  STORE_ACTION,
  type StoreDeps,
  storeResource,
  storeSecret,
  stringEnv,
} from "../../shared/secret-store.ts"

/** The evaluation fields the command-run hook reads and writes. */
export type Evaluation = {
  readonly action: string
  effect: "allow" | "deny" | "ask"
  message?: string
}

/** Test seams; the host never passes these. */
export type Overrides = Partial<Pick<StoreDeps, "run" | "which" | "env" | "home">>

/** Turn an allowed secret command run into a prompt, so every run asks; a configured deny stays a deny. */
export function confirmSecretCommand(evaluation: Evaluation): void {
  if (evaluation.action !== COMMAND_ACTION || evaluation.effect !== "allow") return
  evaluation.effect = "ask"
  evaluation.message = COMMAND_QUESTION
}

export function createPlugin(overrides: Overrides = {}) {
  return Plugin.define({
    id: "srobroek.secret-store",
    async setup(ctx) {
      const sessionDirectory = (sessionID: string): Promise<string> =>
        ctx.session
          .get({ sessionID } as never)
          .then((session) => (session as { location: { directory: string } }).location.directory)
          .catch(() => ctx.location.directory as string)

      const tool = await ctx.tool.transform((editor) => {
        editor.add({
          name: STORE_ACTION,
          description: SECRET_STORE_DESCRIPTION,
          input: SECRET_STORE_INPUT,
          execute: async (input, context) => {
            // `signal` is undefined on hosts older than OpenCode 2.3.
            if (context.signal?.aborted === true) return { content: `${STORE_ACTION} stopped before it started; nothing was stored.` }
            const directory = await sessionDirectory(context.sessionID)
            const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
            const env = overrides.env ?? stringEnv(process.env)
            const home = overrides.home ?? homedir()
            const deps: StoreDeps = {
              ...localStoreDeps(directory, env, home),
              ...overrides,
              ...(context.signal ? { signal: context.signal } : {}),
              askExternal: (external) =>
                ctx.permission.assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                  action: "external_directory",
                  resources: external.map((item) => item.resource),
                  save: external.map((item) => item.save),
                } as never),
              askStore: (request, destination) => {
                const resource = storeResource(request, destination)
                return ctx.permission.assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                  action: STORE_ACTION,
                  resources: [resource],
                  save: [resource],
                  metadata: {
                    name: request.name,
                    target: request.target,
                    provider: destination.provider,
                    config: destination.file,
                    source: request.source.kind,
                  },
                } as never)
              },
              askCommand: (argv, cwd) =>
                ctx.permission.assert({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                  action: COMMAND_ACTION,
                  resources: [`${displayArgv(argv)}  (in ${cwd})`],
                  metadata: { argv, cwd },
                } as never),
            }
            const result = await storeSecret(input, deps)
            const where = "reference" in result ? `reference ${result.reference}` : `provider ${result.provider}`
            return { content: `Stored ${result.name} (${where}).`, metadata: result }
          },
        })
      })
      try {
        const confirmCommand = await ctx.permission.hook("evaluate", (evaluation) => confirmSecretCommand(evaluation as Evaluation))
        return async () => {
          await confirmCommand.dispose()
          await tool.dispose()
        }
      } catch (error) {
        await tool.dispose()
        throw error
      }
    },
  })
}

export default createPlugin()
