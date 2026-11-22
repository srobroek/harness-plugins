import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowSteeringReads, DEFAULT_STEERING_DIRS, readSteeringDirs, steeringRoots } from "./steering-dirs.ts";
const base = join(realpathSync(tmpdir()), "opencode");
let dir;
let steering;
let outside;
beforeAll(() => {
    mkdirSync(base, { recursive: true });
    dir = realpathSync(mkdtempSync(join(base, "steering-")));
    steering = join(dir, "home/.config/opencode/steering");
    outside = join(dir, "home/.config/opencode/other");
    mkdirSync(steering, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), "x");
    symlinkSync(join(outside, "secret.md"), join(steering, "link.md"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const evaluation = (resources, effect = "ask", action = "external_directory") => ({ action, resources, effect });
describe("readSteeringDirs", () => {
    test("defaults to the user's steering directory and keeps only strings from a list", () => {
        expect(readSteeringDirs(undefined)).toEqual([...DEFAULT_STEERING_DIRS]);
        expect(readSteeringDirs(["/a", 3, ""])).toEqual(["/a"]);
    });
});
describe("steeringRoots", () => {
    test("expands ~ and keeps an existing directory the user owns", () => {
        expect(steeringRoots(["~/.config/opencode/steering"], join(dir, "home"))).toEqual([steering]);
    });
    test("resolves a symlinked directory to its real path", () => {
        const real = join(dir, "real-steering");
        mkdirSync(real);
        symlinkSync(real, join(dir, "linked-steering"));
        expect(steeringRoots([join(dir, "linked-steering")])).toEqual([real]);
    });
    test("drops a missing directory, a relative path and a directory owned by someone else", () => {
        expect(steeringRoots(["~/nope", "relative/dir"], join(dir, "home"))).toEqual([]);
        expect(steeringRoots([steering], "/h", () => -1)).toEqual([]);
    });
});
describe("allowSteeringReads", () => {
    const roots = () => steeringRoots([steering]);
    test("allows a file and a directory pattern inside the directory", () => {
        for (const resource of [join(steering, "git-defender.md"), `${steering}/*`, steering]) {
            const e = evaluation([resource]);
            allowSteeringReads(e, roots());
            expect(e.effect).toBe("allow");
        }
    });
    test("leaves a sibling directory, a parent and a ..-escape asking", () => {
        for (const resource of [join(outside, "secret.md"), join(dir, "home/.config/opencode"), `${steering}/../other/secret.md`]) {
            const e = evaluation([resource]);
            allowSteeringReads(e, roots());
            expect(e.effect).toBe("ask");
        }
    });
    test("leaves a symlink that escapes the directory asking", () => {
        const e = evaluation([join(steering, "link.md")]);
        allowSteeringReads(e, roots());
        expect(e.effect).toBe("ask");
    });
    test("leaves mixed resources asking", () => {
        const e = evaluation([join(steering, "a.md"), join(outside, "secret.md")]);
        allowSteeringReads(e, roots());
        expect(e.effect).toBe("ask");
    });
    test("never overrides a deny and ignores other actions and no roots", () => {
        const denied = evaluation([join(steering, "a.md")], "deny");
        allowSteeringReads(denied, roots());
        expect(denied.effect).toBe("deny");
        const other = evaluation([join(steering, "a.md")], "ask", "shell");
        allowSteeringReads(other, roots());
        expect(other.effect).toBe("ask");
        const none = evaluation([join(steering, "a.md")]);
        allowSteeringReads(none, []);
        expect(none.effect).toBe("ask");
    });
});
