// The embedded-write runner in the pi tree. The bash gate rewrites a `bd` write to run under
// `bun <this file> ... -- bd ...`, and the lock finds this file by name beside the `beads`
// extension. pi loads every listed extension, so this one also default-exports a factory that
// registers nothing; only a direct `bun` run executes the runner.
import { main } from "@srobroek/opencode-lib/bd-embedded-write-runner"

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))

/** Loaded as a pi extension, the runner registers nothing. */
export default function (): void {}
