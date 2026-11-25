/**
 * Route the spec-kit commands that conflict with beads. `speckit-implement` reads and ticks
 * tasks.md, so its content becomes a redirect to the implement step's beads;
 * `speckit-analyze` aborts without tasks.md, so a beads preamble goes ahead of its
 * unchanged analysis; the taskstoissues commands open a second tracker, so their content
 * becomes a refusal. OpenCode applies the routes to skills, pi to the `/speckit.*` prompts
 * and the prompt or skill files a `read` returns. All apply only where a beads workspace
 * is active.
 */

/** Marks content this plugin wrote, so a rewritten skill is not rewritten again. */
export const MARKER = "<!-- srobroek.speckit-beads -->"

export const IMPLEMENT_SKILLS: readonly string[] = ["speckit-implement", "speckit.implement"]

export const ANALYZE_SKILLS: readonly string[] = ["speckit-analyze", "speckit.analyze"]

export const TASKSTOISSUES_SKILLS: readonly string[] = [
  "speckit-taskstoissues",
  "speckit.taskstoissues",
  "speckit-github-taskstoissues",
  "speckit.github.taskstoissues",
]

/** The implement route, without the marker: pi sends it as the prompt of `/speckit.implement`. */
export const IMPLEMENT_ROUTE = `# speckit-implement is replaced in this repository

This repository tracks tasks in beads, so the upstream implement command, which reads
and ticks \`specs/<spec>/tasks.md\`, does not run here. Work the task beads under the
molecule's unconditional \`implement\` step instead:

1. Find the run: \`bd query 'spec_id="<NNN-slug>"' --json\`, then \`bd mol current <root-id>\`.
2. Check the implement step's prerequisites are closed, including every analysis
   approval gate that was not waived. Stop and report when one is open.
3. Pick work with \`bd ready\`, claim it with \`bd update <id> --claim\`, implement and
   test it, then \`bd close <id> --reason "<evidence>"\`.
4. Keep the implement step open until every child is closed; then close it.

Do not create or edit \`specs/*/tasks.md\`; the speckit-beads plugin refuses those writes.
If a check script demands tasks.md (\`check-prerequisites.sh --require-tasks\`), skip it
and read \`bd list --spec <NNN-slug>\`.`

export const IMPLEMENT_REDIRECT = `${MARKER}\n${IMPLEMENT_ROUTE}`

/** The analyze preamble, without the marker: pi adds it beside the expanded `/speckit.analyze` prompt. */
export const ANALYZE_NOTE = `# speckit-analyze here: tasks live in beads

This repository keeps tasks in beads, not \`specs/<spec>/tasks.md\`. Run the analyze
command with these changes; its spec, plan and constitution analysis stays as written.

- Run the prerequisite script with \`--json --require-spec\` only, without
  \`--require-tasks --include-tasks\` (PowerShell: \`-RequireTasks -IncludeTasks\`). It
  still checks the feature directory, spec.md and plan.md. Do not abort for tasks.md.
- Wherever the command reads tasks.md, read the task beads: find the run with
  \`bd query 'spec_id="<NNN-slug>"' --json\`, then \`bd list --parent <implement-step-id> --json\`.
  Use each bead's id, title, description, acceptance criteria and dependencies.
- Cite tasks by bead id. A coverage fix is a bead change, never a tasks.md edit.`

export const ANALYZE_REDIRECT = `${MARKER}\n${ANALYZE_NOTE}\n\n---\n`

/** The taskstoissues refusal without a harness's option hint. */
export const TASKSTOISSUES_REASON =
  "blocked by speckit-beads: taskstoissues turns tasks.md into GitHub issues, a second task tracker in a repository whose task state already lives in beads. Do not invoke it; link an existing GitHub issue instead with bd update <id> --external-ref gh-<number>."

/** OpenCode's taskstoissues refusal. */
export const TASKSTOISSUES_REFUSAL = `${TASKSTOISSUES_REASON} Disable: set the srobroek.speckit-beads plugin option blockTasksToIssues=false`

export type SkillLike = { id: string; content?: string; description?: string }

export type SkillRouting = { implement: boolean; analyze: boolean; taskstoissues: boolean }

export type SkillRoute = keyof SkillRouting

/** The route a skill or command id takes under `routing`, or `undefined` when it runs as upstream wrote it. */
export function skillRoute(id: string, routing: SkillRouting): SkillRoute | undefined {
  if (routing.implement && IMPLEMENT_SKILLS.includes(id)) return "implement"
  if (routing.analyze && ANALYZE_SKILLS.includes(id)) return "analyze"
  if (routing.taskstoissues && TASKSTOISSUES_SKILLS.includes(id)) return "taskstoissues"
  return undefined
}

/** The content one skill should have, or `undefined` to leave it as it is. `refusal` is the harness's taskstoissues wording. */
export function rewriteSkill(
  skill: SkillLike,
  routing: SkillRouting,
  refusal: string = TASKSTOISSUES_REFUSAL,
): Pick<SkillLike, "content" | "description"> | undefined {
  if (skill.content?.startsWith(MARKER)) return undefined
  const route = skillRoute(skill.id, routing)
  if (route === "implement")
    return {
      content: IMPLEMENT_REDIRECT,
      description:
        "Work a SpecKit feature's implementation task beads under its molecule's implement step (replaces the tasks.md implement command)",
    }
  if (route === "analyze") return { content: `${ANALYZE_REDIRECT}\n${skill.content ?? ""}` }
  if (route === "taskstoissues")
    return { content: `${MARKER}\n${refusal}\n`, description: "Disabled here: task state lives in beads; do not load" }
  return undefined
}

/** Whether some skill in `skills` still has upstream content this plugin replaces. */
export function staleSkills(skills: ReadonlyArray<SkillLike>, routing: SkillRouting): boolean {
  return skills.some((skill) => rewriteSkill(skill, routing) !== undefined)
}

/** The refusal for a `skill` tool call that loads a taskstoissues skill. */
export function skillRefusal(tool: string, input: unknown): string | undefined {
  if (tool !== "skill" || input === null || typeof input !== "object") return undefined
  const id = (input as { id?: unknown }).id
  return typeof id === "string" && TASKSTOISSUES_SKILLS.includes(id) ? TASKSTOISSUES_REFUSAL : undefined
}
