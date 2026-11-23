---
name: toolchain-languages
description: Defaults for choosing language libraries and runtime dependencies.
metadata:
  opencode/autoinvoke: false
  omp/autoinvoke: false
---
# Toolchain languages

Use language-native and mature packages for shared concerns. Ask before adding a dependency the
request did not name.

For feature flags, applications and services may use OpenFeature with one provider over
`flags.yaml`, SSM, or AppConfig, chosen by need. Libraries leave the decision to callers. Keep
agentic tools' configuration in the host rather than adding application-level flags.

Load the matching language skill for language-specific tools and libraries.
