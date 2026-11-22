import { describe, expect, test } from "bun:test"
import {
  commandFromInput,
  commandSegments,
  invocation,
  leadingCdCwd,
  parse,
  parsedInvocations,
  readsScriptFromStdin,
  type ShellScan,
  scanShell,
} from "./shell-command.ts"

test("a shell interpreter reads its script from stdin only without -c or a script operand", () => {
  const stdin = (command: string) => readsScriptFromStdin(command.split(" "))
  for (const command of ["bash", "sh -s", "bash -s -- a", "bash -o pipefail", "bash -e -x", "/bin/bash -l"])
    expect(stdin(command)).toBe(true)
  for (const command of ["bash -c true", "bash -lc true", "bash script.sh", "sh -o pipefail script.sh", "bash -- script.sh", "cat", "git"])
    expect(stdin(command)).toBe(false)
})

test("executable-only substitutions omit parameter and arithmetic sources without changing the default", () => {
  const source = `echo "\${sleep}" "$((sleep + 1))" "\${value:-$(sleep 5)}" \`sleep 6\` <(sleep 7)`
  const original = scanShell(source)
  expect(original.substitutions).toContain("sleep")
  expect(original.substitutions).toContain("(sleep + 1)")
  expect(original.substitutions).toContain("value:-$(sleep 5)")
  const executable = scanShell(source, { executableSubstitutionsOnly: true })
  expect(executable.substitutions).toEqual(["sleep 5", "sleep 6", "sleep 7"])
  expect(executable.items).toEqual(original.items)
  expect(scanShell(`cat <<EOF\n\${sleep}\n\${value:-$(sleep 5)}\nEOF`, { executableSubstitutionsOnly: true }).substitutions).toEqual(["sleep 5"])
})

/** Each item as text: an operator as itself, a command as its words. */
function outline(scan: ShellScan): string[] {
  return scan.items.map((item) =>
    item.kind === "operator" ? item.operator : item.words.map((word) => word.value).join(" "),
  )
}

test("reads fd redirections as redirections, not as background operators", () => {
  const scan = scanShell("bd list 2>&1 | head -40 &> log; bd prime >| out")
  expect(outline(scan)).toEqual(["bd list", "|", "head -40", ";", "bd prime"])
  expect(
    scan.items.flatMap((item) => (item.kind === "command" ? [item.redirects.map((word) => word.value)] : [])),
  ).toEqual([["1"], ["log"], ["out"]])
})

test("keeps quoted separators inside their word and records exact source offsets", () => {
  const source = `bd close x --reason 'a; b | c' && echo "d && e"`
  const scan = scanShell(source)
  expect(outline(scan)).toEqual(["bd close x --reason a; b | c", "&&", "echo d && e"])
  const first = scan.items[0]
  if (first?.kind !== "command") throw new Error("expected a command first")
  expect(first.words.map((word) => source.slice(word.start, word.end))).toEqual([
    "bd",
    "close",
    "x",
    "--reason",
    "'a; b | c'",
  ])
  expect(first.words[4]?.quoted).toBe(true)
  expect(scan.complete).toBe(true)
})

test("returns every substitution for the caller to judge, wherever it expands", () => {
  const scan = scanShell(
    "echo \"$(bd list)\" `date` <(sort f)\ncat <<EOF\n$(bd show x)\nEOF\ncat <<'EOF'\n$(inert)\nEOF\n",
  )
  expect(scan.substitutions).toEqual(["bd list", "date", "sort f", "bd show x"])
  expect(scan.items.flatMap((item) => (item.kind === "command" ? item.hereDocuments : []))).toEqual([
    { body: "$(bd show x)\n", quoted: false },
    { body: "$(inert)\n", quoted: true },
  ])
})

test("marks words the shell expands later", () => {
  const scan = scanShell("bd -C $DIR close ~/x 'lit$eral' *.md")
  const first = scan.items[0]
  if (first?.kind !== "command") throw new Error("expected a command")
  expect(first.words.map((word) => word.expands)).toEqual([false, false, true, false, true, false, true])
})

test("treats braces as group words only in command position", () => {
  // The group's own redirection is a command with no words.
  expect(outline(scanShell("{ bd list; } > out; find . -exec echo {} +"))).toEqual([
    "{",
    "bd list",
    ";",
    "}",
    "",
    ";",
    "find . -exec echo {} +",
  ])
})

test("drops comments and joins continued lines", () => {
  expect(outline(scanShell("bd list \\\n  --json # then bd close x"))).toEqual(["bd list --json"])
})

test("reports an open quote, substitution or here-document as incomplete", () => {
  for (const source of ["echo 'open", 'echo "open', "echo $(bd list", "cat <<EOF\nbody", "cat <<EOF"]) {
    expect(scanShell(source).complete).toBe(false)
  }
})

test("splits segments at operators outside quotes", () => {
  expect(commandSegments("a && b 'c;d' | e")).toEqual(["a ", "&&", " b 'c;d' ", "|", " e"])
})

test("finds an invocation behind env and wrapper prefixes, never behind a quoted word", () => {
  expect(invocation("env FOO=1 -u BAR sudo git push", ["git", "push"])?.map((token) => token.value)).toEqual([
    "git",
    "push",
  ])
  expect(invocation("/usr/bin/git push origin", ["git", "push"])?.length).toBe(3)
  expect(invocation("'git' push", ["git", "push"])).toBeNull()
  expect(invocation("echo git push", ["git", "push"])).toBeNull()
})

test("resolves a leading literal cd against cwd", () => {
  expect(leadingCdCwd("cd sub && ls", "/repo")).toBe("/repo/sub")
  expect(leadingCdCwd("cd /abs && ls", "/repo")).toBe("/abs")
  expect(leadingCdCwd("cd $DIR && ls", "/repo")).toBe("/repo")
  expect(leadingCdCwd("ls", "/repo")).toBe("/repo")
})

test("parses command positions and nested sources, flagging what it cannot read", () => {
  const parsed = parse("FOO=1 git status; echo \"$(gh pr list)\" | bash -c 'rm x'")
  expect(parsed.commands.map((position) => position.executable)).toEqual(["git", "echo", "bash"])
  expect(parsed.nested.map((child) => child.command)).toEqual(["gh pr list", "rm x"])
  expect(parsed.unknown).toBe(false)
  expect(parse("eval $CMD").unknown).toBe(true)
  expect(parse("echo 'open")).toMatchObject({ kind: "parse-failure", reason: "unbalanced shell quote" })
  expect(parse(42)).toMatchObject({ kind: "parse-failure" })
})

test("finds a substitution whose quoted argument holds parentheses or a nested quote", () => {
  const sources = (command: string) => parse(command).nested.map((child) => child.command)
  expect(sources('echo "$(bd create "a (b)")"')).toEqual(['bd create "a (b)"'])
  expect(sources("echo `bd create 'a ) b'`")).toEqual(["bd create 'a ) b'"])
  const nested = parse("echo \"$(echo $(bd create 'x)'))\"").nested
  expect(nested.map((child) => child.command)).toEqual(["echo $(bd create 'x)')"])
  expect(nested[0]?.nested.map((child) => child.command)).toEqual(["bd create 'x)'"])
  expect(sources("echo '$(bd create x)'")).toEqual([])
  expect(sources("cat <<'EOF'\n$(bd create x)\nEOF")).toEqual([])
  expect(parse('echo "$(bd create "a (b)"').unknown).toBe(true)
})

const sourcesOf = (command: string) => parse(command).nested.map((child) => child.command)

describe("executable substitutions in parameter expansions", () => {
  test.each([
    [`echo "\${X:-'$(bd create y)'}"`, ["bd create y"]],
    ["echo \"${X:-`bd create y`}\"", ["bd create y"]],
    ["cat ${X:-'$(sleep 5)'}", []],
    ["cat ${X:-$(sleep 5)}", ["sleep 5"]],
    ["cat ${X:-'<('$(sleep 5)')'}", ["sleep 5"]],
    ["echo ${X:- #$(sleep 5)}", ["sleep 5"]],
    ['echo ${X:-"$(sleep 5)" ${Y:-`sleep 6`}}', ["sleep 5", "sleep 6"]],
    ["echo ${X:-'#$(sleep 5)'}", []],
    [`echo "\${X:-can't $(sleep 5)}"`, ["sleep 5"]],
    [`echo "\${X:-{ $(sleep 5) }"`, ["sleep 5"]],
    [`echo \${A:-"\${B:-'$(sleep 5)'}"}`, ["sleep 5"]],
    [`echo \${A:-'\${B:-$(sleep 5)}'}`, []],
  ])("reads substitutions in %s", (command, expected) => {
    expect(sourcesOf(command)).toEqual(expected)
  })

  test.each([`echo "\${X:-can't}"`, `echo "\${X:-{}"`, `echo "\${X:-$(printf '{"a":1}')}"`, `echo \${X:-$(printf '{"a":1}')}`, 'echo "${X:-{} ${Y:-${Z}}"'])(
    "parses %s without an unknown construct",
    (command) => {
      expect(parse(command).unknown).toBe(false)
    },
  )

  test(`reads a substitution after a braced word inside a double-quoted expansion`, () => {
    expect(sourcesOf(`echo "\${X:-$(printf '{"a":1}' && sleep 5)}"`)).toEqual([`printf '{"a":1}' && sleep 5`])
  })
})

describe("executable substitutions in shell-fed here-documents and here-strings", () => {
  test.each([
    ["bash <<'EOF'\nbd create y\nEOF", ["bd create y\n"]],
    ["bash -s <<'EOF'\nbd create y\nEOF", ["bd create y\n"]],
    ["sh <<< 'bd create y'", ["bd create y"]],
    ["cat <<'EOF'\nbd create y\nEOF", []],
    ["bash <<<'bd create y' </dev/null", []],
    ["bash <<<'bd create y' >out", ["bd create y"]],
    ["bash <<<'bd create y'>out", ["bd create y"]],
    ["bash <<<'bd create y' 0<&0", ["bd create y"]],
  ])("reads %s", (command, expected) => {
    expect(sourcesOf(command)).toEqual(expected)
  })

  test("ignores a here-document fed to a command that is not a shell", () => {
    expect(sourcesOf("bash -c 'true' <<'EOF'\nbd create y\nEOF").includes("bd create y\n")).toBe(false)
  })
})

describe("executable process substitutions", () => {
  test.each([
    ["cat ${X:-<(sleep 30)}", ["sleep 30"]],
    ["cat ${X:->(sleep 30)}", ["sleep 30"]],
    ['cat "${X:-<(sleep 30)}"', []],
  ])("reads %s", (command, expected) => {
    expect(sourcesOf(command)).toEqual(expected)
  })
})

describe("executable substitutions behind fd-prefixed redirects", () => {
  test.each([
    ["bash 0<<<'bd create y'", ["bd create y"]],
    ["bash <<<'bd create y' 3</dev/null", ["bd create y"]],
    ["bash 3<<<'bd create y' </dev/null", []],
    ["bash 3<<'EOF'\nbd create y\nEOF", []],
    ["bash 3<<<'bd create y'>out", []],
    ["bash 3<<<'x' 0<<<'bd create y'", ["bd create y"]],
    ["bash 3<<<'bd create y' 0<&3", ["bd create y"]],
    ["bash 3<<'EOF' <&3\nbd create y\nEOF", ["bd create y\n"]],
    ["sleep 3 3<<<'x' <&3", []],
  ])("reads %s", (command, expected) => {
    expect(sourcesOf(command)).toEqual(expected)
  })
})

test("lists invocations of one executable with their globals and verb", () => {
  const found = parsedInvocations(parse("gh -R o/r pr list && echo $(gh --json api x)"), "gh", ["--json"])
  expect(found.map(({ verb, globals }) => ({ verb, globals }))).toEqual([
    { verb: "pr", globals: ["-R", "o/r"] },
    { verb: "api", globals: ["--json"] },
  ])
  expect(parsedInvocations(parse("eval $X; gh pr list"), "gh")).toEqual([])
})

test("reads command or cmd from tool input", () => {
  expect(commandFromInput({ command: "ls" })).toBe("ls")
  expect(commandFromInput({ cmd: "pwd" })).toBe("pwd")
  expect(commandFromInput(null)).toBe("")
})
