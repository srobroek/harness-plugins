// Mirrors common/skills/beads-preflight/test_preflight.py case for case (the first fifteen
// tests), then covers the report the pi tool returns.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import {
  BOOTSTRAP_FIX,
  CHECK_IDS,
  type CommandResult,
  checkActorIdentity,
  checkBdAvailable,
  checkReadyWork,
  checkRemoteSync,
  checkStaleLeases,
  checkStoreReachable,
  commandResult,
  DEFAULT_TIMEOUT_SECONDS,
  INIT_FIX,
  optionsError,
  type PreflightDeps,
  pathRemedy,
  REMOTE_FIX,
  runBd,
  runPreflight,
  systemDeps,
} from "./preflight.ts"

// The stub-process tests start a 2 s stub twice and a UTF-8 stub once; together they measured
// 3.9 s on an idle machine, so the 5 s default leaves no room for a loaded one.
setDefaultTimeout(30_000)

const root = mkdtempSync(join(tmpdir(), "beads-preflight-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Deps whose commands answer from `answer`; `bd` resolves unless `which` says otherwise. */
function fake(answer: (command: readonly string[]) => CommandResult, overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return { env: {}, which: () => "/usr/bin/bd", run: async (command) => answer(command), ...overrides }
}

const always = (result: CommandResult) => fake(() => result)

/** A directory with a `bd` stub running `script`, and deps that run real commands from it. */
function stubDeps(name: string, script: string): PreflightDeps {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeExecutable(join(dir, "bd"), script)
  return systemDeps({ PATH: `${dir}:${process.env.PATH ?? ""}` }, dir)
}

describe("beads preflight, as test_preflight.py", () => {
  test("missing bd remedy keeps the path outside single quotes", async () => {
    const outcome = await checkBdAvailable({}, fake(() => commandResult(0, "", ""), { which: () => null }))
    expect(outcome.status).toBe("fail")
    const remedy = (outcome.fix ?? "").replace("<directory-containing-bd>", "/opt/bd")
    const expanded = Bun.spawnSync(["/bin/sh", "-c", `${remedy}; printf %s "$PATH"`], { env: { PATH: "/usr/bin" } })
    expect(expanded.stdout.toString()).toBe("/opt/bd:/usr/bin")
  })

  test("path remedy quotes the directory and expands PATH", () => {
    expect(pathRemedy("/opt/my tools/bin")).toBe(`export PATH='/opt/my tools/bin'":$PATH"`)
    expect(pathRemedy("/usr/local/bin")).toBe('export PATH=/usr/local/bin":$PATH"')
  })

  test("invalid UTF-8 command output is replaced", async () => {
    const result = await runBd(["--version"], 1, stubDeps("utf8", "printf '\\377\\376'\n"))
    expect(result.returncode).toBe(0)
    expect(result.stdout).toContain("\ufffd")
  })

  test("a missing database uses bootstrap when origin has Dolt data", async () => {
    const deps = fake((command) =>
      command[0] === "git"
        ? commandResult(0, "abc123\trefs/dolt/data\n", "", { command })
        : commandResult(1, "", "no beads database found", { command: ["bd", "info", "--json"] }),
    )
    const outcome = await checkStoreReachable({ timeoutSeconds: 1 }, deps)
    expect(outcome.fix).toBe(BOOTSTRAP_FIX)
    expect(outcome.detail).toContain("beads-setup skill")
  })

  test("a missing database uses init when origin has no Dolt data", async () => {
    const deps = fake((command) =>
      command[0] === "git"
        ? commandResult(2, "", "fatal: No such remote 'origin'", { command })
        : commandResult(1, "", "no beads database found", { command: ["bd", "info", "--json"] }),
    )
    const outcome = await checkStoreReachable({ timeoutSeconds: 1 }, deps)
    expect(outcome.fix).toBe(INIT_FIX)
    expect(outcome.detail).toContain("confirm the git origin first")
    expect(outcome.detail).toContain("beads-setup skill")
  })

  test("a missing database ready failure points to the store remedy", async () => {
    const outcome = await checkReadyWork({ timeoutSeconds: 1 }, always(commandResult(1, "", "no beads database found")))
    expect(outcome.fix).not.toBe("bd ready --json")
    expect(outcome.fix).toContain("store-reachable")
  })

  test("no remote warns with the add remedy", async () => {
    const outcome = await checkRemoteSync({ timeoutSeconds: 1 }, always(commandResult(0, "No remotes configured.\n", "")))
    expect(outcome.status).toBe("warn")
    expect(outcome.fix).toBe(REMOTE_FIX)
    expect(outcome.detail).toContain("bd dolt push exits 0 without pushing")
  })

  test("a git+ssh remote passes", async () => {
    const deps = always(commandResult(0, "origin git+ssh://git@github.com/srobroek/omp-plugins.git\n", ""))
    expect((await checkRemoteSync({ timeoutSeconds: 1 }, deps)).status).toBe("pass")
  })

  test("multiple valid remotes pass", async () => {
    const deps = always(
      commandResult(0, "origin git+ssh://git@github.com/srobroek/omp-plugins.git\nbackup git+https://example.test/ledger.git\n", ""),
    )
    expect((await checkRemoteSync({ timeoutSeconds: 1 }, deps)).status).toBe("pass")
  })

  test("a garbage remote line skips", async () => {
    expect((await checkRemoteSync({ timeoutSeconds: 1 }, always(commandResult(0, "this is garbage\n", "")))).status).toBe("skip")
  })

  test("non-text ready output fails without throwing", async () => {
    const deps = always(commandResult(0, { ready: true } as unknown as string, "", { command: ["bd", "ready", "--json"] }))
    const outcome = await checkReadyWork({ timeoutSeconds: 1 }, deps)
    expect(outcome.status).toBe("fail")
    expect(outcome.detail).toContain("unparseable JSON")
  })

  test("non-text error output is bounded", async () => {
    const deps = always(commandResult(1, { stdout: true } as unknown as string, ["stderr"] as unknown as string))
    const outcome = await checkReadyWork({ timeoutSeconds: 1 }, deps)
    expect(outcome.status).toBe("fail")
    expect(outcome.detail).toContain("command exited 1")
  })

  test("arbitrary successful remote output does not pass", async () => {
    expect((await checkRemoteSync({ timeoutSeconds: 1 }, always(commandResult(0, "NOT A DOLT REMOTE LIST", "")))).status).not.toBe(
      "pass",
    )
  })

  test("a successful version without a semantic version fails", async () => {
    const outcome = await checkBdAvailable({ timeoutSeconds: 1 }, always(commandResult(0, "bd development build", "")))
    expect(outcome.status).toBe("fail")
    expect(outcome.detail).toContain("parseable semantic version")
  })

  test("the default bound outlasts a slow store while an injected bound still stops it", async () => {
    // A cold embedded store answers after 30-50 s, which the default must wait out. The Python
    // twin waits 8 s on its stub; this one answers after 2 s and checks the default directly.
    expect(DEFAULT_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(50)
    const deps = stubDeps("slow", "sleep 2\necho '[]'\n")
    const slow = await checkReadyWork({}, deps)
    const bounded = await checkReadyWork({ timeoutSeconds: 1 }, deps)
    expect(slow.status, slow.detail).toBe("pass")
    expect(bounded.status).toBe("warn")
    expect(bounded.detail).toContain("timed out after 1 seconds")
  })
})

describe("beads preflight report", () => {
  test("ok is false only when a check fails; warn and skip leave it true", async () => {
    const deps = fake(
      (command) => {
        const line = command.join(" ")
        if (line === "bd --version") return commandResult(0, "bd version 1.3.1 (c1c4b642a)\n", "")
        if (line === "bd info --json")
          return commandResult(0, JSON.stringify({ mode: "embedded", database_path: "/r/.beads/x", config: { issue_prefix: "r" } }), "")
        if (line === "bd ready --json") return commandResult(0, "[]", "")
        if (line === "bd dolt remote list") return commandResult(0, "No remotes configured.\n", "")
        return commandResult(1, "", "unexpected")
      },
      { env: { BD_ACTOR: "pi/root" } },
    )
    const report = await runPreflight({}, deps)
    expect(report.checks.map((check) => check.id)).toEqual([...CHECK_IDS])
    expect(report.checks.map((check) => check.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "pass", "skip", "warn"])
    expect(report.ok).toBe(true)
    expect(report.summary).toMatch(/^6 pass, 1 warn, 0 fail, 1 skip, elapsed \d+\.\d{2}s$/)
  })

  test("selecting the lease scan by id runs it", async () => {
    const deps = fake(
      (command) => {
        const line = command.join(" ")
        if (line === "bd list --help") return commandResult(0, "  --json\n  --limit int\n", "")
        return commandResult(
          0,
          JSON.stringify([
            { id: "r-1", assignee: "pi/x", lease_expires_at: "2026-01-01T00:00:00Z" },
            { id: "r-2", assignee: "pi/y", lease_expires_at: "2027-01-01T00:00:00Z" },
            { id: "r-3", lease_expires_at: "2026-01-01T00:00:00Z" },
          ]),
          "",
          { command },
        )
      },
      { now: () => new Date("2026-06-01T00:00:00Z") },
    )
    const report = await runPreflight({ only: ["no-stale-lease-on-open-work"] }, deps)
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]?.status).toBe("warn")
    expect(report.checks[0]?.detail).toBe(
      "stale assigned leases: r-1 (expired 2026-01-01T00:00:00Z); capped at 50 rows with --limit",
    )
    expect(await checkStaleLeases({}, deps)).toMatchObject({ status: "skip" })
  })

  test("the actor check reads the environment the checks run with", async () => {
    expect((await checkActorIdentity({}, fake(() => commandResult(0, "", ""), { env: { BD_ACTOR: "pi/r" } }))).detail).toBe(
      "BD_ACTOR is set",
    )
    expect((await checkActorIdentity({}, fake(() => commandResult(0, "", "")))).status).toBe("fail")
  })

  test("options are validated as the script's parser does", async () => {
    expect(optionsError({ only: ["store-reachable", " nope ", "constructor"] })).toBe("unknown check id(s): nope, constructor")
    expect(optionsError({ timeoutSeconds: 0 })).toBe("--timeout must be a finite number greater than zero")
    expect(optionsError({ only: ["bd-available"], timeoutSeconds: 5 })).toBeUndefined()
    await expect(runPreflight({ only: ["nope"] }, always(commandResult(0, "", "")))).rejects.toThrow("unknown check id(s): nope")
  })
})
