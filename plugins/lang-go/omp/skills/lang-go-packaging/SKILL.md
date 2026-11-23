---
name: lang-go-packaging
description: Go package layout and module packaging guidance.
---
# Go Packaging

Keep package boundaries aligned with cohesive responsibilities. Put reusable APIs in packages with
clear names; keep `internal/` for implementation that consumers must not import. Use a `go.work`
workspace only when multiple modules need coordinated local development.
