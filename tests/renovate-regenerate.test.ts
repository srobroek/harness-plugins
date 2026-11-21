import { afterEach, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parse } from "@visulima/yaml"

const root = path.join(import.meta.dir, "..")
// Focused tests took 2.8 s locally. Allow slower CI process startup.
setDefaultTimeout(30_000)
type Step = { name?: string; run?: string }
const workflow = parse(readFileSync(path.join(root, ".github/workflows/renovate-regenerate.yml"), "utf8")) as {
  jobs: { push: { steps: Step[] } }
}
const validator = workflow.jobs.push.steps.find((step) => step.name === "Validate and apply generated patch")?.run ?? ""
if (!validator) throw new Error("missing patch validator")

const fixtures: string[] = []
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(dir: string, args: string[]) {
  const result = Bun.spawnSync(args, { cwd: dir, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}

function fixture(source?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "renovate-patch-"))
  fixtures.push(dir)
  run(dir, ["git", "init", "--quiet"])
  run(dir, ["git", "config", "core.filemode", "false"])
  const file = (name: string, text: string | Uint8Array) => {
    const target = path.join(dir, name)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, text)
  }
  file("README.md", "fixture\n")
  if (source) file(source, "executable source fixture\n")
  run(dir, ["git", "add", "--all"])
  if (source) run(dir, ["git", "update-index", "--chmod=+x", source])
  run(dir, ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "fixture"])
  return { dir, file }
}

function apply(dir: string, executable?: string) {
  run(dir, ["git", "add", "--all"])
  if (executable) run(dir, ["git", "update-index", "--chmod=+x", executable])
  const patch = run(dir, ["git", "diff", "--cached", "--no-renames", "--full-index"])
  run(dir, ["git", "reset", "--hard", "--quiet"])
  run(dir, ["git", "clean", "-fd", "--quiet"])
  const patchPath = path.join(dir, ".git", "regenerated.patch")
  const output = path.join(dir, ".git", "step-output")
  writeFileSync(patchPath, patch)
  const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-c", validator], {
    cwd: dir,
    env: { ...process.env, PATCH_PATH: patchPath, VALIDATE_MODE: "push", GITHUB_OUTPUT: output },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { result, output }
}

test.each([
  "plugins/aws/opencode/.mcp.json",
  "plugins/aws/claude/.mcp.json",
  "plugins/repomix/opencode/dist/index.js",
  "plugins/beads/claude/skills/beads-preflight/SKILL.md",
  "plugins/aws/opencode/package.json",
  "plugins/example/common/agents/researcher.claude.md",
  "inventory.json",
])("applies a text patch to generated output %s", (name) => {
  const { dir, file } = fixture()
  file(name, "generated fixture\n")
  const { result, output } = apply(dir)
  expect(result.exitCode).toBe(0)
  expect(readFileSync(path.join(dir, name), "utf8")).toBe("generated fixture\n")
  expect(readFileSync(output, "utf8")).toBe("changed=true\n")
})

test.each([
  ".github/workflows/ci.yml",
  "package.json",
  "docs/design/repomix.md",
  "plugins/aws/common/.mcp.json",
  "plugins/repomix/opencode/src/pack.ts",
  "plugins/aws/common/agents/hand-written.md",
  "plugins/cad/opencode/examples/fixture.py",
])("rejects a source patch before applying %s", (name) => {
  const { dir, file } = fixture()
  file(name, "untrusted edit\n")
  const { result } = apply(dir)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("non-generated path")
  expect(run(dir, ["git", "status", "--porcelain"])).toBe("")
})

test("rejects a binary patch", () => {
  const { dir, file } = fixture()
  file("plugins/repomix/opencode/dist/index.js", new Uint8Array([0, 1, 2, 3]))
  const { result } = apply(dir)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("binary data")
  expect(run(dir, ["git", "status", "--porcelain"])).toBe("")
})

test("rejects a generated-path symlink", () => {
  const { dir, file } = fixture()
  file("plugins/aws/opencode/.mcp.json", "placeholder\n")
  rmSync(path.join(dir, "plugins/aws/opencode/.mcp.json"))
  symlinkSync("../../../README.md", path.join(dir, "plugins/aws/opencode/.mcp.json"))
  const { result } = apply(dir)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("symlinks and special file modes")
  expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("fixture\n")
  expect(run(dir, ["git", "status", "--porcelain"])).toBe("")
})

test("rejects an executable bundle", () => {
  const { dir, file } = fixture()
  const name = "plugins/repomix/opencode/dist/index.js"
  file(name, "executable bundle fixture\n")
  const { result } = apply(dir, name)
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain("executable copies must match")
  expect(run(dir, ["git", "status", "--porcelain"])).toBe("")
})

test("preserves the execute bit of a common script copied into a harness tree", () => {
  const { dir, file } = fixture("plugins/worktrunk/common/skills/worktrunk-preflight/preflight.py")
  const name = "plugins/worktrunk/opencode/skills/worktrunk-preflight/preflight.py"
  file(name, "executable copy fixture\n")
  const { result } = apply(dir, name)
  expect(result.exitCode).toBe(0)
  expect(run(dir, ["git", "ls-files", "--stage", name])).toStartWith("100755 ")
})

test("allows a composed agent only when its agents.src source exists", () => {
  const { dir, file } = fixture()
  file("plugins/example/agents.src/researcher.md", "source\n")
  run(dir, ["git", "add", "--all"])
  run(dir, ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "source"])
  file("plugins/example/common/agents/researcher.opencode.md", "generated\n")
  expect(apply(dir).result.exitCode).toBe(0)
})

test("an empty patch requests no push", () => {
  const { dir } = fixture()
  const { result, output } = apply(dir)
  expect(result.exitCode).toBe(0)
  expect(readFileSync(output, "utf8")).toBe("changed=false\n")
})
