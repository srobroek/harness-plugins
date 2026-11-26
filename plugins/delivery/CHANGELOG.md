## delivery [0.17.0](https://github.com/srobroek/harness-plugins/compare/delivery--v0.16.3...delivery--v0.17.0) (2026-11-26)

### Features

* **delivery:** let pi's delivery_land skip its confirmation by setting ([#226](https://github.com/srobroek/harness-plugins/issues/226)) ([0d63fca](https://github.com/srobroek/harness-plugins/commit/0d63fca321cb92d6e657a19387eca2d71548fdf3))

## delivery [0.16.3](https://github.com/srobroek/harness-plugins/compare/delivery--v0.16.2...delivery--v0.16.3) (2026-11-26)

### Bug Fixes

* **delivery:** round-11 running-reports fixes ([#223](https://github.com/srobroek/harness-plugins/issues/223)) ([9a69443](https://github.com/srobroek/harness-plugins/commit/9a69443c83a67d25bb329c2c6260e2b3e5477ec6))

## delivery [0.16.2](https://github.com/srobroek/harness-plugins/compare/delivery--v0.16.1...delivery--v0.16.2) (2026-11-26)

### Bug Fixes

* **delivery:** round-10 running-reports fixes missed by [#131](https://github.com/srobroek/harness-plugins/issues/131) ([#222](https://github.com/srobroek/harness-plugins/issues/222)) ([3e4afbb](https://github.com/srobroek/harness-plugins/commit/3e4afbbe93e29ba9aed931d64546cc9ac34d62a2))

## delivery [0.16.1](https://github.com/srobroek/harness-plugins/compare/delivery--v0.16.0...delivery--v0.16.1) (2026-11-26)

### Bug Fixes

* **safety:** stop refusing read-only git over a quoted regex anchor; drop clone-to-temp guidance ([#216](https://github.com/srobroek/harness-plugins/issues/216)) ([a33afd8](https://github.com/srobroek/harness-plugins/commit/a33afd853a55d047fa64409058da684564b3e264))

## delivery [0.16.0](https://github.com/srobroek/harness-plugins/compare/delivery--v0.15.1...delivery--v0.16.0) (2026-11-26)

### Features

* **delivery:** ship delivery_land and the git-workflow skill on pi ([46eb74e](https://github.com/srobroek/harness-plugins/commit/46eb74e3066c203b412db9995ae0462b29daa5c9))

## delivery [0.15.1](https://github.com/srobroek/harness-plugins/compare/delivery--v0.15.0...delivery--v0.15.1) (2026-11-26)

### Bug Fixes

* **delivery:** honour configured GitLab hosts in land and cleanup ([2e1c1a5](https://github.com/srobroek/harness-plugins/commit/2e1c1a51553d75377891c436544d85f5418af8fc))

## delivery [0.15.0](https://github.com/srobroek/harness-plugins/compare/delivery--v0.14.0...delivery--v0.15.0) (2026-11-26)

### Features

* **delivery:** running reports, one raw report per session on disk ([c2029bd](https://github.com/srobroek/harness-plugins/commit/c2029bddce4ca7687f8c3d0b5ef635fee7be4453))

### Bug Fixes

* **delivery:** count landing records a parent's permissions hide as unreadable; test eviction through delivery's own registration ([24e628f](https://github.com/srobroek/harness-plugins/commit/24e628fc41bfafd5e579f91da3c76519e6211334))
* **delivery:** drop stale reports after deletion, filter fake events by type, count only ENOENT as no landing records, test eviction after collection ([8424188](https://github.com/srobroek/harness-plugins/commit/8424188702ea028b81f4d3c49456e4bfd39a9859))
* **delivery:** gate the report-ordering tests at the lock wait instead of polling ([5200463](https://github.com/srobroek/harness-plugins/commit/520046318eae1c98ac8e278c4f04045c21a55570))
* **delivery:** keep a clone registered under registry pressure until its landing records are collected ([708c695](https://github.com/srobroek/harness-plugins/commit/708c6950d1c122917b66f2576cdb79a69099c7c8))
* **delivery:** keep the registry parse error as cause; test lease causes for every update ([006d067](https://github.com/srobroek/harness-plugins/commit/006d067971cf1a3cb8b603561eaf8dc0fba44e85))
* **delivery:** lift an unsafe mark only after a write that landed; acknowledge pending fake emits on close; drop the intermediate report-count assertion ([92a9e5e](https://github.com/srobroek/harness-plugins/commit/92a9e5e5ea8b7f7410bf35d426ecf771982fadc6))
* **delivery:** no vetoes from empty reports, clear them on deletion or for left-out clones, log the blocking session, reread the registry after the session listing ([8a76e12](https://github.com/srobroek/harness-plugins/commit/8a76e12638b8dedddfbb41ef3912636c7b8f1ccf))
* **delivery:** one ordered store for every veto: clears leave a tombstone, clone vetoes keyed by the registry's repository identity ([f866ed9](https://github.com/srobroek/harness-plugins/commit/f866ed946316d9003567cee0b891895f611e7ae6))
* **delivery:** one ordered store for every veto: clears leave a tombstone, clone vetoes keyed by the registry's repository identity (restore the ordered raise) ([bf19370](https://github.com/srobroek/harness-plugins/commit/bf193705f0bef08bda0f0cb7b5235657fb762a85))
* **delivery:** one report-ordered rule for every veto and unsafe mark ([50dc6c3](https://github.com/srobroek/harness-plugins/commit/50dc6c395a33da5c4e5c7bc540ed23096f094659))
* **delivery:** order veto clears and holds by report, keep report state only while reports are in flight ([a7773e9](https://github.com/srobroek/harness-plugins/commit/a7773e9c028576ef26697c0fc1ba19a6f4b67086))
* **delivery:** read a registry under a non-directory as absent ([94fa449](https://github.com/srobroek/harness-plugins/commit/94fa449e5ec02e2b113f0880d633e7b1476a7d3d))
* **delivery:** rebuild the bundle ([624da1b](https://github.com/srobroek/harness-plugins/commit/624da1ba16e0d92f8d772c330483cb30ba056735))
* **delivery:** rebuild the bundle ([a213689](https://github.com/srobroek/harness-plugins/commit/a213689ec6764caf73e13cfcac4edd83fd62e0a7))
* **delivery:** rebuild the bundle ([6e436bc](https://github.com/srobroek/harness-plugins/commit/6e436bc11b4f8cb1f0d5d970764dca94af514867))
* **delivery:** rebuild the bundle; fix a lint error in the clone gate ([489f90c](https://github.com/srobroek/harness-plugins/commit/489f90c7312a2313521ae97f903df0ecaafefdec))
* **delivery:** rebuild the bundle; type the receipts helper's work as any promise ([a69b1cc](https://github.com/srobroek/harness-plugins/commit/a69b1cccb084650ad23fa5591a22abb65ecc7702))
* **delivery:** run clone discovery before removal, keep hold vetoes per reporting session until reconciled, recheck them after the session listing ([6cbbad2](https://github.com/srobroek/harness-plugins/commit/6cbbad2267fb358868411cd04ea745f40df2dbd0))
* **delivery:** the running-reports store takes a lease, tells servers apart, reads files bounded, and judges a job's cwd ([448f0a3](https://github.com/srobroek/harness-plugins/commit/448f0a354aacdbbea31f71df586959519500638b))
* **delivery:** veto removal when holds or the clone registry are unknown, surface registry errors ([828b5bb](https://github.com/srobroek/harness-plugins/commit/828b5bb3a6409842e148d7247d8341f4abcbb97a))

## delivery [0.14.0](https://github.com/srobroek/harness-plugins/compare/delivery--v0.13.1...delivery--v0.14.0) (2026-11-25)

### Features

* **delivery:** add an explicit delivery_cleanup tool for pi and OMP ([dfed416](https://github.com/srobroek/harness-plugins/commit/dfed416a728eb0977e28c29d9501e05d4a15b9dd))
* **delivery:** document the pi delivery_cleanup and test its partial-removal outcome ([4c0350f](https://github.com/srobroek/harness-plugins/commit/4c0350fa642e724ea3295e09b1651b2fe0ed157a))

## delivery [0.13.1](https://github.com/srobroek/harness-plugins/compare/delivery--v0.13.0...delivery--v0.13.1) (2026-11-25)

### Bug Fixes

* **delivery:** keep every job when two receipts spell one worktree differently ([23e4a36](https://github.com/srobroek/harness-plugins/commit/23e4a36afa45498c08626648ef123a175accb563))
* **delivery:** keep git's dirty-tree refusal a refusal and never advise a destructive command ([db60f6a](https://github.com/srobroek/harness-plugins/commit/db60f6ac83d7d892a16a9945dc69c109f6b30b23))
* **delivery:** match git's clean-check refusal only on its own line and exit 128 ([ae777d3](https://github.com/srobroek/harness-plugins/commit/ae777d35c06e04c5eb816858f51160489c85f069))
* **delivery:** name the cause, not a removal command, in the deleted-files refusal ([3e9c23e](https://github.com/srobroek/harness-plugins/commit/3e9c23e3ea2fa4f7ace7d842aabe732c3dfbbfe2))
* **delivery:** quote git's removal and branch-delete messages without their deleting hints ([30fe1d0](https://github.com/srobroek/harness-plugins/commit/30fe1d0c302eba1b678734b37a63c23b2439ad7c))
* **delivery:** report git's clean-check refusal as a refusal, not this call's partial removal ([8e13172](https://github.com/srobroek/harness-plugins/commit/8e13172be0762b8e55038441532f86479d6dd36f))
* **delivery:** say the README guarantee is about forcing commands ([a9bd32a](https://github.com/srobroek/harness-plugins/commit/a9bd32a5f0424416beb42b875c88af290afba279))
* **delivery:** say when a blocking hold is a pending one, how old it is and which file ([6b9b241](https://github.com/srobroek/harness-plugins/commit/6b9b2418592d5f990e47f2a37f1421f6863b7261))
* **delivery:** say when a pending hold's file is safe to delete ([f129089](https://github.com/srobroek/harness-plugins/commit/f1290898725538f083b4d14988f3679d5fe35883))
* **delivery:** write every worktree's pending hold before any lock wait ([61872b2](https://github.com/srobroek/harness-plugins/commit/61872b2f285fba808cb9346fda34ca0cfd2c5cba))

## delivery [0.13.0](https://github.com/srobroek/harness-plugins/compare/delivery--v0.12.7...delivery--v0.13.0) (2026-11-25)

### Features

* **agent-reviewer:** flag hand-written contract types and edits to generated output ([26e05ad](https://github.com/srobroek/harness-plugins/commit/26e05adeddebffb8e65f60c87030a8e074bb7b9c))

### Bug Fixes

* **agent-reviewer:** flag serialized or published contracts with no authoritative source ([e4ec4b0](https://github.com/srobroek/harness-plugins/commit/e4ec4b0092cfab0cdf4b4f35015f77f6a21f828e))
* **agent-reviewer:** name AsyncAPI channels and bindings as an authoritative contract source ([503076c](https://github.com/srobroek/harness-plugins/commit/503076ce4b06b33084a0c34ed1a87fe07494e1f7))

## delivery [0.12.7](https://github.com/srobroek/harness-plugins/compare/delivery--v0.12.6...delivery--v0.12.7) (2026-11-25)

### Bug Fixes

* **delivery:** keep a hold write from being starved by the cleanup lock ([ac2cb67](https://github.com/srobroek/harness-plugins/commit/ac2cb67d4f2ca2489a94b955a63f5a3877bd0d49))
* **delivery:** prove cleanup targets under the remover lock and never refuse after a removal ([beb7f68](https://github.com/srobroek/harness-plugins/commit/beb7f68b970f3d807547fabc24fc1ea1b0e307c3))
* **delivery:** report a removal that stopped part-way as partly removed, not as a refusal ([4ce8163](https://github.com/srobroek/harness-plugins/commit/4ce816399fbcee46315e399c0d38b5472835300d))

## delivery [0.12.6](https://github.com/srobroek/harness-plugins/compare/delivery--v0.12.5...delivery--v0.12.6) (2026-11-25)

### Bug Fixes

* **delivery,autopilot,model-roles:** resubscribe event watchers after a stream error ([#153](https://github.com/srobroek/harness-plugins/issues/153)) ([28e6922](https://github.com/srobroek/harness-plugins/commit/28e6922dfa90dea8b4b87bafe388f20fd71cbc58))

## delivery [0.12.5](https://github.com/srobroek/harness-plugins/compare/delivery--v0.12.4...delivery--v0.12.5) (2026-11-24)

### Bug Fixes

* **agent-reviewer:** tell OMP agents that keep a shell it is unrestricted ([#173](https://github.com/srobroek/harness-plugins/issues/173)) ([1b8386d](https://github.com/srobroek/harness-plugins/commit/1b8386dbf43fa6cb5580d4dbc03e619476ba023c))

## delivery [0.12.4](https://github.com/srobroek/harness-plugins/compare/delivery--v0.12.3...delivery--v0.12.4) (2026-11-24)

### Bug Fixes

* **tools:** restore portable MCP defaults ([f4c4930](https://github.com/srobroek/harness-plugins/commit/f4c4930b68477b6c050cc3e0a6ed62b6b8f8d402))

## delivery [0.12.3](https://github.com/srobroek/harness-plugins/compare/delivery--v0.12.2...delivery--v0.12.3) (2026-11-24)

### Bug Fixes

* **agent-researcher:** clarify beadless research scope ([b98d372](https://github.com/srobroek/harness-plugins/commit/b98d3722ac5cffd6bd4dbe223c36a163466cc350))
* **agent-researcher:** make Beads lifecycle conditional ([23b369c](https://github.com/srobroek/harness-plugins/commit/23b369cc514a869e8cd6fc48e69aa9bf9ad53280))
* **beads:** rename the store-pin env marker to HARNESS_BEADS_PIN ([f111b05](https://github.com/srobroek/harness-plugins/commit/f111b051e312b4fd6155486e45e145a9a199bc95))
* **delivery:** align shared reviewer workflow ([7c5814e](https://github.com/srobroek/harness-plugins/commit/7c5814ea37bd8210151de0e7f97f56293eb02ec5))
* **delivery:** make dev checks and tool integrations configurable ([7b66397](https://github.com/srobroek/harness-plugins/commit/7b663976738a90ed05b544c56109a5e3cc4f91e3))

## delivery [0.12.2](https://github.com/srobroek/harness-plugins/compare/delivery--v0.12.1...delivery--v0.12.2) (2026-11-23)

### Bug Fixes

* **whats-new:** grant MCP tools to the whats-new research agent ([8ae7fe0](https://github.com/srobroek/harness-plugins/commit/8ae7fe05c65e2df2f53ebf944c8f9bd5b7625cf9))

## delivery [0.12.1](https://github.com/srobroek/harness-plugins/compare/delivery--v0.12.0...delivery--v0.12.1) (2026-11-23)

### Bug Fixes

* make every plugin agent's OMP form correct ([96b7bfe](https://github.com/srobroek/harness-plugins/commit/96b7bfea3c35017b34a28f59e81fb059f6c68a24))
* **subagent-worktree:** drop project-wide session eviction from finalize ([398ba17](https://github.com/srobroek/harness-plugins/commit/398ba1791911536abc585fd37a129e83347e1e9b))

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
