import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { spawnTool } from "./exec.ts"

// Real /bin/sh fixtures; the overflow cases end an endless `yes`. Measured 0.3 s alone; 30 s leaves headroom (AGENTS.md, Commands).
setDefaultTimeout(30_000)

const dir = mkdtempSync(join(tmpdir(), "challenge-exec-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("spawnTool", () => {
  test("the child sees an allowlisted environment without the caller's secrets", async () => {
    writeExecutable(join(dir, "env-probe"), 'echo "token=[$GITHUB_TOKEN] key=[$OPENAI_API_KEY] path=[$PATH] color=[$NO_COLOR]"\n')
    const saved = { GITHUB_TOKEN: Bun.env.GITHUB_TOKEN, OPENAI_API_KEY: Bun.env.OPENAI_API_KEY }
    Bun.env.GITHUB_TOKEN = "s3cret"
    Bun.env.OPENAI_API_KEY = "s3cret"
    try {
      const run = await spawnTool([join(dir, "env-probe")], { cwd: dir, timeoutMs: 10_000 })
      expect(run.kind).toBe("exited")
      expect(run.stdout.trim()).toBe(`token=[] key=[] path=[${Bun.env.PATH}] color=[1]`)
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete Bun.env[name]
        else Bun.env[name] = value
      }
    }
  })

  test("output past the stdout cap ends the child and reports an overflow", async () => {
    writeExecutable(join(dir, "endless-out"), "exec yes x\n")
    const run = await spawnTool([join(dir, "endless-out")], { cwd: dir, timeoutMs: 20_000, maxStdoutBytes: 10_000 })
    expect(run).toEqual({ kind: "overflow", stream: "stdout", stdout: "", stderr: "" })
  })

  test("output past the stderr cap is an overflow too", async () => {
    writeExecutable(join(dir, "endless-err"), "exec yes x >&2\n")
    const run = await spawnTool([join(dir, "endless-err")], { cwd: dir, timeoutMs: 20_000, maxStderrBytes: 10_000 })
    expect(run).toEqual({ kind: "overflow", stream: "stderr", stdout: "", stderr: "" })
  })

  test("output under the caps comes back whole", async () => {
    writeExecutable(join(dir, "small"), "echo out; echo err >&2; exit 3\n")
    const run = await spawnTool([join(dir, "small")], { cwd: dir, timeoutMs: 10_000, maxStdoutBytes: 100, maxStderrBytes: 100 })
    expect(run).toMatchObject({ kind: "exited", exitCode: 3, stdout: "out\n", stderr: "err\n" })
  })
})
