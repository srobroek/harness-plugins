/**
 * An in-memory stand-in for the `@opencode/plugin` 2.x plugin context, for tests.
 *
 * It implements the domains this repository's plugins use and records what a
 * plugin registers, so a test can call `setup`, fire hooks the way the host would,
 * and check that the cleanup disposed every registration. Only the shapes are
 * faked: no hook here runs unless the test fires it.
 *
 * ```ts
 * const fake = createFakeContext()
 * const cleanup = await plugin.setup(fake.context)
 * await fake.fire.tool("execute.before", { tool: "shell", input: { command: "ls" } })
 * await cleanup?.()
 * expect(fake.active()).toBe(0)
 * ```
 */
import { insideDirectory } from "./session-lanes.ts";
/** Create a fake plugin context. */
export function createFakeContext(options = {}) {
    const directory = options.directory ?? "/fake/project";
    const tools = new Map();
    for (const tool of options.tools ?? [])
        tools.set(tool.name, { ...tool, id: tool.name });
    const agents = new Map((options.agents ?? []).map((agent) => [agent.id, { ...agent }]));
    const sessions = new Map((options.sessions ?? []).map((session) => [session.id, { ...session }]));
    const messages = new Map(Object.entries(options.messages ?? {}));
    const skills = new Map((options.skills ?? []).map((skill) => [skill.id, { ...skill }]));
    const storage = new Map(Object.entries(options.storage ?? {}));
    const mcp = new Map(Object.entries(options.mcp ?? {}).map(([name, config]) => [name, { ...config }]));
    const commands = new Map();
    const asserts = [];
    const replies = [];
    const agentUpdates = [];
    const agentDefaults = [];
    const calls = [];
    const hooks = { tool: [], shell: [], permission: [], session: [] };
    const live = new Set();
    let sequence = 0;
    const register = (onDispose = () => { }) => {
        const token = {};
        live.add(token);
        return {
            dispose: async () => {
                if (!live.delete(token))
                    return;
                onDispose();
            },
        };
    };
    const hook = (domain) => async (name, callback) => {
        const entry = { name, callback };
        hooks[domain].push(entry);
        return register(() => {
            const list = hooks[domain];
            const at = list.indexOf(entry);
            if (at >= 0)
                list.splice(at, 1);
        });
    };
    const fire = (domain) => async (name, payload) => {
        for (const entry of [...hooks[domain]]) {
            if (entry.name === name)
                await entry.callback(payload);
        }
        return payload;
    };
    const toolTransform = async (callback) => {
        const added = [];
        const editor = {
            list: () => [...tools.values()],
            get: (id) => tools.get(id),
            namespace: () => { },
            add: (tool) => {
                tools.set(tool.name, { ...tool, id: tool.name });
                added.push(tool.name);
            },
            update: (id, update) => {
                const tool = tools.get(id);
                if (tool !== undefined)
                    update(tool);
            },
            remove: (id) => void tools.delete(id),
        };
        callback(editor);
        return register(() => {
            for (const name of added)
                tools.delete(name);
        });
    };
    const agentTransform = async (callback) => {
        const editor = {
            list: () => [...agents.values()],
            get: (id) => agents.get(id),
            default: (id) => void agentDefaults.push(id),
            update: (id, update) => {
                agentUpdates.push(id);
                const agent = agents.get(id) ?? { id };
                update(agent);
                agents.set(id, agent);
            },
            remove: (id) => void agents.delete(id),
        };
        callback(editor);
        return register();
    };
    const commandTransform = async (callback) => {
        const added = [];
        callback({
            add: (command) => {
                commands.set(command.name, { ...command });
                added.push(command.name);
            },
        });
        return register(() => {
            for (const name of added)
                commands.delete(name);
        });
    };
    const permissionAssert = async (input) => {
        asserts.push(input);
        await options.assert?.(input);
    };
    const subscribers = new Set();
    const subscribe = (input) => {
        calls.push({ method: "event.subscribe", input });
        const subscriber = { queue: [], closed: false };
        subscribers.add(subscriber);
        const done = { value: undefined, done: true };
        return {
            [Symbol.asyncIterator]: () => ({
                next: async () => {
                    while (subscriber.queue.length === 0 && !subscriber.closed) {
                        await new Promise((resolve) => {
                            subscriber.wake = resolve;
                        });
                    }
                    subscriber.wake = undefined;
                    if (subscriber.queue.length > 0)
                        return { value: subscriber.queue.shift(), done: false };
                    return done;
                },
                return: async () => {
                    subscriber.closed = true;
                    subscribers.delete(subscriber);
                    return done;
                },
            }),
        };
    };
    const sessionGet = async (input) => {
        calls.push({ method: "session.get", input });
        const session = sessions.get(input.sessionID);
        if (session === undefined)
            throw new Error(`fake context: no session ${input.sessionID}`);
        return session;
    };
    const sessionCreate = async (input = {}) => {
        calls.push({ method: "session.create", input });
        const id = typeof input.id === "string" ? input.id : `ses_fake${++sequence}`;
        const location = input.location ?? { directory };
        const session = { ...input, id, location };
        sessions.set(id, session);
        return session;
    };
    const sessionRemove = async (input) => {
        calls.push({ method: "session.remove", input });
        sessions.delete(input.sessionID);
        messages.delete(input.sessionID);
    };
    const sessionMove = async (input) => {
        calls.push({ method: "session.move", input });
        const session = sessions.get(input.sessionID);
        if (session !== undefined)
            session.location = { directory: input.directory };
    };
    const cursors = new Map();
    const updatedAt = (session) => {
        const time = session.time;
        return typeof time?.updated === "number" ? time.updated : 0;
    };
    const matchesQuery = (session, query) => {
        if ("project" in query && session.projectID !== query.project)
            return false;
        // The host matches the directory and every directory below it.
        if ("directory" in query) {
            const where = session.location?.directory;
            if (typeof where !== "string" || typeof query.directory !== "string" || !insideDirectory(where, query.directory))
                return false;
        }
        if (typeof query.search === "string" && query.search) {
            const title = typeof session.title === "string" ? session.title.toLowerCase() : "";
            if (!title.includes(query.search.toLowerCase()))
                return false;
        }
        if (query.parentID === null && session.parentID !== undefined && session.parentID !== null)
            return false;
        if (typeof query.parentID === "string" && session.parentID !== query.parentID)
            return false;
        const archived = session.time?.archived !== undefined;
        if (query.archived === true && !archived)
            return false;
        if (query.archived === false && archived)
            return false;
        return true;
    };
    // Mirrors the host: filters as given (no implicit archived or parentID filter), ordered by
    // `time.updated`, and a cursor that carries the filters of the first page.
    const sessionList = async (input = {}) => {
        calls.push({ method: "session.list", input });
        const page = typeof input.cursor === "string" ? cursors.get(input.cursor) : { query: input, offset: 0 };
        if (page === undefined)
            throw new Error(`fake context: unknown cursor ${String(input.cursor)}`);
        const { query, offset } = page;
        const order = query.order === "asc" ? 1 : -1;
        const all = [...sessions.values()]
            .filter((session) => matchesQuery(session, query))
            .sort((a, b) => order * (updatedAt(a) - updatedAt(b)) || order * a.id.localeCompare(b.id));
        const limit = typeof query.limit === "number" ? query.limit : all.length;
        const data = all.slice(offset, offset + limit);
        if (offset + limit >= all.length)
            return { data, cursor: {} };
        const next = `cursor_${++sequence}`;
        cursors.set(next, { query, offset: offset + limit });
        return { data, cursor: { next } };
    };
    const sessionContext = async (input) => {
        calls.push({ method: "session.context", input });
        if (!sessions.has(input.sessionID))
            throw new Error(`fake context: no session ${input.sessionID}`);
        return messages.get(input.sessionID) ?? [];
    };
    const skillTransform = async (callback) => {
        const added = [];
        const editor = {
            list: () => [...skills.values()],
            get: (id) => skills.get(id),
            add: (skill) => {
                skills.set(skill.id, { ...skill });
                added.push(skill.id);
            },
            update: (id, update) => {
                const skill = skills.get(id);
                if (skill !== undefined)
                    update(skill);
            },
            remove: (id) => void skills.delete(id),
        };
        callback(editor);
        return register(() => {
            for (const id of added)
                skills.delete(id);
        });
    };
    const mcpTransform = async (callback) => {
        const added = [];
        callback({
            list: () => [...mcp.entries()],
            get: (name) => mcp.get(name),
            set: (name, config) => {
                if (!mcp.has(name))
                    added.push(name);
                mcp.set(name, { ...config });
            },
            update: (name, update) => {
                const config = mcp.get(name);
                if (config !== undefined)
                    update(config);
            },
            remove: (name) => void mcp.delete(name),
        });
        return register(() => {
            for (const name of added)
                mcp.delete(name);
        });
    };
    const sessionSynthetic = async (input) => {
        calls.push({ method: "session.synthetic", input });
        return {
            id: `msg_fake${++sequence}`,
            sessionID: input.sessionID,
            time: { created: Date.now() },
            type: "synthetic",
            payload: input,
            delivery: input.delivery ?? "queue",
        };
    };
    const sessionPrompt = async (input) => {
        calls.push({ method: "session.prompt", input });
        return {
            id: `msg_fake${++sequence}`,
            sessionID: input.sessionID,
            time: { created: Date.now() },
            type: "user",
            payload: input,
            delivery: input.delivery ?? "queue",
        };
    };
    const sessionInterrupt = async (input) => {
        calls.push({ method: "session.interrupt", input });
        return { interrupted: false };
    };
    const scan = async (input) => {
        const keys = [...storage.keys()]
            .filter((key) => key.startsWith(input.prefix) && (input.after === undefined || key > input.after))
            .sort();
        const page = input.limit === undefined ? keys : keys.slice(0, input.limit);
        const entries = page.map((key) => ({ key, value: storage.get(key) }));
        const next = page.length < keys.length ? page[page.length - 1] : undefined;
        return next === undefined ? { entries } : { entries, next };
    };
    const context = {
        location: options.projectID === undefined ? { directory } : { directory, project: { id: options.projectID, directory, canonical: directory } },
        worktree: { transform: async () => ({ dispose: async () => { } }), list: async () => (options.worktrees ?? []).map((dir) => ({ directory: dir })) },
        options: options.options ?? {},
        tool: {
            transform: toolTransform,
            hook: hook("tool"),
            reload: async () => { },
            list: async () => [...tools.values()],
        },
        shell: { hook: hook("shell") },
        permission: {
            hook: hook("permission"),
            assert: permissionAssert,
            reply: async (input) => void replies.push(input),
        },
        session: {
            hook: hook("session"),
            list: sessionList,
            get: sessionGet,
            context: sessionContext,
            create: sessionCreate,
            move: sessionMove,
            remove: sessionRemove,
            synthetic: sessionSynthetic,
            prompt: sessionPrompt,
            interrupt: sessionInterrupt,
        },
        command: {
            transform: commandTransform,
            reload: async () => { },
            list: async () => [...commands.values()],
        },
        agent: {
            transform: agentTransform,
            reload: async () => { },
            list: async () => {
                calls.push({ method: "agent.list", input: undefined });
                return [...agents.values()];
            },
            get: async (input) => agents.get(input.agentID ?? input.id ?? ""),
        },
        event: { subscribe },
        skill: {
            transform: skillTransform,
            reload: async () => { },
            list: async () => [...skills.values()],
        },
        mcp: {
            transform: mcpTransform,
            reload: async () => { },
            list: async () => [...mcp.keys()].map((name) => ({ name })),
        },
        storage: {
            get: async (key) => storage.get(key),
            set: async (key, value) => void storage.set(key, value),
            remove: async (key) => void storage.delete(key),
            scan,
        },
    };
    return {
        context: context,
        tools,
        agents,
        commands,
        agentUpdates,
        agentDefaults,
        storage,
        sessions,
        messages,
        skills,
        mcp,
        asserts,
        replies,
        calls,
        fire: { tool: fire("tool"), shell: fire("shell"), permission: fire("permission"), session: fire("session") },
        hooks: (domain) => hooks[domain].map((entry) => entry.name),
        emit: (event) => {
            for (const subscriber of subscribers) {
                subscriber.queue.push(event);
                subscriber.wake?.();
            }
        },
        closeEvents: () => {
            for (const subscriber of subscribers) {
                subscriber.closed = true;
                subscriber.wake?.();
            }
            subscribers.clear();
        },
        active: () => live.size,
    };
}
/**
 * Whether `name` is a variable `bd` reads: anything starting with `BEADS_` or `BD_`
 * (`BEADS_DIR`, `BEADS_DB`, `BEADS_ACTOR`, `BD_ACTOR`, `BD_DB`, `BD_SOCKET`,
 * `BEADS_DOLT_SERVER_*`, `BEADS_DOLT_SHARED_SERVER`, ...). The OpenCode server, and so a
 * test process, can inherit these from another project's shell; they carry that project's
 * ledger, actor or dolt server routing, so a test that runs a real `bd` would act on it.
 * A prefix rule covers variables a later `bd` release adds. `SROBROEK_BEADS_PIN` and
 * `MY_BD_X` do not match.
 */
export function isBeadsEnvKey(name) {
    return name.startsWith("BEADS_") || name.startsWith("BD_");
}
/**
 * A copy of `process.env` for a test child: every {@link isBeadsEnvKey} variable removed,
 * then `extra` applied. A key in `extra` with value `undefined` is left unset.
 */
export function scrubbedBeadsEnv(extra = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env))
        if (isBeadsEnvKey(key))
            delete env[key];
    Object.assign(env, extra);
    return Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== undefined));
}
