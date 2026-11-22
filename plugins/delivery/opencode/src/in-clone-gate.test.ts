import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { embeddedWriteTargets } from "@srobroek/opencode-lib/bd-embedded-write-lock"
import { setBdShowRunForTests } from "../../../beads/opencode/src/bd-close-gate.ts"
import { decideShell } from "../../../beads/opencode/src/shell-gates.ts"
import { gateDeps } from "../../../beads/opencode/src/test-support.ts"
import { inClone } from "./land.ts"
import { closeoutCommands } from "./landing-receipt.ts"

// A session pinned to the origin repository's embedded ledger hands a close-out command to the
// beads shell gates (the embedded write lock and the #101 fail-closed refusal of a `bd` it cannot
// place). The command for another repository's landing has to pass them and land in the target's
// ledger, never the origin's.
let base = ""
let origin = ""
let target = ""

const repository = (name: string): string => {
  const root = join(base, name)
  mkdirSync(join(root, ".beads"), { recursive: true })
  writeFileSync(join(root, ".beads", "metadata.json"), "{}")
  execFileSync("git", ["init", "-q", root])
  return root
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "in-clone-gate-")))
  origin = repository("origin")
  target = repository("target repo's clone")
  // The close gate looks the bead up; a plain task has nothing to resolve.
  setBdShowRunForTests((argv) => ({
    exitCode: 0,
    stdout: JSON.stringify(argv.filter((word) => /^b-/.test(word)).map((id) => ({ id, issue_type: "task" }))),
  }))
})
afterAll(() => {
  setBdShowRunForTests(null)
  rmSync(base, { recursive: true, force: true })
})

const oid = "b".repeat(40)
const session = () => ({ PATH: process.env.PATH, BEADS_DIR: join(origin, ".beads") })

describe("the close-out command for another repository's landing, through the beads shell gates", () => {
  test.each(["update", "close"] as const)("the %s command is accepted and names the target's ledger", async (which) => {
    const command = inClone(target, closeoutCommands("b-1", 7, oid, "/receipts/r.json")[which])
    const decision = await decideShell(command, origin, gateDeps({ env: session() }))
    expect(decision).toMatchObject({ kind: "allow" })
    expect(embeddedWriteTargets(command, origin, session())).toEqual({ kind: "stores", stores: [join(target, ".beads")] })
  })

  test("the form that hides bd behind env is refused: the control the accepted form is judged against", async () => {
    // The form delivery handed out before: `bd` behind `env`, the directory quoted for the shell.
    const directory = target.replaceAll("'", "'\\''")
    const command = `cd '${directory}' && env -u BEADS_DIR ${closeoutCommands("b-1", 7, oid, "/receipts/r.json").update}`
    const decision = await decideShell(command, origin, gateDeps({ env: session() }))
    expect(decision.kind).toBe("block")
    expect(decision.kind === "block" ? decision.cause : "").toContain("launched through `env`")
  })

  test("a command that does not start with bd is refused, not wrapped", () => {
    expect(() => inClone(target, "git status")).toThrow("bd")
  })
})
