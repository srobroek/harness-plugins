import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { runCommand } from "./rundir.ts"

// One stub process, measured at under 100 ms here; the allowance covers a slow endpoint scan.
setDefaultTimeout(30_000)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("runCommand gives the child the env it is passed, over an inherited value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-run-"))
  dirs.push(dir)
  writeExecutable(join(dir, "show"), '#!/bin/sh\nprintf "%s" "$BEADS_DIR"\n')
  const inherited = process.env.BEADS_DIR
  process.env.BEADS_DIR = "/inherited/.beads"
  try {
    const result = await runCommand(dir, join(dir, "show"), [], 20_000, { BEADS_DIR: "/run/.beads" })
    expect(result).toEqual({ ok: true, stdout: "/run/.beads", stderr: "" })
  } finally {
    if (inherited === undefined) delete process.env.BEADS_DIR
    else process.env.BEADS_DIR = inherited
  }
})
