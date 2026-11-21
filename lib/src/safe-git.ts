import { devNull } from "node:os"

/**
 * Git's global options for every command that runs inside a checkout this tool does
 * not control (a landed worktree, or another repository's checkout).
 *
 * `core.fsmonitor` is a program `git status` executes and `core.hooksPath` selects
 * hooks, so a hostile checkout's own config could run code; command-line `-c`
 * outranks repository config. `--no-optional-locks` keeps a read from writing the index.
 */
export const SAFE_GIT_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${devNull}`,
  "--no-optional-locks",
] as const

/**
 * {@link SAFE_GIT_ARGS} plus the overrides for a command that only reads or updates local
 * state in a checkout whose config may be hostile, and so must never reach a remote.
 *
 * - `core.attributesFile` drops the global attributes file.
 * - `diff.external` is blanked, so a patch diff fails instead of running it.
 * - `core.sshCommand`, `credential.helper` and `core.askPass` are blanked. With every transport
 *   refused ({@link UNTRUSTED_LOCAL_GIT_ENV}) none of them should start; this is a second layer.
 * - `log.showSignature` is off, so a log-style read (`stash list`) verifies no signature, and
 *   the signature programs are blanked as a second layer.
 *
 * Filter drivers are named per repository, so a command that hashes work-tree files also needs
 * {@link filterDriverOverrides}.
 */
export function untrustedLocalGitArgs(): string[] {
  // A function, not a constant, so bundles that only use SAFE_GIT_ARGS can drop it.
  return [
    ...SAFE_GIT_ARGS,
    "-c",
    `core.attributesFile=${devNull}`,
    "-c",
    "diff.external=",
    "-c",
    "core.sshCommand=",
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "-c",
    "log.showSignature=false",
    "-c",
    "gpg.program=",
    "-c",
    "gpg.ssh.program=",
    "-c",
    "gpg.x509.program=",
  ]
}

/**
 * Environment for the commands {@link untrustedLocalGitArgs} covers.
 *
 * - An empty `GIT_ALLOW_PROTOCOL` refuses every transport, built-in or remote helper, whatever
 *   the repository's `protocol.*.allow` says. A lazy fetch in a partial clone would otherwise run
 *   the repository's `remote.<name>.uploadpack`, SSH command or credential helper.
 * - `GIT_NO_LAZY_FETCH` stops that fetch before it starts.
 * - No system config and no terminal prompt.
 *
 * Residual risk (no minimum-version bump): `GIT_NO_LAZY_FETCH` needs git 2.45. Older git still
 * starts a lazy fetch and relies on the transport refusal, which git checks before it connects.
 */
export const UNTRUSTED_LOCAL_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_ALLOW_PROTOCOL: "",
  GIT_NO_LAZY_FETCH: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
}

/**
 * The git arguments that list every configured key, NUL-terminated; {@link filterDriverOverrides}
 * picks the filter drivers out. A `--get-regexp` would skip a key that is not valid in the locale's
 * encoding, and with it the driver. Run them in the same directory, with the same options and
 * environment, as the command they protect: git then evaluates conditional includes (`includeIf`)
 * and per-worktree config the same way for both. Exit 1 with no output means no config at all.
 */
export const FILTER_DRIVER_LISTING = ["config", "--name-only", "-z", "--list"] as const

/**
 * `-c` options that disable every filter driver a {@link FILTER_DRIVER_LISTING} output names, so
 * a command that hashes work-tree files runs no clean or process filter. That includes drivers
 * from the user's global config, git-lfs among them: the repository picks the driver through its
 * attributes and can supply the program a relative command runs. Undefined when the listing is
 * malformed or a driver name is not UTF-8 or contains `=`, since `-c` cannot name such a driver;
 * the caller must then not run the command.
 *
 * Not covered: a submodule's own drivers when `git status` recurses into it, and a config that
 * changes between the listing and the command.
 */
export function filterDriverOverrides(listing: string): string[] | undefined {
  const keys = listing.split("\0")
  if (keys.pop() !== "") return undefined
  const drivers = new Set<string>()
  for (const key of keys) {
    const last = key.lastIndexOf(".")
    // A key is `filter.<driver>.<variable>`, and `<driver>` may be empty; a two-part `filter.<variable>` names no driver.
    if (!key.startsWith("filter.") || last < "filter.".length) continue
    drivers.add(key.slice("filter.".length, last))
  }
  // Output is decoded as UTF-8 with replacement, so U+FFFD marks a name that was not UTF-8.
  if ([...drivers].some((driver) => driver.includes("=") || driver.includes("\uFFFD"))) return undefined
  return [...drivers].flatMap((driver) =>
    ["clean=", "smudge=", "process=", "required=false"].flatMap((setting) => ["-c", `filter.${driver}.${setting}`]),
  )
}
