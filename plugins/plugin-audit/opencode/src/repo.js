/** Reads the repository into a RepoSnapshot. The only module that touches the file system. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
function readText(file) {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}
function readJson(file) {
    return JSON.parse(readFileSync(file, "utf8"));
}
/** Files under `dir` (relative paths) whose names pass `keep`, read as text. */
function filesUnder(dir, keep) {
    if (!existsSync(dir))
        return [];
    return readdirSync(dir, { recursive: true })
        .filter((relative) => keep(relative))
        .sort()
        .map((relative) => ({ path: relative.split("\\").join("/"), text: readFileSync(join(dir, relative), "utf8") }));
}
function loadPlugin(root, name) {
    const dir = join(root, "plugins", name);
    const isTest = (relative) => /\.test\.tsx?$/.test(relative);
    const src = filesUnder(join(dir, "src"), (relative) => /\.tsx?$/.test(relative));
    const tests = src
        .map((file) => file.path.slice(file.path.lastIndexOf("/") + 1))
        .filter((name) => /\.test\.ts$/.test(name))
        .sort();
    return {
        name,
        manifest: readJson(join(dir, "package.json")),
        src: src
            .filter((file) => !isTest(file.path))
            .map((file) => ({ path: `plugins/${name}/src/${file.path}`, text: file.text })),
        skills: filesUnder(join(dir, "skills"), (relative) => relative.endsWith(".md")).map((file) => ({
            path: `plugins/${name}/skills/${file.path}`,
            text: file.text,
        })),
        agents: existsSync(join(dir, "agents"))
            ? readdirSync(join(dir, "agents"))
                .filter((entry) => entry.endsWith(".md"))
                .sort()
                .map((entry) => ({ path: `plugins/${name}/agents/${entry}`, text: readFileSync(join(dir, "agents", entry), "utf8") }))
            : [],
        hasSkillsDir: existsSync(join(dir, "skills")),
        hasAgentsDir: existsSync(join(dir, "agents")),
        hasReadme: existsSync(join(dir, "README.md")),
        hasChangelog: existsSync(join(dir, "CHANGELOG.md")),
        tests,
    };
}
/** Loads the root package.json and every plugins/<name>/ directory that has a package.json. */
export function loadRepo(root) {
    const pluginsDir = join(root, "plugins");
    const names = existsSync(pluginsDir)
        ? readdirSync(pluginsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, "package.json")))
            .map((entry) => entry.name)
            .sort()
        : [];
    const biome = readText(join(root, "biome.json"));
    const releaseConfig = readText(join(root, "release-please-config.json"));
    const releaseManifest = readText(join(root, ".release-please-manifest.json"));
    return {
        root: readJson(join(root, "package.json")),
        biome,
        plugins: names.map((name) => loadPlugin(root, name)),
        releaseConfig: releaseConfig === undefined ? undefined : JSON.parse(releaseConfig),
        releaseManifest: releaseManifest === undefined ? undefined : JSON.parse(releaseManifest),
    };
}
