# Pi spikes

Status: measured 2026-11-23 on pi 1.6.0 with Amazon Bedrock models, in isolated agent directories (`PI_CODING_AGENT_DIR`). The [adoption review](plugin-adoption.md) depends on these results.

## Subagent worktrees with worktrunk

pi-subagents 0.90.0 allocates worktrees through worktrunk with `worktreeProvider: "worktrunk"`, and fails closed when worktrunk is missing. It calls:

```text
wt -C <repoRoot> switch --create <branch> --base <baseCommit> --no-cd --no-hooks --format json
```

The `--no-hooks` flag stops worktrunk's own hooks. A scratch repo with `pre-start` and `post-start` marker hooks showed both markers and the copied ignored file missing in the child.

A `worktreeSetupHook` script that runs `wt -C <worktree> hook pre-start --foreground --yes` and then `post-start` the same way fixes this. The markers and the ignored file were present at the child's first tool call. With real user-level hooks (copy-ignored, a cargo check), the hook took 1.2 s, under the default 30 s timeout. The script removes pi-subagents' `node_modules` symlink first, so a hook that installs dependencies cannot write into the main checkout.

pi-subagents reads these keys from `~/.pi/agent/extensions/subagent/config.json`:

```json
{
  "worktreeProvider": "worktrunk",
  "worktreeSetupHook": "~/.pi/agent/hooks/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 60000,
  "authorityPolicy": { "discardWorktree": "confirm" }
}
```

With `discardWorktree: "auto"`, pi removed the worktree and the branch after the handoff, and the child's edit survived only in the run's patch file. Keep `confirm` so a branch stays until the lead runs `wt merge`. The spike did not test a child that commits followed by `wt merge`, or herdr tab placement for worktree children.

## pi-subagents with Beads

pi-subagents has no Beads logic, and pi-beads-companion 0.1.2 adds `bd prime` and selected-issue context in `before_agent_start`. Results:

| Check | Result |
|---|---|
| One background child claims, comments and closes a bead | Works. The child had the companion's context, but Beads recorded every write under the parent's actor |
| Two parallel children in separate worktrees | Both finished, but both resolved to the main checkout's embedded store. No errors this run; the Beads rules warn that concurrent embedded-store writes can corrupt it, so this does not prove safety |
| Typed gate running `bd show <id> --json` | Works with `acceptance: false`; the gate's JSON became the step's `structuredOutput` |
| Child environment | Inherits the parent's Beads actor and store variables. Foreground children do not load the parent's extensions |

What remains for our own extension: a per-child actor, claim before work, store pinning per checkout, serialized embedded-store writes, close with evidence, and shell gates on `bd`, `git` and `gh`. The companion covers context only.

## cc-safety-net vs our safety plugin

Both analyzers ran over cases taken from our safety plugin's tests (`guards`, `permission` and `op-guard`), plus 11 adversarial wrappers per block or ask case: `bash -c`, `eval`, `xargs`, env assignment, `command`, `builtin`, `exec`, `git -C`, `&&`, a subshell and a pipeline. cc-safety-net 2.8.2 ran through its `checkCommand` API in strict mode.

| Gate | Cases | cc-safety-net blocks | ours blocks or asks |
|---|---:|---:|---:|
| Indirect execution | 348 block | 300 | 319 |
| Remote execution | 132 block | 104 | 117 |
| Force push and destructive git | 96 block | 70 | 88 |
| Attribution, worktree under `/tmp`, DNS, Git Defender | 17 block | 0 | 17 |
| Allow fixtures | 88 allow | 8 wrongly blocked | 5 wrongly blocked |
| State-aware asks (branch delete, worktree remove, reset, stash, clean) | 168 ask | no ask outcome: 109 blocked, 59 allowed | 96 asked |
| Secret tool guard (`op`, `fnox`) | 292 block | 28 | 276 |

The corpus was written for our plugin, so it favors ours. It does not measure cc-safety-net's sensitive-path rules. The stateful cases ran without their real repositories, so the ask results are provisional.

| Stability | cc-safety-net | ours |
|---|---|---|
| Releases | 100 since January, 86 since late May | not ported to pi |
| Breaking changes | 1.0 (June) dropped legacy inline rules; 2.0 (August) rebuilt the engine | none on pi |
| Tests | 227 test files, 3 pi adapter test files | 1,978 tests across 24 files |
| Maintainers | effectively one | this repository |
| Failure behavior | a thrown check blocks; a failed load at startup exits pi | hard-gate exceptions mostly fail open; the secret guard fails closed |
| Speed | about 5 ms per check | not measured |

Running both needs a split: cc-safety-net hard-blocks some commands ours would ask about, so an approval from our extension can still be denied by cc-safety-net. How to build on cc-safety-net instead of choosing one is the next spike.

## @onkernel/browser-loop

browser-loop drives a Kernel cloud browser and needs `KERNEL_API_KEY`; its README documents adapters for Anthropic, OpenAI, Google, xAI and Moonshot, not Bedrock. It was not run. The adopted `pi-agent-browser-native` completed the same task, reading the title of `https://example.com`, on Bedrock Sonnet 5.5: 69 s, 6 model turns, about 76K tokens. Verdict: skip browser-loop unless cloud browsers are needed.

## glimpseui

glimpseui 0.8.1 is a native WebView window library with a pi skill, not an always-on extension. `pi install npm:glimpseui` took about 2 minutes, and its `postinstall` script needed approval, so the macOS host binary had to be built by hand (`npm run build:macos`, a 213 KB arm64 binary). A script-driven form that auto-submitted after 2 s returned `{"choice":"blue","name":"Ada"}`, so the JSON bridge works. A model-driven run on Haiku 5.5 opened a choice window, but nobody answered it, and it timed out after 180 s.

It can complement parley for rich one-off windows on the Mac. It does not replace parley's round lifecycle (recommendations, notes, deferral, persistence) or the design plugin's rendered-surface review. Headless Linux servers are unsupported in practice, and over SSH the window opens on the remote host. The last code release was in May; 9 issues are open. Verdict: trial on the Mac only.

## pi-mcp-adapter vs built-in MCP

The same servers (Context7, Engram's `engram mcp`, and the filesystem server) ran in three isolated setups:

| Setup | Startup median (3 runs) | System prompt chars | Context7 route |
|---|---:|---:|---|
| Built-in, default `codemode` exposure | 6.5 s | 20,100 | `codemode` called `mcp__context7__resolve_library_id` |
| Built-in, `exposure: "deferred"` | 6.3 s | 19,990 | `tool_search` found the same tool |
| pi-mcp-adapter 7.0.1 | 4.8 s (first cold run 21.9 s) | 20,104 | the adapter's `mcp__context7` proxy |

The prompt size barely differs, and three runs are too noisy to call startup either way. Context7 answered every route with its monthly-quota error, so no lookup completed. The filesystem server failed in all three on a broken npm dependency.

The adapter replaces built-in MCP (it takes `/mcp` and turns `builtin:mcp` off) and adds MCP prompts, elicitation, sampling, MCP UI, MCP Tasks and keychain OAuth. gentle-engram's `mem_*` tools, context-mode's `ctx_*` tools and a pi-subagents background child all worked with it.

Verdict: keep built-in MCP with `exposure: "deferred"`. Revisit the adapter only if those extra protocol features are needed. Engram stays out of pi's `mcp.json`, because gentle-engram already provides its tools.

## Building on cc-safety-net

cc-safety-net's extension points are narrow:

| Extension point | What it supports |
|---|---|
| Rulebooks (`rulebook_version` 2, since 2.3.0) | Block an exact command path with exact `any_args` and `exclude_args`; case-sensitive; no regex, substring or path conditions. Rules only add blocks. Rulebooks load from user or project `.cc-safety-net/` or a GitHub repository; a pi package cannot ship one automatically |
| `policy.json` | Tune or turn off built-in rules; `CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY=1` refuses project weakenings |
| Modes | `standard`, `strict`, `paranoid`, plus a worktree mode; no ask outcome |
| Library API | `checkCommand({command, cwd})` from `cc-safety-net/api`, returning allow or deny; no parse results |

A v2 rulebook rule blocked `git commit -m 'Co-Authored-By: Claude'` and allowed `git commit -m 'Fix the bug'` in `explain`. It matches whole arguments only, so it cannot see a phrase inside a longer message, a `-F` file or a heredoc. All the other gates (migrations, external directories, push-via, `/tmp` worktrees, Git Defender, the DNS marker, history rewrite, the `op`/`fnox` guard, state-aware asks, close-keyword rewrite, package advisory) need repository state, path resolution or a rewrite. They stay in our own extension with our own parser. Redaction and the secret-store tool are `tool_result` and `registerTool` features.

Composition, tested in a model-free pi 1.6.0 harness with a fake `git branch -D x` call: pi runs `tool_call` handlers in package order, and the first block stops the call. With cc-safety-net first, its `git.branch-force-delete` block ran and our ask never did. With our ask first, an approval was still denied by cc-safety-net afterwards. Reversing the `packages` array reversed the order.

Architecture: load cc-safety-net first as the baseline for generic destructive commands and sensitive paths. Our slim extension owns the workflow gates, redaction and the secret store. Where we want an evidence-based ask instead of a hard block, turn off the overlapping built-in rule in `policy.json`: `git.branch-force-delete`, `git.stash-drop`, `git.stash-clear`, `git.worktree-remove-force`, `git.reset-hard`, `git.clean-force`. Our extension then owns those decisions. It imports nothing from cc-safety-net. Pin cc-safety-net to a tested version and run `rule verify` after upgrades, because an invalid rulebook silently contributes no rules.
