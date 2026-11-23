---
name: lang-typescript-packaging
description: TypeScript monorepo packaging, workspace, and package export guidance.
---
# TypeScript Packaging

Use the package manager already adopted by the project. Define explicit package exports, keep
workspace boundaries clear, and test the packed artifact rather than only the source tree. Use a
frozen lockfile install in CI. Avoid publishing build output that is not part of the package
contract.
