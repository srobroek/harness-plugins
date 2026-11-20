# eli5

Explains a topic at the requested depth, from a concise ELI5 up to five levels:
metaphor, concept, mechanism, tradeoffs and frontier.

| Skill | When |
| --- | --- |
| `eli5` | "ELI5", "explain like I'm five", or an explicit request for child-friendly, plain-language or beginner wording; not a generic "explain X" |

Ported from the omp-plugins `eli5` plugin. The only text change: research goes
through reading the source or a web search instead of omp tool names, and changes
since a baseline go to the `whats-new` skill. This is the authoritative copy; the
earlier one under `~/.claude/skills` is gone.

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/eli5/opencode'
```

Claude Code install the same skill from this repository's marketplace:

```sh
claude plugin marketplace add srobroek/harness-plugins
claude plugin install eli5@harness-plugins

```

A skill you already have with the same name wins over the plugin's copy.
