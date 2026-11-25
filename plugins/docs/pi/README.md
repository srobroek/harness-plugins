# docs

Documentation MCP servers for OpenCode, OMP and Pi. The shared source is
[`common/.mcp.json`](common/.mcp.json); harness-kit generates the OMP, Claude and
Pi MCP declarations from it. Context7 works without a key. When
`CONTEXT7_API_KEY` is set, OpenCode and Pi send it as a `CONTEXT7_API_KEY` header.
OMP omits the optional header. OpenAI Developer Docs stays off by default.

| Server | Default | What it serves |
| --- | --- | --- |
| `context7` | on | Current library and framework docs and code examples from [Context7](https://context7.com) (`https://mcp.context7.com/mcp`) |
| `openaiDeveloperDocs` | off | The OpenAI developer documentation (`https://developers.openai.com/mcp`) |

In OpenCode, both servers answer without signing in, so the plugin disables OAuth.
It reads `CONTEXT7_API_KEY` itself because OpenCode does not expand environment
variables in plugin configs. Both speak MCP 2026-07-28, so OpenCode shares one
connection across locations with `pool: true`.

Both servers run in Code Mode in OpenCode: their tools are listed in the Code Mode
catalog and called through `execute`, instead of each tool schema going into every
request.

## Options

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/harness-plugins::path:plugins/docs/opencode",
    "options": {
      "mcp": "auto",                                    // "auto" (default) or "always" add the servers; "off" adds none
      "mcpServers": { "openaiDeveloperDocs": true }     // turn single servers on or off by name
    }
  }]
}
```

These servers help in any project, so `auto` and `always` behave the same here.

## Overriding a server

A server under the same name in your `opencode.json` wins: the plugin leaves it as
you configured it. Use that to change a URL, headers or `codemode`, or set
`"disabled": true` to keep a server configured but off. To drop one entirely, set it
to `false` in `mcpServers`.

## Install

```sh
opencode plugin add 'github:srobroek/harness-plugins::path:plugins/docs/opencode'
```

Install the pi package from npm:

```sh
pi install npm:@srobroek/pi-docs
```

