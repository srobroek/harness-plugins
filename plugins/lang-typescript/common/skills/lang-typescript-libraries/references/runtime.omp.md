---
name: runtime
---
# Runtime providers

Feature flags: applications and services choose one OpenFeature provider over flags.yaml, SSM, or
AppConfig. Browser applications ask before adding a client-side provider. Libraries leave flag
decisions to callers. Agent plugins keep options in the host's configuration rather than adding
an application-level feature-flag layer.
