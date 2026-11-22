/**
 * A plugin that only ships content: `skills/<name>/SKILL.md` and `agents/<id>.md` at the
 * package root. Both directories sit one level above `src/` and the bundled `dist/`.
 */
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { registerFallbackAgents } from "./agent-fallback.ts";
import { agentIds, agentPaths } from "./agent-files.ts";
import { mcpGrant } from "./agent-tools.ts";
import { registerSkills, skillPaths } from "./skill-files.ts";
/** The shipped skill and agent files of the package whose module URL is `moduleUrl`. */
export function contentPaths(moduleUrl) {
    return {
        skills: skillPaths(fileURLToPath(new URL("../skills", moduleUrl))),
        agents: agentPaths(fileURLToPath(new URL("../agents", moduleUrl))),
    };
}
/** Define plugin `id`, registering the skills and agents found next to `moduleUrl`. */
export function contentPlugin(id, moduleUrl, options = {}) {
    return Plugin.define({
        id,
        async setup(ctx) {
            const { skills, agents } = contentPaths(moduleUrl);
            const registrations = [];
            const cleanup = async () => {
                for (const registration of registrations.reverse())
                    await registration.dispose();
            };
            try {
                if (skills.length > 0)
                    registrations.push(await registerSkills(ctx.skill, skills));
                if (agents.length > 0) {
                    const grant = mcpGrant(ctx.options?.tools, agentIds(agents));
                    registrations.push(await registerFallbackAgents(ctx, agents, options.fallbacks ?? {}, grant));
                }
            }
            catch (error) {
                await cleanup();
                throw error;
            }
            return cleanup;
        },
    });
}
