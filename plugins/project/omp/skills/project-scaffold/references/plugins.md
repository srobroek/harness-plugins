---
name: plugins
---
# Choosing project tooling

Load `new-project` to discover and install OMP plugins, project-local skills, and MCP
servers. Project-local skills install to `.agents/skills/<name>/` through the `agents`
provider; do not place them in `.omp/skills/`. The skill handles catalog and source selection,
approval, install, and verification. Do not install tools until the user approves them.
