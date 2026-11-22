import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { onSessionDeleted } from "./session-cache.ts";
export const LEAD_PATH = fileURLToPath(new URL("../instructions/lead-routing.md", import.meta.url));
export function filterLeadRouting(text, registered) {
    return text.split("\n").filter((line) => {
        if (!line.startsWith("- "))
            return true;
        const ids = [...line.split(":")[0]?.matchAll(/`([^`]+)`/g) ?? []].map((match) => match[1]);
        return ids.length === 0 || ids.some((id) => registered.has(id));
    }).join("\n");
}
export async function setupLead(ctx) {
    const text = readFileSync(LEAD_PATH, "utf8").trim();
    const cached = new Map();
    const stop = onSessionDeleted(ctx, (sessionID) => cached.delete(sessionID), () => cached.clear());
    const forSession = async (sessionID) => {
        try {
            const session = await ctx.session.get({ sessionID });
            if (session.parentID != null)
                return undefined;
            const agents = await ctx.agent.list();
            // OpenCode 2.2.7+ returns a partial list while plugins load; "agent.updated" clears the cache.
            // The shared fake uses the editor's array shape; the client wraps it in data.
            const listed = Array.isArray(agents) ? agents : agents.data;
            return filterLeadRouting(text, new Set(listed.map((agent) => agent.id)));
        }
        catch {
            return undefined;
        }
    };
    const inject = async (event) => {
        if (!("subagent" in event.tools))
            return;
        let known = cached.get(event.sessionID);
        if (!known) {
            known = forSession(event.sessionID);
            cached.set(event.sessionID, known);
        }
        const routing = await known;
        if (routing)
            event.system.push({ type: "text", text: routing });
    };
    const hooks = [await ctx.session.hook("context", inject), await ctx.session.hook("compaction", inject), await ctx.session.hook("generate", inject)];
    return async () => {
        await stop();
        for (const hook of hooks)
            await hook.dispose();
        cached.clear();
    };
}
