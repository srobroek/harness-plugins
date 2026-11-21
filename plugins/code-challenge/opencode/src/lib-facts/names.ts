import type { Ecosystem } from "./types.ts"

const MAX_NAME = 214
const MAX_VERSION = 128

const NAME: Record<Ecosystem, RegExp> = {
  npm: /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i,
  pypi: /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i,
  crates: /^[a-z][a-z0-9_-]*$/i,
  go: /^[a-z0-9][a-z0-9._~-]*(?:\/[a-z0-9._~-]+)*$/i,
}

const VERSION = /^[a-z0-9][a-z0-9._+!~-]*$/i

/** Why a package name is unusable in a URL path for this ecosystem, or `undefined` when it is fine. */
export function nameProblem(ecosystem: Ecosystem, name: string): string | undefined {
  if (name.length > MAX_NAME) return `package name over ${MAX_NAME} characters`
  if (!NAME[ecosystem].test(name) || name.split("/").some((part) => part === "." || part === ".."))
    return `invalid ${ecosystem} package name`
  return undefined
}

export function versionProblem(version: string): string | undefined {
  return version.length <= MAX_VERSION && VERSION.test(version) ? undefined : "invalid version"
}
