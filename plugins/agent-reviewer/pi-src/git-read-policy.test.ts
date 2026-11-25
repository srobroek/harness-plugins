import { describe, expect, test } from "bun:test"
import { GIT_READ_SUBCOMMANDS, gitReadArgs } from "./git-read-policy.ts"

const DIFF_GUARDS = ["--no-ext-diff", "--no-textconv"]

describe("gitReadArgs allows the listed reads", () => {
  test.each([
    ["log", ["--oneline", "main..feature"], ["log", ...DIFF_GUARDS, "--oneline", "main..feature"]],
    ["log", ["-p", "--stat", "main...feature", "--", "src"], ["log", ...DIFF_GUARDS, "-p", "--stat", "main...feature", "--", "src"]],
    ["diff", ["main..feature"], ["diff", ...DIFF_GUARDS, "main..feature"]],
    ["diff", ["--output-indicator-new=>", "HEAD"], ["diff", ...DIFF_GUARDS, "--output-indicator-new=>", "HEAD"]],
    ["show", ["feature", "--", "README.md"], ["show", ...DIFF_GUARDS, "feature", "--", "README.md"]],
    ["show", ["--no-textconv", "--no-ext-diff", "HEAD"], ["show", ...DIFF_GUARDS, "--no-textconv", "--no-ext-diff", "HEAD"]],
    ["branch", ["--list"], ["branch", "--list"]],
    ["branch", ["--list", "-a", "-vv", "--contains=main", "--sort=-committerdate", "feat*"], ["branch", "--list", "-a", "-vv", "--contains=main", "--sort=-committerdate", "feat*"]],
    ["rev-parse", ["--verify", "feature^{commit}"], ["rev-parse", "--verify", "feature^{commit}"]],
    ["merge-base", ["main", "feature"], ["merge-base", "main", "feature"]],
    ["merge-base", ["--is-ancestor", "main", "feature"], ["merge-base", "--is-ancestor", "main", "feature"]],
    ["ls-files", [], ["ls-files"]],
    ["cat-file", ["-p", "HEAD:README.md"], ["cat-file", "-p", "HEAD:README.md"]],
    ["cat-file", ["-t", "HEAD"], ["cat-file", "-t", "HEAD"]],
    ["ls-tree", ["-r", "--name-only", "feature"], ["ls-tree", "-r", "--name-only", "feature"]],
    ["for-each-ref", ["--format=%(refname:short)", "refs/heads"], ["for-each-ref", "--format=%(refname:short)", "refs/heads"]],
  ] as const)("%s %j", (subcommand, args, expected) => {
    expect(gitReadArgs(subcommand, args)).toEqual({ allowed: true, args: [...expected] })
  })

  test("lists exactly the ten read subcommands", () => {
    expect([...GIT_READ_SUBCOMMANDS].sort()).toEqual(
      ["branch", "cat-file", "diff", "for-each-ref", "log", "ls-files", "ls-tree", "merge-base", "rev-parse", "show"],
    )
  })
})

describe("gitReadArgs refuses", () => {
  test.each([
    ["commit", ["-m", "x"]],
    ["push", ["origin", "main"]],
    ["checkout", ["feature"]],
    ["reset", ["--hard", "HEAD~1"]],
    ["switch", ["main"]],
    ["fetch", []],
    ["config", ["user.name"]],
    ["status", []],
    ["-c", ["core.pager=sh"]],
    ["", []],
  ] as const)("the subcommand %j", (subcommand, args) => {
    const decision = gitReadArgs(subcommand, args)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain("is not a git_read subcommand")
  })

  test.each([
    [["-D", "feature"], "only with --list"],
    [["feature"], "only with --list"],
    [[], "only with --list"],
    [["--list", "-D", "feature"], "only listing options"],
    [["--list", "-d", "feature"], "only listing options"],
    [["--list", "--delete", "feature"], "only listing options"],
    [["--list", "-m", "feature", "renamed"], "only listing options"],
    [["--list", "-c", "feature", "copy"], "only listing options"],
    [["--list", "-f", "feature", "main"], "only listing options"],
    [["--list", "--set-upstream-to=origin/main"], "only listing options"],
    [["--list", "--edit-description"], "only listing options"],
    [["--list", "-av"], "only listing options"],
    [["--li", "feature"], "only with --list"],
    // A separate value could be `--list` itself: `--format --list new` would create `new`.
    [["--format", "--list", "new"], "--format=<value>"],
    [["--list", "--contains", "main"], "--contains=<value>"],
  ] as const)("branch %j", (args, reason) => {
    const decision = gitReadArgs("branch", args)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain(reason)
  })

  test.each([
    ["log", ["--output=x"], "--output writes a file"],
    ["diff", ["--output", "x"], "--output writes a file"],
    ["show", ["--outp=x"], "abbreviates --output"],
    ["log", ["-o", "x"], "-o is refused"],
    ["diff", ["--ext-diff"], "runs an external diff program"],
    ["diff", ["--ext"], "abbreviates --ext-diff"],
    ["log", ["-p", "--textconv"], "runs a textconv program"],
    ["log", ["--show-signature"], "runs a signature verifier"],
    ["diff", ["--no-index", "/etc/hosts", "README.md"], "reads files outside the repository"],
    // Checked past `--` too: `--grep` would take the `--` as its value and parse the next argument as an option.
    ["log", ["--grep", "--", "--output=x"], "--output writes a file"],
    ["for-each-ref", ["--output=x"], "--output writes a file"],
  ] as const)("%s %j", (subcommand, args, reason) => {
    const decision = gitReadArgs(subcommand, args)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toContain(reason)
  })

  test.each([
    [["--batch"]],
    [["-p"]],
    [["-p", "HEAD", "extra"]],
    [["--filters", "HEAD:README.md"]],
    [["--textconv", "HEAD:README.md"]],
    [["-s", "HEAD"]],
    [["-p", "--batch-all-objects"]],
  ] as const)("cat-file %j", (args) => {
    const decision = gitReadArgs("cat-file", args)
    expect(decision.allowed).toBe(false)
  })
})
