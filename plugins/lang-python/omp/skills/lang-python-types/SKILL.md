---
name: lang-python-types
description: Python typing, protocols, generics, and Pydantic guidance.
---
# Python Types

Use strict typing for new code. Prefer concrete types and `Protocol` for structural boundaries.
Use generics when they capture a real reusable relationship. Validate untrusted input at the
boundary with Pydantic when it fits the project; keep internal domain types explicit and avoid
unnecessary runtime validation.
