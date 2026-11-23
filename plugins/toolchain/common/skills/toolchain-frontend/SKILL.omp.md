---
name: toolchain-frontend
description: Use when choosing a frontend framework, UI kit, or client or server state library.
---
# Frontend Defaults

Route framework choice by product surface:

- React + Vite for SPA and product UIs.
- Vue + Vite for app-style UIs when Vue is a better team or domain fit.
- SvelteKit when server rendering, routing, and form actions belong in one framework.
- Astro for content-heavy sites with interactive islands.
- Next.js only when the project needs its server/runtime features.

Use the project's existing framework and conventions unless the task is explicitly a migration.
