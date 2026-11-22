import { resolve } from "node:path";
import { Plugin } from "@opencode/plugin";
import { agentIds, registerAgents } from "@srobroek/opencode-lib/agent-files";
import { mcpGrant } from "@srobroek/opencode-lib/agent-tools";
import { contentPaths } from "@srobroek/opencode-lib/content-plugin";
import { registerPluginMcp } from "@srobroek/opencode-lib/mcp";
import { registerSkills } from "@srobroek/opencode-lib/skill-files";
import { isFrontendProject } from "./detect.ts";
import { installFormulas, SETUP_TOOL } from "./formulas.ts";
import { confirmScan, readScanParams, resolveTargets, runScan, SCAN_DESCRIPTION, SCAN_INPUT, SCAN_TOOL } from "./impeccable.ts";
export { FRONTEND_MARKERS, isFrontendProject } from "./detect.ts";
export { FORMULAS, installFormulas, SETUP_TOOL } from "./formulas.ts";
export { confirmScan, countFindings, interpretScan, readScanParams, resolveTargets, runScan, SCAN_TOOL, scanArgv, } from "./impeccable.ts";
export const SETUP_DESCRIPTION = "Copy the design plugin's beads formulas into a beads workspace's .beads/formulas/.\n" +
    "Covers design-touch, design-surface, design-system and the mol-design-* sub-processes, so bd mol pour and " +
    "bd mol bond find them. Identical " +
    "copies stay; divergent ones are refused unless force=true; symlinked paths are always refused.";
const SETUP_INPUT = {
    type: "object",
    properties: {
        workspace: { type: "string", description: "Beads workspace root (contains .beads/); default the session directory" },
        force: { type: "boolean", description: "Overwrite design formulas that differ from the shipped ones" },
    },
    additionalProperties: false,
};
/**
 * OpenCode-only and off unless the `mcpServers` option turns it on: it answers only while
 * `storybook dev` runs, so the Claude Code and Codex `.mcp.json` leaves it out.
 */
export const STORYBOOK_MCP = { storybook: { type: "http", url: "http://localhost:6006/mcp" } };
export function parseOptions(options) {
    return { confirmScan: options?.confirmScan === true };
}
export async function setupDesign(ctx, moduleUrl, overrides = {}) {
    const options = parseOptions(ctx.options);
    const location = ctx.location.directory;
    const { skills, agents } = contentPaths(moduleUrl);
    const registrations = [];
    const cleanup = async () => {
        for (const registration of registrations.reverse())
            await registration.dispose();
    };
    const directory = (sessionID) => ctx.session
        .get({ sessionID })
        .then((session) => session.location.directory ?? location)
        .catch(() => location);
    const assert = (context, action, resources, metadata) => ctx.permission.assert({
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, id: context.id },
        action,
        resources,
        save: resources,
        metadata,
    });
    try {
        registrations.push(await ctx.tool.transform((editor) => {
            editor.add({
                name: SETUP_TOOL,
                description: SETUP_DESCRIPTION,
                input: SETUP_INPUT,
                execute: async (input, context) => {
                    const { workspace, force } = (input ?? {});
                    if (workspace !== undefined && (typeof workspace !== "string" || workspace === ""))
                        return { content: `${SETUP_TOOL}: workspace must be a non-empty string`, metadata: { ok: false } };
                    const cwd = await directory(context.sessionID);
                    const target = resolve(cwd, typeof workspace === "string" ? workspace : ".");
                    await assert(context, SETUP_TOOL, [target], { workspace: target, force: force === true });
                    const result = installFormulas(target, cwd, force === true);
                    return {
                        content: result.ok ? result.text : `${SETUP_TOOL}: ${result.text}`,
                        metadata: { ok: result.ok, copied: result.copied, unchanged: result.unchanged },
                    };
                },
            });
            editor.add({
                name: SCAN_TOOL,
                description: SCAN_DESCRIPTION,
                input: SCAN_INPUT,
                execute: async (input, context) => {
                    const params = readScanParams(input);
                    if (typeof params === "string")
                        return { content: `${SCAN_TOOL}: ${params}`, metadata: { ok: false } };
                    const cwd = await directory(context.sessionID);
                    await assert(context, SCAN_TOOL, resolveTargets(params.targets, cwd), { ...params });
                    const result = await runScan(params, cwd, context.signal, overrides.exec);
                    return {
                        content: result.text,
                        metadata: { ok: result.ok, status: result.status, exitCode: result.exitCode, findings: result.findings },
                    };
                },
            });
        }));
        if (options.confirmScan)
            registrations.push(await ctx.permission.hook("evaluate", confirmScan));
        if (skills.length > 0)
            registrations.push(await registerSkills(ctx.skill, skills));
        if (agents.length > 0)
            registrations.push(await registerAgents(ctx.agent, agents, [], mcpGrant(ctx.options?.tools, agentIds(agents))));
        const mcp = await registerPluginMcp(ctx, moduleUrl, {
            relevant: isFrontendProject,
            servers: STORYBOOK_MCP,
            off: ["storybook"],
            extra: { storybook: { oauth: false } },
        });
        registrations.push(mcp.registration);
    }
    catch (error) {
        await cleanup();
        throw error;
    }
    return cleanup;
}
export function createPlugin(overrides = {}) {
    return Plugin.define({
        id: "srobroek.design",
        setup: (ctx) => setupDesign(ctx, import.meta.url, overrides),
    });
}
export default createPlugin();
