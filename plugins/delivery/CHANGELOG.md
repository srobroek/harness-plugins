## delivery [0.12.0](https://github.com/srobroek/harness-plugins/compare/delivery--v0.11.1...delivery--v0.12.0) (2026-11-22)

### Features

* **delivery:** ship the orchestrator agent ([#121](https://github.com/srobroek/harness-plugins/issues/121)) ([53f33c0](https://github.com/srobroek/harness-plugins/commit/53f33c016315732220a7c87066267931ee87f514))

## delivery [0.11.1](https://github.com/srobroek/harness-plugins/compare/delivery--v0.11.0...delivery--v0.11.1) (2026-11-22)

### Bug Fixes

* **subagent-worktree:** release a dead writer's worktree to a new writer ([#95](https://github.com/srobroek/harness-plugins/issues/95)) ([5e88065](https://github.com/srobroek/harness-plugins/commit/5e880653ad897ed41a69cc41658dc2f941d0ad96)), closes [#106](https://github.com/srobroek/harness-plugins/issues/106) [#99](https://github.com/srobroek/harness-plugins/issues/99) [#100](https://github.com/srobroek/harness-plugins/issues/100) [#109](https://github.com/srobroek/harness-plugins/issues/109)

## delivery [0.11.0](https://github.com/srobroek/harness-plugins/compare/delivery--v0.10.6...delivery--v0.11.0) (2026-11-22)

### Features

* **delivery:** register clones with their receipts and collect them at gc ([356b0e8](https://github.com/srobroek/harness-plugins/commit/356b0e8d1563e3533d272ee0a19a01a7a52532d4)), closes [#94](https://github.com/srobroek/harness-plugins/issues/94)

### Bug Fixes

* **delivery:** keep a clone registered when its receipt directory cannot be opened ([4de6356](https://github.com/srobroek/harness-plugins/commit/4de63562df43c90b9faa35d58c77842212b42b5e))
* **delivery:** keep a clone registered while another receipt of it is pending ([d6c7d69](https://github.com/srobroek/harness-plugins/commit/d6c7d69da8b1fa992055f688a88465711737e944))
* **delivery:** run close-out commands for another repository as bd -C ([2e73a29](https://github.com/srobroek/harness-plugins/commit/2e73a2906a9cda0ca96c12a22166cb111d97287f))
* **delivery:** test that an unparseable registry refusal keeps the SyntaxError as cause ([5e384c9](https://github.com/srobroek/harness-plugins/commit/5e384c9057de64f95cbacfccaecf8d1d3f4ff141))

## delivery [0.10.6](https://github.com/srobroek/harness-plugins/compare/delivery--v0.10.5...delivery--v0.10.6) (2026-11-22)

## delivery [0.10.5](https://github.com/srobroek/harness-plugins/compare/delivery--v0.10.4...delivery--v0.10.5) (2026-11-22)

### Bug Fixes

* **subagent-worktree:** require git 2.45 and run automatic git hardened ([3b6c86c](https://github.com/srobroek/harness-plugins/commit/3b6c86c81349e8fb65322aca3b6c68ec101d8869))

## delivery [0.10.4](https://github.com/srobroek/harness-plugins/compare/delivery--v0.10.3...delivery--v0.10.4) (2026-11-22)

### Bug Fixes

* **delivery:** clean up another repository's landing under that repository's coordination ([#94](https://github.com/srobroek/harness-plugins/issues/94)) ([56d9ef5](https://github.com/srobroek/harness-plugins/commit/56d9ef5db05edab91f28c59b87f0932512b22828))

## delivery [0.10.3](https://github.com/srobroek/harness-plugins/compare/delivery--v0.10.2...delivery--v0.10.3) (2026-11-22)

### Bug Fixes

* **delivery:** run repository observations on an async git child ([#82](https://github.com/srobroek/harness-plugins/issues/82)) ([4923124](https://github.com/srobroek/harness-plugins/commit/492312408a994465698b61e6b4497459953748d2))

## delivery [0.10.2](https://github.com/srobroek/harness-plugins/compare/delivery--v0.10.1...delivery--v0.10.2) (2026-11-21)

### Bug Fixes

* **code-challenge:** close dogfood friction in skill, schema and validation ([043a8b3](https://github.com/srobroek/harness-plugins/commit/043a8b39057ec8fca54d09adebb0532c2154e330))
* stop forcing confirmation prompts in delivery, dep-update, design and repomix ([fe59fa1](https://github.com/srobroek/harness-plugins/commit/fe59fa10692bc61a3d7b2b7c8eb728ee6a0050b5))

## delivery [0.10.1](https://github.com/srobroek/harness-plugins/compare/delivery--v0.10.0...delivery--v0.10.1) (2026-11-21)

## delivery [0.10.0](https://github.com/srobroek/harness-plugins/compare/delivery--v0.9.6...delivery--v0.10.0) (2026-11-21)

### Features

* **subagent-worktree:** remove lanes through one finalize path ([#59](https://github.com/srobroek/harness-plugins/issues/59)) ([14d4dae](https://github.com/srobroek/harness-plugins/commit/14d4dae9287a4a815569da6f9172b5ace2f36774))

## delivery [0.9.6](https://github.com/srobroek/harness-plugins/compare/delivery--v0.9.5...delivery--v0.9.6) (2026-11-21)

### Bug Fixes

* **delivery:** do not prompt for land and cleanup in a subagent session ([95d0d48](https://github.com/srobroek/harness-plugins/commit/95d0d4846e46f385cb36cc6ce2393fc5deda8dd6))

## delivery [0.9.5](https://github.com/srobroek/harness-plugins/compare/delivery--v0.9.4...delivery--v0.9.5) (2026-11-21)

### Bug Fixes

* **delivery:** scope a repo-only cleanup to its repository before preferring uncleaned receipts ([5293d21](https://github.com/srobroek/harness-plugins/commit/5293d21f42c2a15e2b7bf47418c1e7bd339f3efb)), closes [#24](https://github.com/srobroek/harness-plugins/issues/24)

## delivery [0.9.4](https://github.com/srobroek/harness-plugins/compare/delivery--v0.9.3...delivery--v0.9.4) (2026-11-21)

### Bug Fixes

* **autopilot:** review-only approval, bound worktree identity, full checks and explicit merge method ([a888673](https://github.com/srobroek/harness-plugins/commit/a888673f410701b98818d437fb5f22984bac0ed8))

## delivery [0.9.3](https://github.com/srobroek/harness-plugins/compare/delivery--v0.9.2...delivery--v0.9.3) (2026-11-21)

### Bug Fixes

* **delivery:** refuse already-cleaned when a worktree reappeared at the recorded path ([360d865](https://github.com/srobroek/harness-plugins/commit/360d865a2008522c134d13b898767086892c0da4))

## delivery [0.9.2](https://github.com/srobroek/harness-plugins/compare/delivery--v0.9.1...delivery--v0.9.2) (2026-11-20)

### Bug Fixes

* **delivery:** dedup cleanup receipts by repository and PR ([3803bd9](https://github.com/srobroek/harness-plugins/commit/3803bd9b15c2f87fd9f7a15f4f9b6229f130b69e)), closes [#22](https://github.com/srobroek/harness-plugins/issues/22)

## delivery [0.9.1](https://github.com/srobroek/harness-plugins/compare/delivery--v0.9.0...delivery--v0.9.1) (2026-11-20)

### Bug Fixes

* **delivery:** match cleanup receipts to the requested repo and scope bead reads ([078e864](https://github.com/srobroek/harness-plugins/commit/078e864482dda5829cfead1e10715b1a15a15ec3))

# Changelog

## [0.9.0](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.8.2...delivery--v0.9.0) (2026-11-20)


### Features

* **agents:** follow lang skills and the repo engineering doc, report departures ([#267](https://github.com/srobroek/opencode-plugins/issues/267)) ([2c15755](https://github.com/srobroek/opencode-plugins/commit/2c15755d62faed398c8f3ce4747a61d1c92ff00c))
* **delivery:** land and clean up a pull request of an explicit repository ([#270](https://github.com/srobroek/opencode-plugins/issues/270)) ([137606c](https://github.com/srobroek/opencode-plugins/commit/137606c05fb83273d5207a6e3b2d743113d4fa3b))
* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))


### Bug Fixes

* **delivery:** accept a symlinked home above the receipt root ([#275](https://github.com/srobroek/opencode-plugins/issues/275)) ([1b11481](https://github.com/srobroek/opencode-plugins/commit/1b1148136015ea68eb4db494a06bbfac5c3b52f1))
* **delivery:** select cleanup receipt by PR or worktree head and accept renamed or gone worktrees ([7016e89](https://github.com/srobroek/opencode-plugins/commit/7016e890ae25ea9133ae48fb1bb83702f2a07dae))

## [0.8.2](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.8.1...delivery--v0.8.2) (2026-11-19)


### Bug Fixes

* **delivery:** observe remote refs via forge API instead of ssh ([a356555](https://github.com/srobroek/opencode-plugins/commit/a3565558a36edbe14d632e0d69828fc0d854e39b))

## [0.8.1](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.8.0...delivery--v0.8.1) (2026-11-19)


### Bug Fixes

* **delivery:** record the queue landing on the first MERGED read before re-reading ([ae56952](https://github.com/srobroek/opencode-plugins/commit/ae56952b58a021f71fd9cb540ad79c3abe53e7a2))

## [0.8.0](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.7.1...delivery--v0.8.0) (2026-11-19)


### Features

* **delivery:** land through a GitHub merge queue ([d2965be](https://github.com/srobroek/opencode-plugins/commit/d2965be5bf99a178cf98da6e77506f7dbbf6e750))
* **modes:** debug, refactor and concept agents ([6369b8a](https://github.com/srobroek/opencode-plugins/commit/6369b8ae6c4ca35c664f094b60c28d356cc13298))
* **quality:** add stub-and-swap rules to coding and testing standards ([2bdfe9b](https://github.com/srobroek/opencode-plugins/commit/2bdfe9b4755dfc284200dadfb4648e6e9239f3b6))
* **safety:** secret_store tool stores a generated or command-issued secret without a shell ([d84a1d2](https://github.com/srobroek/opencode-plugins/commit/d84a1d22b0ff6e72f327fb185c512b2296a80a1e))
* stop long tools and their processes on ToolContext.signal ([94c0ac5](https://github.com/srobroek/opencode-plugins/commit/94c0ac59e12df53eee73d3152da8523f10148bb0))
* **subagent-worktree:** free build dirs, handle closed-unmerged lanes, share delivery helpers ([14db9ad](https://github.com/srobroek/opencode-plugins/commit/14db9ad7a1eee5ca5bfde292b9d5822a5deed662))
* **subagent-worktree:** remove agent worktrees once their work lands ([1cbfd38](https://github.com/srobroek/opencode-plugins/commit/1cbfd38f569bd7ad7d04c99173edb2df55b0351f))


### Bug Fixes

* **agents:** let read-only agents load quality and lang skills ([#208](https://github.com/srobroek/opencode-plugins/issues/208)) ([6eac5c5](https://github.com/srobroek/opencode-plugins/commit/6eac5c52afa176c0463755cef4d9871092192fa2))
* **safety:** refuse history-rewriting git in a canonical checkout ([#210](https://github.com/srobroek/opencode-plugins/issues/210)) ([515f7ba](https://github.com/srobroek/opencode-plugins/commit/515f7ba36493307fad32de51e48c47197bb31f26))
* **subagent-worktree:** refuse a second live writer in a named worktree ([#202](https://github.com/srobroek/opencode-plugins/issues/202)) ([1c66f3e](https://github.com/srobroek/opencode-plugins/commit/1c66f3e9d710c40cc257bda9ea64e9e1a437ad59))


### Documentation

* **delivery:** add a repository CI and landing standard for parallel agents ([c47d0ef](https://github.com/srobroek/opencode-plugins/commit/c47d0ef303865da47122e79dccff73b5dbf8a36f))
* **delivery:** cache guidance for setup actions without a save switch ([ee5e0dd](https://github.com/srobroek/opencode-plugins/commit/ee5e0dd03ed22c206a9a4897c5b831e503c4cfb1))
* **delivery:** draft-PR workflow and interim merge-queue landing ([#193](https://github.com/srobroek/opencode-plugins/issues/193)) ([96108c1](https://github.com/srobroek/opencode-plugins/commit/96108c16bd8316de214dea391af0bc43c87c9244))
* **delivery:** GraphQL interim queue landing, generic draft rule, plugin-update pitfall ([#199](https://github.com/srobroek/opencode-plugins/issues/199)) ([a6fbe8e](https://github.com/srobroek/opencode-plugins/commit/a6fbe8ea4ea3d8f327a093be137e159e08250aac))
* **delivery:** squash with PR_TITLE and COMMIT_MESSAGES on every GitHub repository ([451ac16](https://github.com/srobroek/opencode-plugins/commit/451ac16fcaf1bfc32aa9824a06101c77a1e77ac3))

## [0.7.1](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.7.0...delivery--v0.7.1) (2026-11-16)


### Bug Fixes

* **delivery:** delivery_cleanup removes OpenCode-created worktrees through the host ([b83f0dc](https://github.com/srobroek/opencode-plugins/commit/b83f0dc01c30fd0e4541c4110609ecd90c19df79))
* **delivery:** record the landed worktree and land a repo from another checkout ([#181](https://github.com/srobroek/opencode-plugins/issues/181)) ([9ebb118](https://github.com/srobroek/opencode-plugins/commit/9ebb118d0da835a0400abecd79324c70bff9880b))


### Documentation

* **skills:** add a per-skill references/pitfalls.md standard and a check ([#178](https://github.com/srobroek/opencode-plugins/issues/178)) ([ff2489a](https://github.com/srobroek/opencode-plugins/commit/ff2489af6aab145e3a5e6be8462d390b43395ae7))

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.6.0...delivery--v0.7.0) (2026-11-13)


### Features

* **agents:** a tools option that lets read-only and coding agents call allowed MCP tools ([70558c3](https://github.com/srobroek/opencode-plugins/commit/70558c30dc450faec7e6012cdb0f678f1ecd7f01))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.5.0...delivery--v0.6.0) (2026-11-12)


### Features

* **quality:** research-first engineering standards and per-language library standards for every coding agent ([09e8d46](https://github.com/srobroek/opencode-plugins/commit/09e8d461bb2b7654788a588ef6932929ff564d28))
* **quality:** testing standards: behavior tests, test budget, same-change maintenance, reviewers check test changes ([dcdf941](https://github.com/srobroek/opencode-plugins/commit/dcdf9413b6793ed06ef8978a0084d9f50d30b00c))
* **toolchain:** compare Connect, gRPC and OpenAPI, and use Connect for RPC beside Hono for HTTP ([d62b5c7](https://github.com/srobroek/opencode-plugins/commit/d62b5c79f355c687a9d53333c64cc583dcabfea8))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.4.0...delivery--v0.5.0) (2026-11-11)


### Features

* **quality:** require quality-code-design only for new behavior, refactors, hard bugs and reviews ([#125](https://github.com/srobroek/opencode-plugins/issues/125)) ([774d73f](https://github.com/srobroek/opencode-plugins/commit/774d73f64e9966cdd1bbad40c13f152d17f2c61d))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.3.0...delivery--v0.4.0) (2026-11-11)


### Features

* cap every shipped agent with a step limit ([#123](https://github.com/srobroek/opencode-plugins/issues/123)) ([7b3b60f](https://github.com/srobroek/opencode-plugins/commit/7b3b60f84ac4aabcf8d5d649042e26054f79b0f4))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.2.1...delivery--v0.3.0) (2026-10-27)


### Features

* **agent-researcher:** allow repomix_pack for researcher ([56867d2](https://github.com/srobroek/opencode-plugins/commit/56867d20cff05af4d65f7d61ffccc28701d303e3))
* **lib:** coding-core type-checks after multi-file or signature changes ([ea722cd](https://github.com/srobroek/opencode-plugins/commit/ea722cd31c171b4b08969eaa0e9084c6fda0bdd9))


### Performance

* **delivery:** lean profiles for the delivery agents ([0fa1b1f](https://github.com/srobroek/opencode-plugins/commit/0fa1b1fc5179d2ba52193cf6e1227b64c7086ecf))


### Refactors

* **delivery:** compose implementers from coding-core ([ea15911](https://github.com/srobroek/opencode-plugins/commit/ea15911eea22eeec0bd4144d238759f18275119d))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.2.0...delivery--v0.2.1) (2026-10-27)


### Performance

* **delivery:** add the fan-out text to compaction and generate requests ([a4752f6](https://github.com/srobroek/opencode-plugins/commit/a4752f6475c9a93ef52f1fb8fc6966ac041c2638))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.1.0...delivery--v0.2.0) (2026-10-27)


### Features

* **agent-researcher:** move researcher into its own plugin with a delivery fallback ([5b03fdb](https://github.com/srobroek/opencode-plugins/commit/5b03fdb123fd5b1d967c3f52bd69c5e897d1af92))
* **agent-reviewer:** reviewer subagents on a shared review core ([74f29b7](https://github.com/srobroek/opencode-plugins/commit/74f29b73b257531d894e508e957cddd7f9bfd4a3))
* **delivery:** emit model-role headers and defer to model-roles when installed ([2a53139](https://github.com/srobroek/opencode-plugins/commit/2a531399f9483e688e652b485febf7a1533fce45))
* **delivery:** port delivery_land, delivery_cleanup, receipts and delivery agents to V2 ([2ea028e](https://github.com/srobroek/opencode-plugins/commit/2ea028e44498f5138e93dd2e256c6334a99bb522))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))
* **lib:** register shipped agent files and content-only plugins ([df7fa53](https://github.com/srobroek/opencode-plugins/commit/df7fa53ac93f0327a1735fcf1e5c6017d0216754))
* **model-roles:** tiers derived from the catalog, reviewer tier and one-time classification ([4265016](https://github.com/srobroek/opencode-plugins/commit/42650166140c1fada15bda5066d235fdf5fce327))


### Bug Fixes

* **delivery:** accept a verdict line below a preamble or inside a code fence ([6ad154e](https://github.com/srobroek/opencode-plugins/commit/6ad154ed08d6d76c27aa38d27c71a54639c0d640))
* **delivery:** build the rebase fixture in one fast-import and time the land interrupt from the abort ([80dd989](https://github.com/srobroek/opencode-plugins/commit/80dd989ed639b6323a3ba72a2d9e208dd170617c))
* **delivery:** raise git read bounds to 5 s and guard lost exits ([2f73194](https://github.com/srobroek/opencode-plugins/commit/2f73194a9c228ed60075331c6d1065f1ae822285))
* **delivery:** run the deadline test's script through /bin/sh so the deadline cannot fire before it starts ([93fc2bd](https://github.com/srobroek/opencode-plugins/commit/93fc2bd29e96c9aec3b5a51147b1c92b1ffdcda7))
* **lib:** accept numeric signal codes from @types/bun 1.4.4 ([a3d2e42](https://github.com/srobroek/opencode-plugins/commit/a3d2e4225211d1a288fa3fed561e1c9d8e696284))
* **model-roles:** let user agent model pins win over tiers ([92a2a5b](https://github.com/srobroek/opencode-plugins/commit/92a2a5bda3dc0f2f880dda733994acb38aa93595))


### Performance

* **delivery:** shrink the fan-out block and gate it on the subagent tool ([927712e](https://github.com/srobroek/opencode-plugins/commit/927712ec0dfa5709df668030ed8ee4e93ae57631))
* give shipped subagents tool allowlists ([014fffb](https://github.com/srobroek/opencode-plugins/commit/014fffb403fd1363f494af84c63bf93074af6d20))
* keep shipped agent descriptions under 150 characters ([7023675](https://github.com/srobroek/opencode-plugins/commit/70236752520b0fd02b872ec61510ec1388028778))
* lead every tool description with a first line under 120 characters ([74b65d9](https://github.com/srobroek/opencode-plugins/commit/74b65d9f446fcc535320b7c320ccaf8482d594df))
* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))
