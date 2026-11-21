import { readFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Context } from "@opencode/plugin/promise/plugin"
import { type Schema, validate } from "./json-schema.ts"

export const VALIDATE_TOOL = "challenge_validate"

export const VALIDATE_DESCRIPTION =
  "Validate a code-challenge run's report.json and decisions.jsonl against the shipped JSON Schemas.\n" +
  "Takes the absolute run directory (<git-dir>/code-challenge/<run-id>). Reads only those two files, lists every error as " +
  "file, path and message, and reports ok=false when any file is missing or invalid."

export const VALIDATE_INPUT = {
  type: "object",
  properties: { run_dir: { type: "string", description: "Absolute path of the run directory" } },
  required: ["run_dir"],
  additionalProperties: false,
} as const

/** The shipped references: `src/` and the bundled `dist/` both sit one level below `skills/`. */
const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "code-challenge", "references")

const load = (name: string) => JSON.parse(readFileSync(join(SCHEMAS, name), "utf8")) as Schema
const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** Errors of one run directory, each prefixed with its file (and line, for decisions.jsonl). Empty when valid. */
export function validateRun(runDir: string): string[] {
  const errors: string[] = []
  const read = (name: string): string | undefined => {
    try {
      return readFileSync(join(runDir, name), "utf8")
    } catch {
      errors.push(`${name}: cannot be read`)
      return undefined
    }
  }
  const report = read("report.json")
  if (report !== undefined) {
    try {
      for (const error of validate(load("report.schema.json"), JSON.parse(report))) errors.push(`report.json ${error}`)
    } catch (cause) {
      errors.push(`report.json: ${reason(cause)}`)
    }
  }
  const decisions = read("decisions.jsonl")
  if (decisions !== undefined) {
    const schema = load("decisions.schema.json")
    const lines = decisions.split("\n")
    lines.forEach((text, index) => {
      if (text.trim() === "") return
      try {
        for (const error of validate(schema, JSON.parse(text))) errors.push(`decisions.jsonl:${index + 1} ${error}`)
      } catch (cause) {
        errors.push(`decisions.jsonl:${index + 1}: ${reason(cause)}`)
      }
    })
    if (lines.every((text) => text.trim() === "")) errors.push("decisions.jsonl: has no lines")
  }
  return errors
}

/** Register `challenge_validate`. Dispose the returned registration with the plugin's other cleanups. */
export function registerValidateTool(ctx: Context) {
  return ctx.tool.transform((editor) => {
    editor.add({
      name: VALIDATE_TOOL,
      description: VALIDATE_DESCRIPTION,
      input: VALIDATE_INPUT,
      execute: async (input) => {
        const { run_dir } = (input ?? {}) as { run_dir?: unknown }
        if (typeof run_dir !== "string" || !isAbsolute(run_dir))
          return { content: `${VALIDATE_TOOL}: run_dir must be an absolute path`, metadata: { ok: false } }
        const errors = validateRun(run_dir)
        return {
          content: errors.length === 0 ? "report.json and decisions.jsonl are valid" : errors.join("\n"),
          metadata: { ok: errors.length === 0, errors },
        }
      },
    })
  })
}
