/**
 * The shell permission rules of every read-only agent (reviewers, challengers, architect,
 * seance, and the built-in explore).
 *
 * A read-only agent may run any command except the ones that change the repository, a remote,
 * the beads ledger or files on disk. OpenCode lets the last matching rule win, so the order
 * below is part of the contract: allow everything, deny the mutators, then re-allow the
 * read forms that a broader deny caught. Clones, fetches and `git worktree add` stay allowed
 * (they write only where the caller points them). `edit`, `write` and `patch` stay denied in
 * each agent's own rules.
 *
 * Agent sources reference this list with a `# {{rules read-only-shell}}` comment line in the
 * frontmatter permissions; `composeAgent` expands it (see `fragments.ts`).
 */

export type ShellRule = { action: "shell"; resource: string; effect: "allow" | "deny" }

const deny = (...resources: string[]): ShellRule[] => resources.map((resource) => ({ action: "shell", resource, effect: "deny" }))
const allow = (...resources: string[]): ShellRule[] => resources.map((resource) => ({ action: "shell", resource, effect: "allow" }))

const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"]

/** `gh api` and `glab api` default to GET; a body flag or another method makes a write. */
const forgeApi = (cli: "gh" | "glab"): ShellRule[] => [
  ...deny(`${cli} api *-f *`, `${cli} api *-F *`, `${cli} api *--field*`, `${cli} api *--raw-field*`, `${cli} api *--input*`),
  ...deny(`${cli} api *-X*`, `${cli} api *--method*`),
  ...allow(`${cli} api *-X GET*`, `${cli} api *--method GET*`),
  ...deny(...WRITE_METHODS.flatMap((m) => [`${cli} api *-X ${m}*`, `${cli} api *--method ${m}*`])),
]

/** The beads ledger: everything is denied except the read verbs. */
const BD_READS = [
  "show", "list", "ready", "search", "query", "count", "blocked", "children", "graph", "history", "status", "stale",
  "types", "statuses", "where", "info", "context", "ping", "memories", "recall", "find-duplicates", "lint", "events",
  "diff", "dep list", "dep tree", "dep cycles", "label list", "config get", "config list", "epic status", "state",
]

export const READ_ONLY_SHELL_RULES: readonly ShellRule[] = [
  ...allow("*"),
  // files
  ...deny("rm*", "mv*", "cp*", "touch*", "tee*", "chmod*", "chown*", "ln*", "sudo*", "sed -i*", "sed * -i*", "find *-delete*", "find *-exec*"),
  ...deny("* > *", "* >> *"),
  // git: the working tree, refs, history and config
  ...deny(
    "git push*", "git commit*", "git reset*", "git checkout*", "git switch*", "git restore*", "git clean*", "git rebase*",
    "git merge*", "git pull*", "git cherry-pick*", "git revert*", "git apply*", "git am*", "git add*", "git rm*", "git mv*",
    "git branch -d*", "git branch -D*", "git branch --delete*", "git branch -m*", "git branch -M*", "git branch --move*",
    "git branch -f*", "git branch --force*", "git tag -d*", "git tag --delete*", "git stash*", "git worktree remove*",
    "git worktree prune*", "git update-ref*", "git remote add*", "git remote remove*", "git remote rm*",
    "git remote set-url*", "git remote rename*", "git config*", "git gc*",
  ),
  ...allow("git stash list*", "git stash show*", "git config --get*", "git config --list*", "git config -l*"),
  ...deny("git * --output*"),
  // forges
  ...deny(
    "gh pr create*", "gh pr merge*", "gh pr close*", "gh pr edit*", "gh pr comment*", "gh pr review*", "gh pr ready*",
    "gh pr reopen*", "gh issue create*", "gh issue close*", "gh issue edit*", "gh issue comment*", "gh issue reopen*",
    "gh release*", "gh repo delete*", "gh repo create*", "gh repo edit*", "gh * delete*", "gh workflow run*", "gh run rerun*",
    "glab mr create*", "glab mr merge*", "glab mr close*", "glab mr note*", "glab mr approve*", "glab mr update*",
    "glab mr reopen*", "glab issue create*", "glab issue close*", "glab issue note*", "glab issue update*", "glab release*",
    "glab repo delete*", "glab * delete*",
  ),
  ...forgeApi("gh"),
  ...deny("gh api *graphql*"),
  ...forgeApi("glab"),
  // beads ledger
  ...deny("bd*"),
  ...allow(...BD_READS.flatMap((verb) => [`bd ${verb}*`, `bd --json ${verb}*`]), "bd --version*", "bd --help*", "bd * --help*"),
  ...deny("bd comments add*", "bd config set*", "bd label add*", "bd dep add*"),
  // search tools with autofix
  ...deny(
    "ast-grep * -U*", "ast-grep *--update-all*", "ast-grep * -i*", "ast-grep *--interactive*",
    "semgrep *--autofix*", "semgrep *-a *",
  ),
]
