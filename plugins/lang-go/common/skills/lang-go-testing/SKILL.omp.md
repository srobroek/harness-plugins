---
name: lang-go-testing
description: Go tests, race detection, fuzzing, and test design.
---
# Go Testing

Use table-driven tests for input/output cases and test behavior at package boundaries. Run
`go test ./...`; use `go test -race ./...` for concurrent code. Fuzz parsers and boundary
conditions with Go's built-in fuzzing. Keep tests deterministic, isolate shared files or ports,
and include regression tests for fixed defects.
