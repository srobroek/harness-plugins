import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeContext, type FakeAssert } from "@srobroek/opencode-lib/testing"
import { COMMAND_ACTION, STORE_ACTION } from "../../shared/secret-store.ts"
import plugin, { confirmSecretCommand, createPlugin, type Evaluation } from "./index.ts"

const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1" }

describe("setup", () => {
  test("registers the tool and the command-run hook, and disposes them", async () => {
    const fake = createFakeContext({ directory: "/project" })
    const cleanup = await createPlugin().setup(fake.context)
    expect(fake.hooks("permission")).toEqual(["evaluate"])
    expect([...fake.tools.keys()]).toEqual([STORE_ACTION])
    await cleanup?.()
    expect(fake.active()).toBe(0)
    expect(fake.tools.size).toBe(0)
  })

  test("the default export is the plugin", () => {
    expect(plugin.id).toBe("srobroek.secret-store")
  })
})

describe("safety_secret_store through the plugin", () => {
  const SENTINEL = "SENTINEL-dummy-6ks-plugin"
  const toolCall = { ...call, id: "t1", signal: new AbortController().signal }
  const OP_CONFIG = '[providers.proj6ks]\ntype = "1password"\nvault = "Dev"\n'
  let root: string

  beforeAll(() => {
    const base = join(realpathSync(tmpdir()), "opencode")
    mkdirSync(base, { recursive: true })
    root = mkdtempSync(join(base, "secret-store-"))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  /** A fresh project with `fnox.toml`, an empty home, and a directory outside the project. */
  function layout(config = OP_CONFIG) {
    const dir = mkdtempSync(join(root, "case-"))
    const project = join(dir, "project")
    const outside = join(dir, "outside")
    for (const path of [project, outside, join(dir, "home")]) mkdirSync(path, { recursive: true })
    writeFileSync(join(project, "fnox.toml"), config)
    return { project, outside, home: join(dir, "home") }
  }

  type Run = { argv: string[]; stdin?: string }

  async function storeThrough(
    input: unknown,
    options: { assert?: (input: FakeAssert) => void; onCommand?: () => void; project?: string; home?: string } = {},
  ) {
    const runs: Run[] = []
    const where = options.project === undefined ? layout() : { project: options.project, home: options.home as string }
    const fake = createFakeContext({
      directory: where.project,
      sessions: [{ id: "ses_1", location: { directory: where.project } }],
      ...(options.assert ? { assert: options.assert } : {}),
    })
    await createPlugin({
      env: { PATH: "/bin" },
      home: where.home,
      which: (bin) => `/bin/${bin}`,
      run: async (argv, run) => {
        runs.push({ argv, ...(run.stdin ? { stdin: new TextDecoder().decode(run.stdin) } : {}) })
        if (argv[0] !== "/bin/gh") return { kind: "exited", exitCode: 0 }
        options.onCommand?.()
        return { kind: "exited", exitCode: 0, stdout: new TextEncoder().encode(`${SENTINEL}\n`) }
      },
    }).setup(fake.context)
    const execute = fake.tools.get(STORE_ACTION)?.execute as (input: unknown, context: unknown) => Promise<{ content: string; metadata: unknown }>
    const result = await execute(input, toolCall).catch((error: Error) => error)
    return { fake, runs, result, project: where.project }
  }

  const input = { name: "GH_TOKEN", target: { kind: "1password", vault: "Dev", item: "gh" }, command: { argv: ["gh", "auth", "token"] } }

  test("asks to store into the resolved config, then asks to run the command, and returns no value", async () => {
    const { fake, runs, result, project } = await storeThrough(input)
    const file = join(project, "fnox.toml")
    expect(fake.asserts.map((a) => [a.action, a.resources])).toEqual([
      [STORE_ACTION, [`GH_TOKEN -> 1password Dev/gh/credential (fnox provider proj6ks) in ${file}`]],
      [COMMAND_ACTION, [`gh auth token  (in ${project})`]],
    ])
    expect(fake.asserts[0]?.metadata).toMatchObject({ config: file, provider: "proj6ks", target: { kind: "1password", vault: "Dev" } })
    expect(runs.map((run) => run.argv[0])).toEqual(["/bin/gh", "/bin/op", "/bin/fnox"])
    expect(runs[2]?.argv[1]).toBe(`--config=${file}`)
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
    expect(JSON.stringify(fake.asserts)).not.toContain(SENTINEL)
    expect(result).toMatchObject({ metadata: { name: "GH_TOKEN", reference: "gh/credential", stored: true } })
  })

  test("a refused command prompt runs nothing", async () => {
    const { runs, result } = await storeThrough(input, {
      assert: (a) => {
        if (a.action === COMMAND_ACTION) throw new Error("rejected")
      },
    })
    expect(String(result)).toContain("rejected")
    expect(runs).toEqual([])
  })

  test("a command that switches the provider to plain in the config makes the tool refuse, with no fnox set", async () => {
    const { project, home } = layout('[providers.host6ks]\ntype = "age"\n')
    const { runs, result } = await storeThrough(
      { name: "A", target: { kind: "fnox-store", provider: "host6ks" }, command: { argv: ["gh"] } },
      { project, home, onCommand: () => writeFileSync(join(project, "fnox.toml"), '[providers.host6ks]\ntype = "plain"\n') },
    )
    expect(String(result)).toContain("config changed")
    expect(String(result)).not.toContain(SENTINEL)
    expect(runs.map((run) => run.argv[0])).toEqual(["/bin/gh"])
  })

  test("a command that switches the 1Password provider to plain makes the tool refuse, with no op item create", async () => {
    const { project, home } = layout()
    const { runs, result } = await storeThrough(input, {
      project,
      home,
      onCommand: () => writeFileSync(join(project, "fnox.toml"), '[providers.proj6ks]\ntype = "plain"\n'),
    })
    expect(String(result)).toContain("config changed")
    expect(runs.map((run) => run.argv[0])).toEqual(["/bin/gh"])
  })

  test("a config outside the project asks external_directory, and a refusal stores nothing", async () => {
    const { project, outside, home } = layout()
    writeFileSync(join(outside, "fnox.toml"), OP_CONFIG)
    const { fake, runs, result } = await storeThrough(
      { ...input, config: "../outside/fnox.toml" },
      {
        project,
        home,
        assert: (a) => {
          if (a.action === "external_directory") throw new Error("rejected")
        },
      },
    )
    expect(String(result)).toContain("rejected")
    expect(fake.asserts.map((a) => [a.action, a.resources])).toEqual([["external_directory", [join(outside, "*")]]])
    expect(runs).toEqual([])
  })

  test("a symlink inside the project to a config outside counts as outside, and the store prompt names the target", async () => {
    const { project, outside, home } = layout()
    writeFileSync(join(outside, "real.toml"), OP_CONFIG)
    symlinkSync(join(outside, "real.toml"), join(project, "fnox.local.toml"))
    const { fake, runs } = await storeThrough({ ...input, config: "fnox.local.toml" }, { project, home })
    expect(fake.asserts.map((a) => a.action)).toEqual(["external_directory", STORE_ACTION, COMMAND_ACTION])
    expect(fake.asserts[0]?.resources).toEqual([join(outside, "*")])
    expect(fake.asserts[1]?.resources[0]).toEndWith(` in ${join(outside, "real.toml")}`)
    expect(runs[2]?.argv[1]).toBe(`--config=${join(outside, "real.toml")}`)
  })

  test("every command run asks, even when the policy allows it; a deny and other actions stay as they are", () => {
    const evaluation = (action: string, effect: Evaluation["effect"]) => ({ action, effect }) as Evaluation
    const allowed = evaluation(COMMAND_ACTION, "allow")
    confirmSecretCommand(allowed)
    expect(allowed.effect).toBe("ask")
    for (const other of [evaluation(COMMAND_ACTION, "deny"), evaluation(STORE_ACTION, "allow")]) {
      const before = other.effect
      confirmSecretCommand(other)
      expect(other.effect).toBe(before)
    }
  })
})
