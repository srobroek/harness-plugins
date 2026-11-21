import { expect, test } from "bun:test"

// Bun.spawnSync without `env` passes the startup environment, so this proves
// `.env.test` was loaded before any code ran.
test(".env.test excludes the host git config from spawned children", () => {
  const child = Bun.spawnSync(["sh", "-c", 'printf "%s|%s" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_NOSYSTEM"'])
  expect(child.stdout.toString()).toBe("/dev/null|1")
})

test("the preload deletes the beads variables a parent shell leaks", () => {
  // The child is a fresh bun process given the foreign values; only the preload can remove them.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--preload",
      "./scripts/test-preload.ts",
      "-e",
      'const keys = ["BEADS_DIR", "BEADS_DB", "BEADS_ACTOR", "BD_ACTOR"]; process.stdout.write(JSON.stringify(keys.map((k) => process.env[k] ?? null)))',
    ],
    {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, BEADS_DIR: "/foreign/.beads", BEADS_DB: "/foreign/db", BEADS_ACTOR: "foreign", BD_ACTOR: "foreign" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toEqual([null, null, null, null])
})
