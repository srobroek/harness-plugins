/**
 * The `gitWrappers` plugin option: the executables a gate treats as git.
 *
 * A host may route git through a wrapper (a credential helper or a transport that
 * forwards to another machine) that takes git's own arguments. Listing its name in
 * `gitWrappers` makes the gates read its calls as git calls. Matching is on the
 * command word's basename, so `/opt/bin/<name>` counts as `<name>`.
 */

/** Only `git` itself. */
export const DEFAULT_GIT_WRAPPERS: readonly string[] = Object.freeze(["git"])

/**
 * The `gitWrappers` option's non-empty string entries. An absent option, a value that is not a
 * list, or a list with no usable entry gives only `git`, so a typo never switches the git gates off.
 */
export function readGitWrappers(options: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const raw = options?.gitWrappers
  if (!Array.isArray(raw)) return DEFAULT_GIT_WRAPPERS
  const names = raw.filter((name): name is string => typeof name === "string" && name !== "")
  return names.length === 0 ? DEFAULT_GIT_WRAPPERS : names
}

/** Whether the basename of the command word `argv0` is one of `wrappers`. */
export function isGitCommand(argv0: string | undefined, wrappers: readonly string[] = DEFAULT_GIT_WRAPPERS): boolean {
  if (argv0 === undefined) return false
  return wrappers.includes(argv0.slice(argv0.lastIndexOf("/") + 1))
}

/** A regular-expression alternation that matches any of `wrappers` literally, for use inside `(?:…)`. */
export function gitWrapperPattern(wrappers: readonly string[] = DEFAULT_GIT_WRAPPERS): string {
  return wrappers.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
}
