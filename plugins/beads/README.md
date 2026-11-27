# beads

[Beads](https://github.com/steveyegge/beads) (`bd`) issue tracking for OpenCode V2.
Ported from the Oh My Pi `beads` plugin in
[omp-plugins](https://github.com/srobroek/omp-plugins).

## What it does

On every `shell` call (`tool.hook("execute.before")`), in this order, with one
25-second budget for the whole call:

1. Binary Git hooks: `bd hooks install` is refused and `bd init` gains
   `--skip-hooks` when an existing hook is a binary executable.
2. Gate admission: a mutating `bd` command waits for its store's automatic gates
   to be verified (`bd gate list`, plus `bd gate check` when one could resolve).
3. An unparseable command is refused.
4. `bd edit` is refused: it opens `$EDITOR` and hangs the session.
5. `bd update --status closed|done` is refused in favour of `bd close --reason`.
6. `bd close` on a gate bead is refused (looked up with `bd show`).
7. `bd unclaim` without `--if-assignee` is refused.
8. A subagent command that clears or blanks the injected actor gets an advisory in the
   tool result. A main session chooses its own actor and gets none.
9. The plugin refuses a `bd` write (any verb the write lock treats as one, such as `bd create` or `bd heartbeat`) when the ledger belongs to a different git repository
   than the command's directory. Reads, `bd init` and `bd bootstrap` pass. So does a command
   that assigns `BEADS_DIR=` itself (`BEADS_DIR=/path bd create ...` or an earlier
   `export BEADS_DIR=...`), and so does the project's `options.store`. A `BEADS_DIR`
   that only arrives through the environment is not a choice. One example is a variable
   inherited from the shell that started a shared OpenCode server. `-C`, `--db`,
   `--database` and `--global` name their own target and pass. The Claude Code hook has
   no `options.store`, so a ledger in another repository needs the literal `BEADS_DIR=`
   there. A `bd` the gate cannot place (behind `exec`, `env`, `xargs`, a shell string or a
   substitution, quoted or not) is refused too while the default ledger is foreign, because it
   may be a write. The same holds for a command that defines an `alias` or a shell function.
   It also holds for a command name spelled with quotes or a backslash (`"b"d`, `\bd`).
   Run each `bd` as its own simple command. The `bd-embedded-write-lock` gate controls this check. An unquoted `bd` operand of any
   other command counts as a launch, so the write lock fails closed on `flock X bd create`.
   A quoted `'bd'` operand names it and passes: `git diff -- 'bd'`.

   Threat model: this gate stops a ledger inherited by accident, such as a `BEADS_DIR`
   that leaked from the shell that started the server. It does not stop deliberate shell
   obfuscation. Out of scope are `eval`, indirect expansion, sourced scripts, aliases
   defined outside the command and unknown wrapper binaries. The real fix is a clean
   server environment.
   Under a foreign ledger, a `bd` that follows a recognised wrapper (`flock`, `taskset`,
   `timeout`, `sudo`, `xargs` and the like) is refused without parsing the wrapper's
   arguments. A literal `BEADS_DIR=<path>` on the command line is the override.
10. `gh pr create` without a `Bead:`, `Closes-Bead:` or `Bead-Id:` trailer is
   refused in a repository with a live ledger that you can write to. The gate does not
   decode shell: it reads one exact form (`gh pr create` or `gh pr new` alone, with one
   `--body` or a relative regular `--body-file`) and refuses any other command that may
   reach `gh pr create`, such as a chain, a wrapper, `env -S`, a `$'...'` word, a short-flag
   cluster, `--fill`, or an alias. The refusal prints the accepted form.
11. Each `bd` write to an embedded store is rewritten to run under
    `bd-embedded-write-runner`, which holds the store's write lock for exactly the
    life of the `bd` process. The lock files are shared with the omp plugin.
12. Every shell call of a subagent session starts with
    `unset BEADS_ACTOR; export BD_ACTOR='opencode/<root-session>/<agent>/<session>'`.
    A main session gets no prefix. The prefix is fixed text, not a parse of the command:
    anything the command sets later wins through shell order and bd's precedence
    (`--actor`, then `BEADS_ACTOR`, then `BD_ACTOR`). The actor gate only warns when a
    command ends with no actor. Claim tooling should match an actor on its final
    `/`-separated segment, the session id; the root session and agent name are context.

A refusal is thrown, so the model sees it as the tool error.

`shell.hook("create.before")` sets `BEADS_DIR` (the checkout's `.beads`, or the
primary checkout's from a linked worktree) and clears `BEADS_DOLT_SHARED_SERVER`
in the child environment. An explicitly set `BEADS_DIR` is left alone, and it is the default ledger for
claim tracking: a plain claim is tracked under that store (see Claim tracking).
The pin also sets `HARNESS_BEADS_PIN` to the same path. A process can inherit a pinned
shell's environment, for example an OpenCode server restarted from that shell. When the
two variables match, the plugin drops the inherited pin and pins each session to its own
checkout's store. A `BEADS_DIR` that the user sets in a pinned shell differs from the
marker, so the plugin keeps it. To select the marker's own path on purpose, clear the
marker as well: `unset HARNESS_BEADS_PIN; export BEADS_DIR=/path/.beads`. With
`beads-dir-pin` off, the hook still drops an inherited pin but sets no new one. Sessions
started before the upgrade keep the old marker until restarted.

Every gate judges a `bd` write at the store the write lock runs it in. The lock's
planner follows what the command does before the write:

- a `cd`
- an `export BEADS_DIR=...` or `unset BEADS_DIR`
- a command-local `BEADS_DIR=`

Gate admission, the close gate's `bd show` lookup and the write lock share one
resolution of that target, by the store's real path. The runner checks every write's
store path again just before `bd` starts.

The gates refuse these writes:

- A write whose store the shell chooses at run time, such as after
  `export BEADS_DIR=$X`, even when no ledger is in reach.
- A write after an `export`, `unset` or `BEADS_DIR=` that may not run: behind `&&` or
  `||`, or inside `if`, `case` or a loop.
- A write that the gates cannot read, such as inside `$(...)`, while a ledger is in reach.
- A write whose store changed between the check and the run: a link that moved, or a
  directory replaced by a link to another store. The runner also stops when the store no
  longer resolves. It stops before `bd` starts, and the command needs a second run.

The gates still let reads through in these cases.

`tool.hook("execute.after")` records successful claims per session in plugin
storage, confirming each claim from the claim command's own `--json` output (a claim
bd does not confirm that way is not tracked, with a warning), and
appends the contention-retry and stale-import advisories.

`session.hook("context")` adds `bd prime` to the system prompt. The text is read
once and frozen per session, so the prompt stays cacheable. A root session's frozen
text also carries its session-start advisories, once: a binary Git hook that Beads
modified, the verdict a detached `bd dolt push` left in `.beads/last-push.log`
(consumed when read), and an inherited `BEADS_DIR` that points at another
repository's store.

Only mutating `bd` commands wait for gate admission. A `subagent` spawn, a shell command
that writes no bd store, and every read or edit pass without waiting on the ledger.

## Session lifecycle

The plugin follows `session.execution.*` events (`ctx.event.subscribe`). Every
message it sends is a `session.synthetic` with `metadata.source: "srobroek.beads"`.

- **Claim tracking.** The plugin tracks a claim only when it knows the ledger and the outcome.
  It resolves the ledger once, in bd 1.3.1's order for store commands such as `bd update` and
  `bd create`: `--db`, then `BEADS_DIR`, then the `.beads` found from the directory (the session
  pin), then `BEADS_DB` only when no `.beads` is found. A `BEADS_DB` that is a `.beads` directory
  names that store; any other value, such as a database file, selects the directory that holds
  it. The plugin pins `BEADS_DIR` to the resolved store on its shells and its own `bd` calls, so
  a later change to `BEADS_DB` cannot move a claim. Commands that skip bd's store init
  (`bd where`, `bd dolt set`, `bd init`) use another order: `--db`, then `BEADS_DB`, then
  `BD_DB`, then `BEADS_DIR`. The embedded write lock refuses such a write when `BEADS_DB` or
  `BD_DB` is set or appears in the command, unless `--db` names the store. An inherited
  `BD_DB`, `BD_SOCKET` or `BEADS_DOLT_*`/`BEADS_PROXIED_SERVER_*` variable leaves the claim
  untracked, because bd's store commands do not read `BD_DB` as a store path and the others
  name a server. A command that overrides it is not tracked: a ledger selector anywhere
  in it (a word starting `-C`, `--db`, `--database`, `--directory`, `--global` or `--dolt-`),
  or a `BEADS_*`/`BD_*` assignment other than the actor. The one exception is an inline
  assignment of a ledger variable to the plugin's own value, compared as canonical paths
  (symlinks resolved, trailing slash ignored). The invocation must be one plain `bd` command (no
  `;`, `&&`, `||`, pipe, subshell, substitution, wrapper, embedded-write runner, quoted
  assignment, background job or shell-computed word), and bd's own `--json` output must show the
  claimed bead `in_progress` under an actor that invocation could have used. The plugin adds
  `--json` to such a claim itself and says so, so the result is bd's JSON rather than a status
  line. Any other claim is not tracked: no stop nudge, no release, no heartbeat, and the result
  carries a one-line warning (variable names only, never values). Run the claim as its own simple
  command to have it tracked. A missed heartbeat is the safe failure; a release of the wrong
  ledger or actor is not. An assignment (`bd assign`, `--assignee`) never starts tracking a claim.
- **Stop nudge.** When a root session's execution succeeds while it holds tracked
  claims, it gets one queued message listing each claim with its guarded release
  command, and resumes. A real user prompt (`session.hook("prompt")`, not one from
  this plugin or OpenCode's built-in goal) re-arms the nudge. Nothing happens when the
  execution failed or was interrupted. While the built-in goal is active (the
  `opencode.goal` RPC's `get`) the stop is deferred: the nudge runs when the goal ends
  (`rpc.opencode.goal.changed`), unless a new execution starts first.
- **Release.** When the nudged session stops again still holding claims, they are
  released in the background (at most 120 s): `bd show`, then
  `bd unclaim <id> --if-assignee <holder>`, then, for a parked claim,
  `bd update <id> --status blocked|deferred --if-status open --if-assignee ''`. A claim
  bd no longer shows as the holder's is forgotten without a write. The session gets a
  message, without resuming, naming what was released and what could not be verified.
- **Subagents.** A subagent's claims are released when it ends successfully or its
  session is deleted. A failed or interrupted subagent keeps them so it can be resumed.
  For a foreground `subagent` call the release runs in the
  parent's `execute.after` (at most 25 s) and its report is appended to the tool
  result. For a background call the child's end triggers the release, and the parent
  gets the report as a message that does not wake it. The release also asks bd what the
  subagent still holds: `bd list --assignee <its actor> --status in_progress --json` in
  each store its shell calls ran against. A bead listed there joins the tracked claims, so
  a claim made inside a function, script or pipeline is released too. A list that fails is
  reported in the release message.
- **Lease heartbeat.** Each tracked claim with a known actor and store is renewed with
  `bd heartbeat <id> --json` every 60 s while its session executes, under the
  embedded write lock. Timers pause when an execution ends and resume (renewing at
  once) when the next starts, so an idle session lets its leases lapse. A close, an
  unclaim, a status other than `in_progress`, or `session.deleted` ends the lease. A
  failed heartbeat ends it and tells the session once. Leases live in plugin storage
  (`leases/<sessionID>`); timers are process-wide, so two plugin instances never renew
  one lease twice, and each instance clears its own on cleanup.
- **Fork notice.** On OpenCode 2.3.0 and later, the experimental `session.fork` hook
  tells a forked session which beads the original holds (at most 10, then "and N more"),
  so it does not assume them. The fork inherits no claims; the original's claims and
  leases are left alone. With no claims nothing is sent, and a host without the hook is
  unaffected. Gated by `beads-session-advisories`.

## Skills

Only `beads-guide` is listed to the model in OpenCode: it is a router whose body maps each
situation to the other beads skills, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short.

Registered through `ctx.skill.transform` from `skills/` (a user skill of the same
name wins): `beads-ledger`, `beads-evidence`, `beads-setup`,
`beads-contention-retry` and `beads-preflight` (a read-only `preflight.py`). They are
not exported to the Claude Code marketplaces, because they describe this
plugin's write lock and prime context.

## Options

Every gate is on by default. Switch one off in the plugin options:

```json
{ "gates": { "pr-bead-link-gate": { "enabled": false } } }
```

Gates: `beads-gate-admission`, `binary-git-hooks`, `bd-update-close-gate`,
`bd-close-gate`, `bd-unclaim-gate`, `bd-actor-gate`, `pr-bead-link-gate`,
`bd-embedded-write-lock`, `bd-editor-gate`, `beads-dir-pin`, `beads-prime`,
`beads-claim-tracking`, `beads-stop-nudge` (also the root-session release that
follows it), `beads-claim-release`, `bd-lease-heartbeat`, `beads-session-advisories`,
`beads-skills`. The lifecycle and the heartbeat read the claims that
`beads-claim-tracking` records.

### Busy-ledger wait

An embedded-store write that finds the write lock held waits for its turn, polling
with exponential backoff and jitter, for `embeddedWriteWaitMs` (default `30000`)
before it is refused. The refusal says the ledger is busy and to retry the command
as its own simple command; it only advises removing the lock when the holder is gone.

```json
{ "embeddedWriteWaitMs": 60000 }
```

## Process-global state

Some state lives on `globalThis` so every instance of the plugin in one process shares
it: the lifecycle (`srobroek.beads.lifecycle`), the heartbeat timers
(`srobroek.beads.heartbeats`) and the embedded write lock
(`com.srobroek.beads.embedded-write-lock.v1`). After a plugin update an older instance
can still be loaded, and it may have created that object before the new version
existed. The rules:

- The object must stay compatible across plugin versions in one process. Read it
  as possibly old-shaped.
- A new field needs a backfill (`state.field ??= ...`) in the accessor, on the
  existing object. Never replace the object, and never assume it has the new field.
- A new field needs a test that pre-seeds `globalThis` with the old shape, runs the
  new code and checks that nothing throws.
- A lock key never changes and is never versioned. Two versions that used two keys
  would each hold the same store, and embedded-store writes would stop being serialised.

## Permissions

OpenCode evaluates shell permissions on the rewritten command. A write that runs
under the lock runner starts with `BEADS_DOLT_SHARED_SERVER= BEADS_DIR=... '<bun>'
'<plugin>/dist/bd-embedded-write-runner.js' ... -- bd ...`, so a rule that allows
`bd *` does not cover it. Add a rule for the runner if your shell permission is
not `allow`.

## Requirements

`bd` and `bun` on `PATH` (or `BUN_INSTALL`, or mise). The runner is a Bun script.

## Subagent routing (FO-5)

When the location has a store, a second `execute.before` hook checks each new
`subagent` call against delivery rule FO-5:

1. It finds bead ids in the prompt. Ids that start with the ledger prefix (the
   name of the store's repository directory) win. If there are none, a token
   counts when its hash part contains a digit or it has a `.N` child suffix.
   At most 8 ids are read.
2. It reads them in one `bd show <ids> --json`, with a 3-second limit.
3. If a named bead sets `metadata.execution_agent_type` and the spawn's agent
   matches none of them, the call is refused. The refusal names each bead's agent
   and its `execution_reasoning_effort`. A namespaced agent (`delivery:implementer`)
   matches `implementer`. A bead typed `implementer` or `implementer-high` also
   accepts `coder`, because `implementer` cannot work in lane worktrees.
4. A spawn to `implementer-high` that no named bead asks for goes ahead, with an
   advisory appended to the result: use `implementer` unless the brief states an
   implementer-high criterion.

Orchestrator spawns are exempt, because an orchestrator names the many beads it
will delegate: a spawn to the `general` agent, or with tier `orchestrate` (or the
legacy `role: "orchestrate"`), skips the check and the bead lookup. Review spawns
are exempt too, because a reviewer reads a bead's change rather than executing the
bead: a spawn to `code-reviewer`, `security-auditor` or `security-reviewer`
(namespaced or not) skips the check. Every other spawn is judged as above. To switch the gate off for all spawns, set
`{ "gates": { "bead-agent-routing": { "enabled": false } } }`.

A resumed call (with `sessionID`), a prompt with no ids, a failed or slow `bd`
read, and a location without a store are all allowed. Gate name:
`bead-agent-routing`.

## Install
Install the Pi package from npm:

```sh
pi install npm:@srobroek/pi-beads-enforcer
```

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/beads/opencode'
```

## Claude Code

The plugin is also in this repository's Claude Code marketplace. Install it with these
two commands:

```text
/plugin marketplace add srobroek/harness-plugins
/plugin install beads@harness-plugins
```

It ships the skills and the two hooks in `hooks/claude-hooks.json`. Both hooks run
`bun dist/claude-hook.js`:

- `SessionStart` adds `bd prime` and the session-start advisories as context, within
  Claude Code's 10,000-character limit. It runs on startup, resume, clear and compact.
  It also writes the store pin to `CLAUDE_ENV_FILE`: `BEADS_DIR` with its
  `HARNESS_BEADS_PIN` marker, and an empty `BEADS_DOLT_SHARED_SERVER`. It drops an
  inherited pin first, so `bd prime`, the advisories and the pin share one store. In a
  directory without a store, it writes `unset BEADS_DIR HARNESS_BEADS_PIN`, so Bash
  leaves the inherited ledger too.
- `PreToolUse` on `Bash` runs the shell gates above, with every gate on. It skips a
  command that names none of `bd`, `git` and `gh`. A refusal denies the call. A rewrite replaces
  `command`. An advisory becomes context. Every Bash command of a subagent, gated or not,
  starts with
  `unset BEADS_ACTOR; export BD_ACTOR='claude/<session>/<agent type>/<agent id>';`, so a script
  it runs writes under that actor. A main session gets no injected actor and writes under the
  actor its own environment or command chooses.

These parts stay OpenCode-only:

- claim tracking and lease heartbeats
- the stop nudge and guarded claim release
- subagent routing
- plugin options

Without `bun`, session start falls back to `bd prime` and no gate runs. A hook that fails
exits 0, so Claude Code carries on without it.

## pi

`pi/extensions/beads.js` (source `pi-src/beads.ts`) is a pi extension. It runs the shell gates
above on every `bash` call with every gate on, and it adds three pi-only gates and the
`beads_preflight` tool. It injects no context: install
[`npm:pi-beads-companion`](https://www.npmjs.com/package/pi-beads-companion) beside it for
`bd prime` and the selected issue.

A refusal blocks the call with `<cause>; <fix>. (beads gate <name>)`. A call that passes
gets two prefixes:

- The store pin: `export` lines for `BEADS_DIR`, its `HARNESS_BEADS_PIN` marker and an empty
- The actor: `unset BEADS_ACTOR; export BD_ACTOR='pi/<root session>/.../<this session>';`.

Every pi session gets its own actor, the interactive root session included. pi runs a
foreground subagent inside the parent's process. The process environment therefore cannot
tell the child's writes from the parent's, but each session's `parentSession` header can. The
actor lists the session ids from the root down. A `--actor` flag or `BEADS_ACTOR=` in the
command still wins. An embedded-store write runs under `bd-embedded-write-runner.js` beside
the extension, which needs `bun` on `PATH`.

### Gates only pi has

The OpenCode plugin and the Claude Code hook do not run these three gates.

1. `bd-claim-gate`: these commands need each bead they name to be `in_progress` under this
   session's actor or under a descendant's:

   - `bd close` and `bd done`
   - `bd update` without `--claim`
   - `bd comment` and `bd comments add`

   `pi/<root>/<child>` descends from `pi/<root>`. A parent can therefore close the bead its
   child claimed, but the child cannot close the parent's. Name the ids as literal words. The
   gate reads the claim with `bd show --json` from the store the write lands in. It refuses
   the command when bd cannot answer.

   To reopen a blocked bead you still own, use this exact form with the full ID and your literal actor:
   `bd update FULL_ID --status open --if-status blocked --if-assignee ACTOR`.
   Both guards must still match when `bd` writes. Claim the open bead before doing more work.
2. `bd-close-evidence-gate`: a close needs `--reason` (or `-r`, or a readable `--reason-file`)
   that names checkable evidence, as `rule://beads-evidence` asks. The gate accepts any of
   these:

   - a backticked command, or a tool command such as `bun test x.test.ts` (a git command
     counts when it names git, or a wrapper listed in `gitWrappers`)
   - a path or a file name
   - a commit SHA, a PR or issue reference, or a URL
   - a test count or an exit code

   A reason such as `done` or `N/A` fails this gate.

   pi passes no options to an extension. This gate reads `gitWrappers`, the only beads option on
   pi, from the `beads` key of pi's user settings, `~/.pi/agent/settings.json` (or
   `settings.json` under `PI_CODING_AGENT_DIR`), for example
   `{ "beads": { "gitWrappers": ["git", "<wrapper>"] } }`. The gate ignores a project's
   `.pi/settings.json`, so a repository cannot widen what counts as evidence. The default is
   `["git"]` and a list replaces it. A `beads` value that is not an object leaves only `git` and
   warns at session start. So does a `settings.json` that is unreadable or not valid JSON.
3. `write-claim-gate`: in a pi-subagents child, `edit` and `write` need a claim. The rule
   covers a file in a checkout with a Beads store: the child must hold at least one
   `in_progress` claim in that store. The gate asks
   `bd list --assignee <actor> --status in_progress`. A confirmed claim counts for 30 seconds,
   and the gate asks again after any `bd` write. The gate leaves the interactive root session
   and its `/fork` or `/clone` copies alone. A session counts as a child in two cases:

   - it runs in a detached pi-subagents runner (`PI_SUBAGENT_CHILD=1`)
   - its session file sits under its parent's pi-subagents session directory.

### `beads_preflight`

The tool runs the checks of the `beads-preflight` skill and returns its JSON report:
`{ ok, summary, checks: [{ id, status, detail, fix }] }`. Its parameters follow the script's
flags: `only` (a list of check ids), `include_slow`, `timeout` (seconds) and `apply`. The
checks see what the session's `bash` calls see, including its store pin and actor. The logic
is `shared/preflight.ts`, a port of `preflight.py`. OpenCode and Claude Code still run the
Python script, so a change to either copy must reach the other.

### Subagents

A foreground pi-subagents child loads none of the parent's extensions. List this extension
for every child in pi's `settings.json` (user `~/.pi/agent/settings.json` or the project's
`.pi/settings.json`):

```json
{
  "subagents": {
    "defaultSubagentOnlyExtensions": ["/absolute/path/to/beads/pi/extensions/beads.js"]
  }
}
```

An agent whose frontmatter sets `subagentOnlyExtensions` replaces this default, so add the
path to that list as well. A background child can load the extension twice, through ambient
discovery and through this list. In that case the second copy skips any call that the first
copy already gated. See the `extensions` and `subagentOnlyExtensions` fields in the
[pi-subagents agent docs](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md).

#### Verify a tracked foreground handoff

For work assigned to a bead, call one native Pi `subagent` with `async: false`. Start its `task` with `Bead: FULL_ID` on a line by itself. Put the work instructions on the next line. Use the same ledger for the coordinator and worker. Leave the marker off standalone investigations. An issue mentioned elsewhere in a brief does not start tracking.

The parent enforcer selects the ledger at dispatch and adds a fresh event ID and checkpoint instructions to the brief. Before returning, the worker records its result, evidence and next action on the assigned bead under its own actor. The parent checks the direct child's session identity and runs the packaged `beads-evidence/work_check.py progress` with `python3`. Missing proof produces a tool error. Inspect the session and ledger before retrying: the worker's changes may already exist. A verified progress record does not prove acceptance or authorize closure.

#### Verify a tracked background handoff

For one local native worker on POSIX, set `async: true`, start the brief with the same marker and supply `options.acceptance: { level: "verified", verify: [...] }`. Include the worker's required verification commands in that list. The enforcer appends a required `beads-progress` command; it does not replace those commands. The worker must satisfy the runner's verified acceptance policy as well as post the progress checkpoint.

The launch receipt means pending, not verified. Before reporting successful completion, pi-subagents runs the command against the dispatch ledger and event. The verifier reads the direct child's session header from a fresh assignment directory under the parent session directory. Missing, ambiguous or mismatched identity fails verification. Inspect the worker output and ledger before retrying a failed run.

This path requires fresh context and the local single-worker session layout used by pi-subagents 0.90.0. Custom session directories, separate agent contracts, workflows, remote execution and other hosts are outside this check. The enforcer does not parse completion notices or count a progress checkpoint as permission to close a bead. Unmarked calls keep their existing behavior.

These parts stay OpenCode-only:

- claim tracking and lease heartbeats
- the stop nudge and guarded claim release
- subagent routing (`bead-agent-routing`) and the fork notice
- session-start advisories and the plugin options (pi reads only `gitWrappers`, above)

# Project ledger store

Set `options.store` when the project's ledger lives outside its checkout:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@srobroek/opencode-beads",
      "options": { "store": "/absolute/path/to/ledger/.beads" }
    }
  ]
}
```

Relative store paths resolve from OpenCode's project root
(`location.project.directory`), not from the config file or a shell call's
working directory. The plugin resolves symlinks and requires a directory with
`metadata.json` or `embeddeddolt/`. For invalid values the plugin installs refusal
hooks that block shell tools, shell creation, dispatch and session context with
an `Invalid beads store option` error. It runs no internal `bd` commands.
Fix the config before running ledger writes.

For ordinary `bd` calls, precedence is a literal command-local `BEADS_DIR=`,
then `options.store`, then the server's `BEADS_DIR`, then checkout discovery.
Explicit database/directory CLI flags retain their existing semantics.
The configured store supplies `BEADS_DIR` to shell children and every internal
`bd` command, including admission checks and `bd prime`. This explicit selection
also applies when the automatic `beads-dir-pin` gate is disabled. The write
runner uses the canonical store path, so projects and worktrees sharing a ledger
use its same `omp-embedded-write.lock` file.

The plugin skips an inherited pin in the server's environment, as
`shell.hook("create.before")` describes. The close gate's `bd show` lookup also
uses a command-local `BEADS_DIR=`.

OpenCode V2 searches project config through all ancestors, including above a Git
root. Either `opencode.json` or `.opencode/opencode.json` works; all discovered
`.opencode` configs take precedence over direct configs. Plugin arrays are
processed from lower to higher precedence. In the current V2 implementation,
a later entry with the **same package target** replaces its earlier options;
it does not deep-merge them. Repeat any global gate options you want to retain,
and match the global target exactly, including its version or Git specification.
Different targets exporting the same plugin ID can be reported as duplicates,
with the first instance retained. Use the package target, not `srobroek.beads`,
to supply options: an ID entry only enables the plugin.

Sources: [V2 config](https://opencode.ai/v2/docs/config),
[V2 plugins](https://opencode.ai/v2/docs/plugins), and
[`PluginSupervisor.resolve`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/supervisor.ts)
with [`PluginModule.load`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/module.ts).
