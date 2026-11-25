# debate

Stress-test a decision before committing to it. Two skills:

| Skill | When |
| --- | --- |
| `debate` | Two-sided analysis of an architectural decision, technology choice or feature proposal, with a conditional verdict |
| `grilling` | Interview the user in numbered frontier rounds until every branch of a plan has an answer. `debate` routes deeper interviews here. |

This plugin vendors `grilling` in modified form from
[mattpocock/skills](https://github.com/mattpocock/skills) under the MIT license. Its skill
directory carries the license text and a NOTICE listing the changes.

## Asking questions

The skills ask their question rounds through your preferred question tool, or as a
numbered markdown round in chat when no question tool is available.

[parley](../parley/README.md) is one such tool for OpenCode: it shows the whole round in one
TUI panel. Install it beside this plugin to get the panel:

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/parley/opencode'
```

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/debate/opencode'
```

Claude Code installs the same skills from this repository's marketplace:

```sh
claude plugin marketplace add srobroek/harness-plugins
claude plugin install debate@harness-plugins
```

A skill you already have with the same name wins over the plugin's copy.

## pi

```sh
pi install npm:@srobroek/pi-debate
```

The pi package needs `pi-subagents`, which runs the council, and `@srobroek/pi-architecture`,
which provides the `architect` agent. Install both beside it.

For a consequential or contested decision, the `debate` skill hands the finished two-sided
analysis to a pi-subagents council for independent critique. The default roster is
`council-advocate`, `council-skeptic` and `council-pragmatist`. An architecture decision adds
`architect`, and a security decision adds `council-security`. The council runs at most three
passes. The skill treats the council memo as evidence and still writes the conditional verdict.

Two commands run a council with a fixed roster and up to three passes:

| Command | Roster |
| --- | --- |
| `/council-arch <question>` | `architect`, `council-advocate`, `council-skeptic`, `council-pragmatist` |
| `/council-security <question>` | `council-security`, `council-advocate`, `council-skeptic`, `council-pragmatist` |

The four `council-*` advisors can only read, and the parent's agent list does not show them.
They pin no model. Set one per advisor in `~/.pi/agent/settings.json`, replacing
`provider/model-id` with the provider and model you use:

```jsonc
{
  "subagents": {
    "agentOverrides": {
      "council-advocate": { "model": "provider/model-id" },
      "council-skeptic": { "model": "provider/model-id" },
      "council-pragmatist": { "model": "provider/model-id" },
      "council-security": { "model": "provider/model-id" }
    }
  }
}
```

## Works with

This package works with these pi packages. Install them next to it.

| Package | Required | For | Install |
| --- | --- | --- | --- |
| `pi-subagents` | yes | council advisors and the council protocol | `pi install npm:pi-subagents` |
| `@srobroek/pi-architecture` | yes | the architect agent in /council-arch | `pi install npm:@srobroek/pi-architecture` |
