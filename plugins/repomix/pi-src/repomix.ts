import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
    chooseRunner,
    PACK_DESCRIPTION,
    PACK_INPUT,
    PACK_TOOL,
    type PackDeps,
    readPackParams,
    resolveTarget,
    runPack,
    targetResource,
} from "../shared/pack.ts";

export type RepomixOverrides = PackDeps & { which?: (bin: string) => string | null; isDirectory?: (path: string) => boolean }

const properties = PACK_INPUT.properties
const parameters = Type.Object({
  directory: Type.Optional(Type.String({ description: properties.directory.description })),
  remote: Type.Optional(Type.String({ description: properties.remote.description })),
  ref: Type.Optional(Type.String({ description: properties.ref.description })),
  include: Type.Optional(Type.Array(Type.String(), { description: properties.include.description })),
  ignore: Type.Optional(Type.Array(Type.String(), { description: properties.ignore.description })),
  compress: Type.Optional(Type.Boolean({ description: properties.compress.description })),
  style: Type.Optional(Type.Union([Type.Literal("xml"), Type.Literal("markdown"), Type.Literal("plain")], { description: properties.style.description })),
  lineNumbers: Type.Optional(Type.Boolean({ description: properties.lineNumbers.description })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: properties.timeoutSeconds.maximum, description: properties.timeoutSeconds.description })),
}, { additionalProperties: false })

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function registerRepomix(pi: ExtensionAPI, overrides: RepomixOverrides = {}): void {
  const which = overrides.which ?? ((bin: string) => Bun.which(bin))
  pi.registerTool({
    name: PACK_TOOL,
    label: "Pack Repository",
    description: PACK_DESCRIPTION,
    parameters,
    async execute(_id, raw, signal, _update, ctx) {
      const params = readPackParams(raw)
      if (typeof params === "string")
        return { content: [{ type: "text", text: `${PACK_TOOL}: ${params}` }], details: { ok: false } }
      const target = resolveTarget(params, ctx.cwd)
      if (target.kind === "local" && !(overrides.isDirectory ?? isDirectory)(target.directory))
        return { content: [{ type: "text", text: `${PACK_TOOL}: ${target.directory} is not a directory` }], details: { ok: false } }

      const runner = chooseRunner(which)
      const resource = targetResource(target)
      if (!ctx.hasUI)
        return { content: [{ type: "text", text: `${PACK_TOOL}: write refused because confirmation UI is unavailable for ${resource}` }], details: { ok: false } }
      if (!(await ctx.ui.confirm("Confirm repository pack", `Run ${runner.kind === "npx" ? `npx repomix@1.19.0` : "repomix"} to pack ${resource}? The pack will be written to a temporary file.`)))
        return { content: [{ type: "text", text: `${PACK_TOOL}: pack cancelled` }], details: { ok: false } }

      try {
        const result = await runPack(params, target, runner, signal, overrides)
        return {
          content: [{ type: "text", text: result.ok ? result.text : `${PACK_TOOL}: ${result.text}` }],
          details: {
            ok: result.ok,
            status: result.status,
            runner: runner.kind,
            path: result.path,
            files: result.summary?.files,
            tokens: result.summary?.tokens,
            topFiles: result.summary?.topFiles,
            suspiciousExcluded: result.summary?.suspiciousExcluded,
          },
        }
      } catch (error) {
        return { content: [{ type: "text", text: `${PACK_TOOL}: ${error instanceof Error ? error.message : String(error)}` }], details: { ok: false } }
      }
    },
  })
}

export default function (pi: ExtensionAPI): void {
  registerRepomix(pi)
}

