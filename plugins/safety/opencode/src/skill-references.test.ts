import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allowSkillReads, listedSkills, skillDirectories } from "./skill-references.ts"

describe("skillDirectories", () => {
  // users/me is the home folder. links/ holds symlinks to it, to its parent, to the filesystem root and to an ordinary skill.
  let fixture: string
  let home: string
  const at = (...parts: string[]) => join(fixture, ...parts)
  beforeAll(() => {
    fixture = mkdtempSync(join(realpathSync(tmpdir()), "safety-skill-dirs-"))
    home = at("users/me")
    mkdirSync(join(home, ".cache/skills/a"), { recursive: true })
    mkdirSync(at("opt/skills/b"), { recursive: true })
    mkdirSync(at("links"))
    symlinkSync(home, at("links/home"))
    symlinkSync(at("users"), at("links/users"))
    symlinkSync("/", at("links/root"))
    symlinkSync(at("opt/skills/b"), at("links/skill"))
  })
  afterAll(() => rmSync(fixture, { recursive: true, force: true }))

  test("keeps the directory of each SKILL.md", () => {
    const skills = [{ path: join(home, ".cache/skills/a/SKILL.md") }, { path: at("opt/skills/b/SKILL.md") }]
    expect(skillDirectories(skills, home)).toEqual([join(home, ".cache/skills/a"), at("opt/skills/b")])
  })

  test("keeps the real directory of a skill whose directory links to an ordinary folder", () => {
    expect(skillDirectories([{ path: at("links/skill/SKILL.md") }], home)).toEqual([at("opt/skills/b")])
  })

  test.each([
    ["the filesystem root", () => ["/SKILL.md", home]],
    ["the home folder", () => [join(home, "SKILL.md"), home]],
    ["a parent of the home folder", () => [at("users/SKILL.md"), home]],
    ["a link to the home folder", () => [at("links/home/SKILL.md"), home]],
    ["a link to a parent of the home folder", () => [at("links/users/SKILL.md"), home]],
    ["a link to the filesystem root", () => [at("links/root/SKILL.md"), home]],
    ["the home folder named through a link to it", () => [join(home, "SKILL.md"), at("links/home")]],
    ["a directory that does not resolve", () => [at("missing/SKILL.md"), home]],
    ["any skill when the home folder does not resolve", () => [at("opt/skills/b/SKILL.md"), at("no-home")]],
    ["a relative path", () => ["skills/a/SKILL.md", home]],
    ["a file that is not SKILL.md", () => [at("opt/skills/b/notes.md"), home]],
  ])("skips %s", (_, paths) => {
    const [path, homeFolder] = paths()
    expect(skillDirectories([{ path }], homeFolder)).toEqual([])
  })

  test("a skill linked to the home folder does not allow reads elsewhere in it", () => {
    const evaluation = { action: "external_directory", resources: [join(home, ".ssh/*")], effect: "ask" }
    allowSkillReads(evaluation, skillDirectories([{ path: at("links/home/SKILL.md") }], home))
    expect(evaluation.effect).toBe("ask")
  })
})

describe("listedSkills", () => {
  test("reads the client's { data } shape and a bare array", () => {
    const skill = { path: "/opt/skills/a/SKILL.md" }
    expect(listedSkills({ data: [skill] })).toEqual([skill])
    expect(listedSkills([skill])).toEqual([skill])
    expect(listedSkills(undefined)).toEqual([])
  })
})
