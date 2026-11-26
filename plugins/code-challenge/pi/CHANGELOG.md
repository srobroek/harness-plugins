## code-challenge [2.2.1](https://github.com/srobroek/harness-plugins/compare/code-challenge--v2.2.0...code-challenge--v2.2.1) (2026-11-26)

### Bug Fixes

* **code-challenge:** make the challenger's delegation section harness-neutral ([#212](https://github.com/srobroek/harness-plugins/issues/212)) ([c4020d9](https://github.com/srobroek/harness-plugins/commit/c4020d98d273517a78f3bdfbb650ee55b6618657))

## code-challenge [2.2.0](https://github.com/srobroek/harness-plugins/compare/code-challenge--v2.1.3...code-challenge--v2.2.0) (2026-11-26)

### Features

* challenger delegation, model families in the guard, one Pi adversarial-challenger ([#207](https://github.com/srobroek/harness-plugins/issues/207)) ([deb6d8e](https://github.com/srobroek/harness-plugins/commit/deb6d8e2a52dbe431ab4b256b8a53289bd418645))

## code-challenge [2.1.3](https://github.com/srobroek/harness-plugins/compare/code-challenge--v2.1.2...code-challenge--v2.1.3) (2026-11-25)

### Bug Fixes

* **code-challenge:** give the OMP refactor challenger a shell ([f2075a6](https://github.com/srobroek/harness-plugins/commit/f2075a61aa475bd1d7cbb700dd063e768095ab71))

## code-challenge [2.1.2](https://github.com/srobroek/harness-plugins/compare/code-challenge--v2.1.1...code-challenge--v2.1.2) (2026-11-25)

### Bug Fixes

* **code-challenge:** declare the Pi challengers read-only for acceptance ([0f879b4](https://github.com/srobroek/harness-plugins/commit/0f879b4ff5f9c03ab6f72d26826c4348adec8ec2))
* **code-challenge:** give the Pi challengers their tools, skills and providers ([6eb17ce](https://github.com/srobroek/harness-plugins/commit/6eb17ceac34722e99f973697cc13f33196d409a3))

## code-challenge [2.1.1](https://github.com/srobroek/harness-plugins/compare/code-challenge--v2.1.0...code-challenge--v2.1.1) (2026-11-24)

### Bug Fixes

* **agent-reviewer:** tell OMP agents that keep a shell it is unrestricted ([#173](https://github.com/srobroek/harness-plugins/issues/173)) ([1b8386d](https://github.com/srobroek/harness-plugins/commit/1b8386dbf43fa6cb5580d4dbc03e619476ba023c))

## code-challenge [2.1.0](https://github.com/srobroek/harness-plugins/compare/code-challenge--v2.0.3...code-challenge--v2.1.0) (2026-11-24)

### Features

* **agent-reviewer:** grant Pi subagents tools ([159ad02](https://github.com/srobroek/harness-plugins/commit/159ad02eac3b9ba206d568a93877c2dedd5e9036))

## code-challenge [2.0.3](https://github.com/srobroek/harness-plugins/compare/code-challenge--v2.0.2...code-challenge--v2.0.3) (2026-11-24)

## code-challenge [2.0.2](https://github.com/srobroek/harness-plugins/compare/code-challenge--v2.0.1...code-challenge--v2.0.2) (2026-11-24)

### Bug Fixes

* **design:** make MCP servers opt-in ([1ecb493](https://github.com/srobroek/harness-plugins/commit/1ecb493f35ebfe9112f9e4661fa1b2e5ec457fc4))
* **tools:** restore portable MCP defaults ([f4c4930](https://github.com/srobroek/harness-plugins/commit/f4c4930b68477b6c050cc3e0a6ed62b6b8f8d402))

## code-challenge [2.0.1](https://github.com/srobroek/harness-plugins/compare/code-challenge--v2.0.0...code-challenge--v2.0.1) (2026-11-23)

### Bug Fixes

* **whats-new:** grant MCP tools to the whats-new research agent ([8ae7fe0](https://github.com/srobroek/harness-plugins/commit/8ae7fe05c65e2df2f53ebf944c8f9bd5b7625cf9))

## code-challenge [2.0.0](https://github.com/srobroek/harness-plugins/compare/code-challenge--v1.5.1...code-challenge--v2.0.0) (2026-11-23)

### ⚠ BREAKING CHANGES

* **code-challenge:** challenge_scan's staticOnly input is removed. Scans are static-only by default; pass allowCode: true to run analyzers that execute repository or downloaded code. The scan never prompts for consent.

### Features

* **code-challenge:** ship to OMP as an extension over its TypeScript ([#146](https://github.com/srobroek/harness-plugins/issues/146)) ([a1cfd1f](https://github.com/srobroek/harness-plugins/commit/a1cfd1f1064a7ca44a2b45a3fe1d762f0af3ea92))

## code-challenge [1.5.1](https://github.com/srobroek/harness-plugins/compare/code-challenge--v1.5.0...code-challenge--v1.5.1) (2026-11-23)

### Bug Fixes

* make every plugin agent's OMP form correct ([96b7bfe](https://github.com/srobroek/harness-plugins/commit/96b7bfea3c35017b34a28f59e81fb059f6c68a24))

## code-challenge [1.5.0](https://github.com/srobroek/harness-plugins/compare/code-challenge--v1.4.0...code-challenge--v1.5.0) (2026-11-22)

### Features

* **delivery:** ship the orchestrator agent ([#121](https://github.com/srobroek/harness-plugins/issues/121)) ([53f33c0](https://github.com/srobroek/harness-plugins/commit/53f33c016315732220a7c87066267931ee87f514))

### Bug Fixes

* **code-challenge:** close five dogfood friction gaps in the skill text ([#120](https://github.com/srobroek/harness-plugins/issues/120)) ([4a7dac3](https://github.com/srobroek/harness-plugins/commit/4a7dac3eff8684b6da163f93b38eb24ae7f6b2ea))

## code-challenge [1.4.0](https://github.com/srobroek/harness-plugins/compare/code-challenge--v1.3.1...code-challenge--v1.4.0) (2026-11-22)

### Features

* **code-challenge:** add scope lens for design and docs conformance ([#116](https://github.com/srobroek/harness-plugins/issues/116)) ([8a9680b](https://github.com/srobroek/harness-plugins/commit/8a9680b0874b19b956a5a37d7d250269f7570def))

## code-challenge [1.3.1](https://github.com/srobroek/harness-plugins/compare/code-challenge--v1.3.0...code-challenge--v1.3.1) (2026-11-21)

### Bug Fixes

* **code-challenge:** close dogfood friction in skill, schema and validation ([043a8b3](https://github.com/srobroek/harness-plugins/commit/043a8b39057ec8fca54d09adebb0532c2154e330))

## code-challenge [1.3.0](https://github.com/srobroek/harness-plugins/compare/code-challenge--v1.2.0...code-challenge--v1.3.0) (2026-11-21)

### Features

* **code-challenge:** challenge_scan analyzer recipes and runner ([73df850](https://github.com/srobroek/harness-plugins/commit/73df850a716a6e3aa2dbbb2f70227031d52302c3))

## code-challenge [1.2.0](https://github.com/srobroek/harness-plugins/compare/code-challenge--v1.1.0...code-challenge--v1.2.0) (2026-11-21)

### Features

* **code-challenge:** give the challengers the read-only shell ([073c537](https://github.com/srobroek/harness-plugins/commit/073c53744e5675b92e7d8e69c420683e60419faa))

### Bug Fixes

* **code-challenge:** rebuild with the hardened read-only shell rules ([a625c97](https://github.com/srobroek/harness-plugins/commit/a625c979af933dadd5f7fed1962ad99eb6081782))

## code-challenge [1.1.0](https://github.com/srobroek/harness-plugins/compare/code-challenge--v1.0.0...code-challenge--v1.1.0) (2026-11-21)

### Features

* **code-challenge:** add challenge_lib_facts for package registry, OSV and GitHub facts ([#28](https://github.com/srobroek/harness-plugins/issues/28)) ([4c55530](https://github.com/srobroek/harness-plugins/commit/4c55530fdb88c070fe73eaa9a8103aa586b9fa4c))

## code-challenge 1.0.0 (2026-11-21)

### Features

* **code-challenge:** add the code-challenge plugin ([#30](https://github.com/srobroek/harness-plugins/issues/30)) ([82baa11](https://github.com/srobroek/harness-plugins/commit/82baa116b647fc293a17318e11cf132ff9c39151))
