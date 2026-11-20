// Entry point of the embedded-write runner; the implementation lives in the shared library
// next to the lock it takes, which finds this script by name beside itself.
import { main } from "@srobroek/opencode-lib/bd-embedded-write-runner"

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))

export default main
