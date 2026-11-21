import { expect, setDefaultTimeout, test } from "bun:test"

// One fresh bun process: 45 ms for the whole file at load average 11; 30 s leaves headroom for a loaded machine (AGENTS.md, Testing).
setDefaultTimeout(30_000)

// Bun.spawnSync without `env` passes the startup environment, so this proves
// `.env.test` was loaded before any code ran.
test(".env.test excludes the host git config from spawned children", () => {
  const child = Bun.spawnSync(["sh", "-c", 'printf "%s|%s" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_NOSYSTEM"'])
  expect(child.stdout.toString()).toBe("/dev/null|1")
})

test("the preload deletes the beads variables a parent shell leaks and keeps others", () => {
  // The child is a fresh bun process given the foreign values; only the preload can remove them.
  const leaked = ["BEADS_DIR", "BEADS_DB", "BEADS_ACTOR", "BD_ACTOR", "BD_DB", "BD_SOCKET", "BEADS_DOLT_SERVER_PORT"]
  const kept = ["BEADSX", "MY_BD_X", "SROBROEK_BEADS_PIN"]
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--preload",
      "./scripts/test-preload.ts",
      "-e",
      `process.stdout.write(JSON.stringify(${JSON.stringify([...leaked, ...kept])}.map((k) => process.env[k] ?? null)))`,
    ],
    {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, ...Object.fromEntries([...leaked, ...kept].map((key) => [key, "foreign"])) },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toEqual([...leaked.map(() => null), ...kept.map(() => "foreign")])
})
