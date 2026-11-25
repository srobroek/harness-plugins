## safety [0.14.6](https://github.com/srobroek/harness-plugins/compare/safety--v0.14.5...safety--v0.14.6) (2026-11-25)

### Bug Fixes

* **delivery,autopilot,model-roles:** resubscribe event watchers after a stream error ([#153](https://github.com/srobroek/harness-plugins/issues/153)) ([28e6922](https://github.com/srobroek/harness-plugins/commit/28e6922dfa90dea8b4b87bafe388f20fd71cbc58))

## safety [0.14.5](https://github.com/srobroek/harness-plugins/compare/safety--v0.14.4...safety--v0.14.5) (2026-11-24)

### Bug Fixes

* **safety:** load on hosts whose plugin effect module lacks Tool ([#169](https://github.com/srobroek/harness-plugins/issues/169)) ([1543acd](https://github.com/srobroek/harness-plugins/commit/1543acd3908001b8339176f35de92fc1af45233f))

## safety [0.14.4](https://github.com/srobroek/harness-plugins/compare/safety--v0.14.3...safety--v0.14.4) (2026-11-24)

## safety [0.14.3](https://github.com/srobroek/harness-plugins/compare/safety--v0.14.2...safety--v0.14.3) (2026-11-24)

### Bug Fixes

* **safety:** read git wrappers from the gitWrappers option ([4da3a61](https://github.com/srobroek/harness-plugins/commit/4da3a6175ea0890c3492b820b01488514cf1a4b4))

## safety [0.14.2](https://github.com/srobroek/harness-plugins/compare/safety--v0.14.1...safety--v0.14.2) (2026-11-24)

## safety [0.14.1](https://github.com/srobroek/harness-plugins/compare/safety--v0.14.0...safety--v0.14.1) (2026-11-23)

### Bug Fixes

* **whats-new:** grant MCP tools to the whats-new research agent ([8ae7fe0](https://github.com/srobroek/harness-plugins/commit/8ae7fe05c65e2df2f53ebf944c8f9bd5b7625cf9))

## safety [0.14.0](https://github.com/srobroek/harness-plugins/compare/safety--v0.13.1...safety--v0.14.0) (2026-11-23)

### Features

* **safety:** add pi extension layered on cc-safety-net ([42cb883](https://github.com/srobroek/harness-plugins/commit/42cb88359abd6cbd6276c558d0843024a115b2cd))
* **safety:** add pi gates for profiles, system permissions, fork bombs, disks and power ([1d23923](https://github.com/srobroek/harness-plugins/commit/1d2392376378fad93afae85ae4619ec8ab8022df))
* **safety:** remove the Git Defender and Route 53 parent-marker gates ([8bdb0e5](https://github.com/srobroek/harness-plugins/commit/8bdb0e58ae24d1c16b84541f9239b793246a8737))

## safety [0.13.1](https://github.com/srobroek/harness-plugins/compare/safety--v0.13.0...safety--v0.13.1) (2026-11-23)

### Bug Fixes

* make every plugin agent's OMP form correct ([96b7bfe](https://github.com/srobroek/harness-plugins/commit/96b7bfea3c35017b34a28f59e81fb059f6c68a24))

## safety [0.13.0](https://github.com/srobroek/harness-plugins/compare/safety--v0.12.2...safety--v0.13.0) (2026-11-22)

### Features

* **delivery:** ship the orchestrator agent ([#121](https://github.com/srobroek/harness-plugins/issues/121)) ([53f33c0](https://github.com/srobroek/harness-plugins/commit/53f33c016315732220a7c87066267931ee87f514))

## safety [0.12.2](https://github.com/srobroek/harness-plugins/compare/safety--v0.12.1...safety--v0.12.2) (2026-11-22)

### Bug Fixes

* **safety:** allow a root session to read one non-secret file outside the repo ([0ffd2ec](https://github.com/srobroek/harness-plugins/commit/0ffd2ecef788365a379f6d1aeb8312df959b7fbf)), closes [#109](https://github.com/srobroek/harness-plugins/issues/109)

## safety [0.12.1](https://github.com/srobroek/harness-plugins/compare/safety--v0.12.0...safety--v0.12.1) (2026-11-22)

### Bug Fixes

* **safety:** detect hook frameworks by generated markers ([c20a19f](https://github.com/srobroek/harness-plugins/commit/c20a19fe9a1957ceae8995395e6d3fdb6ceb0d3d))

## safety [0.12.0](https://github.com/srobroek/harness-plugins/compare/safety--v0.11.5...safety--v0.12.0) (2026-11-22)

### Features

* **safety:** refuse plain git push to a configured host (pushVia) ([#88](https://github.com/srobroek/harness-plugins/issues/88)) ([e101dde](https://github.com/srobroek/harness-plugins/commit/e101dde80fb5da9b3bfb8ffdee68cf8a6cf01eed))

## safety [0.11.5](https://github.com/srobroek/harness-plugins/compare/safety--v0.11.4...safety--v0.11.5) (2026-11-22)

### Bug Fixes

* **subagent-worktree:** require git 2.45 and run automatic git hardened ([3b6c86c](https://github.com/srobroek/harness-plugins/commit/3b6c86c81349e8fb65322aca3b6c68ec101d8869))

## safety [0.11.4](https://github.com/srobroek/harness-plugins/compare/safety--v0.11.3...safety--v0.11.4) (2026-11-22)

### Bug Fixes

* **safety:** defer to host rules when the internal review fails ([a40b658](https://github.com/srobroek/harness-plugins/commit/a40b658d169c4aa5a050178d7a719953a881444f))

## safety [0.11.3](https://github.com/srobroek/harness-plugins/compare/safety--v0.11.2...safety--v0.11.3) (2026-11-22)

### Bug Fixes

* **safety:** resubscribe and tear down the permission prompt watch safely ([#93](https://github.com/srobroek/harness-plugins/issues/93)) ([15b636e](https://github.com/srobroek/harness-plugins/commit/15b636e2fa61cbd5bf2be3be7f282751d07859af))

## safety [0.11.2](https://github.com/srobroek/harness-plugins/compare/safety--v0.11.1...safety--v0.11.2) (2026-11-22)

### Bug Fixes

* **safety:** trust a skill directory whole only when it is a dedicated skills/<dir> ([#85](https://github.com/srobroek/harness-plugins/issues/85)) ([57b4b53](https://github.com/srobroek/harness-plugins/commit/57b4b53e483eafc1f891ee3bb979b7aead997a9d))

## safety [0.11.1](https://github.com/srobroek/harness-plugins/compare/safety--v0.11.0...safety--v0.11.1) (2026-11-22)

### Bug Fixes

* **safety:** treat glob and include/exclude option values as data in the rewrite fallback ([#83](https://github.com/srobroek/harness-plugins/issues/83)) ([45ee5fe](https://github.com/srobroek/harness-plugins/commit/45ee5fe60bce90d47a18d97e40db31fa15342a53))

## safety [0.11.0](https://github.com/srobroek/harness-plugins/compare/safety--v0.10.0...safety--v0.11.0) (2026-11-21)

### Features

* **safety:** relax subagent external_directory asks ([dba194a](https://github.com/srobroek/harness-plugins/commit/dba194a44931234efb54cce1f8d16b7d4be07fd0))

## safety [0.10.0](https://github.com/srobroek/harness-plugins/compare/safety--v0.9.3...safety--v0.10.0) (2026-11-21)

### Features

* **safety:** let subagents read outside the session directory, allow symlink aliases and tool-output folders ([6888618](https://github.com/srobroek/harness-plugins/commit/68886186a55fb554ae4ef65354fd0d53e7dfa71d))

### Bug Fixes

* **safety:** follow a dangling symlink when checking a subagent read for secrets ([1d1bb89](https://github.com/srobroek/harness-plugins/commit/1d1bb896e2f05256f845878c49dd2367391a3e43))
* **safety:** refuse ancestors and symlinked secrets for subagent reads, test the hook, name the option subagentSecretPaths ([b0ca47d](https://github.com/srobroek/harness-plugins/commit/b0ca47d01c6316e9bb7adbbb636b6df34ea92bfe))

## safety [0.9.3](https://github.com/srobroek/harness-plugins/compare/safety--v0.9.2...safety--v0.9.3) (2026-11-21)

### Bug Fixes

* **safety:** resolve symlinks before excluding broad skill roots ([0c2355c](https://github.com/srobroek/harness-plugins/commit/0c2355cdec427af1184946a5ec64c8083f6de16a))

## safety [0.9.2](https://github.com/srobroek/harness-plugins/compare/safety--v0.9.1...safety--v0.9.2) (2026-11-20)

### Bug Fixes

* **safety:** surface permission-watch and skill-lookup host errors ([75a398c](https://github.com/srobroek/harness-plugins/commit/75a398cc7ded8494bd5bff026718e2925f246d63)), closes [#23](https://github.com/srobroek/harness-plugins/issues/23)

## safety [0.9.1](https://github.com/srobroek/harness-plugins/compare/safety--v0.9.0...safety--v0.9.1) (2026-11-20)

### Bug Fixes

* **safety:** fail fast on permission prompts a subagent cannot answer ([#273](https://github.com/srobroek/harness-plugins/issues/273)) ([77b75e9](https://github.com/srobroek/harness-plugins/commit/77b75e98a252f056a5005555a33b4165cca8d567))

# Changelog

## [0.9.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.8.0...safety--v0.9.0) (2026-11-20)


### Features

* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))


### Refactors

* **lib:** one MCP tool grant table for the tools option ([f8cc1d8](https://github.com/srobroek/opencode-plugins/commit/f8cc1d817d62b211b712d1889200f7c91f049c89))

## [0.8.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.7.0...safety--v0.8.0) (2026-11-19)


### Features

* **safety:** secret_store tool stores a generated or command-issued secret without a shell ([d84a1d2](https://github.com/srobroek/opencode-plugins/commit/d84a1d22b0ff6e72f327fb185c512b2296a80a1e))
* stop long tools and their processes on ToolContext.signal ([94c0ac5](https://github.com/srobroek/opencode-plugins/commit/94c0ac59e12df53eee73d3152da8523f10148bb0))


### Bug Fixes

* **beads:** decide the actor gate on the parsed command, not re-joined argv ([#187](https://github.com/srobroek/opencode-plugins/issues/187)) ([9eaabde](https://github.com/srobroek/opencode-plugins/commit/9eaabde95f1dd57d0a650a8c6435455c004e28d2))
* **safety:** close two history-rewrite gate bypasses ([48c357b](https://github.com/srobroek/opencode-plugins/commit/48c357be482dc207c44003c7a2eea3e16bab47e1))
* **safety:** refuse history rewrites the guard cannot fully parse ([#223](https://github.com/srobroek/opencode-plugins/issues/223)) ([a80d574](https://github.com/srobroek/opencode-plugins/commit/a80d574613789362a4adf8317321eb3ab9f0737b))
* **safety:** refuse history-rewriting git in a canonical checkout ([#210](https://github.com/srobroek/opencode-plugins/issues/210)) ([515f7ba](https://github.com/srobroek/opencode-plugins/commit/515f7ba36493307fad32de51e48c47197bb31f26))

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.6.1...safety--v0.7.0) (2026-11-16)


### Features

* **safety:** refuse route53 delete-hosted-zone without a parent-cleanup marker ([#176](https://github.com/srobroek/opencode-plugins/issues/176)) ([ffc4054](https://github.com/srobroek/opencode-plugins/commit/ffc4054b4ae218b8f3e71089f742b6b8cb9095cc))

## [0.6.1](https://github.com/srobroek/opencode-plugins/compare/safety--v0.6.0...safety--v0.6.1) (2026-11-13)


### Bug Fixes

* **safety:** reference-only fnox set for read-only providers, op vault list, and scratch folders without prompts ([9b83124](https://github.com/srobroek/opencode-plugins/commit/9b831248b7b1a73a7f5677bd67153ee3182c0d13))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.5.0...safety--v0.6.0) (2026-11-12)


### Features

* **safety:** refuse direct 1Password reads and literal secrets in commands, pointing to fnox ([#131](https://github.com/srobroek/opencode-plugins/issues/131)) ([36cd391](https://github.com/srobroek/opencode-plugins/commit/36cd3912e954c1078b808802b069d7010d8f319f))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.4.0...safety--v0.5.0) (2026-11-11)


### Features

* **agent-efficiency:** add lead routing, a foreground sleep guard and subagent scratch reminders ([#122](https://github.com/srobroek/opencode-plugins/issues/122)) ([34bdb2d](https://github.com/srobroek/opencode-plugins/commit/34bdb2d512109065956f88397bd2dc8e6e99ecd3))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.3.0...safety--v0.4.0) (2026-11-05)


### Features

* **safety:** redact secret environment values from tool output ([#113](https://github.com/srobroek/opencode-plugins/issues/113)) ([5ca701a](https://github.com/srobroek/opencode-plugins/commit/5ca701adb139a7a93b7134406467dd703fd84dec))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.2.0...safety--v0.3.0) (2026-10-27)


### Features

* **safety:** git-aware migration-edit gate and external_directory check for directory flags ([5f35605](https://github.com/srobroek/opencode-plugins/commit/5f356054281f62e9458007aee836d1942df9e52e))


### Documentation

* list the profiling skills in the marketplace export table ([f40f96c](https://github.com/srobroek/opencode-plugins/commit/f40f96c2adb224704660399730daedee5cbab870))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.1.0...safety--v0.2.0) (2026-10-27)


### Features

* **agent-efficiency:** run bash tool calls as the built-in shell tool ([bdca7d7](https://github.com/srobroek/opencode-plugins/commit/bdca7d779c47d9cd2cdc6db8d8a8d5f78a3ba8cc))
* **safety:** add opt-in commit-msg hook that rejects AI attribution ([9973023](https://github.com/srobroek/opencode-plugins/commit/99730231c3d23e184db2565f49e61dca794bcb06))
* **safety:** port safety gates, permission checks, close-keywords and package advisory ([f5ceff9](https://github.com/srobroek/opencode-plugins/commit/f5ceff953fbfe532aaef066acb858195c7a9f34a))


### Bug Fixes

* **lib:** accept numeric signal codes from @types/bun 1.4.4 ([a3d2e42](https://github.com/srobroek/opencode-plugins/commit/a3d2e4225211d1a288fa3fed561e1c9d8e696284))
* **safety:** fail closed when a probe's exit is never reported ([db86eba](https://github.com/srobroek/opencode-plugins/commit/db86eba3a68ebd8d19d9e640cd8463a57e224011))
