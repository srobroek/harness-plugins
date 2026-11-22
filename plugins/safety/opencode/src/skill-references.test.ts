import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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

describe("skill directories that are not dedicated skill folders", () => {
  let fixture: string
  let home: string
  const at = (...parts: string[]) => join(fixture, ...parts)
  const ask = (resource: string) => {
    const evaluation = { action: "external_directory", resources: [resource], effect: "ask" }
    return evaluation
  }
  const allowed = (skillPath: string, resource: string) => {
    const evaluation = ask(resource)
    allowSkillReads(evaluation, skillDirectories([{ path: skillPath }], home))
    return evaluation.effect === "allow"
  }
  beforeAll(() => {
    fixture = mkdtempSync(join(realpathSync(tmpdir()), "safety-skill-scope-"))
    home = at("users/me")
    mkdirSync(home, { recursive: true })
    // a repository root holding a SKILL.md, with a .git directory, a references/ directory and other files
    mkdirSync(at("repo/.git"), { recursive: true })
    mkdirSync(at("repo/references"))
    mkdirSync(at("repo/src"))
    // a worktree-style repository root: .git is a file
    mkdirSync(at("wt/skills/s/references"), { recursive: true })
    writeFileSync(at("wt/skills/s/.git"), "gitdir: elsewhere")
    // a broad directory that is not under skills/
    mkdirSync(at("broad/scripts"), { recursive: true })
    mkdirSync(at("broad/other"))
    // a dedicated skill folder
    mkdirSync(at("plug/skills/good/references"), { recursive: true })
    mkdirSync(at("plug/skills/good/misc"))
    // references/ linking out of the skill directory, and a skill link into a broad directory
    mkdirSync(at("out/secret"), { recursive: true })
    mkdirSync(at("broad2"))
    symlinkSync(at("out/secret"), at("broad2/references"))
    symlinkSync(at("broad"), at("plug/skills/linked-broad"))
  })
  afterAll(() => rmSync(fixture, { recursive: true, force: true }))

  test("a dedicated skill folder is trusted whole", () => {
    expect(allowed(at("plug/skills/good/SKILL.md"), at("plug/skills/good/misc/*"))).toBe(true)
  })

  test("a trailing slash on a requested path stays inside the skill folder", () => {
    expect(allowed(at("plug/skills/good/SKILL.md"), at("plug/skills/good/misc/"))).toBe(true)
  })

  test("a repository root with a .git directory does not allow its other directories", () => {
    expect(allowed(at("repo/SKILL.md"), at("repo/src/*"))).toBe(false)
  })

  test("a repository root still allows its references/ directory", () => {
    expect(allowed(at("repo/SKILL.md"), at("repo/references/*"))).toBe(true)
  })

  test("a skills/<dir> folder with a .git file is not trusted whole", () => {
    expect(allowed(at("wt/skills/s/SKILL.md"), at("wt/skills/s/.git"))).toBe(false)
  })

  test("a skills/<dir> folder with a .git file still allows its references/ directory", () => {
    expect(allowed(at("wt/skills/s/SKILL.md"), at("wt/skills/s/references/*"))).toBe(true)
  })

  test("a broad directory outside skills/ does not allow its other directories", () => {
    expect(allowed(at("broad/SKILL.md"), at("broad/other/*"))).toBe(false)
  })

  test("a broad directory outside skills/ allows its scripts/ directory", () => {
    expect(allowed(at("broad/SKILL.md"), at("broad/scripts/*"))).toBe(true)
  })

  test("a references/ directory swapped for an outside link after the roots were computed is not allowed", () => {
    mkdirSync(at("race/references"), { recursive: true })
    mkdirSync(at("race-out"))
    writeFileSync(at("race-out/secret"), "x")
    const dirs = skillDirectories([{ path: at("race/SKILL.md") }], home)
    rmSync(at("race/references"), { recursive: true })
    symlinkSync(at("race-out"), at("race/references"))
    const evaluation = ask(at("race/references/secret"))
    allowSkillReads(evaluation, dirs)
    expect(evaluation.effect).toBe("ask")
  })

  test("a skills/ link to a broad directory follows the real directory", () => {
    expect(allowed(at("plug/skills/linked-broad/SKILL.md"), at("broad/other/*"))).toBe(false)
  })

  test("a references/ link that leaves the skill directory is not trusted", () => {
    expect(allowed(at("broad2/SKILL.md"), at("out/secret/*"))).toBe(false)
  })

  test("a requested path that climbs out of an allowed subdirectory is refused", () => {
    expect(allowed(at("repo/SKILL.md"), at("repo/references/../src/*"))).toBe(false)
  })
})

describe("a .git probe that cannot say the entry is absent", () => {
  let fixture: string
  let home: string
  const at = (...parts: string[]) => join(fixture, ...parts)
  const skill = (name: string) => [{ path: at("skills", name, "SKILL.md") }]
  beforeAll(() => {
    fixture = mkdtempSync(join(realpathSync(tmpdir()), "safety-skill-git-"))
    home = at("home")
    mkdirSync(home)
    for (const name of ["dangling", "looping", "unreadable", "clean"]) mkdirSync(at("skills", name, "references"), { recursive: true })
    symlinkSync(at("nowhere"), at("skills/dangling/.git"))
    symlinkSync(at("skills/looping/.git"), at("skills/looping/.git"))
    chmodSync(at("skills/unreadable"), 0o600)
  })
  afterAll(() => {
    chmodSync(at("skills/unreadable"), 0o700)
    rmSync(fixture, { recursive: true, force: true })
  })

  test("a dangling .git symlink makes the directory a repository root", () => {
    expect(skillDirectories(skill("dangling"), home)).toEqual([at("skills/dangling/references")])
  })

  test("a looping .git symlink makes the directory a repository root", () => {
    expect(skillDirectories(skill("looping"), home)).toEqual([at("skills/looping/references")])
  })

  test.skipIf(process.getuid?.() === 0)("a directory whose .git cannot be inspected is not trusted whole", () => {
    expect(skillDirectories(skill("unreadable"), home)).not.toContain(at("skills/unreadable"))
  })

  test("a skills/<dir> folder without .git is still trusted whole", () => {
    expect(skillDirectories(skill("clean"), home)).toEqual([at("skills/clean")])
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
