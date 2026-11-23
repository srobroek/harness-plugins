import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { findPaths, readFiles, resolvePath } from "./files.ts"

const base = mkdtempSync(path.join(tmpdir(), "parley-pi-files-"))
mkdirSync(path.join(base, "samples"))
writeFileSync(path.join(base, "samples", "notes.txt"), "hello")
writeFileSync(path.join(base, "samples", ".hidden"), "")
afterAll(() => rmSync(base, { recursive: true, force: true }))

test("readFiles reads typed paths relative to the session directory", () => {
  expect(readFiles("samples/notes.txt", base)).toEqual([
    { name: "notes.txt", path: "samples/notes.txt", mime: "text/plain", size: 5, data: Buffer.from("hello").toString("base64") },
  ])
  expect(() => readFiles("samples/missing.txt", base)).toThrow("No such file: samples/missing.txt")
  expect(() => readFiles("samples", base)).toThrow("No such file: samples")
})

test("findPaths lists the typed directory, directories ending in /", () => {
  expect(findPaths("sam", base)).toEqual(["samples/"])
  expect(findPaths("a.txt, samples/no", base)).toEqual(["samples/notes.txt"])
  expect(findPaths("samples/.", base).sort()).toEqual(["samples/.hidden", "samples/notes.txt"])
  expect(findPaths("nowhere/x", base)).toEqual([])
})

test("resolvePath expands ~ and keeps absolute paths", () => {
  expect(resolvePath("/etc/hosts", base)).toBe("/etc/hosts")
  expect(resolvePath("~/x", base)).toBe(`${process.env.HOME ?? ""}/x`)
})
