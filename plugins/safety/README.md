# safety

Guards for the shell tool in OpenCode V2: hard gates for commands that should never run unreviewed,
permission checks for commands that destroy work, a gate that keeps shipped migrations append-only,
an `external_directory` check for directory flags, a PR close-keyword rewrite, a package-vetting
advisory, and redaction of secret environment values from tool output. Ported from the omp-plugins `safety` package.

Every check reads the command with the shared shell parser (`@srobroek/opencode-lib`), not a regex
over the tool call. A hazard quoted as data (`grep 'rm -rf $X'`, a commit message, a here-document
written to a file, a `bun -e` fixture) never trips a check. One run through `sudo`, `env`,
`timeout`, `bash -c`, `eval`, `xargs`, a here-document fed to a shell, or a command substitution does.

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/safety/opencode'
```

Needs `git` on `PATH`. The branch check also uses `gh`. Without `gh`, the merged-PR signal is
absent, so a squash-merged branch asks instead of passing.

## Hard gates

These run in `tool.hook("execute.before")` and throw. The model gets the message as the tool error,
and the command does not run.

| Id | Refuses |
| --- | --- |
| `indirection` | `rm`, `rmdir`, `dd`, `shred`, `truncate`, `unlink`, `wipefs` or `mkfs*` whose operand is `$VAR`, `${VAR}`, `$(…)` or a backtick expression. The one exception: a quoted variable after a bare `--` (`rm -r -- "$tmp_dir"`). Substitutions are never exempt. |
| `remote-exec` | A fetch (`curl`, `wget`, `fetch`, `http`, `xh`) piped into `sh`/`bash`/`zsh`/… at any later pipeline stage. A shell, `source`, `.` or `eval` running a fetch's output (`bash -c "$(curl …)"`, `bash <(curl …)`, `eval "$(curl …)"`). `nc`/`ncat` with `-e`, `--exec` or `--sh-exec`. |
| `attribution` | `git commit` whose `-m`, `--message`, `--trailer` or `-F`/`--file` message names an AI assistant. That covers a `Co-authored-by` trailer naming Claude, Codex, GPT, Copilot, Cursor, Devin, Gemini, Anthropic or OpenAI, a `Generated with …` line, and an `@anthropic.com`/`@openai.com` noreply address. A `-F` file is read from disk, and the gate also reads what earlier commands in the same call wrote into it. `-F -` reads the command's here-document. |
| `worktree-tmp` | `git worktree add` with a path under `/tmp` or `/private/tmp`. Relative paths resolve against the call's directory. Also `wt switch\|new\|co\|agent` naming such a path. |
| `history-rewrite` | History rewrites that do not provably run in a linked worktree or temp clone. The guard fails closed and models neither the shell nor git's repository selection. It covers `git filter-repo` / `git-filter-repo` (also through `uvx`, `uv tool run`, `uv run`, `pipx run`, `pipenv run`, `python -m git_filter_repo`, with `@version` / `==version` qualifiers), `git filter-branch`, `git replace` (not `--list`), and `git update-ref` that deletes a branch (`-d`, a zero or empty new value, or an `--stdin` transaction that is not a sole literal here-document or here-string: a pipe, a file, `<&`, `-z`, two stdin redirections, an expansion, a quoted field). A rewrite is refused when the same shell command also contains `cd`, `pushd`, `popd`, `builtin`, `command`, any `env` wrapper, a wrapper's `-C`/`--chdir`/`-D`, `git --exec-path`, a nested shell (`sh -c`, `bash -c`, a script run by a shell), `eval`, `source`, `.`, `xargs`, `exec`, or a function or alias definition; or anything that selects a repository: `--git-dir`, `--work-tree`, `--config-env`, `-c core.worktree`, `-c core.bare`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` in any position (options, assignments, exports, env wrappers). It is also refused when the session's own environment sets `GIT_DIR`, `GIT_WORK_TREE` or `GIT_COMMON_DIR`; the refusal names the variable, never its value. Otherwise only the workdir, `-C` and filter-repo's `--target` are judged: each must resolve to a real directory the same way logically (`..` removes the previous component) and physically (symlinks first), and the result must be a temp clone (under the OS temp folder) or a verified linked worktree (a regular `.git` file naming a `worktrees/<name>` directory with `commondir` and a `gitdir` file pointing back at it; submodules, separate git directories, symlinked or FIFO metadata do not count). Metadata is read with `lstat`, a non-blocking no-follow open and a bounded read, so a FIFO cannot hang the guard. A directory outside any repository passes. `filter-repo --force` is refused everywhere. As a text-level fallback, a command that names `filter-repo`, `filter-branch`, `update-ref` or `replace` next to `git` (or `git-filter-repo`) is refused when the walker did not judge it as a rewrite (`builtin eval '…'`, `python -c`, a git alias, any unrecognised wrapper); arguments of `grep`, `rg`, `echo`, `printf`, `cat`, `bd`, `pip`, and of `git log`/`commit`/`show`/`diff`/`grep`/`status`/`add`/`blame`/`shortlog` are data only in a positional, `-e`, `-m`, `--grep` or `--message` position, and never alongside an option that runs a program (`-O`, `--open-files-in-pager`, `--ext-diff`, `--textconv`, `--pager`, `rg --pre`). A launcher whose arguments mention a rewrite passes only when it directly launches a filter-repo that the guard judged and allowed, or when it installs or lists packages; any other launcher (launched `git`, a nested launcher, a shell, an interpreter, a script) is refused. A repeated filter-repo `--target` or `--source` (including argparse abbreviations such as `--targ`) is refused, and `git --config-env <value>` consumes its value. A false refusal costs one retry: clone into a temp directory and run the command there with the tool's workdir set to the clone. |
| `push-via` | Off by default. With `{ "pushVia": { "host": "github.com", "command": "git-wrapper" } }` in the plugin options, a literal `git push` whose remote resolves to `host` is refused with a hint to run `<command> -C <dir> push` instead. **Scope, by the owner's decision:** it judges a call only when its first command is a plain, literal `git push` or `git -C <literal dir> push`, written with no wrapper (`env`, `exec`, `sudo`, `doas`, `command`, `nohup`), no inline assignment, no variable or `~` expansion, no command substitution, no quoting or escapes in the command words, no redirect on the push and no `-c`, `--config-env`, `--git-dir` or `--work-tree` option. Anything else passes unchecked: earlier commands, nested shells, `eval`, subshells, and a `..` in a `-C` directory too. Reproducing git's config and environment through those shapes never converged (each fix left another gap), so the guard stays a convenience that saves a doomed network call, not a security boundary. The remote is the positional repository (which wins over `--repo`, as in git; values of `-o`/`--push-option` are skipped; a unique prefix of a long option counts as that option, and an unknown or ambiguous long option fails open), else `--repo`, else for a bare push the branch's `pushRemote`, `remote.pushDefault`, the branch's remote, the only configured remote when there is exactly one (git's `remotes_remote_for_branch` in `remote.c`), then `origin`. A remote name is read from local config with `git remote get-url --push --all` under hardened arguments (`pushurl` and `pushInsteadOf` apply, and any of several URLs on the host refuses). A word that is not a configured remote and looks like a URL or path goes through `git ls-remote --get-url` (`insteadOf` applies); it fails open when any `pushInsteadOf` rule exists. Neither contacts the network. System and global git config are read, as the push would read them. It also fails open for an unresolvable remote, for `git push -h`/`--help`, and when the session's environment sets `GIT_CONFIG*`, `GIT_DIR`, `GIT_WORK_TREE` or `GIT_COMMON_DIR`. The configured command itself is never refused. A malformed option leaves it off. Turn off with `disable: ["push-via"]`. |
| `op-guard` | The 1Password CLI `op` (also `op.exe` or a path ending in `/op`) in any command position, with any subcommand except `op whoami`, `op --version`, `--help`, `op vault create <name>`, `op vault list` (names and ids only) and the `opAllow` prefixes. Each direct call opens a new 1Password session and prompts the user, so the refusal points to `fnox exec -- <cmd>` and `fnox provider discover <provider> --tags project/<name>`. `op item create` and `op item edit` pass only when they carry no value from the shell: `--generate-password`, or literal fields of the `[text]`, `[url]`, `[email]`, `[date]`, `[monthYear]` and `[phone]` types and the built-in `username`, `url` and `notesPlain`. Every value source is refused and points to [`safety_secret_store`](#secret-store-tool): stdin (`-`, a pipe, an input redirect, a here-document or here-string, or stdin a `sh -c` script, a here-document script or `fnox exec` passes down), a `--template` file, and any expanded word (`"credential=$TOKEN"`, `--vault "$V"`). A literal for an untyped field, `[password]`, `[concealed]`, `password` or `credential`, a literal here-document or here-string, or a pipe whose feeding stage writes a literal (`echo`, `printf`, `jq --arg` with a literal value, `cat` of a literal here-document) gets the literal-secret message. `--reveal` is refused. |
| `op-guard` (fnox) | `fnox get`, `fnox export`, `fnox env`, `fnox list --values` (`-V`), and `fnox exec` running `env`, `printenv`, `export -p`, a bare `set` or `declare -x`. They print secret values into the transcript. Also `fnox set` with a value, for every provider: stdin (a pipe, redirect, here-document or here-string, or stdin a script or `fnox exec` passes down), a `-` value, an expanded value or `--default`, a process substitution, `--generate` or `--from-file`. The refusal points to [`safety_secret_store`](#secret-store-tool). The reference form passes: `fnox set NAME '<item>/<field>' --provider <op-provider>`, a literal with no expansion. So does `fnox set NAME` with no value, which prompts the user. The provider type still picks the message, and a literal value or `--default` for a value-store provider is refused as a literal secret. A provider counts as a store only when every definition marks it as one. The guard reads every fnox config file on the path from the call's directory to the filesystem root (`fnox.toml`, `.fnox.toml`, their `.local` and profile files, all profiles whether active or not, and a `root = true` does not stop the search) plus `~/.config/fnox/config.toml`. A provider's name never counts. It is not a store when any definition has another type or none, no definition exists, a file does not parse or uses `import`, `-c`/`--config` names an expanded path, a missing or unparsable file, a file with `import`, or more than one file, or the command could change the directory fnox runs in (`cd`, `pushd`, `popd`, `env -C`, `sudo -D`, `chroot`, a `-C`/`--chdir`/`--directory`-style flag, or a command name made of an expansion); only a command with no directory change uses the call's directory. A literal `-c <file>` (not one of the searched names `fnox.toml`, `fnox.local.toml` and the like, which resolve as above) is read together with the global config, and every definition in those two must be a store. The executor and config-write rules run on the top-level command and on everything `fnox exec` or `sh -c` runs, with the same pipe, redirect and write-target analysis. `-P`/`--profile` and `FNOX_PROFILE` change nothing, since every profile is already read. 

## Subagent prompts and skill references

A permission prompt in a subagent session (any session with a parent) can wait for an answer that
never comes, and the tool call then blocks with no error. The `subagent-prompts` check turns every ask
left in such a session into a deny with a message the subagent can act on, for example:

```text
external_directory denied for /elsewhere/*: subagent sessions cannot answer permission prompts; work inside /worktrees/lane or ask the parent to copy the file in.
```

A root session keeps its prompt. A session that the plugin cannot look up keeps it too. The reason an
earlier hook gave for asking follows the denial. Turn the check off with `{ "disable": ["subagent-prompts"] }`.

The `subagent-external-reads` check runs before `subagent-prompts`. In a subagent session it turns an
`external_directory` ask into an allow when the tool is `read`, `glob`, `grep`, `list` or the shell: an agent
with a shell can `cat` the path anyway, so the deny protected nothing. `edit`, `write` and `patch` keep the
ask (so they are denied outside the session directory). Secret locations keep the ask for every tool, so
a subagent is denied there: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/op`, `~/.config/gh/hosts.yml`,
`~/.netrc`, `~/.docker/config.json`, `~/.kube`, `~/.local/share/opencode/auth.json` (the exported
`SECRET_LOCATIONS`) and any `*.env` or `*.env.*` path. Paths resolve through symlinks, so a link into
`~/.ssh` counts. A request the check cannot judge (a relative path, a wildcard in the middle, `..`) keeps
the ask. Add locations with `{ "subagentSecretPaths": ["~/.config/secret-tool"] }`. Turn the check off
with `{ "disable": ["subagent-external-reads"] }`.

The `root-external-reads` check covers a root session, and only for `read` of one named file: the path the
tool was given must be absolute, resolve to a regular file and not be a secret (the same rules, including
symlinks and `subagentSecretPaths`). `glob`, `grep` and `list` keep the prompt, because a folder can hold an
`.env` or a link to a secret that a check on the folder cannot see. The shell and the writers keep it too,
and so does a session that cannot be looked up. Turn the check off with `{ "disable": ["root-external-reads"] }`.

The `scratchDirs` check also allows direct file tools in the session's own directory (and its repository
root) when the request reaches it through a symlink alias, such as `/home/u` for `/local/home/u`, and in
`<data>/opencode/shell/<project id>` and `<data>/opencode/tool-output`, where OpenCode writes truncated
output.

The `skill-references` check allows the read-only tools (`read`, `glob`, `grep`, `list`) without an
`external_directory` prompt. It applies inside the directory of each skill the host lists, such as an
installed plugin's skill in the plugin cache. Writes, shell commands and other paths in the cache still
ask, or fail at once in a subagent. Turn it off with `{ "disable": ["skill-references"] }`.

The check compares real paths, with symlinks resolved, and ignores a skill when:

- its directory is the filesystem root, the home folder or a parent of it, or links to one of them.
- its directory or the home folder does not resolve.

Three more checks turn an `external_directory` ask into an allow. Each applies to an `ask` only, never
overrides a deny, behaves the same in root and subagent sessions, and runs before `subagent-prompts`:

| Id | Allows |
| --- | --- |
| `steering-dirs` | `read`, `glob`, `grep` and `list` inside the `steeringDirs` option (default `["~/.config/opencode/steering"]`; a list replaces the default). Each directory is resolved with realpath and must exist, hold no symlink component and belong to the current user. A symlink inside that leaves the directory still asks. |
| `scratch-shell` | The `shell` tool when every parsed `external_directory` resource of the evaluation lies in a pinned scratch root (the OpenCode temp folder, the project's worktree folder). It only waives that ask. It does not confine the process: a command run there can still read or write elsewhere, as any allowed shell can from its own directory. One resource outside the roots, such as a `git -C`, `make -C` or `--prefix` directory, keeps the ask, and an empty resource list is never auto-approved. Part of the `scratchDirs` check: `scratchDirs: false` turns it off too. |
| `repo-worktrees` | `read`, `glob`, `grep` and `list` inside the worktrees of the session's own repository. The list comes from `git worktree list --porcelain -z` (run with the shared safe-git flags, a 3 s timeout, the supervised-subprocess wait, and the repository-selecting `GIT_*` variables cleared). A listed path counts only if the disk agrees: the main worktree's `.git` is the repository's common directory; a linked worktree's `.git` file names `<common-dir>/worktrees/<name>` and that directory's `gitdir` file names the worktree's `.git` back. The root must be a real path owned by the current user. Roots are cached 30 s per directory with their device and inode; each use re-checks them, and a root that became a symlink or another directory drops the entry and keeps the ask. Concurrent lookups share one git run. Paths are canonicalised, so a symlink out of a worktree still asks. No writes, no shell. |

Turn each off with `{ "disable": ["steering-dirs"] }`, `["scratch-shell"]` or `["repo-worktrees"]`.

These checks run in this plugin's `permission.hook("evaluate")` in plugin order. A plugin loaded after
`safety` can still turn an allow into a prompt. As a backstop, the plugin watches each
`permission.asked` event in its location. When the session has a parent, it rejects the request at
once through the permission reply API, with the same message.

Each location loads its own copy of the plugin, so a subagent in another worktree's location is
covered by that location's copy. A location that does not load `safety` has no backstop. A failed
session lookup keeps the prompt and logs a warning with the session ID.

The allow-list trusts every skill the host lists: a `SKILL.md` at a repository root opens reads of
that whole repository.

## Secret-store tool

The op-guard refuses every shell command that carries a secret value into `op item create|edit` or
`fnox set`, and points to the `safety_secret_store` tool instead. That tool ships in the
[secret-store](https://github.com/srobroek/harness-plugins/tree/main/plugins/secret-store) plugin, so
install it next to safety. Without it, a refusal names a tool the session does not have. On pi, the
start-up check of this package names `@srobroek/pi-secret-store` while it is not installed.

## pi

`pi/extensions/safety.js`, built from `pi-src/safety.ts`, runs these checks on pi with the modules
in `shared/`, which the OpenCode plugin also uses. It runs after
[cc-safety-net](https://github.com/kenryu42/cc-safety-net) 2.8.2, which blocks generic destructive
commands and secret paths, and adds the checks cc-safety-net cannot express.

Where the two overlap, both stay on. When both block a call, the first block wins and nothing breaks.
A guard here stays on when cc-safety-net 2.8.2, at its default `standard` level, let a case of that
guard's test corpus through. Measured against each corpus:

- `indirection`: cc-safety-net let 24 of 29 through.
- `remote-exec`: 2 of 11.
- `force-push`: 1 of 7.
- `sudo-destructive`: 2 of 2.

### Load order

pi runs `tool_call` handlers in extension load order, and the first block wins. Put cc-safety-net
first in `packages` in `~/.pi/agent/settings.json`, and load this extension after it:

```json
{
  "packages": ["npm:cc-safety-net@2.8.2"]
}
```

cc-safety-net then sees each command before the close-keyword rewrite, and its blocks win over this
extension's asks.

### What each one covers

| Command or data | cc-safety-net 2.8.2 | This extension |
| --- | --- | --- |
| `rm -rf` on root, home, the working directory or outside it, `find -delete`, `xargs`/`parallel rm -rf`, `dd`/`mkfs` on a device, `shred` | Blocks | None |
| A destructive command on an unexpanded variable or substitution (`rm -rf "$TARGET"`) | Blocks only at the `strict` level | Blocks (`indirection`) |
| A download piped into a shell (`curl … \| sh`) | Blocks | Blocks (`remote-exec`) |
| A netcat exec flag (`nc -e`, `ncat --exec`) | None | Blocks (`remote-exec`) |
| A force push without `--force-with-lease` | Blocks | Blocks (`force-push`) |
| Mirror push, `push --delete` | Blocks | None |
| Destructive commands under `sudo` | Unwraps `sudo` and applies its rules; `sudo chmod -R` and a temp-path `sudo rm -rf` pass | Asks (`sudo-destructive`) |
| Secret files (`.env`, `~/.ssh`, `~/.aws`, CLI credentials), from the shell and the file tools | Blocks | None |
| `git checkout`/`restore`/`switch` discards, `rebase --abort`, `merge --abort`, `tag -d`, `reflog delete` | Blocks | None |
| Branch force-delete, forced worktree removal, `reset --hard`, `stash drop`, `stash clear`, `clean -f` | Blocks outright, until the six rules below are off | Asks with what git shows would be lost, or passes when git proves nothing is lost |
| `git reflog expire`, `wt remove --force` | None | Asks the same way |
| AI attribution in a commit message | None | Blocks (`attribution`) |
| A worktree under `/tmp` | None | Blocks (`worktree-tmp`) |
| History rewrites in place | None | Blocks (`history-rewrite`) |
| Direct `op` calls and value-carrying `fnox` commands | None | Blocks (`op-guard`) |
| A plain `git push` to a host that needs a wrapper | None | Blocks when `pushVia` is set (`push-via`) |
| A write to a shipped migration through `edit`, `write` or a shell redirect | None | Blocks (`migration-edit`) |
| A directory flag outside the session (`git -C`, `--prefix`, …) | None | Asks (`external-directory`) |
| A close-keyword list in `gh pr create\|edit --body` | None | Rewrites it in `event.input.command` (`close-keywords`) |
| A package add or install | None | Appends the vetting advisory to the result (`package-investigate`) |
| Secret environment values in any tool result | None | Redacts them in `tool_result` |
| A redirect, `tee`, `cp`, `sed -i` or `truncate` write to `~/.zshrc`, `~/.bashrc`, `~/.profile`, `~/.zprofile` or `~/.bash_profile`, also inside `bash -c` | None | Blocks (`shell-profile`); reads pass, and a profile chezmoi manages (`chezmoi source-path` exits 0) is left to the chezmoi guard |
| A recursive `chmod`, `chown` or `chgrp` without `sudo` on `/`, `/Users`, `/Volumes` or anything under `/System`, `/Library`, `/usr` (including `/usr/local`), `/bin`, `/sbin`, `/etc`, `/opt`, `/Applications`, `/var`, `/private` or `/cores`, outside the temp folders | Blocks only the literal top-level directories, through a local rulebook | Blocks (`system-permissions`) |
| A fork bomb: a function that starts itself through a pipe, or twice with one in the background | Blocks only at the `strict` level | Blocks (`fork-bomb`) |
| A `tee`, `dd of=`, `cp` or redirect write to `/dev/diskN` or `/dev/rdiskN` | Blocks `dd` and redirects | Blocks (`disk-write`) |
| `halt`, `reboot` and `poweroff`, with or without arguments | None | Blocks (`power`) |

### Asks

When a check asks, pi opens `ctx.ui.confirm` with the evidence, and declining blocks the call. Some
sessions cannot show a dialog (`ctx.hasUI` is false):

- print mode
- JSON mode
- a child session without a UI

There the call is blocked with the reason instead.

A check that fails internally lets the call through, as on OpenCode, with two exceptions. The
op-guard refuses. A destruction review that fails asks, because pi has no permission rules to defer
to.

### Hand the six asks to this extension

While cc-safety-net blocks these commands, its block wins and the evidence-based ask never runs. Turn
the six rules off in the cc-safety-net user policy, `~/.cc-safety-net/policy.json` (or
`$CC_SAFETY_NET_HOME/policy.json`). Merge the `overrides` into an existing policy:

```json
{
  "version": 1,
  "destructive_command_protection": {
    "overrides": {
      "git.branch-force-delete": "off",
      "git.stash-drop": "off",
      "git.stash-clear": "off",
      "git.worktree-remove-force": "off",
      "git.reset-hard": "off",
      "git.clean-force": "off"
    }
  }
}
```

`npx -y cc-safety-net@2.8.2 status` shows the policy cc-safety-net enforces.

### Options on pi

pi passes no options to an extension, so this one reads `safety.json` in pi's agent directory
(`~/.pi/agent/safety.json`, or the same file under `PI_CODING_AGENT_DIR`). It takes the OpenCode keys
that apply on pi:

```json
{
  "disable": ["package-investigate"],
  "opAllow": ["vault list"],
  "pushVia": { "host": "github.com", "command": "git-wrapper" },
  "redactSecrets": true,
  "redactNames": [],
  "redactExclude": []
}
```

`disable` takes these ids:

- every hard-gate id in [Hard gates](#hard-gates)
- `shell-profile`, `system-permissions`, `fork-bomb`, `disk-write` and `power`
- `force-push`, `sudo-destructive` and `worktree-destruction`
- `migration-edit` and `external-directory`
- `close-keywords` and `package-investigate`

Without the file, every check runs and `push-via` is off. An unreadable or malformed file gives the
same defaults and a warning at session start.

pi has no `external_directory` permission, so the OpenCode features that tune it have no pi
counterpart. Their ids are not accepted on pi:

- `scratch-shell`, `steering-dirs` and `skill-references`
- `repo-worktrees`, `subagent-external-reads` and `root-external-reads`
- `subagent-prompts`

### Subagent children

pi-subagents' foreground children load no ambient extensions, so a child runs without cc-safety-net
and without this extension unless both are listed as required child extensions. Hosts register those
through an API ([Required host extensions](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md#required-host-extensions));
as a user, list them in the pi-subagents setting `subagents.defaultSubagentOnlyExtensions` in
`~/.pi/agent/settings.json`, by absolute path:

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": [
      "/Users/me/.pi/agent/npm/node_modules/cc-safety-net/dist/pi/index.js",
      "/Users/me/src/harness-plugins/plugins/safety/pi/extensions/safety.js"
    ]
  }
}
```

An agent whose frontmatter sets its own `subagentOnlyExtensions` replaces this default, so it must
list both files itself.

## Limits

If the permission review itself fails (an unexpected exception, not a handled probe timeout), safety
makes no decision for that command, logs the error as a warning and leaves the host's permission rules in
charge: a configured `deny` or `ask` still applies, and an `allow` stays an allow. It no longer forces a
prompt, which a subagent cannot answer. A probe timeout that the review handles itself
(for example in the destruction review) still produces its own ask. Hard gates are separate and unchanged.

The guard catches honest mistakes in the common forms of a command and refuses the forms it cannot
follow. It is not a sandbox against a command built to evade it. For that reason it refuses every
value-carrying `op item create|edit` and `fnox set` from the shell. The
[`safety_secret_store`](#secret-store-tool) tool does that work without a shell.
