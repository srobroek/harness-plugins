import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OutputError, parseJson, parseOutput } from "./parsers.ts"
import type { Hit, ParserId } from "./types.ts"

const ctx = { root: "/r", cwd: "/r" }

// Samples are trimmed from real runs of each tool against a throwaway fixture.
const CLIPPY_LINE = JSON.stringify({
  reason: "compiler-message",
  message: {
    code: { code: "clippy::needless_range_loop" },
    message: "the loop variable `i` is used to index `v`",
    spans: [
      { is_primary: false, file_name: "src/other.rs", line_start: 1 },
      { is_primary: true, file_name: "src/main.rs", line_start: 4 },
    ],
  },
})

const CASES: Array<{ name: string; parser: ParserId; text: string; expected: Hit[] }> = [
  {
    name: "biome keeps lint diagnostics and strips the lint/ prefix",
    parser: "biome-json",
    text: `The \`json\` reporter is experimental\n${JSON.stringify({
      diagnostics: [
        { message: "Avoid spread", category: "lint/performance/noAccumulatingSpread", location: { path: "c.ts", start: { line: 1, column: 59 } } },
        { message: "parse", category: "parse", location: { path: "c.ts" } },
      ],
    })}`,
    expected: [{ rule: "performance/noAccumulatingSpread", file: "c.ts", line: 1, message: "Avoid spread" }],
  },
  {
    name: "oxlint takes the first label's line",
    parser: "oxlint-json",
    text: JSON.stringify({
      diagnostics: [
        { message: "Do not spread accumulators", code: "oxc(no-accumulating-spread)", filename: "c.ts", labels: [{ span: { line: 7 } }] },
      ],
    }),
    expected: [{ rule: "oxc(no-accumulating-spread)", file: "c.ts", line: 7, message: "Do not spread accumulators" }],
  },
  {
    name: "eslint flattens messages per file",
    parser: "eslint-json",
    text: JSON.stringify([
      { filePath: "/r/c2.js", messages: [{ ruleId: "e18e/prefer-includes", line: 1, message: "Use .includes()" }, { ruleId: null, line: 2, message: "x" }] },
    ]),
    expected: [
      { rule: "e18e/prefer-includes", file: "c2.js", line: 1, message: "Use .includes()" },
      { rule: "eslint", file: "c2.js", line: 2, message: "x" },
    ],
  },
  {
    name: "knip reports unused files and dependencies",
    parser: "knip-json",
    text: JSON.stringify({
      issues: [
        { file: "c.ts", files: [{ name: "c.ts" }], exports: [] },
        { file: "package.json", dependencies: [{ name: "lodash", line: 1 }] },
      ],
    }),
    expected: [
      { rule: "knip/files", file: "c.ts", line: null, message: "files: c.ts" },
      { rule: "knip/dependencies", file: "package.json", line: 1, message: "dependencies: lodash" },
    ],
  },
  {
    name: "jscpd names the other side of a clone",
    parser: "jscpd-json",
    text: JSON.stringify({ duplicates: [{ lines: 25, firstFile: { name: "d1.ts", start: 1 }, secondFile: { name: "d2.ts", start: 3 } }] }),
    expected: [{ rule: "duplication", file: "d1.ts", line: 1, message: "25 duplicated lines also in d2.ts:3" }],
  },
  {
    name: "dependency-cruiser renders a cycle as a path",
    parser: "depcruise-json",
    text: JSON.stringify({
      summary: { violations: [{ rule: { name: "no-circular" }, from: "j/a.js", to: "j/b.js", cycle: [{ name: "j/b.js" }, { name: "j/a.js" }] }] },
    }),
    expected: [{ rule: "no-circular", file: "j/a.js", line: null, message: "j/a.js -> j/b.js -> j/a.js" }],
  },
  {
    name: "ruff reads code, row and message",
    parser: "ruff-json",
    text: JSON.stringify([{ code: "F401", filename: "/r/a.py", location: { row: 1, column: 8 }, message: "`os` imported but unused" }]),
    expected: [{ rule: "F401", file: "a.py", line: 1, message: "`os` imported but unused" }],
  },
  {
    name: "vulture parses file, line and confidence",
    parser: "vulture-text",
    text: "a.py:1: unused import 'os' (90% confidence)\nnoise\n",
    expected: [{ rule: "vulture", file: "a.py", line: 1, message: "unused import 'os' (90% confidence)" }],
  },
  {
    name: "golangci uses the linter name and resolves paths against the root",
    parser: "golangci-json",
    text: JSON.stringify({ Issues: [{ FromLinter: "perfsprint", Text: "string-format: fmt.Sprintf can be replaced", Pos: { Filename: "main.go", Line: 14 } }] }),
    expected: [{ rule: "perfsprint", file: "main.go", line: 14, message: "string-format: fmt.Sprintf can be replaced" }],
  },
  {
    name: "deadcode lists each unreachable function",
    parser: "deadcode-json",
    text: JSON.stringify([{ Name: "main", Path: "x", Funcs: [{ Name: "unusedf", Position: { File: "main.go", Line: 3 } }] }]),
    expected: [{ rule: "deadcode", file: "main.go", line: 3, message: "unreachable function unusedf" }],
  },
  {
    name: "clippy takes the primary span and skips messages without a code",
    parser: "clippy-json",
    text: `${CLIPPY_LINE}\n${JSON.stringify({ reason: "compiler-message", message: { message: "aborting", spans: [] } })}\n{"reason":"build-finished"}\n`,
    expected: [{ rule: "clippy::needless_range_loop", file: "src/main.rs", line: 4, message: "the loop variable `i` is used to index `v`" }],
  },
  {
    name: "cargo-machete lists dependencies under each manifest",
    parser: "machete-text",
    text: "Analyzing dependencies of crates in this directory...\ncargo-machete found the following unused dependencies in this directory:\nx -- /r/Cargo.toml:\n\tserde\n\tregex\n",
    expected: [
      { rule: "unused-dependency", file: "Cargo.toml", line: null, message: "unused dependency serde" },
      { rule: "unused-dependency", file: "Cargo.toml", line: null, message: "unused dependency regex" },
    ],
  },
  {
    name: "lizard flags only functions past the limits",
    parser: "lizard-csv",
    text: [
      '10,3,35,1,10,"f@2-11@./a.py","./a.py","f","f( xs )",2,11',
      '60,12,300,6,70,"g@5-74@./a.py","./a.py","g","g( a, b, c, d, e, f )",5,74',
    ].join("\n"),
    expected: [
      { rule: "lizard/ccn", file: "a.py", line: 5, message: "g has cyclomatic complexity 12" },
      { rule: "lizard/nloc", file: "a.py", line: 5, message: "g has 60 lines of code" },
      { rule: "lizard/params", file: "a.py", line: 5, message: "g takes 6 parameters" },
    ],
  },
]

describe("parseOutput", () => {
  test.each(CASES)("$name", ({ parser, text, expected }) => {
    expect(parseOutput(parser, text, ctx)).toEqual(expected)
  })

  test.each([
    ["ruff-json", "Traceback (most recent call last):"],
    ["ruff-json", ""],
    ["golangci-json", ""],
    ["knip-json", "[]"],
    ["biome-json", "not json"],
    ["eslint-json", "{}"],
    ["jscpd-json", ""],
    ["depcruise-json", "Error: cannot read config"],
    ["oxlint-json", ""],
    ["deadcode-json", "oops"],
  ] as const)("%s output %p is an error, not zero findings", (parser, text) => {
    expect(() => parseOutput(parser, text, ctx)).toThrow(OutputError)
  })

  test("empty well-formed output is zero findings", () => {
    expect(parseOutput("ruff-json", "[]", ctx)).toEqual([])
    expect(parseOutput("deadcode-json", "null", ctx)).toEqual([])
    expect(parseOutput("deadcode-json", "", ctx)).toEqual([])
    expect(parseOutput("golangci-json", '{"Issues":null}', ctx)).toEqual([])
    expect(parseOutput("vulture-text", "", ctx)).toEqual([])
  })

  test("paths outside the cwd resolve against it, then the root", () => {
    const hits = parseOutput(
      "golangci-json",
      JSON.stringify({ Issues: [{ FromLinter: "unused", Text: "t", Pos: { Filename: "pkg/x.go", Line: 2 } }] }),
      { root: "/r", cwd: "/r/svc" },
    )
    expect(hits[0]?.file).toBe("svc/pkg/x.go")
  })
})

describe("parseJson", () => {
  test("skips a banner before the payload", () => {
    expect(parseJson('banner\n{"a":1}')).toEqual({ a: 1 })
  })
})

describe("import-linter module resolution", () => {
  const OUTPUT =
    "Contracts: 0 kept, 1 broken.\n\n\n----------------\nBroken contracts\n----------------\n\nlayers\n------\n\npk.b is not allowed to import pk.a:\n\n- pk.b -> pk.a (l.4)\n"
  const roots: string[] = []
  const repo = (files: string[]): string => {
    const root = mkdtempSync(join(tmpdir(), "challenge-il-"))
    roots.push(root)
    for (const file of files) {
      mkdirSync(join(root, file, ".."), { recursive: true })
      writeFileSync(join(root, file), "")
    }
    return root
  }
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })
  const message = "pk.b is not allowed to import pk.a (pk.b -> pk.a)"

  test.each([
    ["a flat module", ["pk/b.py"], "pk/b.py"],
    ["a src-layout module", ["src/pk/b.py"], "src/pk/b.py"],
    ["a package", ["pk/b/__init__.py"], "pk/b/__init__.py"],
    ["a src-layout package", ["src/pk/b/__init__.py"], "src/pk/b/__init__.py"],
  ])("maps %s to its file", (_name, files, expected) => {
    const root = repo(files)
    expect(parseOutput("import-linter-text", OUTPUT, { root, cwd: root })).toEqual([
      { rule: "layers", file: expected, line: 4, message },
    ])
  })

  test("an unresolvable module has no file and no line", () => {
    const root = repo(["other.py"])
    expect(parseOutput("import-linter-text", OUTPUT, { root, cwd: root })).toEqual([
      { rule: "layers", file: null, line: null, message },
    ])
  })
})
