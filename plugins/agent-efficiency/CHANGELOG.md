## agent-efficiency [0.14.5](https://github.com/srobroek/harness-plugins/compare/agent-efficiency--v0.14.4...agent-efficiency--v0.14.5) (2026-11-24)

### Bug Fixes

* **tools:** restore portable MCP defaults ([f4c4930](https://github.com/srobroek/harness-plugins/commit/f4c4930b68477b6c050cc3e0a6ed62b6b8f8d402))

## agent-efficiency [0.14.4](https://github.com/srobroek/harness-plugins/compare/agent-efficiency--v0.14.3...agent-efficiency--v0.14.4) (2026-11-24)

### Bug Fixes

* **agent-efficiency:** neutralize captured host details ([70895a9](https://github.com/srobroek/harness-plugins/commit/70895a92c8a79e52407f905b26fd787634035da8))

## agent-efficiency [0.14.3](https://github.com/srobroek/harness-plugins/compare/agent-efficiency--v0.14.2...agent-efficiency--v0.14.3) (2026-11-23)

### Bug Fixes

* **whats-new:** grant MCP tools to the whats-new research agent ([8ae7fe0](https://github.com/srobroek/harness-plugins/commit/8ae7fe05c65e2df2f53ebf944c8f9bd5b7625cf9))
* **whats-new:** profile Pi agent and preserve lean sync agents ([6298e4c](https://github.com/srobroek/harness-plugins/commit/6298e4ca9e629ceae6f0188f9490ee5fc1665294))

## agent-efficiency [0.14.2](https://github.com/srobroek/harness-plugins/compare/agent-efficiency--v0.14.1...agent-efficiency--v0.14.2) (2026-11-23)

### Bug Fixes

* **subagent-worktree:** drop project-wide session eviction from finalize ([398ba17](https://github.com/srobroek/harness-plugins/commit/398ba1791911536abc585fd37a129e83347e1e9b))

## agent-efficiency [0.14.1](https://github.com/srobroek/harness-plugins/compare/agent-efficiency--v0.14.0...agent-efficiency--v0.14.1) (2026-11-23)

### Bug Fixes

* make every plugin agent's OMP form correct ([96b7bfe](https://github.com/srobroek/harness-plugins/commit/96b7bfea3c35017b34a28f59e81fb059f6c68a24))

## agent-efficiency [0.14.0](https://github.com/srobroek/harness-plugins/compare/agent-efficiency--v0.13.0...agent-efficiency--v0.14.0) (2026-11-22)

### Features

* **delivery:** ship the orchestrator agent ([#121](https://github.com/srobroek/harness-plugins/issues/121)) ([53f33c0](https://github.com/srobroek/harness-plugins/commit/53f33c016315732220a7c87066267931ee87f514))

## agent-efficiency [0.13.0](https://github.com/srobroek/harness-plugins/compare/agent-efficiency--v0.12.0...agent-efficiency--v0.13.0) (2026-11-21)

### Features

* **agent-efficiency:** nudge idle sessions whose background shell a restart cancelled ([#77](https://github.com/srobroek/harness-plugins/issues/77)) ([003b430](https://github.com/srobroek/harness-plugins/commit/003b430749c6a45df48c8180c42286349602efd1))

## agent-efficiency [0.12.0](https://github.com/srobroek/harness-plugins/compare/agent-efficiency--v0.11.0...agent-efficiency--v0.12.0) (2026-11-21)

### Features

* **agent-efficiency:** align explore with the shared read-only shell rules ([0581d66](https://github.com/srobroek/harness-plugins/commit/0581d66b22dec37c8284d59369940763b3ed216b))

### Bug Fixes

* **agent-efficiency:** rebuild explore with the hardened shell rules, escape regex in the test ([4fabbe9](https://github.com/srobroek/harness-plugins/commit/4fabbe97d12013eabd8ac2aa89c1751a734329c0))

# Changelog

## [0.11.0](https://github.com/srobroek/opencode-plugins/compare/agent-efficiency--v0.10.0...agent-efficiency--v0.11.0) (2026-11-20)


### Features

* **agent-efficiency:** cover every agent with the large-read guard by default ([be08e1e](https://github.com/srobroek/opencode-plugins/commit/be08e1e1443e7401370d539a019866fbe2e52af9))
* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))
* **plugin-audit:** add plugin_audit_scan tool and plugin-audit skill ([d400433](https://github.com/srobroek/opencode-plugins/commit/d4004330e9a922d8e832b6f3266502141eaea4a3))


### Bug Fixes

* **agent-efficiency:** explore gets a read-only shell ([#277](https://github.com/srobroek/opencode-plugins/issues/277)) ([043edd5](https://github.com/srobroek/opencode-plugins/commit/043edd5a4ba2aadf6b2c967d1d9e24490cd82944))


### Refactors

* **lib:** one MCP tool grant table for the tools option ([f8cc1d8](https://github.com/srobroek/opencode-plugins/commit/f8cc1d817d62b211b712d1889200f7c91f049c89))

## [0.10.0](https://github.com/srobroek/opencode-plugins/compare/agent-efficiency--v0.9.0...agent-efficiency--v0.10.0) (2026-11-19)


### Features

* **modes:** debug, refactor and concept agents ([6369b8a](https://github.com/srobroek/opencode-plugins/commit/6369b8ae6c4ca35c664f094b60c28d356cc13298))
* **safety:** secret_store tool stores a generated or command-issued secret without a shell ([d84a1d2](https://github.com/srobroek/opencode-plugins/commit/d84a1d22b0ff6e72f327fb185c512b2296a80a1e))


### Bug Fixes

* **agent-efficiency:** do not keep lead routing filtered by a partial agent list ([f4e1216](https://github.com/srobroek/opencode-plugins/commit/f4e1216ba87aeb5ec1de30f92eab2a872f7c9e78))
* **agents:** let read-only agents load quality and lang skills ([#208](https://github.com/srobroek/opencode-plugins/issues/208)) ([6eac5c5](https://github.com/srobroek/opencode-plugins/commit/6eac5c52afa176c0463755cef4d9871092192fa2))
* **beads:** decide the actor gate on the parsed command, not re-joined argv ([#187](https://github.com/srobroek/opencode-plugins/issues/187)) ([9eaabde](https://github.com/srobroek/opencode-plugins/commit/9eaabde95f1dd57d0a650a8c6435455c004e28d2))

## [0.9.0](https://github.com/srobroek/opencode-plugins/compare/agent-efficiency--v0.8.0...agent-efficiency--v0.9.0) (2026-11-13)


### Features

* **agents:** a tools option that lets read-only and coding agents call allowed MCP tools ([70558c3](https://github.com/srobroek/opencode-plugins/commit/70558c30dc450faec7e6012cdb0f678f1ecd7f01))

## [0.8.0](https://github.com/srobroek/opencode-plugins/compare/agent-efficiency--v0.7.0...agent-efficiency--v0.8.0) (2026-11-12)


### Features

* **safety:** refuse direct 1Password reads and literal secrets in commands, pointing to fnox ([#131](https://github.com/srobroek/opencode-plugins/issues/131)) ([36cd391](https://github.com/srobroek/opencode-plugins/commit/36cd3912e954c1078b808802b069d7010d8f319f))

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/agent-efficiency--v0.6.0...agent-efficiency--v0.7.0) (2026-11-11)


### Features

* **agent-efficiency:** refuse untargeted reads of large text files ([#127](https://github.com/srobroek/opencode-plugins/issues/127)) ([6ee4eb2](https://github.com/srobroek/opencode-plugins/commit/6ee4eb2eec7d5a44a85a8f4ce7665303f446fb97))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/agent-efficiency--v0.5.0...agent-efficiency--v0.6.0) (2026-11-11)


### Features

* **agent-efficiency:** add lead routing, a foreground sleep guard and subagent scratch reminders ([#122](https://github.com/srobroek/opencode-plugins/issues/122)) ([34bdb2d](https://github.com/srobroek/opencode-plugins/commit/34bdb2d512109065956f88397bd2dc8e6e99ecd3))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/agent-efficiency--v0.4.0...agent-efficiency--v0.5.0) (2026-10-30)


### Features

* **agent-efficiency:** trim the cad read-only agents by default ([9e3b8a3](https://github.com/srobroek/opencode-plugins/commit/9e3b8a3b4f6f1cc36369373620ea1e284ec0ff3a))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/agent-efficiency--v0.3.0...agent-efficiency--v0.4.0) (2026-10-27)


### Features

* **agent-efficiency:** keep the global AGENTS.md in lean subagent prompts ([9dd4718](https://github.com/srobroek/opencode-plugins/commit/9dd4718d38214a21f310d826f89e9ccc9ae63fd8))


### Performance

* **agent-efficiency:** trim researcher, architect and speckit-sync by default ([2427aee](https://github.com/srobroek/opencode-plugins/commit/2427aee44d8d3b814dbb3c9310fad0c143044b16))


### Documentation

* add repomix to the manual-test install loop ([d411160](https://github.com/srobroek/opencode-plugins/commit/d41116016e8a7f7390046cc8aca70f58b7c2ab22))
* **agent-efficiency:** drop rust from the plugins that treat bash as shell ([fd87225](https://github.com/srobroek/opencode-plugins/commit/fd87225284c57875e5dc7db6b43facdc500d4e8d))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/agent-efficiency--v0.2.0...agent-efficiency--v0.3.0) (2026-10-27)


### Features

* **agent-efficiency:** keep the project AGENTS.md for lean read-only subagents ([b26263c](https://github.com/srobroek/opencode-plugins/commit/b26263cd6cab577fb725fe6390280ba5b15884e1))


### Performance

* **agent-efficiency:** trim compaction and generate requests like the turns ([51f543f](https://github.com/srobroek/opencode-plugins/commit/51f543fdf8bf2619e9e5373857cd47ddc9714540))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/agent-efficiency--v0.1.0...agent-efficiency--v0.2.0) (2026-10-27)


### Features

* **agent-efficiency:** lean explore agent and trimmed read-only subagent prompts ([9fcdd6b](https://github.com/srobroek/opencode-plugins/commit/9fcdd6ba2c2d68bda79fc1f131f821c2df92c70b))
* **agent-efficiency:** run bash tool calls as the built-in shell tool ([bdca7d7](https://github.com/srobroek/opencode-plugins/commit/bdca7d779c47d9cd2cdc6db8d8a8d5f78a3ba8cc))
