import { describe, expect, test } from "bun:test"
import { parse } from "@srobroek/opencode-lib/beads-shell"
import { ACCEPTED_FORMS, beadIn, mayCreatePr, type ReadFile, readPrCreate, TRAILER_RULE } from "./pr-create-form.ts"

const noFile: ReadFile = () => ({ ok: false, reason: "unexpected file read" })

describe("beadIn", () => {
  test.each([
    ["Bead: a-1", "a-1"],
    ["Closes-Bead: chezmoi-4rc2", "chezmoi-4rc2"],
    ["Bead-Id: omp-plugins-dd1", "omp-plugins-dd1"],
    ["bead: a-1", "a-1"],
    ["CLOSES-BEAD:\ta-1  ", "a-1"],
    ["  \tBead: a-1", "a-1"],
    ["Adds a thing.\n\nBead: a-1\n", "a-1"],
    ["Bead: a-1\r\nmore", "a-1"],
    ["Bead: a-1\nBead: b-2", "a-1"],
  ])("finds the bead in %j", (body, id) => {
    expect(beadIn(body)).toBe(id)
  })

  test.each([
    ["no trailer", "Adds a fish alias."],
    ["a BOM before the key", "\uFEFFBead: a-1"],
    ["a no-break space before the key", "\u00A0Bead: a-1"],
    ["text before the key", "x Bead: a-1"],
    ["text after the id", "Bead: a-1 fixes it"],
    ["a bare id", "Fixes omp-plugins-dd1 somehow"],
    ["a bead-shaped key", "Beading: omp-1"],
    ["an id without a dash", "Bead: abc"],
    ["a literal backslash n", "x\\nBead: a-1"],
    ["a non-ASCII id", "Bead: ä-1"],
    ["the rejected opt-out", "No-Bead: reason"],
    ["a lone carriage return as the separator", "x\rBead: a-1"],
  ])("finds nothing in %s", (_name, body) => {
    expect(beadIn(body)).toBeUndefined()
  })
})

describe("readPrCreate: forms it reads", () => {
  test.each([
    ["a single-quoted multi-line body", "gh pr create --body 'a\nBead: a-1\n'", "a\nBead: a-1\n", null],
    ["a double-quoted body", 'gh pr create --body "Bead: a-1"', "Bead: a-1", null],
    ["--body=", "gh pr new --body='Bead: a-1'", "Bead: a-1", null],
    ["-b", "gh pr create -b x -d", "x", null],
    ["a bare --body=", "gh pr create --body=Bead:a-1", "Bead:a-1", null],
    ["boolean flags and a quoted title", "gh pr create --title 'a b' --draft --no-maintainer-edit --dry-run --body x", "x", null],
    ["every valued flag", "gh pr create -t t -B b -H h -r r -a a -l l -m m -p p --body x", "x", null],
    ["--repo", "gh pr create --body x --repo o/r", "x", "o/r"],
    ["-R with a host, the last one winning", "gh pr create -R a/b -R ghe.example.com/o/r --body x", "x", "ghe.example.com/o/r"],
    ["a repository that starts with a dot", "gh pr create --body x -R owner/.github", "x", "owner/.github"],
    ["a repository that starts with an underscore or a dash", "gh pr create --body x -R owner/_-x", "x", "owner/_-x"],
    ["a dotted repository on a host", "gh pr create --body x -R ghe.example.com/o/a.b_c-d", "x", "ghe.example.com/o/a.b_c-d"],
    ["tabs and repeated spaces between words", "gh  pr\tcreate   --body\tx", "x", null],
    ["a backslash-newline continuation", "gh pr create \\\n  --title t \\\n  --body x", "x", null],
    ["surrounding whitespace and a final newline", "\n  gh pr create --body x \n", "x", null],
  ])("%s", (_name, command, text, repo) => {
    expect(readPrCreate(command, noFile)).toEqual({ kind: "form", body: expect.objectContaining({ text }), repo })
  })

  test.each([
    ["--body-file", "gh pr create --body-file b.md", "b.md"],
    ["--body-file=", "gh pr create --body-file=docs/b.md", "docs/b.md"],
    ["-F", "gh pr create -F b.md --title t", "b.md"],
  ])("reads the file for %s and names it as the source", (_name, command, path) => {
    const seen: string[] = []
    const read = readPrCreate(command, (file) => {
      seen.push(file)
      return { ok: true, text: "from file" }
    })
    expect(seen).toEqual([path])
    expect(read).toEqual({ kind: "form", body: { text: "from file", source: `--body-file ${path}` }, repo: null })
  })
})

describe("readPrCreate: forms it refuses, naming the rule", () => {
  test.each([
    ["a second command", "gh pr create --body x; ls", "not the only command"],
    ["a chain", "git push && gh pr create --body x", "not the only command"],
    ["a pipe", "gh pr create --body x | cat", "not the only command"],
    ["a group", "(gh pr create --body x)", "not the only command"],
    ["a redirection", "gh pr create --body x > out", "redirection"],
    ["an assignment", "FOO=1 gh pr create --body x", "command word"],
    ["a wrapper", "env gh pr create --body x", "command word"],
    ["a quoted command word", "g''h pr create --body x", "command word"],
    ["a variable command word", "$GH pr create --body x", "command word"],
    ["a substitution", "gh pr create --body $(cat f)", "substitution"],
    ["an open quote", "gh pr create --body 'x", "unclosed"],
    ["another gh command", "gh pr list", "not `gh pr create`"],
    ["an alias", "gh mkpr --body x", "not `gh pr create`"],
    ["a trailing comment", "gh pr create --body x # note", "after its last word"],
    ["a CR between words", "gh pr create\r--body x", "not `gh pr create`"],
    ["$ in a double-quoted value", 'gh pr create --body "$X"', "value of `--body`"],
    ["a backtick substitution", 'gh pr create --body "`x`"', "substitution"],
    ["an ANSI-C value", "gh pr create --body $'Bead: a-1'", "value of `--body`"],
    ["mixed quoting in a value", "gh pr create --body a'b'", "value of `--body`"],
    ["an ANSI-C flag", "gh pr create $'--body' x", "not a flag"],
    ["a quoted flag", "gh pr create '--body' x", "not a flag"],
    ["a control character in a value", "gh pr create --body 'a\rb'", "control character"],
    ["a NUL in a value", "gh pr create --body 'a\u0000b'", "control character"],
    ["a positional word", "gh pr create --body x extra", "position 6"],
    ["--", "gh pr create --body x --", "`--`"],
    ["a flag without its value", "gh pr create --title", "no value"],
    ["a boolean flag given a value", "gh pr create --draft=false --body x", "`--draft` is not an accepted flag"],
    ["no body", "gh pr create --title t", "no --body or --body-file"],
    ["a repeated body flag", "gh pr create --body x --body y", "more than one body flag"],
    ["body and body file", "gh pr create --body x -F b.md", "more than one body flag"],
    ["a short cluster", "gh pr create -db x", "attached value or a cluster"],
    ["a short flag with an attached value", "gh pr create -bX", "attached value or a cluster"],
    ["a short flag with =", "gh pr create -b=X", "attached value or a cluster"],
    ["an attached short file", "gh pr create -Fb.md", "attached value or a cluster"],
    ["--fill", "gh pr create --fill", "`--fill` is not an accepted flag"],
    ["--fill-first", "gh pr create --fill-first", "`--fill-first` is not an accepted flag"],
    ["--web", "gh pr create --web", "`--web` is not an accepted flag"],
    ["-w", "gh pr create -w", "`-w` is not an accepted flag"],
    ["--editor", "gh pr create --editor", "`--editor` is not an accepted flag"],
    ["--template", "gh pr create --template t.md --body x", "`--template` is not an accepted flag"],
    ["--recover", "gh pr create --recover k", "`--recover` is not an accepted flag"],
    ["--attach", "gh pr create --attach a", "`--attach` is not an accepted flag"],
    ["a repo that is no OWNER/REPO", "gh pr create -R justname --body x", "--repo value"],
    ["a repo named .", "gh pr create -R owner/. --body x", "--repo value"],
    ["a repo named ..", "gh pr create -R owner/.. --body x", "--repo value"],
    ["a repo with a fourth component", "gh pr create -R a/b/c/d --body x", "--repo value"],
    ["a repo that starts with a dash", "gh pr create -R -x/y --body x", "--repo value"],
    ["a quoted body-file path", "gh pr create -F 'b.md'", "quoted"],
    ["standard input as the body file", "gh pr create -F -", "standard input"],
    ["an absolute body-file path", "gh pr create -F /tmp/b.md", "absolute"],
    ["a body-file path through ..", "gh pr create -F a/../b.md", "`..`"],
    ["a body-file path with a tilde", "gh pr create -F ~/b.md", "value of `-F`"],
    ["a body-file path that starts with a dash", "gh pr create --body-file=-x", "`-` or `~`"],
  ])("%s", (_name, command, rule) => {
    const read = readPrCreate(command, noFile)
    expect(read.kind).toBe("refused")
    if (read.kind === "refused") expect(read.rule).toContain(rule)
  })

  test("a file the reader refuses is refused with the path and the reader's reason", () => {
    const read = readPrCreate("gh pr create -F b.md", () => ({ ok: false, reason: "it is not a regular file" }))
    expect(read).toEqual({ kind: "refused", rule: "--body-file b.md: it is not a regular file" })
  })

  test("a file failure keeps the reader's cause and shows only its reason", () => {
    const cause = new Error("EACCES: permission denied, open '/secret/path/b.md'")
    const read = readPrCreate("gh pr create -F b.md", () => ({ ok: false, reason: "it could not be opened", cause }))
    expect(read).toEqual({ kind: "refused", rule: "--body-file b.md: it could not be opened", cause })
  })

  test("a refusal that is not a file failure has no cause", () => {
    expect(readPrCreate("gh pr create --fill", noFile)).not.toHaveProperty("cause")
  })

  test("a refusal never echoes a body", () => {
    const read = readPrCreate("gh pr create --body 'SECRET-TEXT Bead: a-1' extra", noFile)
    expect(read.kind === "refused" ? read.rule : "").not.toContain("SECRET-TEXT")
  })

  test("the accepted forms and the trailer rule are printed whole", () => {
    expect(ACCEPTED_FORMS).toContain("`gh pr create` or `gh pr new`")
    expect(ACCEPTED_FORMS).toContain("`--body V`, `--body=V` or `-b V`")
    expect(ACCEPTED_FORMS).toContain("`--body-file P`, `--body-file=P` or `-F P`")
    expect(TRAILER_RULE).toContain("`Bead: <id>`, `Closes-Bead: <id>` or `Bead-Id: <id>`")
  })
})

describe("mayCreatePr", () => {
  test.each([
    ["a plain create", "gh pr create --body x"],
    ["gh pr new", "gh pr new --body x"],
    ["behind a wrapper", "timeout 30 gh pr create --body x"],
    ["behind sudo and env", "sudo -u x env A=1 gh pr create"],
    ["with a quoted command word", "g''h pr create --body x"],
    ["with a quoted subcommand", "gh 'pr' create"],
    ["from a variable command word", "$GH pr create --body x"],
    ["as an alias", "gh mkpr --body x"],
    ["as an alias behind a path", "/usr/bin/gh mkpr"],
    ["as an extension", "gh copilot-pr"],
    ["after env -S", "env -S 'gh pr create --body x'"],
    ["after env -iS", `env -iS"gh pr create --body x"`],
    ["after env -uX -S", "env -uX -S 'gh pr create --body x'"],
    ["after env, in a later chain", "ls && env -S 'gh pr create'"],
    ["after env in env", "env -S \"env -S 'gh pr create'\""],
    ["in sh -c", "sh -c 'gh pr create --body x'"],
    ["in sh -c after env -S", `sh -c "env -S 'gh pr create'"`],
    ["in a substitution", 'echo "$(gh pr create --body x)"'],
    ["with an ANSI-C word beside gh", "gh $'p\\x72' create"],
    ["with an expanding word beside create", "x create $Y"],
    ["with two expanding words, one the command", "$A $B"],
    ["in a chain", "git push && gh pr create --body x"],
    ["in a heredoc fed to cat that mentions the words", "cat <<EOF\nrun gh pr create later\nEOF"],
    ["in a heredoc fed to git commit that mentions the words", "git commit -F - <<'EOF'\nrun gh pr create later\nEOF"],
    ["in a heredoc piped to a shell", "cat <<'EOF' | sh\ngh pr create --body x\nEOF"],
    ["in a heredoc fed to tee with a process substitution", "tee >(sh) <<'EOF'\ngh pr create --body x\nEOF"],
    ["in a heredoc fed to git with a shell alias", "git -c alias.x='!sh' x <<'EOF'\ngh pr create --body x\nEOF"],
    ["in a heredoc fed to bd", "bd create --body-file - <<EOF\ngh pr create --body x\nEOF"],
    ["with pr and later new in a heredoc fed to cat", "cat <<EOF\nthe pr is new\nEOF"],
    ["with an expanding here-string fed to cat", 'cat <<<"$X"'],
    ["in a heredoc fed to a wrapped shell", "env sh <<'EOF'\ngh pr create --body x\nEOF"],
    ["in a here-string fed to a shell", "bash <<<'gh pr create --body x'"],
    ["in a heredoc fed to an unknown command", "mytool <<EOF\ngh pr create --body x\nEOF"],
    ["with a gh alias in a heredoc fed to a shell", "sh <<EOF\ngh mkpr\nEOF"],
    ["with an expanding here-string fed to a wrapped shell", 'env sh <<<"$CMD"'],
    ["with an expanding command word in a heredoc fed to a shell", "sh <<EOF\n$A x\nEOF"],
  ])("%s", (_name, command) => {
    expect(mayCreatePr(parse(command))).toBe(true)
  })

  test.each([
    ["gh pr list", "gh pr list --state open"],
    ["gh pr view", "gh pr view 3 --json state"],
    ["gh run watch", "gh run watch 42"],
    ["gh issue create", "gh issue create --title t --body b"],
    ["gh api", "gh api repos/o/r/pulls"],
    ["gh version", "gh --version"],
    ["gh without an operand", "which gh"],
    ["git push", "git push origin main"],
    ["a phrase in one word", "bd create --title 'pr create'"],
    ["a quoted message that mentions it", "git commit -m 'run gh pr create later'"],
    ["one expanding word and no watched word", 'echo "$HOME" done'],
    ["env without a PR", "env FOO=1 ls"],
    ["env -S without a PR", "env -S 'ls -l'"],
    ["two expanding arguments", "ls $A $B"],
    ["a heredoc into git commit", "git commit -F - <<'EOF'\nfix: a thing\nEOF"],
    ["harmless text into a shell", "sh <<EOF\necho hi\nEOF"],
    ["harmless text into a wrapped shell", "env bash <<<'echo hi'"],
  ])("not %s", (_name, command) => {
    expect(mayCreatePr(parse(command))).toBe(false)
  })
})
