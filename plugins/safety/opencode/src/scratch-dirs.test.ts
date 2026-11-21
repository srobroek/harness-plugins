import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { allowScratch, inside, insideCanonical, realRoots, scratchRoots } from "./scratch-dirs.ts"

const base = join(realpathSync(tmpdir()), "opencode")
let dir: string
let roots: string[]
let temp: string
let own: string
let other: string

beforeAll(() => {
  mkdirSync(base, { recursive: true })
  dir = mkdtempSync(join(base, "scratch-"))
  temp = join(dir, "tmp/opencode")
  own = join(dir, "data/opencode/worktree/41bad1")
  other = join(dir, "data/opencode/worktree/ffffff")
  for (const path of [temp, own, other, join(dir, "tmp/other-user")]) mkdirSync(path, { recursive: true })
  roots = [temp, own]
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const evaluation = (resources: string[], effect = "ask", action = "external_directory") => ({ action, resources, effect })

describe("scratchRoots", () => {
  test("names the temp folder, the worktree folder (first six characters of the project id) and the shell and tool-output folders (full id)", () => {
    expect(
      scratchRoots("41bad135688c6b4d51e3ed10b0d2ed0ee58e94e2", { home: "/h", temp: "/t", env: {} }),
    ).toEqual([
      "/t/opencode",
      "/h/.local/share/opencode/worktree/41bad1",
      "/h/.local/share/opencode/shell/41bad135688c6b4d51e3ed10b0d2ed0ee58e94e2",
      "/h/.local/share/opencode/tool-output",
    ])
  })

  test("follows XDG_DATA_HOME", () => {
    expect(scratchRoots("41bad135688c", { home: "/h", temp: "/t", env: { XDG_DATA_HOME: "/x" } }).slice(1)).toEqual([
      "/x/opencode/worktree/41bad1",
      "/x/opencode/shell/41bad135688c",
      "/x/opencode/tool-output",
    ])
  })
})

describe("allowScratch", () => {
  test("allows a path in the temp folder", () => {
    const e = evaluation([`${temp}/pack.xml`])
    allowScratch(e, roots)
    expect(e.effect).toBe("allow")
  })

  test("allows a directory pattern in the project's own worktree folder", () => {
    const e = evaluation([`${own}/lane-1/*`])
    allowScratch(e, roots)
    expect(e.effect).toBe("allow")
  })

  test("leaves another project's worktree folder asking", () => {
    const e = evaluation([`${other}/lane-1/src`])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves another user's temp folder asking", () => {
    const e = evaluation([join(dir, "tmp/other-user/opencode/x")])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves a sibling whose name starts with the folder name asking", () => {
    const e = evaluation([`${temp}-evil/x`])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves a path that climbs out with .. asking", () => {
    const e = evaluation([`${temp}/../other-user/x`])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves a symlink out of the folder asking", () => {
    symlinkSync(join(dir, "tmp/other-user"), join(temp, "link"))
    const e = evaluation([`${temp}/link/secret`])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves the call asking when one resource is outside", () => {
    const e = evaluation([`${temp}/a`, "/etc/passwd"])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves a relative path and a wildcard in the middle asking", () => {
    for (const resource of ["opencode/x", `${temp}/*/x`, "*"]) {
      const e = evaluation([resource])
      allowScratch(e, roots)
      expect(e.effect).toBe("ask")
    }
  })

  test("leaves a root replaced by a symlink to an outside folder asking", () => {
    const outside = join(dir, "outside")
    mkdirSync(outside, { recursive: true })
    const swapped = join(dir, "swapped")
    symlinkSync(outside, swapped)
    const e = evaluation([`${swapped}/pack.xml`])
    allowScratch(e, [swapped])
    expect(e.effect).toBe("ask")
  })

  test("leaves a root below a symlinked component asking", () => {
    mkdirSync(join(dir, "real/inner"), { recursive: true })
    symlinkSync(join(dir, "real"), join(dir, "alias"))
    const e = evaluation([join(dir, "alias/inner/x")])
    allowScratch(e, [join(dir, "alias/inner")])
    expect(e.effect).toBe("ask")
  })

  test("leaves a root that does not exist asking", () => {
    const e = evaluation([join(dir, "missing/x")])
    allowScratch(e, [join(dir, "missing")])
    expect(e.effect).toBe("ask")
  })

  test("leaves a root owned by another user asking", () => {
    const e = evaluation([`${temp}/a`])
    allowScratch(e, roots, () => (process.getuid?.() ?? 0) + 1)
    expect(e.effect).toBe("ask")
  })

  test("never changes a deny", () => {
    const e = evaluation([`${temp}/a`], "deny")
    allowScratch(e, roots)
    expect(e.effect).toBe("deny")
  })

  test("never touches another action", () => {
    const e = evaluation([`${temp}/a`], "ask", "edit")
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })

  test("leaves a call with no resources asking", () => {
    const e = evaluation([])
    allowScratch(e, roots)
    expect(e.effect).toBe("ask")
  })
})

describe("insideCanonical", () => {
  test("does not re-resolve a root: a root that became a symlink does not move the boundary", () => {
    const target = join(dir, "swap-target")
    const link = join(dir, "swap-link")
    mkdirSync(target, { recursive: true })
    symlinkSync(target, link)
    expect(inside(`${target}/x`, [link])).toBe(true) // inside() follows the root's symlink
    expect(insideCanonical(`${target}/x`, [link])).toBe(false)
    expect(insideCanonical(`${link}/x`, [link])).toBe(false) // the resource resolves to the target
    expect(insideCanonical(`${temp}/x`, [temp])).toBe(true)
  })
})

describe("realRoots", () => {
  test("allows a request spelled through a symlink alias of the session directory", () => {
    mkdirSync(join(dir, "aliased/real-session/src"), { recursive: true })
    symlinkSync(join(dir, "aliased"), join(dir, "aliased-link"))
    const root = realRoots([join(dir, "aliased/real-session")])
    const e = evaluation([join(dir, "aliased-link/real-session/src/x.md")])
    allowScratch(e, root)
    expect(e.effect).toBe("allow")
  })

  test("leaves an alias inside the session directory that points outside asking", () => {
    mkdirSync(join(dir, "sess"), { recursive: true })
    symlinkSync(join(dir, "tmp/other-user"), join(dir, "sess/escape"))
    const e = evaluation([join(dir, "sess/escape/secret")])
    allowScratch(e, realRoots([join(dir, "sess")]))
    expect(e.effect).toBe("ask")
  })

  test("gives no root for a missing, relative or filesystem-root directory", () => {
    expect(realRoots([join(dir, "missing"), "relative", "/"])).toEqual([])
  })
})
