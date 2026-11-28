import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveBdTargets } from "@srobroek/opencode-lib/bd-embedded-write-lock"
import type { BdRun } from "../opencode/src/gate-admission.ts"
import {
  CLAIM_GATE,
  closeEvidenceRefusal,
  decideBeadWork,
  EVIDENCE_GATE,
  existingDirectory,
  hasCheckableEvidence,
  heldClaimArgs,
  holdsClaim,
  issueRows,
  unclaimedBeads,
  WRITE_CLAIM_GATE,
  workSites,
  writeClaimRefusal,
} from "./claim-gate.ts"

const root = mkdtempSync(join(tmpdir(), "claim-gate-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ACTOR = "pi/root"

type Bead = { status: string; assignee?: string }

/** A fake `bd show --json` over a fixed table, in bd 1.3.1's envelope, recording every call. */
function fakeShow(table: Record<string, Bead>, calls: string[][] = []): BdRun {
  return async (_cwd, args) => {
    calls.push(args)
    const ids = args.slice(args.indexOf("show") + 1).filter((arg) => !arg.startsWith("--"))
    const rows = ids.flatMap((id) => {
      const full = Object.keys(table).find((key) => key === id || key.endsWith(`-${id}`))
      return full === undefined ? [] : [{ id: full, title: "t", ...table[full] }]
    })
    if (rows.length === 0) return { failure: "bd exited with code 1: no issues found matching the provided IDs" }
    return { output: JSON.stringify({ schema_version: 1, data: rows }) }
  }
}

async function decide(command: string, table: Record<string, Bead>, calls: string[][] = [], actor = ACTOR) {
  const env = {}
  return decideBeadWork(command, root, {
    actor,
    env,
    deadline: Date.now() + 5_000,
    run: fakeShow(table, calls),
    targets: resolveBdTargets(command, root, env),
  })
}

const EVIDENCE = '--reason "bun test x.test.ts: 3 pass"'

describe("workSites", () => {
  test("a close names its ids and reasons in every spelling", () => {
    const [site] = workSites(`bd close ab-1 ab-2 --reason "ran bun test" -r=second --reason-file notes.md`)
    expect(site?.verb).toBe("close")
    expect(site?.ids).toEqual(["ab-1", "ab-2"])
    expect(site?.reasons).toEqual([
      { kind: "text", text: "ran bun test" },
      { kind: "text", text: "second" },
      { kind: "file", path: "notes.md" },
    ])
  })

  test("done is a close", () => {
    expect(workSites("bd done ab-1 -r x")[0]?.verb).toBe("close")
  })

  test("a claim starts work and is not gated", () => {
    expect(workSites("bd update ab-1 --claim")).toEqual([])
    expect(workSites("bd update ab-1 --claim=true --notes n")).toEqual([])
  })

  test("an update skips its option values", () => {
    expect(workSites("bd update ab-1 --status in_progress -a someone --notes ab-9 ab-2")[0]?.ids).toEqual(["ab-1", "ab-2"])
  })

  test("only a status, assignee or defer change is gated; record edits and comments are not", () => {
    for (const command of [
      "bd update ab-1 --status open",
      "bd update ab-1 -s blocked --notes n",
      "bd update ab-1 --assignee=me",
      "bd update ab-1 -a me",
      "bd update ab-1 --defer tomorrow",
    ])
      expect(workSites(command).map((site) => site.verb)).toEqual(["update"])
    for (const command of [
      "bd update ab-1 --append-notes n",
      "bd update ab-1 --notes --status",
      "bd update ab-1 --title t -d desc --add-label x -p 1 --design-file d.md --acceptance a",
      'bd comment ab-1 "fixes ab-2"',
      "bd comments add ab-1 --file notes.md",
    ])
      expect(workSites(command)).toEqual([])
  })

  test("redirections name no bead", () => {
    for (const command of [
      'bd update bhn-1 --status open --append-notes "$(cat /tmp/n.md)" >/dev/null && bd show bhn-1',
      "bd update bhn-1 --status open 2>&1",
      "bd update bhn-1 --status open > /dev/null",
      "bd update bhn-1 --status open 2>/dev/null >>log &>out",
    ])
      expect(workSites(command)[0]?.ids).toEqual(["bhn-1"])
    // A quoted word is data, not a redirection.
    expect(workSites('bd close ab-1 ">x" -r y')[0]?.ids).toEqual(["ab-1", ">x"])
  })

  test("reads, listings and help are not gated", () => {
    expect(workSites("bd show ab-1 && bd comments ab-1 && bd list --json")).toEqual([])
    expect(workSites("bd close --help")).toEqual([])
    expect(workSites("bd create 'x' -t task")).toEqual([])
  })

  test("ids the shell computes are reported, not looked up", () => {
    const [site] = workSites('bd close "$ID" `cat id` ab-1 -r x')
    expect(site?.ids).toEqual(["ab-1"])
    // The parser splits a backtick substitution into its words; each still marks itself computed.
    expect(site?.dynamic).toEqual(["$ID", "`cat", "id`"])
  })

  test("store selectors are replayed on the lookup", () => {
    const [site] = workSites("BEADS_DIR=/s/.beads bd --db /d close ab-1 -C /w -r x")
    expect(site?.dbArgs).toEqual(["--db", "/d", "-C", "/w"])
    expect(site?.beadsDir).toBe("/s/.beads")
  })

  test("every bd in a list is read", () => {
    expect(workSites("bd update ab-1 --status open; cd x && bd close ab-2 -r y").map((site) => site.ids)).toEqual([["ab-1"], ["ab-2"]])
  })
})

describe("hasCheckableEvidence", () => {
  test.each([
    "bun test plugins/beads/shared/claim-gate.test.ts: 40 pass",
    "changed src/index.ts",
    "merged in a1b2c3d",
    "PR #42 merged",
    "https://github.com/o/r/pull/7",
    "`just verify` green",
    "3 tests passed",
    "exit code 0 from the smoke run",
    "updated /etc/x and docs",
    "plugins/beads/README documents it",
    "ran go test ./...",
  ])("accepts %p", (text) => {
    expect(hasCheckableEvidence(text)).toBe(true)
  })

  test.each(["", "   ", "done", "N/A", "and/or finished", "Implement the claim gate", "fixed it", "completed as requested"])(
    "rejects %p",
    (text) => {
      expect(hasCheckableEvidence(text)).toBe(false)
    },
  )

  test("a git command counts by default; a wrapper only when listed in gitWrappers", () => {
    expect(hasCheckableEvidence("ran git push origin topic")).toBe(true)
    expect(hasCheckableEvidence("ran dgit push origin topic")).toBe(false)
    expect(hasCheckableEvidence("ran dgit push origin topic", ["git", "dgit"])).toBe(true)
    expect(hasCheckableEvidence("ran git push origin topic", ["dgit"])).toBe(false)
    expect(hasCheckableEvidence("ran gxt push", ["g.t"])).toBe(false)
  })
})

describe("closeEvidenceRefusal", () => {
  test("a close without a reason is refused", () => {
    expect(closeEvidenceRefusal([], root)).toContain("no --reason")
  })

  test("a reason read from stdin or a computed path cannot be checked first", () => {
    expect(closeEvidenceRefusal([{ kind: "file", path: "-" }], root)).toContain("stdin")
    expect(closeEvidenceRefusal([{ kind: "file", path: "$F" }], root)).toContain("stdin")
  })

  test("a reason file is read and judged", () => {
    writeFileSync(join(root, "good.md"), "ran `bun test`: 12 pass\n")
    writeFileSync(join(root, "bad.md"), "done\n")
    expect(closeEvidenceRefusal([{ kind: "file", path: "good.md" }], root)).toBeUndefined()
    expect(closeEvidenceRefusal([{ kind: "file", path: "bad.md" }], root)).toContain("no checkable evidence")
    expect(closeEvidenceRefusal([{ kind: "file", path: "missing.md" }], root)).toContain("not a small readable file")
  })

  test("every reason must carry evidence", () => {
    expect(
      closeEvidenceRefusal(
        [
          { kind: "text", text: "changed a/b/c.ts" },
          { kind: "text", text: "done" },
        ],
        root,
      ),
    ).toContain('"done"')
  })

  test("gitWrappers reaches every reason", () => {
    writeFileSync(join(root, "wrapped.md"), "dgit push origin topic\n")
    const reasons = [
      { kind: "text" as const, text: "dgit push origin topic" },
      { kind: "file" as const, path: "wrapped.md" },
    ]
    expect(closeEvidenceRefusal(reasons, root)).toContain("no checkable evidence")
    expect(closeEvidenceRefusal(reasons, root, ["git", "dgit"])).toBeUndefined()
  })
})

describe("issueRows", () => {
  test("reads the envelope, a bare list, a bare object and bd's empty null", () => {
    const row = { id: "ab-1", status: "open" }
    expect(issueRows(JSON.stringify({ schema_version: 1, data: [row] }))).toEqual([{ id: "ab-1", status: "open", assignee: "" }])
    expect(issueRows(JSON.stringify([{ ...row, assignee: " x " }]))).toEqual([{ id: "ab-1", status: "open", assignee: "x" }])
    expect(issueRows(JSON.stringify(row))).toEqual([{ id: "ab-1", status: "open", assignee: "" }])
    expect(issueRows("null")).toEqual([])
  })

  test("anything else is no issue list", () => {
    expect(issueRows("not json")).toBeUndefined()
    expect(issueRows(JSON.stringify([{ id: "ab-1" }]))).toBeUndefined()
  })
})

describe("unclaimedBeads", () => {
  const rows = [
    { id: "p-ab-1", status: "in_progress", assignee: "pi/root" },
    { id: "p-ab-2", status: "in_progress", assignee: "pi/root/child" },
    { id: "p-ab-3", status: "in_progress", assignee: "pi/other" },
    { id: "p-ab-4", status: "open", assignee: "" },
    { id: "p-ab-5", status: "in_progress", assignee: "" },
  ]

  test("the session's own claims and its descendants' pass", () => {
    expect(unclaimedBeads("pi/root", ["p-ab-1", "ab-2"], rows)).toEqual([])
  })

  test("a child may not work its parent's bead", () => {
    expect(unclaimedBeads("pi/root/child", ["p-ab-1"], rows)).toEqual(["p-ab-1 (held by pi/root)"])
  })

  test("another holder, an open bead, an unassigned one and a missing one are refused", () => {
    expect(unclaimedBeads("pi/root", ["p-ab-3", "p-ab-4", "p-ab-5", "p-ab-9"], rows)).toEqual([
      "p-ab-3 (held by pi/other)",
      "p-ab-4 (open)",
      "p-ab-5 (in_progress, unassigned)",
      "p-ab-9 (not found)",
    ])
  })
})

describe("decideBeadWork", () => {
  test("only the blocked bead's exact owner may perform a guarded unblock", async () => {
    const table = { "p-1": { status: "blocked", assignee: ACTOR } }
    const command = `bd update p-1 --status open --if-status blocked --if-assignee ${ACTOR}`
    expect(await decide(command, table)).toBeUndefined()
    for (const changed of [
      command.replace("--if-status blocked ", ""),
      command.replace(` --if-assignee ${ACTOR}`, ""),
      command.replace("--status open", "--status deferred"),
      command.replace(ACTOR, `${ACTOR}/child`),
      `${command} --title changed`,
      command.replace("bd update", "bd --db /other update"),
      command.replace("bd update", "bd --database other update"),
      `${command} --status deferred`,
      command.replace("p-1", "p-1 p-2"),
    ]) expect((await decide(changed, table))?.gate).toBe(CLAIM_GATE)
    expect((await decide(command, {}))?.cause).toContain("could not be read")
    for (const row of [
      { status: "deferred", assignee: ACTOR },
      { status: "blocked", assignee: "" },
      { status: "blocked", assignee: `${ACTOR}/child` },
    ]) expect((await decide(command, { "p-1": row }))?.gate).toBe(CLAIM_GATE)
  })

  test("an unclaimed close is refused", async () => {
    const refusal = await decide(`bd close p-ab-1 ${EVIDENCE}`, { "p-ab-1": { status: "open" } })
    expect(refusal?.gate).toBe(CLAIM_GATE)
    expect(refusal?.cause).toContain("p-ab-1 (open)")
    expect(refusal?.cause).toContain(ACTOR)
    expect(refusal?.resolution).toContain("bd update ID --claim")
  })

  test("a close of the session's own claim passes", async () => {
    const calls: string[][] = []
    expect(await decide(`bd close p-ab-1 ${EVIDENCE}`, { "p-ab-1": { status: "in_progress", assignee: ACTOR } }, calls)).toBeUndefined()
    expect(calls).toEqual([["show", "p-ab-1", "--json"]])
  })

  test("a parent closes the bead its child claimed", async () => {
    expect(
      await decide(`bd close p-ab-1 ${EVIDENCE}`, { "p-ab-1": { status: "in_progress", assignee: `${ACTOR}/child` } }),
    ).toBeUndefined()
  })

  test("a lifecycle update needs the claim; notes and comments on another's bead do not", async () => {
    const table = { "p-ab-1": { status: "in_progress", assignee: "pi/other" } }
    expect((await decide("bd update p-ab-1 --status open", table))?.gate).toBe(CLAIM_GATE)
    const calls: string[][] = []
    expect(await decide("bd update p-ab-1 --append-notes n >/dev/null", table, calls)).toBeUndefined()
    expect(await decide('bd comment p-ab-1 "note"', table, calls)).toBeUndefined()
    expect(await decide('bd comments add p-ab-1 "note"', table, calls)).toBeUndefined()
    expect(calls).toEqual([])
  })

  test("the guarded unblock still passes with a redirection", async () => {
    const table = { "p-1": { status: "blocked", assignee: ACTOR } }
    expect(await decide(`bd update p-1 --status open --if-status blocked --if-assignee ${ACTOR} 2>&1`, table)).toBeUndefined()
  })

  test("a close without evidence is refused before any lookup", async () => {
    const calls: string[][] = []
    const refusal = await decide('bd close p-ab-1 --reason "done"', { "p-ab-1": { status: "in_progress", assignee: ACTOR } }, calls)
    expect(refusal?.gate).toBe(EVIDENCE_GATE)
    expect(calls).toEqual([])
  })

  test("a computed or missing id is refused without a lookup", async () => {
    const calls: string[][] = []
    expect((await decide(`bd close "$ID" ${EVIDENCE}`, {}, calls))?.cause).toContain("$ID")
    expect((await decide(`bd close ${EVIDENCE}`, {}, calls))?.cause).toContain("names no bead id")
    expect(calls).toEqual([])
  })

  test("a lookup bd cannot answer fails closed", async () => {
    const refusal = await decide(`bd close p-ab-1 ${EVIDENCE}`, {})
    expect(refusal?.gate).toBe(CLAIM_GATE)
    expect(refusal?.cause).toContain("could not be read")
  })

  test("commands without gated work never ask bd", async () => {
    const calls: string[][] = []
    expect(await decide("git status && bd ready --json && bd update p-ab-1 --claim", {}, calls)).toBeUndefined()
    expect(calls).toEqual([])
  })
})

describe("child write claim", () => {
  test("asks bd for one in-progress claim under the actor", () => {
    expect(heldClaimArgs("pi/r/c")).toEqual(["list", "--assignee", "pi/r/c", "--status", "in_progress", "--limit", "1", "--json"])
  })

  test("reads bd's answer", () => {
    expect(holdsClaim(JSON.stringify({ schema_version: 1, data: [{ id: "a-1", status: "in_progress" }] }))).toBe(true)
    expect(holdsClaim("null")).toBe(false)
    expect(holdsClaim("[]")).toBe(false)
    expect(holdsClaim("garbage")).toBeUndefined()
  })

  test("the refusal names the store and the fix", () => {
    const refusal = writeClaimRefusal("/w/a.ts", "/w/.beads", "pi/r/c")
    expect(refusal.gate).toBe(WRITE_CLAIM_GATE)
    expect(refusal.resolution).toContain("bd update ID --claim")
    expect(writeClaimRefusal("/w/a.ts", "/w/.beads", "pi/r/c", "bd timed out").cause).toContain("bd timed out")
  })

  test("a new file's store is found from its nearest existing directory", () => {
    expect(existingDirectory(join(root, "new", "deeper", "file.ts"))).toBe(root)
  })
})
