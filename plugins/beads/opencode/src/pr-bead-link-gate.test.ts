import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "@srobroek/opencode-lib/beads-shell"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"

import {
  beadsActive,
  controlledByViewerPermission,
  decidePrBeadLink,
  type PrBeadLinkDeps,
  readBodyFile,
  repositoryControlled,
} from "./pr-bead-link-gate.ts"
import { ACCEPTED_FORMS, MAX_BODY_BYTES, TRAILER_RULE } from "./pr-create-form.ts"

describe("repository subprocess contract", () => {
  test("uses gh repo view's viewerPermission output contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-gh-"))
    const gh = join(dir, "gh")
    const args = join(dir, "args")
    writeExecutable(gh, '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_ARGS_FILE"\nprintf "%s\\n" "${' + 'GH_PERMISSION:-WRITE}"\n')
    const previousPath = process.env.PATH
    const previousArgsFile = process.env.GH_ARGS_FILE
    const previousPermission = process.env.GH_PERMISSION
    process.env.PATH = `${dir}:${previousPath ?? ""}`
    process.env.GH_ARGS_FILE = args
    process.env.GH_PERMISSION = "WRITE"
    try {
      expect(repositoryControlled("owner/repo")).toEqual({ kind: "controlled" })
      process.env.GH_PERMISSION = "READ"
      expect(repositoryControlled("owner/repo")).toEqual({ kind: "uncontrolled" })
      expect(readFileSync(args, "utf8").trim().split("\n")).toEqual([
        "repo",
        "view",
        "owner/repo",
        "--json",
        "viewerPermission",
        "--jq",
        ".viewerPermission",
      ])
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousPermission === undefined) delete process.env.GH_PERMISSION
      else process.env.GH_PERMISSION = previousPermission
      if (previousArgsFile === undefined) delete process.env.GH_ARGS_FILE
      else process.env.GH_ARGS_FILE = previousArgsFile
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("refuses when the permission lookup fails and names the failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-gh-failure-"))
    const gh = join(dir, "gh")
    writeExecutable(gh, '#!/bin/sh\nprintf "%s" "permission lookup failed" >&2\nexit 1\n')
    const previousPath = process.env.PATH
    process.env.PATH = `${dir}:${previousPath ?? ""}`
    try {
      const control = repositoryControlled("owner/repo")
      expect(control.kind).toBe("unknown")
      const decision = decidePrBeadLink(parse("gh pr create --title t --body x"), dir, { control: () => control })
      expect(decision?.block).toBe(true)
      expect(decision?.reason).toContain("Repository permission could not be determined")
      expect(decision?.reason).toContain("permission lookup failed")
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("repository control", () => {
  test("only write-capable viewer permissions control", () => {
    for (const permission of ["WRITE", "MAINTAIN", "ADMIN"]) expect(controlledByViewerPermission(permission)).toBe(true)
    for (const permission of ["READ", "TRIAGE", null, undefined, ""])
      expect(controlledByViewerPermission(permission)).toBe(false)
  })
})

describe("beads activity", () => {
  test("allows bead-less bodies for a regular-file RETIRED sentinel", () => {
    const root = mkdtempSync(join(tmpdir(), "beads-retired-"))
    mkdirSync(join(root, ".beads"))
    writeFileSync(join(root, ".beads", "RETIRED"), "")
    try {
      expect(beadsActive(root)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("requires beads for ordinary and malformed RETIRED paths", () => {
    for (const retired of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), "beads-live-"))
      mkdirSync(join(root, ".beads"))
      if (retired) mkdirSync(join(root, ".beads", "RETIRED"))
      try {
        expect(beadsActive(root)).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
  test("keeps a symlink RETIRED marker active even when it targets a file", () => {
    const root = mkdtempSync(join(tmpdir(), "beads-retired-link-"))
    mkdirSync(join(root, ".beads"))
    writeFileSync(join(root, "marker"), "")
    symlinkSync(join(root, "marker"), join(root, ".beads", "RETIRED"))
    try {
      expect(beadsActive(root)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("does not inherit an ancestor sentinel past a nearer live ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "beads-shadow-"))
    mkdirSync(join(root, ".beads"))
    writeFileSync(join(root, ".beads", "RETIRED"), "")
    const child = join(root, "child")
    mkdirSync(join(child, ".beads"), { recursive: true })
    try {
      expect(beadsActive(child)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("readBodyFile", () => {
  let dir = ""
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "beads-bodyfile-"))
    mkdirSync(join(dir, "sub"))
    writeFileSync(join(dir, "ok.md"), "Adds a thing.\n\nBead: a-1\n")
    writeFileSync(join(dir, "sub", "ok.md"), "in sub")
    writeFileSync(join(dir, "edge.md"), "x".repeat(MAX_BODY_BYTES))
    writeFileSync(join(dir, "big.md"), "x".repeat(MAX_BODY_BYTES + 1))
    writeFileSync(join(dir, "bad.md"), Buffer.from([0x42, 0xff, 0xfe]))
    writeFileSync(join(dir, "nul.md"), "a\0b")
    writeFileSync(join(dir, "bom.md"), "\uFEFFBead: a-1")
    mkdirSync(join(dir, "d"))
    symlinkSync(join(dir, "sub"), join(dir, "l"))
    symlinkSync(join(dir, "ok.md"), join(dir, "link.md"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("reads a regular file relative to the working directory", () => {
    expect(readBodyFile(dir)("ok.md")).toEqual({ ok: true, text: "Adds a thing.\n\nBead: a-1\n" })
    expect(readBodyFile(dir)("sub/ok.md")).toEqual({ ok: true, text: "in sub" })
    expect(readBodyFile(join(dir, "sub"))("ok.md")).toEqual({ ok: true, text: "in sub" })
  })

  test("reads a file of exactly the cap", () => {
    expect(readBodyFile(dir)("edge.md")).toMatchObject({ ok: true })
  })

  test("keeps a BOM in the text, so it still hides a trailer from beadIn", () => {
    expect(readBodyFile(dir)("bom.md")).toEqual({ ok: true, text: "\uFEFFBead: a-1" })
  })

  test.each([
    ["a file over the cap", "big.md", "larger than"],
    ["invalid UTF-8", "bad.md", "not valid UTF-8"],
    ["a NUL byte", "nul.md", "NUL"],
    ["a directory", "d", "not a regular file"],
    ["a symlinked directory", "l/ok.md", "symlink"],
    ["a symlinked final file", "link.md", "could not be opened"],
    ["a missing file", "nope.md", "could not be opened"],
  ])("refuses %s", (_name, path, reason) => {
    const read = readBodyFile(dir)(path)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toContain(reason)
  })

  // The test took 0.2 s alone (3 runs); 15 s covers the 10 s child deadline plus load.
  test("refuses a FIFO without blocking", { timeout: 15_000 }, () => {
    const made = spawnSync("mkfifo", [join(dir, "pipe")])
    if (made.status !== 0) {
      console.warn("SKIPPED: mkfifo is unavailable")
      return
    }
    const gate = join(import.meta.dir, "pr-bead-link-gate.ts")
    const script = `import { readBodyFile } from ${JSON.stringify(gate)}
console.log(JSON.stringify(readBodyFile(process.env.DIR ?? "")("pipe")))`
    const child = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, DIR: dir }, timeout: 10_000, encoding: "utf8" })
    expect(child.error).toBeUndefined()
    expect(JSON.parse(child.stdout)).toMatchObject({ ok: false, reason: expect.stringContaining("not a regular file") })
  })
})

describe("decidePrBeadLink", () => {
  const controlled: PrBeadLinkDeps = { control: () => ({ kind: "controlled" }) }
  const decide = (command: string, deps: PrBeadLinkDeps = controlled, cwd = tmpdir()) => decidePrBeadLink(parse(command), cwd, deps)

  test("passes a command that cannot create a PR without asking anything", () => {
    const deps: PrBeadLinkDeps = {
      control: () => {
        throw new Error("lookup")
      },
      note: () => {
        throw new Error("note")
      },
    }
    expect(decide("gh pr list --state open", deps)).toBeNull()
    expect(decide("git push origin main", deps)).toBeNull()
  })

  test("passes an exact form that names a bead without a repository lookup or a note", () => {
    const deps: PrBeadLinkDeps = {
      control: () => {
        throw new Error("lookup")
      },
      note: () => {
        throw new Error("note")
      },
    }
    expect(decide("gh pr create --title t --body 'Bead: a-1'", deps)).toBeNull()
  })

  test("a bead-less exact form is refused with the old reason, the source it read and the accepted forms", () => {
    const decision = decide("gh pr create --title t --body 'Adds a fish alias.'")
    expect(decision?.reason).toContain("This PR names no bead.")
    expect(decision?.reason).toContain("Looked at the --body text, not the branch or the title.")
    expect(decision?.resolution).toBe(`${ACCEPTED_FORMS} ${TRAILER_RULE}`)
  })

  test("a form the gate cannot read is refused naming its one rule, and the body is never echoed", () => {
    const decision = decide("gh pr create --title t --body 'SECRET-TEXT Bead: a-1' extra")
    expect(decision?.reason).toContain("the word at position 8 is not a flag or a flag's value")
    expect(decision?.reason).not.toContain("SECRET-TEXT")
    expect(decision?.resolution).toBe(`${ACCEPTED_FORMS} ${TRAILER_RULE}`)
  })

  test("a body file is read from the working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "beads-pr-link-"))
    try {
      writeFileSync(join(dir, "none.md"), "Adds a thing.\n")
      writeFileSync(join(dir, "ok.md"), "Adds a thing.\n\nBead: a-1\n")
      expect(decide("gh pr create --title t -F none.md", controlled, dir)?.reason).toContain("Looked at --body-file none.md")
      expect(decide("gh pr create --title t -F ok.md", controlled, dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the repository lookup gets the --repo of the form, or null when the form is refused", () => {
    const seen: (string | null)[] = []
    const deps: PrBeadLinkDeps = {
      control: (repo) => {
        seen.push(repo)
        return false
      },
    }
    decide("gh pr create --title t -R o/r --body x", deps)
    decide("gh pr create -R o/r --fill", deps)
    expect(seen).toEqual(["o/r", null])
  })

  test.each<[string, PrBeadLinkDeps["control"]]>([
    ["no ledger", () => false],
    ["an uncontrolled repository", () => ({ kind: "uncontrolled" })],
  ])("a bead-less PR passes for %s", (_name, control) => {
    expect(decide("gh pr create --title t --body x", { control })).toBeNull()
    expect(decide("env -S 'gh pr create'", { control })).toBeNull()
  })

  test("a bead-less PR is refused when the control is plain true", () => {
    expect(decide("gh pr create --title t --body x", { control: () => true })).not.toBeNull()
  })
})
