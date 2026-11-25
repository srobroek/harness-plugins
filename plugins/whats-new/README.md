# whats-new

Research what changed between the version of a dependency, tool or service a
project uses and the latest one: breaking changes, deprecations, new features and
notable fixes. It reports and changes nothing.

## Install
Install the Pi package from npm:

```sh
pi install npm:@srobroek/pi-whats-new
```

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/whats-new/opencode'
```

The plugin has OpenCode and pi extensions. It is not exported to Claude Code. The
Pi package declares `version_gap_scan` and the report-only `whats-new` agent.

## Agent

The `whats-new` agent is a subagent. Ask Pi to use it by name. The `whats-new` skill
also works in any session.

Report-only policy denies dependency manifest and lockfile edits, installers and
upgrade commands, and `dep_apply`. OpenCode installs an evaluation hook for this
agent. It denies wrapped installers such as `sudo npm i`, commands inside
`bash -c` or substitutions, and manifest paths in any letter case.

The Pi extension registers a `tool_call` gate. pi-subagents prefixes native child
system prompts with `<active_agent name="whats-new"/>` and names child sessions from
the agent. The gate checks that prompt marker and, when Pi identifies a child by its
`parentSession` header, its session name. This limits the gate to the whats-new
researcher without disabling writes in parent sessions or other agents.

Pi foreground children do not load ambient parent extensions. The shipped `whats-new`
agent loads this package's extension and `pi-web-access` through
`subagentOnlyExtensions`, so the gate, `version_gap_scan`, `web_search`,
`fetch_content`, `get_search_content` and `source_check` work in its child
sessions. Install `pi-web-access` beside this package. A copy of the agent you
define yourself needs the same `subagentOnlyExtensions` entries.

The gate blocks `write` and `edit` calls for dependency manifests and lockfiles,
and installer or upgrade commands sent through `bash`. Other tools and research
commands are unaffected. Static inspection does not catch writes hidden in scripts,
`eval`, or other tools; it is not a sandbox.

## Tools

`version_gap_scan` lists root dependencies, offline and read-only. It prints one
tab-separated row per dependency: ecosystem, name, declared spec, resolved lockfile
version (`?` when unlocked), and `direct` or `transitive`.

The scanner reads root language manifests and reads `package-lock.json`, `uv.lock`
and `poetry.lock` for resolved versions. It does not read other Node lockfiles,
`Cargo.lock`, `go.sum`, `Pipfile.lock`, Ruby or PHP lockfiles, or workspace child
manifests. Resolve a declaration range separately when needed.

## Skill

The plugin registers the `whats-new` skill, unless one with that id already exists.
The skill links to recipes for registry, git and service-feed endpoints, and to a
report template.
