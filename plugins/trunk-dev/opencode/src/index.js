import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import { appendResultText, shellCall, shellExit } from "@srobroek/opencode-lib";
import { registerSkills } from "@srobroek/opencode-lib/skill-files";
import { decideCommitGate } from "./commit-gate.ts";
import { flagCleanupFollowUp, landedMerge, shellMerges } from "./flag-cleanup.ts";
import { decideMrAdvisory } from "./mr-advisory.ts";
import { sessionReminder } from "./session-reminders.ts";
import { skipCiAdvisory } from "./skip-ci.ts";
export { COMMIT_OVERRIDE, conventional, decideCommitGate, MESSAGES, PUSH_OVERRIDE } from "./commit-gate.ts";
export { createCleanup, decideFlagCleanup, flagCleanupFollowUp, landedMerge, mergedForgeData, shellMerges, } from "./flag-cleanup.ts";
export { ADVICE, decideMrAdvisory } from "./mr-advisory.ts";
export { SKIP_CI_ADVISORY, skipCiAdvisory } from "./skip-ci.ts";
export const LAND_TOOL = "delivery_land";
export const SKILL_NAMES = ["trunk-dev-workflow", "trunk-dev-feature-flags", "trunk-dev-release-setup", "trunk-dev-guide"];
export const SKILL_PATHS = SKILL_NAMES.map((name) => fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)));
export const FEATURE_IDS = ["commit-gate", "skip-ci", "mr-advisory", "flag-cleanup", "session-reminders"];
/** `{ disable: ["commit-gate", …] }` turns features off; unknown ids are ignored. */
export function readOptions(options) {
    const raw = options?.disable;
    const list = Array.isArray(raw) ? raw.filter((id) => FEATURE_IDS.includes(id)) : [];
    return new Set(list);
}
/** The directory a shell call runs in: its `workdir`, resolved against the session's directory. */
export function shellCwd(workdir, sessionDirectory) {
    if (workdir === undefined)
        return sessionDirectory;
    return isAbsolute(workdir) ? workdir : resolve(sessionDirectory, workdir);
}
/** The advisories for one completed shell call, skip-CI first. */
export function shellAdvisories(command, cwd, disabled, advise = decideMrAdvisory) {
    const out = [];
    if (!disabled.has("skip-ci")) {
        const skip = skipCiAdvisory(command, cwd);
        if (skip !== undefined)
            out.push(skip);
    }
    if (!disabled.has("mr-advisory"))
        out.push(...advise(command, cwd));
    return out;
}
export function createPlugin(overrides = {}) {
    return Plugin.define({
        id: "srobroek.trunk-dev",
        async setup(ctx) {
            const disabled = readOptions(ctx.options);
            const gate = overrides.commitGate ?? ((command, cwd) => decideCommitGate(command, cwd));
            const followUp = overrides.followUp ?? ((merges) => flagCleanupFollowUp(merges, process.env));
            const reminded = new Set();
            /** One lookup: the session's directory, and whether it is a child (`undefined` when the lookup failed). */
            const sessionInfo = (sessionID) => ctx.session
                .get({ sessionID })
                .then((found) => {
                const session = found;
                return { directory: session.location.directory, child: session.parentID != null };
            })
                .catch(() => ({ directory: ctx.location.directory, child: undefined }));
            const sessionDirectory = async (sessionID) => (await sessionInfo(sessionID)).directory;
            const before = await ctx.tool.hook("execute.before", async (event) => {
                if (disabled.has("commit-gate"))
                    return;
                const call = shellCall(event.tool, event.input);
                if (call === undefined)
                    return;
                const cwd = shellCwd(call.workdir, await sessionDirectory(event.sessionID));
                let refusal;
                try {
                    refusal = gate(call.command, cwd);
                }
                catch {
                    refusal = undefined;
                }
                if (refusal !== undefined)
                    throw new Error(`trunk-dev: ${refusal.reason}`);
            });
            const after = await ctx.tool.hook("execute.after", async (event) => {
                if (event.status !== "completed")
                    return;
                try {
                    const notes = [];
                    let merges = [];
                    const { directory, child } = await sessionInfo(event.sessionID);
                    if (event.tool === LAND_TOOL) {
                        const landed = landedMerge(event.result.output, directory);
                        if (landed !== undefined)
                            merges = [landed];
                    }
                    else {
                        const call = shellCall(event.tool, event.input);
                        if (call === undefined)
                            return;
                        const cwd = shellCwd(call.workdir, directory);
                        if (!disabled.has("session-reminders") && child === false && !reminded.has(event.sessionID)) {
                            reminded.add(event.sessionID);
                            const note = await (overrides.reminder ?? sessionReminder)(cwd).catch(() => undefined);
                            if (note)
                                notes.push(note);
                        }
                        const exit = shellExit(event.result);
                        if (exit !== undefined && exit !== 0) {
                            if (notes.length)
                                event.result = appendResultText(event.result, notes.join("\n"));
                            return;
                        }
                        notes.push(...shellAdvisories(call.command, cwd, disabled, overrides.advise));
                        if (exit === 0)
                            merges = shellMerges(call.command, cwd);
                    }
                    if (!disabled.has("flag-cleanup") && merges.length > 0) {
                        const note = await followUp(merges).catch(() => undefined);
                        if (note !== undefined)
                            notes.push(note);
                    }
                    if (notes.length > 0)
                        event.result = appendResultText(event.result, notes.join("\n"));
                }
                catch {
                    // Advisories and follow-ups never fail the call they observe.
                }
            });
            const skills = await registerSkills(ctx.skill, SKILL_PATHS);
            return async () => {
                await skills.dispose();
                await after.dispose();
                await before.dispose();
            };
        },
    });
}
export default createPlugin();
