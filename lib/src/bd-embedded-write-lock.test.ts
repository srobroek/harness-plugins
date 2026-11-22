import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import {
  backoffDelayMs,
  decideEmbeddedWrite,
  embeddedWriteRunner,
  embeddedWriteTargets,
  hold,
  parseLinuxStatStartIdentity,
  planEmbeddedWrites,
  release,
  resolveBdTargets,
  resolveBunBinary,
  setPreflightWaitForTests,
  setProcessStartIdentityForTests,
  withEmbeddedWriteLock,
  writeWaitFromOptions,
} from "./bd-embedded-write-lock.ts"
import { main as runEmbeddedWriter, setCommandTimeoutForTests } from "./bd-embedded-write-runner.ts"
import { parse } from "./beads-shell.ts"
import { scrubbedBeadsEnv } from "./testing.ts"

// Real runner and lock processes: 1.5 to 8.4 s at load average 49; 30 s leaves headroom for a loaded machine (AGENTS.md, Testing).
setDefaultTimeout(30_000)

const host = hostname().split(".")[0] ?? "localhost"
/** The scratch-store proof drives the real bd CLI; CI images without bd skip it. */
const BD_ON_PATH = Bun.which("bd") !== null
/** The runner's store flags, as the gate writes them: the real path held, the path as named. */
const runnerStore = (store: string): string[] => ["--beads-store", realpathSync(store), "--beads-store-selected", store]

test("resolves mise-only Bun and completes a real runner write", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-mise-"))
  const marker = join(root, "written")
  try {
    const interpreter = resolveBunBinary({
      execPath: "/opt/omp/omp",
      which: (name) => (name === "mise" ? "/opt/mise/bin/mise" : undefined),
      environment: {},
      miseWhich: () => process.execPath,
    })
    expect(interpreter).toBe(process.execPath)
    const runner = embeddedWriteRunner(import.meta.dir, () => interpreter)
    if ("unavailable" in runner) throw new Error(runner.unavailable)
    if (interpreter === undefined) return
    const result = Bun.spawnSync(
      [
        interpreter,
        runner.script,
        ...runnerStore(root),
        "--",
        "/bin/sh",
        "-c",
        `printf written > ${JSON.stringify(marker)}`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(result.exitCode).toBe(0)
    expect(readFileSync(marker, "utf8")).toBe("written")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(!BD_ON_PATH)(
  "decideEmbeddedWrite rewrites a mise-only runner against a scratch store",
  async () => {
    const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-mise-proof-"))
    const store = join(root, ".beads")
    const env = scrubbedBeadsEnv({ BEADS_DIR: store, BEADS_ACTOR: "omp/test/qycs" })
    try {
      const init = Bun.spawnSync(["bd", "init", "--init-if-missing", "--skip-hooks"], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(init.exitCode).toBe(0)
      const command = "bd create --type task --title mise-runner-proof --json"
      const parsed = parse(command) as unknown as Parameters<typeof decideEmbeddedWrite>[0]
      const decision = await decideEmbeddedWrite(
        parsed,
        root,
        scrubbedBeadsEnv({ BEADS_DIR: store, BEADS_ACTOR: "omp/test/qycs" }),
        "mise-proof",
        Date.now() + 5000,
        () => ({ interpreter: process.execPath, script: join(import.meta.dir, "bd-embedded-write-runner.ts") }),
      )
      expect(decision?.kind).toBe("rewrite")
      if (decision?.kind !== "rewrite") return
      expect(decision.command).toContain("BEADS_DOLT_SHARED_SERVER= BEADS_DIR=")
      const run = Bun.spawnSync(["/bin/sh", "-c", decision.command], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(run.exitCode).toBe(0)
      const created = JSON.parse(new TextDecoder().decode(run.stdout)) as { id?: unknown }
      expect(typeof created.id).toBe("string")
      if (typeof created.id !== "string") return
      const shown = Bun.spawnSync(["bd", "show", created.id, "--json"], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(shown.exitCode).toBe(0)
      expect(new TextDecoder().decode(shown.stdout)).toContain("mise-runner-proof")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  { timeout: 30_000 },
)

test("refuses control and timing wrappers instead of bypassing the embedded lock", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-wrapper-"))
  const store = join(root, ".beads")
  const env = { BEADS_DIR: store }
  try {
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "metadata.json"), "{}")
    for (const command of [
      "! bd update bead-1 --claim",
      "time bd update bead-1 --claim",
      "if bd update bead-1 --claim; then :; fi",
      "while bd update bead-1 --claim; do :; done",
      "until bd update bead-1 --claim; do :; done",
      "env -u BEADS_DIR bd update bead-1 --claim",
      "env -u BEADS_DOLT_SHARED_SERVER bd update bead-1 --claim",
      "env --unset BEADS_DIR bd update bead-1 --claim",
      "env --unset BEADS_DOLT_SHARED_SERVER bd update bead-1 --claim",
      "env -uBEADS_DIR bd update bead-1 --claim",
      "env -uBEADS_DOLT_SHARED_SERVER bd update bead-1 --claim",
      "env --unset=BEADS_DIR bd update bead-1 --claim",
      "env --unset=BEADS_DOLT_SHARED_SERVER bd update bead-1 --claim",
      "env -i bd update bead-1 --claim",
    ]) {
      const result = embeddedWriteTargets(command, root, env)
      expect(result.kind).toBe("refused")
    }
    const direct = embeddedWriteTargets("bd update bead-1 --claim", root, env)
    expect(direct).toEqual({ kind: "stores", stores: [realpathSync(store)] })
    expect(embeddedWriteTargets("bd show bead-1", root, env)).toEqual({ kind: "stores", stores: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("parses Linux stat start ticks after a close-paren-space comm", () => {
  const filler = Array.from({ length: 18 }, () => "0").join(" ")
  const stat = `321 (worker) ) name) S ${filler} 4242`
  expect(parseLinuxStatStartIdentity(stat)).toBe("4242")
})

describe("embedded write lock", () => {
  test.skipIf(process.platform !== "linux")(
    "recovers an expired lock when the writer PID has been reused",
    async () => {
      const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-pid-reuse-"))
      try {
        writeFileSync(
          join(store, "omp-embedded-write.lock"),
          JSON.stringify({
            host,
            pid: process.pid,
            owner: "old",
            token: "old-token",
            taken: Date.now() - 1000,
            expires: Date.now() - 1,
            writer: process.pid,
            writerStart: "a different process start",
          }),
        )
        const result = await hold(store, "replacement", 100)
        expect(result).toEqual({ kind: "held" })
        release(store, "replacement")
      } finally {
        rmSync(store, { recursive: true, force: true })
      }
    },
  )

  test.each(["matching", "unknown"])("protects an expired lock while the live writer identity is %s", async (identity) => {
    const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-live-writer-"))
    setProcessStartIdentityForTests(() => identity === "matching" ? "test-start" : undefined)
    try {
      writeFileSync(
        join(store, "omp-embedded-write.lock"),
        JSON.stringify({
          host,
          pid: process.pid,
          owner: "live",
          token: "live-token",
          taken: Date.now() - 1000,
          expires: Date.now() - 1,
          writer: process.pid,
          writerStart: "test-start",
        }),
      )
      const result = await hold(store, "blocked", 35)
      expect(result.kind).toBe("failed")
      if (result.kind === "failed") expect(result.reason).toContain("ledger is busy")
    } finally {
      setProcessStartIdentityForTests()
      rmSync(store, { recursive: true, force: true })
    }
  })

  test("old-owner exit cannot delete a successor lock after takeover", async () => {
    const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-exit-race-"))
    const ready = join(store, "ready")
    const done = join(store, "done")
    const modulePath = join(import.meta.dir, "bd-embedded-write-lock.ts")
    const script = `
import { existsSync, writeFileSync } from "node:fs";
import { hold, setLeaseTimingForTests } from ${JSON.stringify(modulePath)};

setLeaseTimingForTests(80, 60_000);
const result = await hold(process.argv[1], "old-owner", 2000);
if (result.kind !== "held") process.exit(2);
writeFileSync(process.argv[2], "ready");
			// Coordination with a child process requires the platform clock rather than fake timers.
			while (!existsSync(process.argv[3])) await Bun.sleep(10);
`
    const child = Bun.spawn([process.execPath, "-e", script, store, ready, done], { stdout: "ignore", stderr: "pipe" })
    try {
      const deadline = Date.now() + 30_000
      while (!existsSync(ready)) {
        if (Date.now() >= deadline) throw new Error("old-owner test process did not become ready")
        await Bun.sleep(10)
      }
      const lock = join(store, "omp-embedded-write.lock")
      const old = JSON.parse(readFileSync(lock, "utf8")) as Record<string, unknown>
      old.expires = Date.now() - 1
      writeFileSync(lock, JSON.stringify(old))
      const successor = await hold(store, "successor", 500)
      expect(successor).toEqual({ kind: "held" })
      writeFileSync(done, "exit")
      await child.exited
      expect(existsSync(lock)).toBe(true)
      release(store, "successor")
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      rmSync(store, { recursive: true, force: true })
    }
  }, { timeout: 60_000 })

  test("five consecutive uncontended acquisitions succeed", async () => {
    const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-bounded-"))
    try {
      for (let round = 0; round < 5; round++) {
        const result = await hold(store, `round-${round}`, 500)
        expect(result).toEqual({ kind: "held" })
        release(store, `round-${round}`)
      }
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  test("an aborted waiter leaves the queue for the next writer", async () => {
    const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-abort-"))
    try {
      expect(await hold(store, "holder", 100)).toEqual({ kind: "held" })
      const controller = new AbortController()
      const waiting = hold(store, "cancelled", 1000, controller.signal)
      controller.abort()
      const cancelled = await waiting
      expect(cancelled.kind).toBe("failed")
      if (cancelled.kind === "failed") expect(cancelled.reason).toContain("cancelled")
      release(store, "holder")
      expect(await hold(store, "successor", 100)).toEqual({ kind: "held" })
      release(store, "successor")
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })
})
test("lock timeout identifies the holder and lock age", async () => {
  const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-diagnostic-"))
  try {
    writeFileSync(
      join(store, "omp-embedded-write.lock"),
      JSON.stringify({
        host,
        pid: process.pid,
        owner: "runner-live",
        token: "held",
        taken: Date.now() - 1000,
        expires: Date.now() + 10000,
      }),
    )
    const result = await hold(store, "waiter", 30)
    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toContain("holder runner-live")
      expect(result.reason).toMatch(/age \d+s/)
    }
  } finally {
    rmSync(store, { recursive: true, force: true })
  }
})

test("parallel runner acquisitions do not refuse ordinary short writes", async () => {
  const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-contention-"))
  const runner = join(import.meta.dir, "bd-embedded-write-runner.ts")
  const children = Array.from({ length: 10 }, () =>
    Bun.spawn(
      [process.execPath, runner, ...runnerStore(store), "--beads-wait-ms", "30000", "--", "/bin/sleep", "0.02"],
      { stdout: "ignore", stderr: "pipe" },
    ),
  )
  try {
    const statuses = await Promise.all(children.map((child) => child.exited))
    expect(statuses).toEqual(Array.from({ length: 10 }, () => 0))
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    await Promise.all(children.map((child) => child.exited))
    rmSync(store, { recursive: true, force: true })
  }
}, { timeout: 60_000 })

test("runner refuses a queued writer at its lock deadline", async () => {
  const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-wait-"))
  const runner = join(import.meta.dir, "bd-embedded-write-runner.ts")
  const fakeBd = join(store, "bd")
  const ready = join(store, "ready")
  const releaseMarker = join(store, "release-marker")
  writeFileSync(
    fakeBd,
    `#!/bin/sh\nprintf ready > ${JSON.stringify(ready)}\nwhile [ ! -e ${JSON.stringify(releaseMarker)} ]; do /bin/sleep 0.01; done\n`,
  )
  const first = Bun.spawn(
    [process.execPath, runner, ...runnerStore(store), "--beads-wait-ms", "1000", "--", "/bin/sh", fakeBd, "update", "bead-1"],
    { stdout: "ignore", stderr: "ignore" },
  )
  let second: ReturnType<typeof Bun.spawn> | undefined
  try {
    const deadline = Date.now() + 30_000
    while (!existsSync(ready)) {
      // Separate runner processes and the OS lock use the platform clock; fake timers cannot drive this integration boundary.
      await Bun.sleep(5)
      if (Date.now() >= deadline) throw new Error("first runner did not start its write")
    }
    second = Bun.spawn(
      [process.execPath, runner, ...runnerStore(store), "--beads-wait-ms", "25", "--", "/bin/sh", fakeBd, "update", "bead-2"],
      { stdout: "ignore", stderr: "ignore" },
    )
    expect(await second.exited).toBe(120)
    writeFileSync(releaseMarker, "release")
    expect(await first.exited).toBe(0)
  } finally {
    writeFileSync(releaseMarker, "release")
    for (const child of [first, second]) {
      if (child && child.exitCode === null) child.kill()
      await child?.exited
    }
    rmSync(store, { recursive: true, force: true })
  }
}, { timeout: 60_000 })

test("accepts a literal cd prefix while refusing dynamic cwd", async () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-cwd-"))
  const store = join(root, ".beads")
  try {
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "metadata.json"), "{}")
    const literal = "cd . && bd update bead-1 --claim"
    const decision = await decideEmbeddedWrite(
      parse(literal) as unknown as Parameters<typeof decideEmbeddedWrite>[0],
      root,
      scrubbedBeadsEnv({ BEADS_DIR: store }),
      literal,
      Date.now() + 2000,
      () => ({ interpreter: process.execPath, script: join(import.meta.dir, "bd-embedded-write-runner.ts") }),
    )
    expect(decision?.kind).toBe("rewrite")
    const dynamic = "cd $WORKTREE && bd update bead-1 --claim"
    const refused = await decideEmbeddedWrite(
      parse(dynamic) as unknown as Parameters<typeof decideEmbeddedWrite>[0],
      root,
      scrubbedBeadsEnv({ BEADS_DIR: store }),
      dynamic,
      Date.now() + 2000,
      () => ({ interpreter: process.execPath, script: join(import.meta.dir, "bd-embedded-write-runner.ts") }),
    )
    expect(refused).toEqual({ kind: "block", reason: expect.stringContaining("pass the shell tool's `workdir` parameter") })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test("finds the runner beside the module, or in the plugin's src or dist directory", () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-discovery-"))
  try {
    const src = join(root, "src")
    const dist = join(root, "dist")
    mkdirSync(src, { recursive: true })
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, "bd-embedded-write-runner.js"), "")
    expect(embeddedWriteRunner(src, () => "/opt/bun")).toEqual({
      interpreter: "/opt/bun",
      script: join(dist, "bd-embedded-write-runner.js"),
    })
    writeFileSync(join(src, "bd-embedded-write-runner.ts"), "")
    expect(embeddedWriteRunner(src, () => "/opt/bun")).toEqual({
      interpreter: "/opt/bun",
      script: join(src, "bd-embedded-write-runner.ts"),
    })
    expect(embeddedWriteRunner(import.meta.dir, () => "/opt/bun")).toEqual({
      interpreter: "/opt/bun",
      script: join(import.meta.dir, "bd-embedded-write-runner.ts"),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("refuses the write, naming the missing runner, when none is installed", async () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-no-runner-"))
  const loaded = join(root, "plugin", "src")
  const store = join(root, ".beads")
  const command = "bd update bead-1 --claim"
  try {
    mkdirSync(loaded, { recursive: true })
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "metadata.json"), "{}")
    const decision = await decideEmbeddedWrite(
      parse(command) as unknown as Parameters<typeof decideEmbeddedWrite>[0],
      root,
      scrubbedBeadsEnv({ BEADS_DIR: store }),
      "no-runner",
      Date.now() + 5000,
      () => embeddedWriteRunner(loaded, () => process.execPath),
    )
    if (decision?.kind !== "block") throw new Error(`expected a refusal, got ${JSON.stringify(decision)}`)
    expect(decision.reason).toContain(join(loaded, "bd-embedded-write-runner.ts"))
    expect(decision.reason).toContain("restart OpenCode")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("refuses the write when no bun interpreter is reachable", async () => {
  const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-no-bun-"))
  const store = join(root, ".beads")
  try {
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "metadata.json"), "{}")
    const decision = await decideEmbeddedWrite(
      parse("bd update bead-1 --claim") as unknown as Parameters<typeof decideEmbeddedWrite>[0],
      root,
      scrubbedBeadsEnv({ BEADS_DIR: store }),
      "no-bun",
      Date.now() + 5000,
      () => embeddedWriteRunner(import.meta.dir, () => undefined),
    )
    if (decision?.kind !== "block") throw new Error(`expected a refusal, got ${JSON.stringify(decision)}`)
    expect(decision.reason).toContain("no `bun` binary was found")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("terminates a hung short embedded child and releases its lock", async () => {
  const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-timeout-"))
  const fakeBd = join(store, "bd")
  writeExecutable(fakeBd, "#!/bin/sh\nsleep 1\n")
  setCommandTimeoutForTests(25)
  try {
    const result = await runEmbeddedWriter([...runnerStore(store), "--", fakeBd, "update", "bead-1"])
    expect(result).toBe(124)
    expect(existsSync(join(store, "omp-embedded-write.lock"))).toBe(false)
  } finally {
    setCommandTimeoutForTests()
    rmSync(store, { recursive: true, force: true })
  }
})

test("leaves long embedded maintenance writes to their own lifecycle", async () => {
  const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-long-"))
  const fakeBd = join(store, "bd")
  writeExecutable(fakeBd, "#!/bin/sh\nsleep 0.1\n")
  setCommandTimeoutForTests(25)
  try {
    const result = await runEmbeddedWriter([...runnerStore(store), "--", fakeBd, "gc"])
    expect(result).toBe(0)
  } finally {
    setCommandTimeoutForTests()
    rmSync(store, { recursive: true, force: true })
  }
})

describe("compound commands", () => {
  const runner = { interpreter: "/opt/bun", script: "/opt/beads/extensions/bd-embedded-write-runner.js" }
  let root = ""
  let store = ""
  let other = ""
  /** The canonical spelling the rewrite uses; `/tmp` is a symlink on macOS. */
  let held = ""
  let heldOther = ""
  /** The store as the command names it, which the runner re-resolves before the write. */
  const namedFor = (target: string): string => (target === held ? store : target === heldOther ? other : target)
  const runnerForm = (target: string, using = runner) => {
    const named = ` --beads-store-selected '${namedFor(target)}'`
    return `BEADS_DOLT_SHARED_SERVER= BEADS_DIR='${target}' BEADS_DB= BD_DB= '${using.interpreter}' '${using.script}' --beads-store '${target}'${named} --beads-wait-ms 30000 -- `
  }

  beforeAll(() => {
    root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-compound-"))
    store = join(root, ".beads")
    other = join(root, "other", ".beads")
    for (const dir of [store, other]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "metadata.json"), "{}")
    }
    held = realpathSync(store)
    heldOther = realpathSync(other)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  async function decide(command: string, using = runner) {
    return decideEmbeddedWrite(
      parse(command) as unknown as Parameters<typeof decideEmbeddedWrite>[0],
      root,
      scrubbedBeadsEnv({ BEADS_DIR: store }),
      `compound:${command}`,
      Date.now() + 2000,
      () => using,
    )
  }

  async function rewritten(command: string, using = runner): Promise<string> {
    const decision = await decide(command, using)
    if (decision?.kind !== "rewrite") throw new Error(`expected a rewrite of ${command}, got ${JSON.stringify(decision)}`)
    return decision.command
  }

  async function refusal(command: string): Promise<string> {
    const decision = await decide(command)
    if (decision?.kind !== "block") throw new Error(`expected a refusal of ${command}, got ${JSON.stringify(decision)}`)
    return decision.reason
  }

  test("passes reads anywhere in a compound command, unchanged", async () => {
    for (const command of [
      "git status -sb; git log --oneline -3; bd list --status=open 2>&1 | head -40",
      "bd prime 2>&1 | head -120; echo '--- primed'",
      "bd show bd-1 --json | jq '.[0].status'",
      "bd ready --json | jq -r '.[].id' > ready.txt",
      "( bd stats ) && { bd search lock; bd comments bd-1 --json; }",
      "if bd show bd-1 >/dev/null 2>&1; then echo present; fi",
      "bd close --help | head",
      "bd --readonly update bd-1 --claim && echo checked",
      "git commit -m 'teach bd close a flag' && rg -n 'bd close' .",
    ]) {
      expect(await decide(command)).toBeUndefined()
    }
  })

  test("runs each write under the runner in place and leaves the reads around it alone", async () => {
    const lock = runnerForm(held)
    expect(await rewritten(`export BEADS_DIR=${store}; bd update bd-1 --claim`)).toBe(
      `export BEADS_DIR=${store}; ${lock}bd update bd-1 --claim`,
    )
    expect(await rewritten("bd close bd-1 --reason 'done; merged | verified' && git push")).toBe(
      `${lock}bd close bd-1 --reason 'done; merged | verified' && git push`,
    )
    expect(await rewritten("git status -sb; bd list | head; bd close bd-1; bd show bd-1 --json | jq .")).toBe(
      `git status -sb; bd list | head; ${lock}bd close bd-1; bd show bd-1 --json | jq .`,
    )
    expect(await rewritten('for id in bd-1 bd-2; do bd close "$id"; done')).toBe(
      `for id in bd-1 bd-2; do ${lock}bd close "$id"; done`,
    )
  })

  test("keeps pipes from and to a write", async () => {
    const lock = runnerForm(held)
    expect(await rewritten("bd create 'Fix it' --silent | xargs echo created")).toBe(
      `${lock}bd create 'Fix it' --silent | xargs echo created`,
    )
    expect(await rewritten("bd list --status open -q | awk '{print \"close\", $2}' | bd batch")).toBe(
      `bd list --status open -q | awk '{print "close", $2}' | ${lock}bd batch`,
    )
    expect(await rewritten("bd update bd-1 --claim |& tee claim.log")).toBe(
      `${lock}bd update bd-1 --claim |& tee claim.log`,
    )
  })

  test("gives every write in a list its own runner", async () => {
    const lock = runnerForm(held)
    expect(await rewritten("bd close bd-1 && bd close bd-2 || bd update bd-3 --claim; bd list")).toBe(
      `${lock}bd close bd-1 && ${lock}bd close bd-2 || ${lock}bd update bd-3 --claim; bd list`,
    )
  })

  test("keeps redirections, quoted separators and here-document data byte for byte", async () => {
    const lock = runnerForm(held)
    expect(await rewritten('{ bd list; bd update bd-1 --notes "a; b | c && d"; } > out.txt 2>&1 &')).toBe(
      `{ bd list; ${lock}bd update bd-1 --notes "a; b | c && d"; } > out.txt 2>&1 &`,
    )
    expect(await rewritten("bd update bd-1 --notes 'x; bd close bd-2 | y' 2>/dev/null")).toBe(
      `${lock}bd update bd-1 --notes 'x; bd close bd-2 | y' 2>/dev/null`,
    )
    const heredoc = "bd create 'Task' --body-file - <<'EOF'\nThen run bd dep add; pipe | here\nEOF\necho made"
    expect(await rewritten(heredoc)).toBe(`${lock}${heredoc}`)
    expect(await rewritten("BEADS_ACTOR=me bd close bd-1 > closed.txt")).toBe(
      `BEADS_ACTOR=me ${lock}bd close bd-1 > closed.txt`,
    )
  })

  test("locks the store each write targets, including command-local and exported BEADS_DIR", async () => {
    expect(await rewritten(`BEADS_DIR=${other} bd close bd-1; bd close bd-2`)).toBe(
      `BEADS_DIR=${other} ${runnerForm(heldOther)}bd close bd-1; ${runnerForm(held)}bd close bd-2`,
    )
    expect(await rewritten(`export BEADS_DIR=${other} && bd close bd-1`)).toBe(
      `export BEADS_DIR=${other} && ${runnerForm(heldOther)}bd close bd-1`,
    )
    // A subshell's export does not reach the write after it.
    expect(await rewritten(`(export BEADS_DIR=${other}; bd close bd-1); bd close bd-2`)).toBe(
      `(export BEADS_DIR=${other}; ${runnerForm(heldOther)}bd close bd-1); ${runnerForm(held)}bd close bd-2`,
    )
  })

  test("leaves an already rewritten command untouched and refuses a runner holding the wrong store", async () => {
    const once = await rewritten("git status; bd close bd-1 && bd update bd-2 --claim | cat")
    expect(await decide(once)).toBeUndefined()
    const forged = `BEADS_DIR='${held}' '/opt/bun' '/opt/beads/extensions/bd-embedded-write-runner.js' --beads-store '${heldOther}' -- bd close bd-1`
    expect(await refusal(forged)).toContain(`a runner command holds \`${heldOther}\``)
  })

  test("refuses, with the part it could not place, every shape it cannot locate or resolve", async () => {
    for (const [command, part] of [
      ['echo "$(bd close bd-1)"', "command substitution"],
      ["ID=$(bd create 'Task' --silent) && echo $ID", "command substitution"],
      ["jq . <<< `bd show bd-1 --json`", "command substitution"],
      ["echo ${X:- #$(bd close bd-1)}", "command substitution"],
      ["echo ${X:-'<('$(bd close bd-1)')'}", "command substitution"],
      ["eval 'bd close bd-1'", "shell source to `eval`"],
      ["bash -c 'bd close bd-1'", "shell source to `bash`"],
      ['git status && sh -c "bd update bd-1 --claim"', "shell source to `sh`"],
      ["echo bd-1 | xargs bd close", "launched through `xargs`"],
      ["timeout 60 bd close bd-1", "launched through `timeout`"],
      ["B=bd; $B close bd-1", "`$B` is expanded at run time"],
      ["bash <<'EOF'\nbd close bd-1\nEOF", "here-document fed to `bash`"],
      ["BEADS_DIR=$X bd close bd-1", "set by `BEADS_DIR=$X`"],
      ['export BEADS_DIR="$HOME/.beads"; bd close bd-1', 'set by `BEADS_DIR="$HOME/.beads"`'],
      ["bd -C $DIR close bd-1", "`-C $DIR`"],
      ["if bd update bd-1 --claim; then :; fi", "follows `if`"],
      ["cd sub; bd -C rel close bd-1", "relative `-C` path"],
    ] as const) {
      const reason = await refusal(command)
      expect(reason).toContain(part)
      expect(reason).toContain("Accepted:")
    }
    expect(await refusal("cd $WORKTREE; git pull && bd close bd-1")).toContain(
      "pass the shell tool's `workdir` parameter",
    )
  })

  test("classifies only verified bd 1.3.1 read forms as reads", () => {
    const stores = (command: string) => embeddedWriteTargets(command, root, { BEADS_DIR: store })
    // `bd dep show -b X` is the parent `bd dep <id> --blocks` form; `bd comment list` comments on `list`.
    for (const command of ["bd dep show -b bd-2", "bd comment list", "bd orphans $FLAGS", "bd epic list"]) {
      expect(stores(command)).toEqual({ kind: "stores", stores: [held] })
    }
    for (const command of ["bd stats --json", "bd comments bd-1 --json", "bd dep tree bd-1", "bd mol show mol-1"]) {
      expect(stores(command)).toEqual({ kind: "stores", stores: [] })
    }
  })

  // Each read form below was run against a scratch embedded store on bd 1.3.1 and left every
  // file of the store byte-identical; their `--help` text calls them list/show/status.
  test.each([
    "bd dolt status",
    "bd dolt show",
    "bd dolt test",
    "bd dolt remote list",
    "bd dolt remote list --json",
    "bd label list bd-1",
    "bd label list-all",
    "bd todo list",
    "bd worktree list",
    "bd worktree info",
    "bd hooks list",
    "bd repo list",
    "bd epic status",
    "bd vc status",
    "bd federation list-peers",
    "bd federation status",
    "bd backup status",
    "bd mol current",
    "bd mol progress",
    "bd mol stale",
    "bd mol ready",
  ])("%s is a read", (command) => {
    expect(embeddedWriteTargets(command, root, { BEADS_DIR: store })).toEqual({ kind: "stores", stores: [] })
  })

  test.each([
    "bd dolt remote add origin url",
    "bd dolt remote remove origin",
    "bd dolt remote reset-data origin",
    "bd dolt remote",
    "bd dolt push",
    "bd dolt pull",
    "bd dolt commit",
    "bd dolt set port 1",
    "bd dolt start",
    "bd label add bd-1 x",
    "bd todo add t",
    "bd worktree create w",
    "bd hooks install",
    "bd repo add r",
    "bd vc commit",
    "bd federation sync",
    "bd backup sync",
    "bd mol pour p",
    "bd mol seed x",
  ])("%s stays a write: only the verified nested reads are reads", (command) => {
    expect(embeddedWriteTargets(command, root, { BEADS_DIR: store })).toEqual({ kind: "stores", stores: [held] })
  })

  test(
    "runs each write in a compound command under its own hold, one after another",
    async () => {
      const bin = join(root, "bin")
      const log = join(root, "writes.log")
      mkdirSync(bin, { recursive: true })
      // A stand-in `bd` that records, at its start, whether the hold names this very
      // process as the writer, and sleeps long enough for an overlapping writer to show.
      // writerStart is optional (ps can be unavailable), so writer may end the JSON object.
      writeExecutable(
        join(bin, "bd"),
        `#!/bin/sh\nheld=$(grep -c "\\"writer\\":$$[,}]" "$BEADS_DIR/omp-embedded-write.lock")\nprintf 'start %s %s\\n' "$2" "$held" >> ${JSON.stringify(log)}\nsleep 0.2\nprintf 'end %s\\n' "$2" >> ${JSON.stringify(log)}\n`,
      )
      const real = { interpreter: process.execPath, script: join(import.meta.dir, "bd-embedded-write-runner.ts") }
      // The pipe starts both writes at once; only the lock keeps them apart.
      const command = await rewritten("bd update bd-1 --claim | bd update bd-2 --claim; bd close bd-3 && echo ok", real)
      const run = Bun.spawnSync(["/bin/sh", "-c", command], {
        cwd: root,
        env: scrubbedBeadsEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` }),
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(run.exitCode).toBe(0)
      expect(new TextDecoder().decode(run.stdout)).toBe("ok\n")
      const lines = readFileSync(log, "utf8").trim().split("\n")
      expect(lines).toHaveLength(6)
      for (let at = 0; at < lines.length; at += 2) {
        const [, id, writer] = lines[at]?.split(" ") ?? []
        expect(writer).toBe("1")
        expect(lines[at + 1]).toBe(`end ${id}`)
      }
      expect(
        lines
          .filter((line) => line.startsWith("start"))
          .map((line) => line.split(" ")[1])
          .sort(),
      ).toEqual(["bd-1", "bd-2", "bd-3"])
      expect(existsSync(join(held, "omp-embedded-write.lock"))).toBe(false)
    },
    { timeout: 15_000 },
  )
})

describe("waiting for a busy ledger", () => {
  const liveHolder = (store: string, name = "omp-embedded-write.lock"): void =>
    writeFileSync(
      join(store, name),
      JSON.stringify({
        host,
        pid: process.pid,
        owner: "runner-other",
        token: "other-token",
        taken: Date.now(),
        expires: Date.now() + 60_000,
      }),
    )

  test("acquires a lock that is released inside the wait", async () => {
    const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-wait-"))
    try {
      liveHolder(store)
      const started = Date.now()
      const waiting = hold(store, "waiter", 5000)
      // `hold` runs synchronously up to its first pause: it has already found the lock busy and
      // queued. Releasing now is therefore a release inside the wait, with no timer to race.
      rmSync(join(store, "omp-embedded-write.lock"))
      const result = await waiting
      expect(result.kind).toBe("held")
      expect(Date.now() - started).toBeLessThan(1500)
      release(store, "waiter")
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  test("a live holder past the wait gives retry guidance, not lock removal", async () => {
    const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-busy-"))
    try {
      liveHolder(store)
      const result = await hold(store, "waiter", 60)
      if (result.kind !== "failed") throw new Error("expected a refusal")
      expect(result.busy).toBe(true)
      expect(result.reason).toContain("ledger is busy")
      expect(result.reason).toContain("Retry the same command")
      expect(result.reason).not.toContain("remove it")
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  test("a dead holder that cannot be taken over keeps the stale-lock guidance", async () => {
    const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-stale-"))
    try {
      const dead = Bun.spawnSync(["/bin/sh", "-c", "exit 0"]).pid
      writeFileSync(
        join(store, "omp-embedded-write.lock"),
        JSON.stringify({ host, pid: dead, owner: "runner-dead", token: "t", taken: Date.now(), expires: Date.now() + 60_000 }),
      )
      // A live steal lock stops takeover, so the dead hold is still there at the deadline.
      liveHolder(store, "omp-embedded-write-steal.lock")
      const result = await hold(store, "waiter", 60)
      if (result.kind !== "failed") throw new Error("expected a refusal")
      expect(result.busy).toBeUndefined()
      expect(result.reason).toContain("remove it once its holder is really gone")
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  test("backoff jitter stays inside [ceiling/2, ceiling] and the cap", () => {
    const ceilings = [20, 40, 80, 160, 320, 400, 400]
    for (const [attempt, ceiling] of ceilings.entries()) {
      expect(backoffDelayMs(attempt, () => 0)).toBe(ceiling / 2)
      expect(backoffDelayMs(attempt, () => 0.999999)).toBe(ceiling)
    }
    expect(backoffDelayMs(10_000, () => 0.999999)).toBe(400)
  })

  test.each([
    [undefined, 30_000],
    [{}, 30_000],
    [{ embeddedWriteWaitMs: 5000 }, 5000],
    [{ embeddedWriteWaitMs: 0 }, 0],
    [{ embeddedWriteWaitMs: -1 }, 30_000],
    [{ embeddedWriteWaitMs: "10" }, 30_000],
  ])("reads the embeddedWriteWaitMs option %j as %d ms", (options, expected) => {
    expect(writeWaitFromOptions(options)).toBe(expected)
  })

  test("a live holder past the preflight lets the runner wait instead of refusing the call", async () => {
    const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-preflight-busy-"))
    const store = join(root, ".beads")
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "metadata.json"), "{}")
    try {
      liveHolder(store)
      setPreflightWaitForTests(40)
      const decision = await decideEmbeddedWrite(
        parse("bd update bead-1 --claim") as unknown as Parameters<typeof decideEmbeddedWrite>[0],
        root,
        scrubbedBeadsEnv({ BEADS_DIR: store }),
        "busy-preflight",
        Date.now() + 5000,
        () => ({ interpreter: "/opt/bun", script: "/opt/runner.js" }),
        7000,
      )
      if (decision?.kind !== "rewrite") throw new Error(`expected a rewrite, got ${JSON.stringify(decision)}`)
      expect(decision.command).toContain("--beads-wait-ms 7000 -- bd update")
    } finally {
      setPreflightWaitForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("an oversized owner still releases and a later acquisition succeeds", async () => {
    const store = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-big-owner-"))
    try {
      const owner = `spec-start:${"x".repeat(200_000)}`
      expect((await hold(store, owner, 1000)).kind).toBe("held")
      expect(readFileSync(join(store, "omp-embedded-write.lock"), "utf8").length).toBeLessThan(2048)
      release(store, owner)
      expect(existsSync(join(store, "omp-embedded-write.lock"))).toBe(false)
      expect((await hold(store, "next", 1000)).kind).toBe("held")
      release(store, "next")
    } finally {
      rmSync(store, { recursive: true, force: true })
    }
  })

  describe.each([
    ["a FIFO", (path: string) => Bun.spawnSync(["mkfifo", path])],
    ["a symlink to /dev/zero", (path: string) => symlinkSync("/dev/zero", path)],
    ["an oversized file", (path: string) => writeFileSync(path, "x".repeat(70_000))],
  ])("a steal-lock path that is %s", (_name, plant) => {
    const withHostileSteal = async (run: (store: string, root: string) => Promise<void>): Promise<void> => {
      const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-steal-hostile-"))
      const store = join(root, ".beads")
      mkdirSync(store, { recursive: true })
      writeFileSync(join(store, "metadata.json"), "{}")
      // A live main hold forces the EEXIST path; the hostile steal path is what gets judged.
      writeFileSync(
        join(store, "omp-embedded-write.lock"),
        JSON.stringify({ host, pid: process.pid, owner: "other", token: "t", taken: Date.now(), expires: Date.now() + 60_000 }),
      )
      plant(join(store, "omp-embedded-write-steal.lock"))
      try {
        await run(store, root)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    test("hold refuses at once", async () => {
      await withHostileSteal(async (store) => {
        const started = Date.now()
        const result = await hold(store, "waiter", 20_000)
        if (result.kind !== "failed") throw new Error("expected a refusal")
        expect(Date.now() - started).toBeLessThan(2000)
        expect(result.reason).toContain("not a small regular file")
        expect(result.reason).toContain("omp-embedded-write-steal.lock")
      })
    })

    test("the runner refuses without starting the write", async () => {
      await withHostileSteal(async (store, root) => {
        const marker = join(root, "ran")
        const started = Date.now()
        const code = await runEmbeddedWriter([
          ...runnerStore(store),
          "--beads-wait-ms",
          "20000",
          "--",
          "/bin/sh",
          "-c",
          `touch ${marker}`,
        ])
        expect(code).not.toBe(0)
        expect(existsSync(marker)).toBe(false)
        expect(Date.now() - started).toBeLessThan(3000)
      })
    })
  })

  describe.each([
    ["a FIFO", (path: string) => Bun.spawnSync(["mkfifo", path])],
    ["a symlink to /dev/zero", (path: string) => symlinkSync("/dev/zero", path)],
  ])("a lock path that is %s", (_name, plant) => {
    const withHostileLock = async (run: (store: string, root: string) => Promise<void>): Promise<void> => {
      const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-hostile-"))
      const store = join(root, ".beads")
      mkdirSync(store, { recursive: true })
      writeFileSync(join(store, "metadata.json"), "{}")
      plant(join(store, "omp-embedded-write.lock"))
      try {
        await run(store, root)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    test("hold refuses at once instead of hanging or waiting out the budget", async () => {
      await withHostileLock(async (store) => {
        const started = Date.now()
        const result = await hold(store, "waiter", 20_000)
        if (result.kind !== "failed") throw new Error("expected a refusal")
        expect(Date.now() - started).toBeLessThan(2000)
        expect(result.reason).toContain("not a small regular file")
        expect(result.busy).toBeUndefined()
      })
    })

    test("the preflight blocks the call and writes nothing unlocked", async () => {
      await withHostileLock(async (store, root) => {
        const decision = await decideEmbeddedWrite(
          parse("bd update bead-1 --claim") as unknown as Parameters<typeof decideEmbeddedWrite>[0],
          root,
          scrubbedBeadsEnv({ BEADS_DIR: store }),
          "hostile-preflight",
          Date.now() + 5000,
          () => ({ interpreter: "/opt/bun", script: "/opt/runner.js" }),
        )
        if (decision?.kind !== "block") throw new Error(`expected a block, got ${JSON.stringify(decision)}`)
        expect(decision.reason).toContain("not a small regular file")
      })
    })

    test("the runner refuses without starting the write", async () => {
      await withHostileLock(async (store, root) => {
        const marker = join(root, "ran")
        const started = Date.now()
        const code = await runEmbeddedWriter([
          ...runnerStore(store),
          "--beads-wait-ms",
          "20000",
          "--",
          "/bin/sh",
          "-c",
          `touch ${marker}`,
        ])
        expect(code).not.toBe(0)
        expect(existsSync(marker)).toBe(false)
        expect(Date.now() - started).toBeLessThan(3000)
      })
    })
  })
})

describe("registry left by another plugin version", () => {
  const KEY = Symbol.for("com.srobroek.beads.embedded-write-lock.v1")
  const holder = globalThis as Record<symbol, unknown>

  function embeddedFixture(prefix: string): { root: string; store: string } {
    const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", prefix))
    const store = join(root, ".beads")
    mkdirSync(store)
    writeFileSync(join(store, "metadata.json"), "{}")
    return { root, store }
  }

  test("an object without `queues` is backfilled in place and two writes do not overlap", async () => {
    const { root, store } = embeddedFixture("beads-lock-old-shape-")
    const previous = holder[KEY]
    const old: Record<string, unknown> = { owned: new Map() }
    holder[KEY] = old
    try {
      let active = 0
      let overlapped = false
      const write = async () => {
        active++
        if (active > 1) overlapped = true
        await new Promise((resolve) => setTimeout(resolve, 60))
        active--
      }
      const env = scrubbedBeadsEnv({ BEADS_DIR: store })
      const results = await Promise.all([
        withEmbeddedWriteLock(root, "writer-a", write, env),
        withEmbeddedWriteLock(root, "writer-b", write, env),
      ])
      expect(results.map((r) => r.kind)).toEqual(["done", "done"])
      expect(overlapped).toBe(false)
      expect(holder[KEY]).toBe(old)
      expect(old.queues).toBeInstanceOf(Map)
    } finally {
      holder[KEY] = previous
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a hold an older version took, without the newer writer fields, is waited for", async () => {
    const { root, store } = embeddedFixture("beads-lock-old-holder-")
    const lock = join(store, "omp-embedded-write.lock")
    const previous = holder[KEY]
    const owned = new Map<string, unknown>()
    holder[KEY] = { owned, queues: new Map() }
    try {
      const fd = openSync(lock, "wx")
      const taken = Date.now()
      writeSync(fd, JSON.stringify({ host, pid: process.pid, owner: "old", token: "old-token", taken, expires: taken + 60_000 }))
      owned.set(lock, { fd, holders: new Map([["old", 1]]), renew: setInterval(() => {}, 60_000), token: "old-token" })
      let acquired = false
      const waiting = hold(store, "new", 10_000).then((got) => {
        acquired = true
        return got
      })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(acquired).toBe(false)
      release(store, "old")
      expect((await waiting).kind).toBe("held")
      release(store, "new")
    } finally {
      holder[KEY] = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("who chose the ledger a write lands in", () => {
  /** `beadsDirAssigned` of each observed write: did the command line itself set BEADS_DIR? */
  const assigned = (command: string, env: NodeJS.ProcessEnv): Array<boolean | undefined> => {
    const seen: Array<boolean | undefined> = []
    planEmbeddedWrites(command, "/work", env, {
      classify: false,
      observe: (target) => seen.push(target.beadsDirAssigned),
    })
    return seen
  }

  test.each([
    ["bd create --title t", false],
    ["BEADS_DIR=/x/.beads bd create --title t", true],
    ["export BEADS_DIR=/x/.beads; bd create --title t", true],
    ["BEADS_DIR=/x/.beads; bd create --title t", true],
    ["export OTHER=1; bd create --title t", false],
    ["export BEADS_DIR=/x/.beads; unset BEADS_DIR; bd create --title t", false],
  ])("%s -> assigned %p", (command, expected) => {
    expect(assigned(command, { BEADS_DIR: "/inherited/.beads" })).toEqual([expected])
  })

  test("the same write repeated, first inherited then with an identical explicit BEADS_DIR, is one placed target", () => {
    const store = "/inherited/.beads"
    const command = `bd update proj-1 --status open; BEADS_DIR=${store} bd update proj-1 --status open`
    const invocation = { verb: "update", args: ["proj-1", "--status", "open"], globals: [] }
    const target = resolveBdTargets(command, "/work", { BEADS_DIR: store }).get(invocation)
    expect(target).toBeDefined()
    expect(target).not.toHaveProperty("unresolved")
  })

  test.each([
    ["exec 'bd' create --title t", true],
    ["exec bd create --title t", true],
    ["env 'bd' create --title t", true],
    ["echo x | xargs 'bd' close", true],
    ["id=$(bd create --title t --silent)", true],
    ["bd create --title t", false],
    ["'bd' create --title t", false],
    ["echo 'bd'", false],
  ])("%s -> the planner reports an unplaced bd: %p", (command, unplaced) => {
    const reasons: string[] = []
    planEmbeddedWrites(command, "/work", { BEADS_DIR: "/x/.beads" }, { classify: false, unplaced: (reason) => reasons.push(reason) })
    expect(reasons.length > 0).toBe(unplaced)
  })

  test("each occurrence keeps its own provenance for the refusal", () => {
    const seen: boolean[] = []
    const command = "bd update proj-1 --status open; BEADS_DIR=/x/.beads bd update proj-1 --status open"
    planEmbeddedWrites(command, "/work", { BEADS_DIR: "/x/.beads" }, { classify: false, observe: (t) => seen.push(t.beadsDirAssigned) })
    expect(seen).toEqual([false, true])
  })

  /** Reasons the planner reports as unplaced for `command`, and the writes it observes. */
  const plan = (command: string, env: NodeJS.ProcessEnv = { BEADS_DIR: "/x/.beads" }) => {
    const reasons: string[] = []
    const writes: Array<{ verb: string; assigned: boolean }> = []
    planEmbeddedWrites(command, "/work", env, {
      classify: false,
      unplaced: (reason) => reasons.push(reason),
      observe: (target) => writes.push({ verb: target.invocation.verb, assigned: target.beadsDirAssigned }),
    })
    return { reasons, writes }
  }

  test.each([['"b"d create --title t'], ["b''d create --title t"], ["\\bd create --title t"]])(
    "a quote-split or escaped bd (%s) is placed as a bd write even though the text holds no bare bd word",
    (command) => {
      expect(plan(command).writes.map((w) => w.verb)).toEqual(["create"])
    },
  )

  test('exec "b"d create is reported as a wrapper followed by bd even though the text holds no bare bd word', () => {
    expect(plan('exec "b"d create --title t').reasons.join("\n")).toContain("follows the wrapper")
  })

  test.each([['"b"d list'], ["b''d list"], ["\\bd list"]])("%s is reported as an obfuscated command name", (command) => {
    expect(plan(command).reasons.join("\n")).toContain("quote-split or escaped")
  })

  test.each([["bd create --title t"], ["'bd' create --title t"], ['"bd" create --title t']])(
    "%s, a bd whose quotes wrap the whole name, is placed normally",
    (command) => {
      const { reasons, writes } = plan(command)
      expect(reasons).toEqual([])
      expect(writes.map((w) => w.verb)).toEqual(["create"])
    },
  )

  test.each([
    ["alias b=bd\nb create --title t", "alias"],
    ["alias b=bd; b create --title t", "alias"],
    ["f() { bd create --title t; }; f", "shell function"],
    ["f ()\n{\n bd create --title t\n}\nf", "shell function"],
    ["function f { bd create --title t; }; f", "shell function"],
  ])("%j is reported as unplaced (%s)", (command, what) => {
    expect(plan(command).reasons.join("\n")).toContain(what)
  })

  test.each([
    ["f() { export BEADS_DIR=/y/.beads; }; f; bd create --title t"],
    ["function f { export BEADS_DIR=/y/.beads; }\nbd create --title t"],
    ["f() { :; }; export BEADS_DIR=/y/.beads; bd create --title t"],
  ])("a function definition in the command voids every BEADS_DIR provenance: %j", (command) => {
    expect(plan(command).writes.map((w) => w.assigned)).toEqual([false])
  })

  test.each([
    ["git diff -- 'bd'"],
    ["grep -r 'bd' ."],
    ["gh label create 'bd'"],
  ])("%s names bd as an operand, not as a command", (command) => {
    expect(plan(command).reasons).toEqual([])
  })

  test.each([
    ["flock LOCKFILE bd create --title t"],
    ["taskset 0x1 bd create --title t"],
    ["xargs grep bd"],
    ["sudo -u build ls bd"],
    ["git log -- bd"],
  ])("%s: an unquoted bd operand is a launch the lock fails closed on", (command) => {
    expect(plan(command).reasons.join("\n")).toContain("launched through")
  })

  test.each([
    ["flock LOCKFILE 'bd' create --title t"],
    ["taskset 0x1 \"bd\" create --title t"],
    ["xargs grep 'bd'"],
    ["sudo -u build ls 'bd'"],
  ])("%s: a wrapper followed anywhere by a quoted bd is reported to the foreign-ledger gate, without parsing arity", (command) => {
    expect(plan(command).reasons.join("\n")).toContain("follows the wrapper")
  })

  test.each([
    ["BEADS_DIR=/x/.beads flock LOCKFILE bd create --title t"],
    ["env BEADS_DIR=/x/.beads taskset 0x1 bd create --title t"],
  ])("%s: a literal BEADS_DIR= on the command line is not reported", (command) => {
    expect(plan(command).reasons.join("\n")).not.toContain("follows the wrapper")
  })

  test.each([
    ["sudo -u build bd close x"],
    ["env A=1 bd close x"],
    ["timeout 60 bd close x"],
    ["nice -n 5 bd close x"],
    ["xargs -n1 bd close"],
    ["nohup exec bd close x"],
    ["find . -exec bd close {} \\;"],
  ])("%s runs bd behind a recognised wrapper", (command) => {
    expect(plan(command).reasons.join("\n")).toContain("launched through")
  })

  test.each([["exec 'bd' close x"], ["sudo -u build 'bd' close x"], ["env 'bd' close x"]])(
    "%s: a quoted bd behind a wrapper is not a lock launch, but the foreign-ledger gate is told",
    (command) => {
      const reasons = plan(command).reasons.join("\n")
      expect(reasons).not.toContain("launched through")
      expect(reasons).toContain("follows the wrapper")
    },
  )
})

describe("bd 1.3.1's store order for a write, with BEADS_DB inherited", () => {
  // Measured on bd 1.3.1 with real stores. Store commands open `--db`, then `BEADS_DIR`, then the
  // `.beads` found from the working directory, then `BEADS_DB` only when none is found. Commands that
  // skip store init (`bd where`, `bd dolt set`, `bd init`, ...) read `BEADS_DB` and `BD_DB` before
  // `BEADS_DIR` (cmd/bd/main.go `selectedNoDBBeadsDir`).
  let base = ""
  let checkout = ""
  /** The `.beads` found from `checkout`, canonical, as the lock holds it. */
  let own = ""
  let other = ""
  let moved = ""
  let bare = ""
  let bin = ""
  let log = ""
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-lock-order-")))
    checkout = join(base, "checkout")
    own = join(checkout, ".beads")
    other = join(base, "other", ".beads")
    moved = join(base, "moved", ".beads")
    bare = join(base, "bare")
    bin = join(base, "bin")
    log = join(base, "bd.log")
    for (const dir of [own, other, moved]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "metadata.json"), "{}")
    }
    for (const dir of [bare, bin]) mkdirSync(dir, { recursive: true })
    // A stand-in `bd` that records the store variables it got and whether the lock in its
    // BEADS_DIR names this very process as the writer.
    writeExecutable(
      join(bin, "bd"),
      `#!/bin/sh\nheld=$(grep -c "\\"writer\\":$$[,}]" "$BEADS_DIR/omp-embedded-write.lock" 2>/dev/null)\nprintf 'dir=%s db=%s bd_db=%s held=%s\\n' "$BEADS_DIR" "\${BEADS_DB:-}" "\${BD_DB:-}" "$held" > ${JSON.stringify(log)}\n`,
    )
  })
  afterAll(() => rmSync(base, { recursive: true, force: true }))

  const inherited = (extra: Record<string, string> = {}) => scrubbedBeadsEnv({ BEADS_DB: join(other, "beads.db"), ...extra })
  const real = () => ({ interpreter: process.execPath, script: join(import.meta.dir, "bd-embedded-write-runner.ts") })

  /** Plan `command` under `env`, run the rewrite in bash with `childEnv` added, and return what the stand-in recorded. */
  async function runRewritten(command: string, env: Record<string, string>, childEnv: Record<string, string> = {}) {
    writeFileSync(log, "")
    const decision = await decideEmbeddedWrite(
      parse(command) as unknown as Parameters<typeof decideEmbeddedWrite>[0],
      checkout,
      env,
      `order:${command}`,
      Date.now() + 5000,
      real,
    )
    expect(decision?.kind).toBe("rewrite")
    if (decision?.kind !== "rewrite") return ""
    const run = Bun.spawnSync(["bash", "-c", decision.command], {
      cwd: checkout,
      env: { ...env, PATH: `${bin}:${process.env.PATH ?? ""}`, ...childEnv },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(run.exitCode).toBe(0)
    return readFileSync(log, "utf8").trim()
  }

  test("BEADS_DB is ignored where the working directory has a .beads: the write locks that store", () => {
    expect(embeddedWriteTargets("bd close bd-1", checkout, inherited())).toEqual({ kind: "stores", stores: [own] })
  })

  test("with no .beads found, the write locks the store BEADS_DB names", () => {
    expect(embeddedWriteTargets("bd close bd-1", bare, inherited())).toEqual({ kind: "stores", stores: [other] })
  })

  test("BEADS_DIR beats the .beads found", () => {
    expect(embeddedWriteTargets("bd close bd-1", checkout, inherited({ BEADS_DIR: moved }))).toEqual({ kind: "stores", stores: [moved] })
  })

  test("--db beats BEADS_DIR, the .beads found and BEADS_DB", () => {
    const result = embeddedWriteTargets(`bd --db ${moved} close bd-1`, checkout, inherited({ BEADS_DIR: other }))
    expect(result).toEqual({ kind: "stores", stores: [moved] })
  })

  test.each([
    ["an export before the write", () => `export BEADS_DB=${join(moved, "beads.db")}; bd close bd-1`, false],
    ["an export of a computed name", () => `n=BEADS_; export "\${n}DB=${join(moved, "beads.db")}"; bd close bd-1`, false],
    ["a BASH_ENV startup file", () => "bd close bd-1", true],
  ])("a BEADS_DB changed by %s still writes under the lock of the store the gate pinned", async (_name, command, startupFile) => {
    const startup = join(base, "startup.sh")
    writeFileSync(startup, `export BEADS_DB=${join(moved, "beads.db")}\n`)
    const recorded = await runRewritten(command(), inherited(), startupFile ? { BASH_ENV: startup } : {})
    expect(recorded).toStartWith(`dir=${own} `)
    expect(recorded).toEndWith(" held=1")
  })

  test("a write that skips store init runs with BEADS_DB and BD_DB cleared, so a BASH_ENV file cannot move it", async () => {
    const startup = join(base, "startup-nodb.sh")
    writeFileSync(startup, `export BEADS_DB=${join(moved, "beads.db")} BD_DB=${moved}\n`)
    const recorded = await runRewritten("bd dolt set port 1", scrubbedBeadsEnv(), { BASH_ENV: startup })
    expect(recorded).toBe(`dir=${own} db= bd_db= held=1`)
  })

  // Writes that skip store init, from main.go's noDbCommands, its skip-store annotations and the
  // migrate subcommands that skip it.
  test.each([
    "bd dolt set port 1",
    "bd dolt start",
    "bd init --skip-hooks",
    "bd bootstrap",
    "bd hooks install",
    "bd formula pour f",
    "bd setup claude",
    "bd doctor --fix",
    "bd worktree create w",
    "bd migrate from-server-to-proxied-server",
  ])("refuses `%s` under an inherited BEADS_DB, naming --db and BEADS_DIR", (command) => {
    const result = embeddedWriteTargets(command, checkout, inherited())
    expect(result.kind).toBe("refused")
    expect(JSON.stringify(result)).toContain("--db")
    expect(JSON.stringify(result)).toContain("BEADS_DIR")
  })

  test.each([
    ["BD_DB is inherited", "bd dolt set port 1", { BD_DB: "/x/.beads" }],
    ["BEADS_DB is mentioned in the command", "echo $BEADS_DB; bd dolt set port 1", {}],
    ["BD_DB is mentioned in the command", "BD_DB=/x/.beads bd dolt set port 1", {}],
  ])("refuses `bd dolt set` when %s", (_name, command, env) => {
    const result = embeddedWriteTargets(command, checkout, scrubbedBeadsEnv(env))
    expect(result.kind).toBe("refused")
    expect(JSON.stringify(result)).toContain("--db")
  })

  test.each(["bd dolt push", "bd dolt commit", "bd dolt remote add origin u", "bd close bd-1"])(
    "`%s` opens the store, so an inherited BEADS_DB cannot move it: locked, not refused",
    (command) => {
      expect(embeddedWriteTargets(command, checkout, inherited())).toEqual({ kind: "stores", stores: [own] })
    },
  )

  test.each(["bd where", "bd dolt show", "echo $BEADS_DB; bd where"])("`%s` is a read and passes under an inherited BEADS_DB", (command) => {
    expect(embeddedWriteTargets(command, checkout, inherited())).toEqual({ kind: "stores", stores: [] })
  })
})

