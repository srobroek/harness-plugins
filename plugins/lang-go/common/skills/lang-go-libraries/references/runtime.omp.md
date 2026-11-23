---
name: runtime
---
# Runtime providers

Feature flags: applications and services choose one OpenFeature provider over flags.yaml, SSM, or
AppConfig. Libraries leave flag decisions to callers. Agent plugins keep options in the host's
configuration rather than introducing a second feature-flag layer.
