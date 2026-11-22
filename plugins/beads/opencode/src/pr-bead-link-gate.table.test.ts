import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { decideShell } from "./shell-gates.ts"
import { gateDeps } from "./test-support.ts"

// One `mkfifo` child process; 30 s leaves headroom for a loaded machine (AGENTS.md, Commands).
setDefaultTimeout(30_000)

/**
 * The PR bead-link gate through `decideShell`, in a repository the viewer controls and that has a
 * ledger. Every refused row is a way to reach `gh pr create` that the gate cannot read exactly, and
 * most of them carry a bead trailer the gate could mistake for the body `gh` really submits.
 */
let root = ""
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-pr-table-")))
  mkdirSync(join(root, ".beads"))
  writeFileSync(join(root, ".beads", "metadata.json"), "{}")
  mkdirSync(join(root, "sub"))
  mkdirSync(join(root, "d"))
  writeFileSync(join(root, "b.md"), "Adds a thing.\n\nBead: a-1\n")
  // `sub/b.md` is the file `gh` reads when the command runs from `sub`; the gate would read `b.md`.
  writeFileSync(join(root, "sub", "b.md"), "Adds a thing.\n")
  writeFileSync(join(root, "nobead.md"), "Adds a thing.\n")
  writeFileSync(join(root, "bom.md"), "\uFEFFBead: a-1\n")
  writeFileSync(join(root, "big.md"), `Bead: a-1\n${"x".repeat(64_001)}`)
  writeFileSync(join(root, "bad.md"), Buffer.concat([Buffer.from("Bead: a-1\n"), Buffer.from([0xff, 0xfe])]))
  writeFileSync(join(root, "nul.md"), "Bead: a-1\n\0")
  symlinkSync(join(root, "sub"), join(root, "l"))
  symlinkSync(join(root, "b.md"), join(root, "link.md"))
  execFileSync("mkfifo", [join(root, "pipe")])
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const controlled = { repositoryControl: () => ({ kind: "controlled" as const }) }
const at = (command: string) => command.replaceAll("{root}", root)
const gated = (command: string) => decideShell(at(command), root, gateDeps(controlled))

const MUST_BLOCK: [string, string][] = [
  ["BOM before the trailer", "gh pr create --title t -F bom.md"],
  ["NBSP before the trailer", "gh pr create --title t --body '\u00A0Bead: a-1'"],
  ["text before the trailer", "gh pr create --title t --body 'x Bead: a-1'"],

  ["env -S", "env -S 'gh pr create --title t --body x'"],
  ["env -iS", `env -iS"gh pr create --title t --body x"`],
  ["env -uX -S", "env -uX -S 'gh pr create --title t --body x'"],

  ["env -C", "env -C sub gh pr create --title t -F b.md"],
  ["cd then create", "cd sub && gh pr create --title t -F b.md"],
  ["sh -c with cd", "sh -c 'cd sub; gh pr create --title t -F b.md'"],

  ["dotdot through a symlinked directory", "gh pr create --title t -F l/../b.md"],
  ["symlinked directory", "gh pr create --title t -F l/b.md"],
  ["symlinked final file", "gh pr create --title t -F link.md"],

  ["ANSI-C body", "gh pr create --title t --body $'Bead: a-1'"],
  ["ANSI-C body with NUL", "gh pr create --title t --body $'a\\0\\nBead: a-1'"],
  ["ANSI-C flag", "gh pr create --title t $'--body' 'Bead: a-1'"],
  ["ANSI-C path", "gh pr create --title t -F $'\\xff'"],

  ["body file from stdin", "gh pr create --title t -F -"],
  ["FIFO body file", "gh pr create --title t -F pipe"],
  ["directory body file", "gh pr create --title t -F d"],
  ["body file over 64000 bytes", "gh pr create --title t -F big.md"],
  ["body file that is invalid UTF-8", "gh pr create --title t -F bad.md"],
  ["body file with a NUL", "gh pr create --title t -F nul.md"],
  ["absolute body file path", "gh pr create --title t -F {root}/b.md"],
  ["body and body file together", "gh pr create --title t --body 'Bead: a-1' -F nobead.md"],
  ["file written by an earlier command", "echo x > w.md && gh pr create --title t -F w.md"],

  ["short cluster with a quoted value", "gh pr create --title t -db'Bead: a-1'"],
  ["attached short value", "gh pr create --title t -b'Bead: a-1'"],
  ["short value with equals", "gh pr create --title t -b='Bead: a-1'"],
  ["attached short file", "gh pr create --title t -Fb.md"],
  ["repeated body flag", "gh pr create --title t --body x --body 'Bead: a-1'"],

  ["chained after a push", "git push && gh pr create --title t --body 'Bead: a-1'"],
  ["wrapper", "timeout 30 gh pr create --title t --body x"],
  ["pr new", "gh pr new --title t --body x"],
  ["split command word", "g''h pr create --title t --body 'Bead: a-1'"],
  ["variable command word", "$GH pr create --title t --body 'Bead: a-1'"],
  ["alias", "gh mkpr --title t --body 'Bead: a-1'"],
]

const MUST_PASS: [string, string][] = [
  ["single-quoted multi-line body", "gh pr create --title t --body 'Adds a thing.\n\nBead: a-1\n'"],
  ["double-quoted body", 'gh pr create --title t --body "Adds a thing.\nBead: a-1" --draft'],
  ["--body=", "gh pr create --title t --body='Bead: a-1'"],
  ["-b", "gh pr create -t t -b 'Bead: a-1' -d"],
  ["body file", "gh pr create --title t --body-file b.md"],
  ["-F", "gh pr create --title t -F b.md"],
  ["backslash-newline continuation", "gh pr create \\\n  --title t \\\n  --body 'Bead: a-1'"],
  ["not a PR", "gh pr list --state open"],
  ["another gh command", "gh run watch 42 && git push"],
]

describe("PR bead-link gate: forms it cannot read exactly are refused", () => {
  test.each(MUST_BLOCK)("%s", async (_name, command) => {
    expect(await gated(command)).toMatchObject({ kind: "block", gate: "pr-bead-link-gate" })
  })
})

describe("PR bead-link gate: exact forms with a bead pass", () => {
  test.each(MUST_PASS)("%s", async (_name, command) => {
    // A form that names its bead needs no repository lookup, so a lookup is a failure.
    const deps = gateDeps({
      repositoryControl: () => {
        throw new Error("repository lookup")
      },
    })
    expect(await decideShell(at(command), root, deps)).toMatchObject({ kind: "allow" })
  })

  test("an unsupported form passes where the repository has no ledger", async () => {
    const deps = gateDeps({ repositoryControl: () => false })
    expect(await decideShell("env -S 'gh pr create --title t --body x'", root, deps)).toMatchObject({ kind: "allow" })
  })

  test("an unsupported form passes where the viewer does not control the repository", async () => {
    const deps = gateDeps({ repositoryControl: () => ({ kind: "uncontrolled" }) })
    expect(await decideShell("gh mkpr --title t --body x", root, deps)).toMatchObject({ kind: "allow" })
  })
})
