## subagent-worktree [0.9.1](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.9.0...subagent-worktree--v0.9.1) (2026-11-23)

### Bug Fixes

* **subagent-worktree:** drop project-wide session eviction from finalize ([398ba17](https://github.com/srobroek/harness-plugins/commit/398ba1791911536abc585fd37a129e83347e1e9b))

## subagent-worktree [0.9.0](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.8.3...subagent-worktree--v0.9.0) (2026-11-23)

### Features

* **subagent-worktree:** report long-idle and fenced lanes, add unfence ([#123](https://github.com/srobroek/harness-plugins/issues/123)) ([541f316](https://github.com/srobroek/harness-plugins/commit/541f31639c9f38e2f7bf7674b8c44f43ea79195f))

## subagent-worktree [0.8.3](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.8.2...subagent-worktree--v0.8.3) (2026-11-22)

### Bug Fixes

* **subagent-worktree:** drain dispose fully and prove local merges later ([#115](https://github.com/srobroek/harness-plugins/issues/115)) ([1d31647](https://github.com/srobroek/harness-plugins/commit/1d3164769e9c50d6622a36fc810c8d7f6ef1e7cc))

## subagent-worktree [0.8.2](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.8.1...subagent-worktree--v0.8.2) (2026-11-22)

### Bug Fixes

* **subagent-worktree:** release a dead writer's worktree to a new writer ([#95](https://github.com/srobroek/harness-plugins/issues/95)) ([5e88065](https://github.com/srobroek/harness-plugins/commit/5e880653ad897ed41a69cc41658dc2f941d0ad96)), closes [#106](https://github.com/srobroek/harness-plugins/issues/106) [#99](https://github.com/srobroek/harness-plugins/issues/99) [#100](https://github.com/srobroek/harness-plugins/issues/100) [#109](https://github.com/srobroek/harness-plugins/issues/109)

## subagent-worktree [0.8.1](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.8.0...subagent-worktree--v0.8.1) (2026-11-22)

## subagent-worktree [0.8.0](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.7.0...subagent-worktree--v0.8.0) (2026-11-22)

### Features

* **subagent-worktree:** remove lanes through one finalize path ([59eb833](https://github.com/srobroek/harness-plugins/commit/59eb833e5a84bfabcd5be1c1d8c8438dd73e9b50)), closes [#59](https://github.com/srobroek/harness-plugins/issues/59) [#81](https://github.com/srobroek/harness-plugins/issues/81)

### Bug Fixes

* **subagent-worktree:** disable filter drivers for reads that hash the work tree ([780eda5](https://github.com/srobroek/harness-plugins/commit/780eda579f53f9a5eff358c5a1cbe174ab04fd41)), closes [#79](https://github.com/srobroek/harness-plugins/issues/79) [#96](https://github.com/srobroek/harness-plugins/issues/96)
* **subagent-worktree:** drop inherited command-scope git config before pinning ([87b5a17](https://github.com/srobroek/harness-plugins/commit/87b5a1797a290420239d374ebcda92aa6685b35d)), closes [#96](https://github.com/srobroek/harness-plugins/issues/96)
* **subagent-worktree:** drop inherited repository selectors from the hardened git env ([60c5723](https://github.com/srobroek/harness-plugins/commit/60c572351ff7a6f3e6b7c748e71eca45f2820196)), closes [#96](https://github.com/srobroek/harness-plugins/issues/96)
* **subagent-worktree:** fence each eviction move against a start ([511dfa8](https://github.com/srobroek/harness-plugins/commit/511dfa8e2c5ffd9079fdb7f47932b93d0b73022f)), closes [#96](https://github.com/srobroek/harness-plugins/issues/96)
* **subagent-worktree:** keep the eviction guard after the on-demand sweep landed ([e9ff146](https://github.com/srobroek/harness-plugins/commit/e9ff146f450cde8e39e0d505d22cf2519b948cf7))
* **subagent-worktree:** move other sessions out of the checkout before removing it ([067f343](https://github.com/srobroek/harness-plugins/commit/067f343fdda68138ec381a4ff0184caa4089a83b))
* **subagent-worktree:** order the lock-wait race test with a barrier ([ebc4abd](https://github.com/srobroek/harness-plugins/commit/ebc4abd4794865029e637a527b6b40a8722e099d))
* **subagent-worktree:** prove HEAD and the tree again after the eviction ([fff6758](https://github.com/srobroek/harness-plugins/commit/fff67587df40e5401241985cf894159ed1590936)), closes [#96](https://github.com/srobroek/harness-plugins/issues/96)
* **subagent-worktree:** read liveness again after evicting the other sessions ([336d460](https://github.com/srobroek/harness-plugins/commit/336d4609f123d53c1271c39925b492d910d71c43))
* **subagent-worktree:** read the worktree list NUL-separated ([b00e988](https://github.com/srobroek/harness-plugins/commit/b00e98803913476cddb4931e33aed0e7c3a20263))
* **subagent-worktree:** refuse every git transport in the hardened env ([c1c5888](https://github.com/srobroek/harness-plugins/commit/c1c58887cb92012932a9f58c69616f51af5ca983)), closes [#79](https://github.com/srobroek/harness-plugins/issues/79) [#79](https://github.com/srobroek/harness-plugins/issues/79)
* **subagent-worktree:** require git 2.45 and run automatic git hardened ([3b6c86c](https://github.com/srobroek/harness-plugins/commit/3b6c86c81349e8fb65322aca3b6c68ec101d8869))
* **subagent-worktree:** restore the filter-driver edge-case regressions ([a3c417d](https://github.com/srobroek/harness-plugins/commit/a3c417df253c9bb59207ee0757e35f840fefb8fc)), closes [#79](https://github.com/srobroek/harness-plugins/issues/79) [#96](https://github.com/srobroek/harness-plugins/issues/96)
* **subagent-worktree:** restore the resume-fence regressions for two instances and a queued success ([2c992df](https://github.com/srobroek/harness-plugins/commit/2c992df86021cb036dc96b2cac9a3ecf5ce5704a))
* **subagent-worktree:** test a signed commit and merge against real git ([804015c](https://github.com/srobroek/harness-plugins/commit/804015cbc3eff030c0ee45604367dadbac5f93db))
* **subagent-worktree:** test the git-version refusal through the real spawnRunner ([819110d](https://github.com/srobroek/harness-plugins/commit/819110d30808c6e5cc8baac6a6dcc4f689051dec))
* **subagent-worktree:** test the hardening against real git, program by program ([9fb2eff](https://github.com/srobroek/harness-plugins/commit/9fb2eff6bc77a120dbc69c9ad04df3d1e9840e0c)), closes [#96](https://github.com/srobroek/harness-plugins/issues/96)
* **worktrunk:** harden the git env and skip project hooks ([5adff10](https://github.com/srobroek/harness-plugins/commit/5adff10b20abf498a702b767ec61448c15f86858))

## subagent-worktree [0.7.0](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.6.5...subagent-worktree--v0.7.0) (2026-11-22)

### Features

* **subagent-worktree:** on-demand sweep through finalize; one notice per lane and reason ([dd4867f](https://github.com/srobroek/harness-plugins/commit/dd4867f95b2704190fdfc6cc6ceb31144b843aa0))

## subagent-worktree [0.6.5](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.6.4...subagent-worktree--v0.6.5) (2026-11-22)

### Bug Fixes

* **subagent-worktree:** finish removing lanes at startup; move lane sessions home on Location not found ([#81](https://github.com/srobroek/harness-plugins/issues/81)) ([cd68894](https://github.com/srobroek/harness-plugins/commit/cd688944209246711a6717d4e7f7c059c900c8f8))

## subagent-worktree [0.6.4](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.6.3...subagent-worktree--v0.6.4) (2026-11-21)

### Bug Fixes

* **subagent-worktree:** drop the resume grace ([fe30538](https://github.com/srobroek/harness-plugins/commit/fe305388675ebdade4dac3ec8d1b33b56f5ad57c))

## subagent-worktree [0.6.3](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.6.2...subagent-worktree--v0.6.3) (2026-11-21)

### Bug Fixes

* **subagent-worktree:** harden automatic git calls against hostile repo config ([#79](https://github.com/srobroek/harness-plugins/issues/79)) ([b05559b](https://github.com/srobroek/harness-plugins/commit/b05559bf17a7777a4236ccdd6642c2fad06e6bc1))

## subagent-worktree [0.6.2](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.6.1...subagent-worktree--v0.6.2) (2026-11-21)

### Bug Fixes

* **code-challenge:** close dogfood friction in skill, schema and validation ([043a8b3](https://github.com/srobroek/harness-plugins/commit/043a8b39057ec8fca54d09adebb0532c2154e330))

## subagent-worktree [0.6.1](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.6.0...subagent-worktree--v0.6.1) (2026-11-21)

## subagent-worktree [0.6.0](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.5.0...subagent-worktree--v0.6.0) (2026-11-21)

### Features

* **subagent-worktree:** remove lanes through one finalize path ([#59](https://github.com/srobroek/harness-plugins/issues/59)) ([14d4dae](https://github.com/srobroek/harness-plugins/commit/14d4dae9287a4a815569da6f9172b5ace2f36774))

## subagent-worktree [0.5.0](https://github.com/srobroek/harness-plugins/compare/subagent-worktree--v0.4.0...subagent-worktree--v0.5.0) (2026-11-20)

### Features

* **lib:** add laneSessions and moveSessionsHome ([6374cb6](https://github.com/srobroek/harness-plugins/commit/6374cb6ec0b7eb39b3b2a1e59aeaedf0ef16f615))

# Changelog

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.3.0...subagent-worktree--v0.4.0) (2026-11-20)


### Features

* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))
* **subagent-worktree:** give ui-implementer a worktree by default ([b8d1292](https://github.com/srobroek/opencode-plugins/commit/b8d12923a57d616ec53ff0cae2b3e825b26435e6))


### Bug Fixes

* **subagent-worktree:** keep build directories of a child that may still run ([#269](https://github.com/srobroek/opencode-plugins/issues/269)) ([a1954fb](https://github.com/srobroek/opencode-plugins/commit/a1954fb46c2b2f6e325f33be684a4467a889737e))
* **subagent-worktree:** never remove a worktree whose child is still alive ([#239](https://github.com/srobroek/opencode-plugins/issues/239)) ([5695c34](https://github.com/srobroek/opencode-plugins/commit/5695c3492ec2271ec13c8d88339e10fe7771576a))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.5...subagent-worktree--v0.3.0) (2026-11-19)


### Features

* stop long tools and their processes on ToolContext.signal ([94c0ac5](https://github.com/srobroek/opencode-plugins/commit/94c0ac59e12df53eee73d3152da8523f10148bb0))
* **subagent-worktree:** free build dirs, handle closed-unmerged lanes, share delivery helpers ([14db9ad](https://github.com/srobroek/opencode-plugins/commit/14db9ad7a1eee5ca5bfde292b9d5822a5deed662))
* **subagent-worktree:** remove agent worktrees once their work lands ([1cbfd38](https://github.com/srobroek/opencode-plugins/commit/1cbfd38f569bd7ad7d04c99173edb2df55b0351f))


### Bug Fixes

* **subagent-worktree:** refuse a second live writer in a named worktree ([#202](https://github.com/srobroek/opencode-plugins/issues/202)) ([1c66f3e](https://github.com/srobroek/opencode-plugins/commit/1c66f3e9d710c40cc257bda9ea64e9e1a437ad59))
* **subagent-worktree:** send each lane notice once, and never for a worktree that is gone ([5de4799](https://github.com/srobroek/opencode-plugins/commit/5de4799c536cc67ef0b53326c08fcadd9ad034df))

## [0.2.5](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.4...subagent-worktree--v0.2.5) (2026-11-16)


### Bug Fixes

* **subagent-worktree:** ignore the Beads ledger when checking for tracked changes ([#174](https://github.com/srobroek/opencode-plugins/issues/174)) ([7167f51](https://github.com/srobroek/opencode-plugins/commit/7167f51ca2055385e87b901ecfd322c95cd55da2))

## [0.2.4](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.3...subagent-worktree--v0.2.4) (2026-11-13)


### Bug Fixes

* **subagent-worktree:** start the child on the spawn's resolved model and variant ([0f1f2d4](https://github.com/srobroek/opencode-plugins/commit/0f1f2d4bf60c3d04a4bd104f9847e95bf508bbba))

## [0.2.3](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.2...subagent-worktree--v0.2.3) (2026-11-11)


### Bug Fixes

* **subagent-worktree:** ignore worktree on resume, opt coder in, and skip lanes for dirty checkouts ([#121](https://github.com/srobroek/opencode-plugins/issues/121)) ([c1f1c47](https://github.com/srobroek/opencode-plugins/commit/c1f1c47e8d821ee198562dda3199c07446416656))

## [0.2.2](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.1...subagent-worktree--v0.2.2) (2026-11-05)


### Bug Fixes

* **subagent-worktree:** run in place when the repository has no commit yet ([#111](https://github.com/srobroek/opencode-plugins/issues/111)) ([d0ec69f](https://github.com/srobroek/opencode-plugins/commit/d0ec69f3f6f7cba13a5c833a5bf05f7d18ba90be))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.0...subagent-worktree--v0.2.1) (2026-10-30)


### Bug Fixes

* **subagent-worktree:** guard lane listing with permission ([85883ff](https://github.com/srobroek/opencode-plugins/commit/85883ff5f9b636cefd5f2bbba000a0ae33d6f477))
* **subagent-worktree:** move sessions before cleanup and skip unneeded lanes ([0671175](https://github.com/srobroek/opencode-plugins/commit/06711754dde181e1613980cc4049d142780ca68e))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.1.0...subagent-worktree--v0.2.0) (2026-10-27)


### Features

* **subagent-worktree:** adopt Ensemble merge safety and lane inventory ([0a95bd2](https://github.com/srobroek/opencode-plugins/commit/0a95bd23dd94ff7a5535fa38a31df72c141f1c70))
* **subagent-worktree:** run opted-in subagents in their own worktree ([0586821](https://github.com/srobroek/opencode-plugins/commit/05868212367ced70ce329d56aae68e2e8a606082))
* **subagent-worktree:** start subagents in a named worktree ([9c20954](https://github.com/srobroek/opencode-plugins/commit/9c209545deb91d7394ff90bb3aaa4ad96f573508))


### Bug Fixes

* **lib:** accept numeric signal codes from @types/bun 1.4.4 ([a3d2e42](https://github.com/srobroek/opencode-plugins/commit/a3d2e4225211d1a288fa3fed561e1c9d8e696284))
* **subagent-worktree:** bound git commands and guard lost exit events ([76b17dd](https://github.com/srobroek/opencode-plugins/commit/76b17dd6521f8e9cc6c0b4e20841ee095531f79e))


### Performance

* lead every tool description with a first line under 120 characters ([74b65d9](https://github.com/srobroek/opencode-plugins/commit/74b65d9f446fcc535320b7c320ccaf8482d594df))
