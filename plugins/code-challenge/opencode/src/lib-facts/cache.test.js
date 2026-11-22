import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_TTL_MS, cacheFileName, DiskCache, MAX_ENTRY_BYTES } from "./cache.ts";
const dirs = [];
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "lib-facts-cache-"));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});
const T0 = Date.UTC(2026, 10, 1);
const value = { body: { n: 1 }, link: null };
const legacyName = (key) => `${createHash("sha256").update(key).digest("hex")}.json`;
const files = (dir) => readdirSync(dir).sort();
describe("DiskCache", () => {
    test("deletes an expired entry when it reads it", () => {
        const dir = scratch();
        new DiskCache(dir, () => T0).put("k", value);
        expect(files(dir)).toHaveLength(1);
        expect(new DiskCache(dir, () => T0 + CACHE_TTL_MS).get("k")).toBeUndefined();
        expect(files(dir)).toEqual([]);
    });
    test("the first write of an instance removes expired, legacy and stale files and keeps fresh ones", () => {
        const dir = scratch();
        new DiskCache(dir, () => T0).put("old", value);
        new DiskCache(dir, () => T0 + CACHE_TTL_MS - 1000).put("fresh", value);
        writeFileSync(join(dir, "stale.tmp"), "x");
        utimesSync(join(dir, "stale.tmp"), T0 / 1000, T0 / 1000);
        writeFileSync(join(dir, legacyName("legacy")), "{}");
        utimesSync(join(dir, legacyName("legacy")), (T0 + CACHE_TTL_MS) / 1000, (T0 + CACHE_TTL_MS) / 1000);
        new DiskCache(dir, () => T0 + CACHE_TTL_MS + 1000).put("new", value);
        // Inspected before any read, so only the sweep can explain what is gone.
        expect(files(dir)).toEqual([cacheFileName("fresh"), cacheFileName("new")].sort());
    });
    test("trims to the entry limit, keeping the newest entries", () => {
        const dir = scratch();
        for (const [key, offset] of [["a", 0], ["b", 1000], ["c", 2000]])
            new DiskCache(dir, () => T0 + offset).put(key, value);
        new DiskCache(dir, () => T0 + 3000, CACHE_TTL_MS, 2).put("d", value);
        expect(files(dir)).toEqual([cacheFileName("c"), cacheFileName("d")].sort());
    });
    test("does not store an entry over the size cap", () => {
        const dir = scratch();
        new DiskCache(dir, () => T0).put("big", { body: "x".repeat(MAX_ENTRY_BYTES), link: null });
        expect(existsSync(dir) ? files(dir) : []).toEqual([]);
    });
    test("measures the cap in UTF-8 bytes, not UTF-16 units", () => {
        const dir = scratch();
        const body = "é".repeat(MAX_ENTRY_BYTES * 0.6);
        expect(JSON.stringify(body).length).toBeLessThan(MAX_ENTRY_BYTES);
        new DiskCache(dir, () => T0).put("wide", { body, link: null });
        expect(existsSync(dir) ? files(dir) : []).toEqual([]);
    });
    test("refuses to read a file over the size cap and deletes it", () => {
        const dir = scratch();
        const cache = new DiskCache(dir, () => T0);
        const padding = "x".repeat(MAX_ENTRY_BYTES);
        writeFileSync(join(dir, cacheFileName("k")), JSON.stringify({ at: T0, body: padding, link: null }));
        expect(cache.get("k")).toBeUndefined();
        expect(files(dir)).toEqual([]);
    });
    test("never reads a file written in the legacy format", () => {
        const dir = scratch();
        writeFileSync(join(dir, legacyName("k")), JSON.stringify({ at: T0, body: { whole: "reply" }, link: null }));
        expect(new DiskCache(dir, () => T0).get("k")).toBeUndefined();
    });
    test("treats an entry whose body fails the caller's check as a miss and deletes it", () => {
        const dir = scratch();
        const cache = new DiskCache(dir, () => T0);
        cache.put("k", { body: { whole: "reply" }, link: null });
        expect(cache.get("k", (body) => typeof body === "number")).toBeUndefined();
        expect(files(dir)).toEqual([]);
    });
    test.each([
        ["not an object", "[]"],
        ["no timestamp", JSON.stringify({ body: 1, link: null })],
        ["a non-string link", JSON.stringify({ at: T0, body: 1, link: 5 })],
        ["no body", JSON.stringify({ at: T0, link: null })],
        ["invalid JSON", "{"],
    ])("treats a stored entry with %s as a miss", (_name, text) => {
        const dir = scratch();
        writeFileSync(join(dir, cacheFileName("k")), text);
        expect(new DiskCache(dir, () => T0).get("k")).toBeUndefined();
        expect(files(dir)).toEqual([]);
    });
});
