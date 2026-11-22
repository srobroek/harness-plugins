/** In-memory snapshots for the pure check tests. */
/** The optional @opencode/plugin peer that AGENTS.md requires; spread it into a manifest that must pass the peer rule. */
export const OPTIONAL_PEER = {
    peerDependencies: { "@opencode/plugin": "^2.1.4" },
    peerDependenciesMeta: { "@opencode/plugin": { optional: true } },
};
export function plugin(name, manifest = {}, extra = {}) {
    return {
        name,
        manifest: {
            private: true,
            type: "module",
            exports: { ".": "./dist/index.js" },
            files: ["dist", "index.js"],
            ...manifest,
        },
        src: [],
        skills: [],
        agents: [],
        hasSkillsDir: false,
        hasAgentsDir: false,
        hasReadme: true,
        hasChangelog: true,
        tests: ["index.test.ts"],
        ...extra,
    };
}
export function repo(overrides = {}) {
    return { root: {}, plugins: [], ...overrides };
}
