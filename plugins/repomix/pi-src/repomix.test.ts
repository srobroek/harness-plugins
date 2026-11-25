import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SupervisedRun } from "@srobroek/opencode-lib/subprocess";
import { PACK_TOOL } from "../shared/pack.ts";
import { registerRepomix } from "./repomix.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0]
type Execute = NonNullable<Tool["execute"]>

test("repomix_pack executes against a fixture directory without returning its pack", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "repomix-pi-fixture-"))
  const root = join(fixture, "packs")
  const source = join(fixture, "repo")
  mkdirSync(source)
  writeFileSync(join(source, "README.md"), "fixture content")
  const registered: Tool[] = []
  const pi = { registerTool: (tool: Tool) => registered.push(tool) } as unknown as ExtensionAPI
  const fakeExec = async (argv: string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<SupervisedRun> => {
    expect(options.cwd).not.toBe(source)
    expect(readdirSync(options.cwd)).toContain("repomix.empty.json")
    expect(readFileSync(join(options.cwd, "repomix.empty.json"), "utf8")).toBe("{}\n")
    expect(argv).toContain(source)
    expect(argv).not.toContain("--no-security-check")
    expect(argv).not.toContain("--remote-trust-config")
    const output = (argv.find((arg) => arg.startsWith("--output=")) ?? "").slice("--output=".length)
    writeFileSync(output, '<files><file path="README.md">fixture content</file></files>')
    return {
      kind: "exited",
      exitCode: 0,
      signalCode: null,
      stdout: "Repomix v1.19.0\nTotal Files: 1 files\nTotal Tokens: 3 tokens\nTotal Chars: 15 chars\n",
      stderr: "",
    }
  }
  try {
    registerRepomix(pi, { root, exec: fakeExec, which: () => "/bin/repomix" })
    expect(registered.map(({ name }) => name)).toEqual([PACK_TOOL])
    const tool = registered[0]
    expect(tool).toBeDefined()
    const execute = tool?.execute as Execute
    const result = await execute("call", { directory: source }, new AbortController().signal, () => {}, {
      cwd: fixture,
      hasUI: true,
      ui: { confirm: async () => true },
    } as never)
    const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
    expect(result.details).toMatchObject({ ok: true, status: "packed", runner: "path", files: 1, tokens: 3 })
    expect(text).toContain("Packed 1 files, 3 tokens (15 chars)")
    expect(text).toContain("Never read the whole pack")
    expect(text).not.toContain("fixture content")
    const packs = readdirSync(root).filter((name) => name.startsWith("repomix-"))
    expect(packs).toHaveLength(1)
    expect(existsSync(join(root, packs[0] ?? ""))).toBe(true)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
