import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allowSubagentReads, isSecretResource } from "./subagent-reads.ts"

let home: string
beforeAll(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), "reads-home-"))
  mkdirSync(join(home, ".ssh"), { recursive: true })
  mkdirSync(join(home, ".config/gh"), { recursive: true })
  mkdirSync(join(home, "work"), { recursive: true })
  writeFileSync(join(home, ".config/gh/hosts.yml"), "x")
  writeFileSync(join(home, "work/app.env"), "A=1")
  symlinkSync(join(home, "work/app.env"), join(home, "work/readme.txt"))
  symlinkSync(join(home, ".ssh"), join(home, "work/docs"))
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe("isSecretResource", () => {
  test.each([
    ["a file below a protected folder", () => `${home}/.ssh/id_ed25519`],
    ["the protected folder's glob", () => `${home}/.ssh/*`],
    ["a protected file", () => `${home}/.config/gh/hosts.yml`],
    ["the home folder, an ancestor of the secrets", () => `${home}/*`],
    ["~/.config, an ancestor of the secrets", () => `${home}/.config/*`],
    ["the filesystem root", () => "/*"],
    ["an env file", () => `${home}/work/app.env`],
    ["an env file variant", () => `${home}/work/x.env.local`],
    ["a symlink named like a note that points to an env file", () => `${home}/work/readme.txt`],
    ["a symlink that points into a protected folder", () => `${home}/work/docs/*`],
    ["a relative path", () => "work/x"],
    ["a mid-path wildcard", () => `${home}/*/x`],
    ["a `..` segment", () => `${home}/work/../.ssh/x`],
  ])("%s is a secret", (_, resource) => expect(isSecretResource(resource(), [], home)).toBe(true))

  test.each([
    ["a sibling of the secrets", () => `${home}/work/*`],
    ["a plain file", () => `${home}/work/main.ts`],
    ["a folder whose name only starts like a secret", () => `${home}/.sshfs/x`],
  ])("%s is not", (_, resource) => expect(isSecretResource(resource(), [], home)).toBe(false))

  test("an extra location counts, in both directions", () => {
    expect(isSecretResource(`${home}/work/*`, [`${home}/work/private`], home)).toBe(true)
    expect(isSecretResource(`${home}/work/private/a`, [`${home}/work/private`], home)).toBe(true)
  })
})

describe("allowSubagentReads", () => {
  const ev = (resources: string[]) => ({ action: "external_directory", resources, effect: "ask" })
  test("allows a read-only tool in a subagent, and nothing else", () => {
    const e = ev([`${home}/work/*`])
    allowSubagentReads(e, "read", false, [], home)
    expect(e.effect).toBe("ask")
    allowSubagentReads(e, "edit", true, [], home)
    expect(e.effect).toBe("ask")
    allowSubagentReads(e, "shell", true, [], home)
    expect(e.effect).toBe("allow")
  })
  test("one secret among several resources keeps the ask", () => {
    const e = ev([`${home}/work/*`, `${home}/.ssh/*`])
    allowSubagentReads(e, "read", true, [], home)
    expect(e.effect).toBe("ask")
  })
})
