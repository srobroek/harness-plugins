# speckit-beads

SpecKit on Beads: spec-driven setup, a workflow tracked as beads molecules, and
protection for `specs/*/tasks.md`, whose task state lives in beads.

It replaces the `speckit` plugin and needs no other plugin from this repository. It
works through the public `bd` CLI, and the agents run `bd prime` for the Beads workflow
and command reference. Beads is required. Setup always creates the beads workspace and
installs the formulas, and nothing switches that off.

## Install

| Harness | Install |
| --- | --- |
| OpenCode | `opencode plugin add 'github:srobroek/harness-plugins::path:plugins/speckit-beads/opencode'` |
| Claude Code | `speckit-beads@harness-plugins` from this repository's marketplace |
| pi | `pi install npm:@srobroek/pi-speckit-beads` |

| Tool | Needed for | Version |
| --- | --- | --- |
| `bd` | The beads workspace, the formulas and the task state. Setup and the tasks.md guard ask `bd -C <repository> where`. Required. | 1.3.0 or later |
| `specify` | `speckit_setup`'s `specify init` and extension installs | 1.4.0 or later |

On pi, a session start reports a missing or too-old tool with its install hint
(`mise use -g aqua:gastownhall/beads`, `mise use -g pipx:specify-cli`).

## From the `speckit` plugin

- The OpenCode entry is `plugins/speckit-beads/opencode`, and the plugin id is
  `srobroek.speckit-beads`. Move the options to that entry.
- Claude Code installs it as `speckit-beads@harness-plugins`, without the beads plugin.
- `speckit_setup` has no input that skips beads. It refuses every input it does not know.
- The `speckit-ledger` skill holds the task graph rules. The workflow, the formulas and
  the agents load it instead of the beads plugin's skills.

## Options

OpenCode takes them as the plugin's `options`. pi reads the same keys from
`~/.pi/agent/speckit-beads.json` (`$PI_CODING_AGENT_DIR/speckit-beads.json`). Claude Code
takes none.

| Option | Default | Effect |
| --- | --- | --- |
| `integration` | `codex` (OpenCode), `pi` (pi) | The spec-kit integration that `speckit_setup` passes to `specify init`. `codex` writes the commands as skills under `.agents/skills/`, where OpenCode finds them. `pi` writes prompt templates under `.pi/prompts/`, and pi runs each as `/speckit.<command>`. |
| `tasksGuard` | `true` | Refuse writes of `specs/*/tasks.md` where beads is active. |
| `implementRedirect` | `true` | Where beads is active, replace the implement command with the beads route and point the analyze command at the task beads. |
| `blockTasksToIssues` | `true` | Refuse the taskstoissues commands where beads is active. |
| `workflow` | `true` | Add the workflow instructions to sessions in a SpecKit repository. |
| `agents` | `true` | OpenCode: register the `speckit-sync` and `speckit-verify` subagents. |
| `specAgent` | `"auto"` | OpenCode: register the primary `spec` agent. `"auto"`: only where the location, or the project root it lies inside, holds `.specify/`; `true`: everywhere; `false`: never. |

## Tools

OpenCode and pi get the three tools. Claude Code gets the manual steps in the
`speckit-setup` skill instead. The tools run in the session's SpecKit workspace: the
session's directory when it holds `.specify/`, else the project root when the directory
lies inside it and the root holds `.specify/`. OpenCode takes the project root from the
session's project. pi takes the nearest directory that holds `.git`. Agent registration
and the workflow instructions use the same workspace.

`speckit_setup` bootstraps the session's repository. Every phase reports `done`,
`skipped` (already present or an extension could not install) or `failed`.
Extension failures are non-fatal and report the extension and CLI reason;
other failed phases stop with `ok: false`. A rerun skips completed work and retries
missing extensions. `ok: true` means bootstrap completed, not that every optional
extension is available. Each phase has its own timeout.

1. `specify init --here --force --integration <integration> --script sh --ignore-agent-tools`, unless `.specify/` exists.
2. The community catalog, only with `installAllowed=true` (skipped when `SPECKIT_CATALOG_URL` is set: specify then reads only that catalog).
3. Attempt optional extensions not yet installed: `agent-context`, `bugfix`, `cleanup`, `critique`, `fix-findings`, `iterate`, `qa`, `refine`, `retro`, `security-review`, `status-report`, `tinyspec`.
4. `bd init --skip-hooks` without a workspace, then the bundled formulas into `.beads/formulas/`. Formula installation rejects symlinks and never overwrites a divergent file. Without a working `bd`, this phase fails with an install hint.
5. `specs/**/spec-status.md` in `.gitignore`.

`agent-context` is in the core catalog. The other ids above are only in the community
catalog. That catalog is discovery-only by default, so their default installs fail.
Setup changes that trust policy only on explicit opt-in.

Before a workflow, report skipped capabilities. Select `speckit-basic` for core commands
only, or use the direct-work fallbacks of the formulas, with the same deliverables and
checks. Never skip a review or verification because its extension is not installed.

| Input | Effect |
| --- | --- |
| `workspace` | Repository root, resolved against the session's directory; defaults to it. |
| `integration` | Overrides the `integration` option for this call. |
| `installAllowed=true` | Registers the public community catalog as an install source. Opt in only after vetting the extensions. |
| `force=true` | Re-scaffolds `.specify/` only. |
| `skipSpecify=true` | Skips steps 1 to 3. Beads, the formulas and the gitignore entry still run. |
| `script` | `sh` (default) or `ps`, passed to `specify init --script`. |

`speckit_start` starts or resumes the workflow for one `NNN-slug` spec. It asks for
an explicit routine-approval choice before pouring, records it on the run root, reads
it back, and reuses it on resume.

| Human approvals | Formula selection | Routine sign-offs |
| --- | --- | --- |
| Required | `autonomous=no` | Retained |
| Declined | `autonomous=yes` | Omitted |

- `CHOICE_REQUIRED` and `MIGRATION_REQUIRED` return a question. Ask the user, then call again: after `CHOICE_REQUIRED` with `approvals` and `decision`; after `MIGRATION_REQUIRED`, on consent, with the pending `approvals=no`, `migrate=true`, the returned `root` and `decision`. `migrate` with any other `approvals` is refused, so a yes to migrating cannot become `approvals=yes`.
- `READY` names the run root and both selections.
- `INCOMPLETE` means the store-lock wait ran out, a bounded `bd` command passed its 120 s bound, or the call was cancelled. It names the step reached and whether a pour was issued; inspect the run before retrying. `mol pour` and `gate resolve` are never cut off.

The whole start holds the beads store's embedded-write lock, so concurrent starts for
a spec cannot pour duplicate runs. The lock module comes from this repository's shared
library, and the plugin bundles it. The beads plugin bundles the same module, so the two
take turns on the same lock file when both run. Pass `root` when the spec has several
runs, or alone to resume a run: the tool reads the spec id from the root.
Clarification, analysis, reviews, verification, tests and consequential safety
confirmations stay required whatever the choice.

`speckit_commit` commits SpecKit artifacts. It takes only paths under `specs/` and
`.specify/` (by default both) and refuses when a requested path lies outside them or the
index already holds other files. It builds the commit in a private index (HEAD plus the
working-tree state of those paths), checks the tree changes nothing else, commits that
tree on top of HEAD and syncs the real index for those paths. It stores each file's bytes
exactly as they are on disk, never through `git add`: no clean or process filter from
`.gitattributes` runs and `core.autocrlf` converts nothing. Ignored files stay out, the
exec bit sets the file mode, and a symlink is stored as its link text. A symlink that is
absolute or climbs out of `specs/` and `.specify/`, a path through a symlinked directory,
a submodule and a nested repository are refused. After reading each file it checks the
ancestors, the file's real path and its inode again, and refuses the commit if anything
moved. That closes the practical race window, not a perfectly timed double swap: the
tool guards against an agent's mistakes and casual misuse, not a hostile local process
racing it. It never amends, and a concurrent move of HEAD makes it fail rather than
overwrite the other commit. Every git call runs pinned to the workspace (`git -C`)
without inherited repository selectors (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
object-store and `GIT_CONFIG*` variables), and it refuses before writing unless git
resolves the workspace to itself.

No git hook of any kind runs (pre-commit, commit-msg, reference-transaction,
post-index-change): the tool commits with plumbing, and every git call points
`core.hooksPath` at an empty directory. That is the price of committing exactly the
checked snapshot, so run the project's checks separately. The `spec` agent commits
through it, since a shell `git add` or `git commit` pattern cannot keep its operands or
options in bounds.

## Guards and routes

All of them apply only where `bd -C <repository> where` finds a beads workspace, and fail open when
it cannot run.

| Surface | Behavior |
| --- | --- |
| File writes of `specs/*/tasks.md` | Refused. OpenCode: `edit`, `write` and `patch`, including patch move destinations. Claude Code: `Edit` and `Write`. pi: `edit` and `write`, with an `@` or `~` path read as pi reads it. The guard asks the target's own repository. |
| Shell writes of `specs/*/tasks.md` | Refused: redirects, `tee`, `cp`/`mv` destinations, `sed -i`, `touch` and similar, resolved against the call's working directory. Reads run. |
| Implement command | Becomes the beads route: work the task beads under the molecule's `implement` step. OpenCode rewrites the `speckit-implement` skill. pi rewrites a typed `/speckit.implement` or `/skill:speckit-implement`, and keeps the words after it. A `read` of the prompt or skill file returns the route too. |
| Analyze command | Gets a beads preamble ahead of the upstream text. The preamble drops `--require-tasks --include-tasks` from the prerequisite script. It also says to read the task beads where the command reads tasks.md. The spec and plan analysis stays as upstream wrote it. OpenCode adds the preamble to the skill. pi sends it as a message with a typed `/speckit.analyze`, and adds it to a `read` of the prompt file. |
| `speckit-taskstoissues`, `speckit-github-taskstoissues` | Refused. OpenCode: the `skill` tool does not load them, and their content becomes the refusal. pi: a typed command stops and shows the refusal. A `read` of the file returns it. |

Upstream writers the guard denies: `speckit-tasks`, `speckit-converge` (it appends a
`## Phase N: Convergence` section), and the bugfix, cleanup, iterate, reconcile and
refine extensions.

On OpenCode, project skills load after plugins, so the skill transform registers again
whenever a `skill.updated` event shows upstream content.

## Workflow instructions

`opencode/instructions/speckit-workflow.md` holds the beads workflow contract and
command routing. Its BEADS section has the agent run `bd prime` once per session and
load `speckit-ledger`.

- **OpenCode:** a session gets it in its system prompt when it has a SpecKit workspace
  (see Tools) at its first request. That decision holds for the whole session, also
  across a server restart. The system prompt stays the same, and the prompt cache of the
  provider holds. The two speckit subagents do not get it.
- **pi:** every run in a SpecKit workspace gets it as the `speckit_workflow` system prompt
  section. pi sends only the sections that change. A section that appears after setup
  costs one patch message and keeps the prompt cache.
- **OpenCode and pi:** a run that started without it and calls `speckit_setup` gets the
  text in the tool result.
- **Claude Code:** gets no workflow text, because the text names the OpenCode and pi tools.

## Agents

### spec

`spec` drives one feature through SpecKit up to implementation:

1. It checks for `.specify/`, the SpecKit commands and a beads workspace, and offers
   `speckit_setup`. Then it runs `bd prime`.
2. It calls `speckit_start` and asks the routine-approval question.
3. It follows the poured molecule and runs the upstream command of each phase. The tasks
   phase creates child beads of the implement step. Checklist, critique and security
   review run where the profile has them.
4. It stops at the first step outside its boundary and hands those steps over by id.
   The implement step, later docs, checks and the final commit are outside it.

It has three entry paths: a new spec, a resume of an existing spec id or run root (no
new number), and a verify-return that routes verification to `speckit-verify`.

On OpenCode it is a primary agent. It asks through the `question` tool, which parley
takes over when its TUI is attached, and through `tools.parley_ask` for rounds of
several questions.

| Boundary | Allowed |
| --- | --- |
| Steps | 100 |
| Edits | Any file. Its prompt keeps it to spec artifacts, and commits go through `speckit_commit`, which stages only `specs/` and `.specify/` |
| Shell | `bd` (including the beads write-lock runner), `specify`, `.specify/` scripts, and `git` status, diff, log, show, branch, rev-parse, ls-files, merge-base, switch. Branch deletion, renames and forced moves, and discarding or forced switches are denied. |
| Tools | read, grep, glob, LSP, `question`, `execute` (for `parley_ask`, `speckit_setup`, `speckit_start`), `speckit_*` (commits go through `speckit_commit`) |
| Skills | `speckit-*` (this plugin's and spec-kit's), `quality-*` |
| Subagents | `explore`, `researcher`, `architect`, `speckit-verify`, `speckit-sync` |

Everything else is denied, including `git push` and web access. It writes spec artifacts
and never implements product code; that boundary is its prompt's, not a permission.

It carries the `strong` model tier: the spec, plan and task breakdown decide what every
implementer builds, and the agent writes no code, so its token volume stays small next
to the implementation it directs.

Each location runs its own plugin instance, so with `specAgent: "auto"` the agent is
listed (and in the primary-agent cycle) only in SpecKit repositories. A `speckit_setup`
that creates `.specify/` at the location registers it without a restart.

On pi it is a pi-subagents agent, from `common/agents/spec.pi.md`. Its own session loads
this package's extension (`subagentOnlyExtensions`). It has the `speckit_*` tools, the
guard and the workflow section even where the parent session does not load the package.

- Tools: every pi file tool, edit and write included, plus bash, `subagent` and the three `speckit_*` tools.
- Subagents: `scout`, `researcher` and `architect`, plus `speckit-verify` and `speckit-sync`.
- Context: the repository's `AGENTS.md` and the skills catalog, so it can load `speckit-ledger`.
- Questions go to the user through `contact_supervisor`. It ends with a report for its
  supervisor.

pi has no per-path edit or shell rules, so the boundary above is an instruction there.
Only the tasks.md guard enforces part of it.

### Subagents

| Agent | Spawn with |
| --- | --- |
| `speckit-sync` (steps 60) | `scope: drift` / `conflicts` / `both` |
| `speckit-verify` (steps 60) | `mode: requirements` / `tasks` / `review` |

On OpenCode the two subagents are read-only (edits denied) and carry the `reviewer`
model tier in `request.headers.x-opencode-model-role`. With the model-roles plugin they
run on that tier's model, otherwise on the parent's. They pin no model. Both are hidden
from the subagent catalog, since the formulas and the workflow instructions spawn them by
id, and neither gets Code Mode. `speckit-verify` may load the `quality-*` skills, and
`speckit-sync` only `speckit-ledger`.

On pi each has the file-reading tools and bash, from `common/agents/<id>.pi.md`.
pi-subagents saves the report to `<id>.md` in the output directory of the run.

`speckit-verify` is composed by `bun run build` from `agents.src/speckit-verify.md` and
the evidence and report parts of the shared review core (`lib/src/review-core.md`);
edit the source, not `agents/`. Its reply starts with `VERDICT: PASS|GAPS`.

Formula steps that spawn them set `execution_agent_type` to the agent id, with
`execution_agent_mode` or `execution_agent_scope` beside it. A spawn for such a step
goes to that agent, and to no other.

The review steps (`review`, and `code-review` in `speckit-feature`) spawn
`speckit-verify` with `mode: review` rather than spec-kit's `review` extension, which
`speckit_setup` does not install. They route to this plugin's own agent, not
delivery's `pr-reviewer`, so they work without the delivery plugin.

## Skills

| Skill | Use when |
| --- | --- |
| `speckit-setup` | Bootstrap `.specify/`, extensions, beads and formulas, or start a spec where `speckit_start` is missing. |
| `speckit-ledger` | Turn a task breakdown into task beads under the implement step: the graph file's fields, a dry run, the create and the read-back. Also adding and changing tasks later. |
| `speckit-bugfix` | Fix a defect. For a tracked trail, bond `mol-speckit-bugfix`. |

`speckit-bugfix` loads the `quality-code-design` skill from the `quality` plugin;
without it the skill reports the missing guidance.

## Formulas

- Depth: `speckit-basic`, `speckit-lean`, `speckit-feature`
- Bonds: `mol-speckit-iterate`, `mol-speckit-fix-findings`, `mol-speckit-bugfix`, `mol-speckit-refine`

## Claude Code

Claude Code gets these parts:

- the `speckit-setup`, `speckit-ledger` and `speckit-bugfix` skills, with the manual steps
  for setup and spec start
- the `speckit-sync` and `speckit-verify` subagents
- the formulas, under `${CLAUDE_PLUGIN_ROOT}/formulas/`
- the tasks.md guard, as a `PreToolUse` hook on `Edit`, `Write` and `Bash`, run by
  `bun dist/claude-hook.js`

These parts stay with OpenCode and pi:

- the `spec` agent
- the `speckit_setup`, `speckit_start` and `speckit_commit` tools
- the command routes
- the workflow instructions, which name those tools

## Not ported

- The omp `tools/spec-start.ts` CLI. Use `speckit_start`.
- The `beadsPlugin` option. The lock implementation is bundled, so no installed beads package has to be found at runtime.

## License

Apache-2.0
