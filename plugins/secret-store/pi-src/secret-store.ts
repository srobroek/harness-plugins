/**
 * The secret-store plugin on pi: `safety_secret_store`, registered as a tool, from the module the
 * OpenCode adapter runs. Each step that needs the user (a config outside the session, the store, each
 * command run) opens `ctx.ui.confirm`; a session without dialogs (print, JSON, a subagent child) stops
 * the call before anything is stored.
 */

import { homedir } from "node:os"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  COMMAND_QUESTION,
  displayArgv,
  localStoreDeps,
  SECRET_STORE_DESCRIPTION,
  SECRET_STORE_INPUT,
  SecretStoreError,
  STORE_ACTION,
  type StoreDeps,
  storeResource,
  storeSecret,
  stringEnv,
} from "../shared/secret-store.ts"

/** The part of the extension context a confirmation needs. */
export type Asker = { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } }

async function confirmStep(asker: Asker, title: string, message: string): Promise<void> {
  if (!asker.hasUI) throw new SecretStoreError(`${STORE_ACTION}: "${title}" needs the user's approval and this session cannot show a dialog; nothing was stored.`)
  if (!(await asker.ui.confirm(title, message))) throw new SecretStoreError(`${STORE_ACTION}: the user declined "${title}"; nothing was stored.`)
}

/** The store's dependencies for a pi session in `directory`: every step that needs the user confirms. */
export function piStoreDeps(
  directory: string,
  asker: Asker,
  local: Pick<StoreDeps, "env" | "home"> & Partial<Pick<StoreDeps, "run" | "which">>,
  signal?: AbortSignal,
): StoreDeps {
  return {
    ...localStoreDeps(directory, local.env, local.home ?? homedir()),
    ...local,
    ...(signal ? { signal } : {}),
    askExternal: (external) =>
      confirmStep(asker, `${STORE_ACTION}: use a fnox config outside the session?`, external.map((item) => item.resource).join("\n")),
    askStore: (request, destination) => confirmStep(asker, `${STORE_ACTION}: store this secret?`, storeResource(request, destination)),
    askCommand: (argv, cwd) => confirmStep(asker, COMMAND_QUESTION, `${displayArgv(argv)}  (in ${cwd})`),
  }
}

type ToolParameters = Parameters<ExtensionAPI["registerTool"]>[0]["parameters"]

/** Test seams for `createSecretStoreExtension`; the default export passes none. */
export type Overrides = Partial<Pick<StoreDeps, "run" | "which" | "env" | "home">>

export function createSecretStoreExtension(overrides: Overrides = {}) {
  return function secretStore(pi: ExtensionAPI): void {
    pi.registerTool({
      name: STORE_ACTION,
      label: "Store secret",
      description: SECRET_STORE_DESCRIPTION,
      parameters: SECRET_STORE_INPUT as unknown as ToolParameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const stopped = `${STORE_ACTION} stopped before it started; nothing was stored.`
        if (signal?.aborted === true) return { content: [{ type: "text", text: stopped }], details: undefined }
        const local = { env: stringEnv(process.env), home: homedir(), ...overrides }
        const result = await storeSecret(params, piStoreDeps(ctx.cwd, ctx, local, signal))
        const where = "reference" in result ? `reference ${result.reference}` : `provider ${result.provider}`
        return { content: [{ type: "text", text: `Stored ${result.name} (${where}).` }], details: result }
      },
    })
  }
}

export default createSecretStoreExtension()
