## autopilot [1.4.2](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.4.1...autopilot--v1.4.2) (2026-11-25)

### Bug Fixes

* **delivery,autopilot,model-roles:** resubscribe event watchers after a stream error ([#153](https://github.com/srobroek/harness-plugins/issues/153)) ([28e6922](https://github.com/srobroek/harness-plugins/commit/28e6922dfa90dea8b4b87bafe388f20fd71cbc58))

## autopilot [1.4.1](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.4.0...autopilot--v1.4.1) (2026-11-24)

## autopilot [1.4.0](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.3.8...autopilot--v1.4.0) (2026-11-24)

### Features

* **autopilot:** port autopilot to pi as an extension ([91f1ee4](https://github.com/srobroek/harness-plugins/commit/91f1ee4f86e268b28f34aca8288717cf850de601))

### Bug Fixes

* **autopilot:** queue pi prompts as follow-ups ([9773642](https://github.com/srobroek/harness-plugins/commit/97736426f374104bb6bc4272c5ea395c9e38be11))

## autopilot [1.3.8](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.3.7...autopilot--v1.3.8) (2026-11-23)

### Bug Fixes

* **autopilot:** retry failed parent lookups, harden takeClaims ([#135](https://github.com/srobroek/harness-plugins/issues/135)) ([b5ed7a2](https://github.com/srobroek/harness-plugins/commit/b5ed7a2dfbc9d135b618a57798a81241cc7d2a73))

## autopilot [1.3.7](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.3.6...autopilot--v1.3.7) (2026-11-23)

### Bug Fixes

* make every plugin agent's OMP form correct ([96b7bfe](https://github.com/srobroek/harness-plugins/commit/96b7bfea3c35017b34a28f59e81fb059f6c68a24))

## autopilot [1.3.6](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.3.5...autopilot--v1.3.6) (2026-11-23)

### Bug Fixes

* **autopilot:** journal a blocker when every scope read fails ([b6ac173](https://github.com/srobroek/harness-plugins/commit/b6ac173ff1a94d8f2d807d267afeb4d199b9013f))

## autopilot [1.3.5](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.3.4...autopilot--v1.3.5) (2026-11-23)

### Bug Fixes

* **autopilot:** treat an empty or failed scope read as unknown, not finished ([#125](https://github.com/srobroek/harness-plugins/issues/125)) ([81e26de](https://github.com/srobroek/harness-plugins/commit/81e26de9c5be0ba30022ca679a70ae7e1cf12136))

## autopilot [1.3.4](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.3.3...autopilot--v1.3.4) (2026-11-22)

### Bug Fixes

* **beads:** follow bd 1.3.1 ledger precedence for claim tracking ([#89](https://github.com/srobroek/harness-plugins/issues/89)) ([cbe4a76](https://github.com/srobroek/harness-plugins/commit/cbe4a76182c36d3b165e27ecbe311071a3068682))

## autopilot [1.3.3](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.3.2...autopilot--v1.3.3) (2026-11-22)

### Bug Fixes

* **subagent-worktree:** require git 2.45 and run automatic git hardened ([3b6c86c](https://github.com/srobroek/harness-plugins/commit/3b6c86c81349e8fb65322aca3b6c68ec101d8869))

## autopilot [1.3.2](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.3.1...autopilot--v1.3.2) (2026-11-21)

### Bug Fixes

* **code-challenge:** close dogfood friction in skill, schema and validation ([043a8b3](https://github.com/srobroek/harness-plugins/commit/043a8b39057ec8fca54d09adebb0532c2154e330))

## autopilot [1.3.1](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.3.0...autopilot--v1.3.1) (2026-11-21)

## autopilot [1.3.0](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.2.0...autopilot--v1.3.0) (2026-11-21)

### Features

* **autopilot:** autopilot_review for a plugin-run verdict a merge can rest on ([10d47e7](https://github.com/srobroek/harness-plugins/commit/10d47e798ea4b1f8e81e17362bcc5537d5942b18))

## autopilot [1.2.0](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.1.2...autopilot--v1.2.0) (2026-11-21)

### Features

* **autopilot:** autopilot_export_review for read-only reviewers ([353abe2](https://github.com/srobroek/harness-plugins/commit/353abe2355f824084499faebdb34734c3c40e26d))

## autopilot [1.1.2](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.1.1...autopilot--v1.1.2) (2026-11-21)

### Bug Fixes

* **autopilot:** pin each run to its own beads ledger ([632df34](https://github.com/srobroek/harness-plugins/commit/632df349e038dd96ed758c5a3d661872d8f9b68a))

## autopilot [1.1.1](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.1.0...autopilot--v1.1.1) (2026-11-21)

### Bug Fixes

* **autopilot:** journal a stale write from autopilot_log as an issue ([4f26159](https://github.com/srobroek/harness-plugins/commit/4f2615948c995b8ccd2f2f7672cc2a65fa2ae56e))

## autopilot [1.1.0](https://github.com/srobroek/harness-plugins/compare/autopilot--v1.0.0...autopilot--v1.1.0) (2026-11-21)

### Features

* **autopilot:** auto-allow the run's own worktrees and merge through a typed tool ([f126be7](https://github.com/srobroek/harness-plugins/commit/f126be7ee27e1e773e4396ad0bcf58da87d3f367))

### Bug Fixes

* **autopilot:** fail closed on unreadable protection and merge queues, confirm the merge from the PR ([9e5ed9d](https://github.com/srobroek/harness-plugins/commit/9e5ed9d94f299456a6d7c606435bb60f4cc93c5e))
* **autopilot:** merge through the synchronous REST endpoint and re-check base and head first ([5eac813](https://github.com/srobroek/harness-plugins/commit/5eac8137ada9ed93553239e39b7a13b6412c4325))
* **autopilot:** review-only approval, bound worktree identity, full checks and explicit merge method ([a888673](https://github.com/srobroek/harness-plugins/commit/a888673f410701b98818d437fb5f22984bac0ed8))

## autopilot 1.0.0 (2026-11-21)

### Features

* **autopilot:** unattended runs with a journal, a 4-minute tick and stop conditions ([2081cc8](https://github.com/srobroek/harness-plugins/commit/2081cc85effd8eb9ff671d5e1de90197451c4a51))

### Bug Fixes

* **autopilot:** close gate bypasses, fence state writes atomically, bind ticks, retry stop artifacts ([85ddd9b](https://github.com/srobroek/harness-plugins/commit/85ddd9b6fdbf6205c85c609b20b46726ef0a015b))
* **autopilot:** close permission bypasses, serialize run state and keep tick signals ([0aa467a](https://github.com/srobroek/harness-plugins/commit/0aa467aa70d3725c848a23ac7c59b28e97913d34))
* **autopilot:** decode only git command words, synchronize the resume race test ([c7332d7](https://github.com/srobroek/harness-plugins/commit/c7332d77b09393671a73c49f77f03d4860faa5e7))
* **autopilot:** decode quoted refspecs, rebind resume under the run lock, report incomplete reads ([6aed858](https://github.com/srobroek/harness-plugins/commit/6aed8587d64b6f0829fccccb46bd3b9b0e0629d0))
* **autopilot:** deny every permission ask while armed, own the state write lock, keep the handoff pending on a failed lookup ([56ffe32](https://github.com/srobroek/harness-plugins/commit/56ffe32e29ae60de3d8f230c97d98733b37ffb20))
* **autopilot:** fail-closed permission gate, fenced run state under a file lock, strict run file reads ([6366fe9](https://github.com/srobroek/harness-plugins/commit/6366fe99280d93801a28200d7d8c525b0811260a))
* **autopilot:** store run state as versioned, create-exclusive generation files ([2be1532](https://github.com/srobroek/harness-plugins/commit/2be1532333e876291371d93fa02c78915ee3ee6e))
