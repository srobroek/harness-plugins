import { describe, expect, test } from "bun:test"
import { parse } from "@srobroek/opencode-lib/beads-shell"
import { ACCEPTED_FORMS, beadIn, mayCreatePr, type ReadFile, readPrCreate, scanCreate, TRAILER_RULE, validRepository } from "./pr-create-form.ts"

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
    ["from a variable as the whole command", 'c="gh pr create --body x"; $c'],
    ["from a command substitution as the command", "$(printf 'gh pr create --body x')"],
    ["from a variable command word alone", "$EDITOR notes.md"],
    ["in bash -lc", "bash -lc 'gh pr create --body x'"],
    ["in sh -c", 'sh -c "gh pr create --body x"'],
    ["in zsh -ec", "zsh -ec 'gh mkpr'"],
    ["in dash -c after an option", "dash -x -c 'gh pr create --body x'"],
    ["behind a wrapper in bash -c", "sudo -u x bash -c 'gh pr create --body x'"],
    ["in the string of bash -c after a flag cluster", "bash -ilc 'gh pr create --body x'"],
    ["in eval", "eval 'gh pr create --body x'"],
    ["in eval of several words", "eval gh pr create --body x"],
    ["in source of a literal", "source 'gh pr create --body x'"],
    ["in dot of a literal", ". 'gh pr create --body x'"],
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
    ["gh api POSTing to pulls with -X", "gh api -X POST repos/o/r/pulls -f title=t"],
    ["gh api POSTing to pulls with --method=", "gh api --method=post repos/o/r/pulls"],
    ["gh api -XPOST attached", "gh api -XPOST repos/o/r/pulls"],
    ["gh api with -f implying POST", "gh api repos/o/r/pulls -f title=t -f head=h -f base=main"],
    ["gh api with -F implying POST", "gh api repos/o/r/pulls -F draft=true"],
    ["gh api with --field implying POST", "gh api repos/o/r/pulls --field title=t"],
    ["gh api with --raw-field implying POST", "gh api repos/o/r/pulls --raw-field title=t"],
    ["gh api with --input implying POST", "gh api repos/o/r/pulls --input body.json"],
    ["gh api with an attached -f", "gh api repos/o/r/pulls -ftitle=t"],
    ["gh api with a leading slash and trailing slash", "gh api /repos/o/r/pulls/ -f title=t"],
    ["gh api with placeholders", "gh api repos/{owner}/{repo}/pulls -f title=t"],
    ["gh api with a full URL", "gh api https://api.github.com/repos/o/r/pulls -f title=t"],
    ["gh api with the flags first", "gh api -f title=t -H 'Accept: x' repos/o/r/pulls"],
    ["gh api behind a wrapper", "timeout 30 gh api repos/o/r/pulls -f title=t"],
    ["gh api in sh -c", "sh -c 'gh api repos/o/r/pulls -f title=t'"],
    ["gh api -X=POST, a short assignment", "gh api -X=POST repos/o/r/pulls"],
    ["gh api -X=POST after a boolean flag", "gh api -i -X=POST repos/o/r/pulls"],
    ["gh api a boolean cluster before a field flag", "gh api -if title=t repos/o/r/pulls"],
    ["gh api a GHES absolute URL", "gh api -X POST https://ghe.example/api/v3/repos/o/r/pulls"],
    ["gh api an api.github.com URL with a field", "gh api https://api.github.com/repos/o/r/pulls -f title=t"],
    ["gh api a data-residency URL with a field", "gh api https://api.acme.ghe.com/repos/o/r/pulls -f title=t"],
    ["gh api an absolute URL with placeholders", "gh api -X POST 'https://ghe.example/api/v3/repos/{owner}/{repo}/pulls'"],
    ["gh api with an expanding method", "gh api -X $M repos/o/r/pulls"],
    ["gh api with an expanding endpoint and a field", "gh api $EP -f title=t"],
    ["gh api with an expanding endpoint and POST", "gh api -X POST \"$EP\""],
  ])("%s", (_name, command) => {
    expect(mayCreatePr(parse(command))).toBe(true)
  })

  test.each([
    ["gh pr list", "gh pr list --state open"],
    ["gh pr view", "gh pr view 3 --json state"],
    ["gh run watch", "gh run watch 42"],
    ["gh issue create", "gh issue create --title t --body b"],
    ["gh api", "gh api repos/o/r/pulls"],
    ["gh api GET with a query", "gh api 'repos/o/r/pulls?state=open' --paginate"],
    ["gh api explicit GET with fields as query", "gh api -X GET repos/o/r/pulls -f state=open"],
    ["gh api GET of one pull", "gh api repos/o/r/pulls/3"],
    ["gh api POST to issues", "gh api repos/o/r/issues -f title=t"],
    ["gh api POST to a pull's comments", "gh api repos/o/r/pulls/3/comments -f body=b"],
    ["gh api graphql with fields", "gh api graphql -f query='query { viewer { login } }'"],
    ["gh api PUT merge", "gh api -X PUT repos/o/r/pulls/3/merge -f sha=abc"],
    ["gh api -i=false is not a field flag", "gh api -i=false repos/o/r/pulls"],
    ["gh api -X=GET with a field", "gh api -X=GET repos/o/r/pulls -f state=open"],
    ["gh api an absolute URL to issues", "gh api -X POST https://ghe.example/api/v3/repos/o/r/issues"],
    ["gh api a GET of an absolute pulls URL", "gh api https://api.github.com/repos/o/r/pulls"],
    ["gh api GET with a jq flag", "gh api repos/o/r/pulls -q '.[0].number'"],
    ["gh version", "gh --version"],
    ["gh without an operand", "which gh"],
    ["git push", "git push origin main"],
    ["a phrase in one word", "bd create --title 'pr create'"],
    ["a quoted message that mentions it", "git commit -m 'run gh pr create later'"],
    ["one expanding word and no watched word", 'echo "$HOME" done'],
    ["env without a PR", "env FOO=1 ls"],
    ["env -S without a PR", "env -S 'ls -l'"],
    ["two expanding arguments", "ls $A $B"],
    ["bash -lc with harmless text", "bash -lc 'echo hi'"],
    ["sh -c with harmless text", 'sh -c "ls -l"'],
    ["eval of harmless text", "eval 'echo hi'"],
    ["source of a script path", "source ./env.sh"],
    ["an assignment from a substitution before a plain command", "FOO=$(date) ls"],
    ["a heredoc into git commit", "git commit -F - <<'EOF'\nfix: a thing\nEOF"],
    ["harmless text into a shell", "sh <<EOF\necho hi\nEOF"],
    ["harmless text into a wrapped shell", "env bash <<<'echo hi'"],
  ])("not %s", (_name, command) => {
    expect(mayCreatePr(parse(command))).toBe(false)
  })
})

describe("scanCreate: where a gh api call creates its PR", () => {
  const scan = (command: string, env: NodeJS.ProcessEnv = {}) => scanCreate(parse(command), env)
  const repos = (command: string, env?: NodeJS.ProcessEnv) => scan(command, env).api.map((target) => target.repo)

  test.each([
    ["a relative endpoint", "gh api repos/o/r/pulls -f t=1", {}, "o/r"],
    ["--hostname", "gh api --hostname ghe.example repos/o/r/pulls -f t=1", {}, "ghe.example/o/r"],
    ["--hostname=", "gh api --hostname=ghe.example repos/o/r/pulls -f t=1", {}, "ghe.example/o/r"],
    ["--hostname github.com", "gh api --hostname github.com repos/o/r/pulls -f t=1", {}, "o/r"],
    ["GH_HOST", "gh api repos/o/r/pulls -f t=1", { GH_HOST: "ghe.example" }, "ghe.example/o/r"],
    ["--hostname over GH_HOST", "gh api --hostname github.com repos/o/r/pulls -f t=1", { GH_HOST: "ghe.example" }, "o/r"],
    ["a GHES URL", "gh api -X POST https://ghe.example/api/v3/repos/o/r/pulls", {}, "ghe.example/o/r"],
    ["a GHES URL over --hostname", "gh api --hostname github.com -X POST https://ghe.example/api/v3/repos/o/r/pulls", {}, "ghe.example/o/r"],
    ["an api.github.com URL", "gh api -f t=1 https://api.github.com/repos/o/r/pulls", {}, "o/r"],
    ["a data-residency URL", "gh api -f t=1 https://api.acme.ghe.com/repos/o/r/pulls", {}, "acme.ghe.com/o/r"],
    ["both placeholders", "gh api 'repos/{owner}/{repo}/pulls' -f t=1", {}, null],
  ])("%s", (_name, command, env, expected) => {
    expect(repos(command, env)).toEqual([expected])
  })

  test.each([
    ["one placeholder", "gh api 'repos/{owner}/r/pulls' -f t=1", {}],
    ["placeholders on another host", "gh api --hostname ghe.example 'repos/{owner}/{repo}/pulls' -f t=1", {}],
    ["an expanding endpoint", "gh api $EP -f t=1", {}],
    ["an expanding hostname", "gh api --hostname $H repos/o/r/pulls -f t=1", {}],
    ["a URL with user info", "gh api -f t=1 https://u@ghe.example/api/v3/repos/o/r/pulls", {}],
    ["an invalid GH_HOST", "gh api repos/o/r/pulls -f t=1", { GH_HOST: "a b" }],
  ])("%s is unresolved, a name no lookup accepts", (_name, command, env) => {
    const [repo, ...rest] = repos(command, env)
    expect(rest).toEqual([])
    expect(repo).not.toBeNull()
    expect(validRepository(repo as string)).toBe(false)
  })

  test("a non-api reason is reported beside the api targets", () => {
    expect(scan("gh api repos/o/r/pulls -f t=1").other).toBe(false)
    expect(scan("gh pr create --body x").other).toBe(true)
    const both = scan("gh api repos/o/r/pulls -f t=1 && gh pr create --body x")
    expect(both).toMatchObject({ may: true, other: true })
    expect(both.api.map((target) => target.repo)).toEqual(["o/r"])
  })

  test("a call that cannot create a PR has no target", () => {
    expect(scan("gh api repos/o/r/pulls")).toEqual({ may: false, api: [], other: false })
  })
})
