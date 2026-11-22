import { isAbsolute, resolve } from "node:path";
import { Plugin, Skill, Worktree } from "@opencode/plugin";
import { shellCall } from "@srobroek/opencode-lib";
import { decideMergePolicy } from "./merge-gate.ts";
import { loadSkills } from "./skills.ts";
import { withSwitchTimeout } from "./switch-timeout.ts";
import { createStrategy } from "./worktree.ts";
export { decideMergePolicy, MERGE_POLICY_REFUSAL, parseMergeInvocation } from "./merge-gate.ts";
export { createStrategy, STRATEGY_ID } from "./worktree.ts";
export function readOptions(options) {
    return { strategy: options?.strategy !== false };
}
/** The shell call to check, or `undefined` when the call cannot run a merge. */
export function mergeGateCall(tool, input) {
    const call = shellCall(tool, input);
    if (!call || !/merge/.test(call.command))
        return undefined;
    return call.workdir === undefined ? { command: call.command } : { command: call.command, workdir: call.workdir };
}
/** The directory a shell call runs in: its `workdir`, resolved against the session's directory. */
export function shellCwd(workdir, sessionDirectory) {
    if (workdir === undefined)
        return sessionDirectory;
    return isAbsolute(workdir) ? workdir : resolve(sessionDirectory, workdir);
}
export function operationError(message, forceRequired) {
    return forceRequired
        ? new Worktree.OperationError({ message, forceRequired: true })
        : new Worktree.OperationError({ message });
}
export function skillInfo(skill) {
    return Skill.Info.make({
        id: Skill.ID.make(skill.name),
        name: Skill.Name.make(skill.name),
        ...(skill.description === undefined ? {} : { description: skill.description }),
        autoinvoke: skill.autoinvoke,
        path: Skill.Info.fields.path.make(skill.path),
        content: skill.content,
    });
}
export function createPlugin(overrides = {}) {
    return Plugin.define({
        id: "srobroek.worktrunk",
        async setup(ctx) {
            const options = readOptions(ctx.options);
            const registrations = [];
            const cleanup = async () => {
                for (const registration of registrations.reverse())
                    await registration.dispose();
            };
            try {
                if (options.strategy) {
                    const strategy = createStrategy({ run: overrides.run, error: operationError });
                    registrations.push(await ctx.worktree.transform((editor) => editor.add(strategy)));
                }
                registrations.push(await ctx.tool.hook("execute.before", async (event) => {
                    const longer = withSwitchTimeout(event.tool, event.input);
                    if (longer)
                        event.input = longer;
                    const call = mergeGateCall(event.tool, event.input);
                    if (!call)
                        return;
                    const sessionDirectory = await ctx.session
                        .get({ sessionID: event.sessionID })
                        .then((session) => session.location.directory)
                        .catch(() => ctx.location.directory);
                    const cwd = shellCwd(call.workdir, sessionDirectory);
                    const decision = await decideMergePolicy(call.command, cwd, overrides.probes);
                    if (decision)
                        throw new Error(decision.reason);
                }));
                const skills = (await loadSkills(overrides.skillsDirectory)).map(skillInfo);
                registrations.push(await ctx.skill.transform((editor) => {
                    for (const skill of skills)
                        if (!editor.get(skill.id))
                            editor.add(skill);
                }));
            }
            catch (error) {
                await cleanup();
                throw error;
            }
            return cleanup;
        },
    });
}
export default createPlugin();
