import { describe, expect, test } from "bun:test";
import { parseAgentFile, permissionEffect } from "./agent-files.ts";
import { composeAgent } from "./fragments.ts";
import { READ_ONLY_SHELL_RULES } from "./read-only-shell.ts";
const rules = [...READ_ONLY_SHELL_RULES];
const effect = (command) => permissionEffect(rules, "shell", command);
describe("shared read-only shell rules", () => {
    test.each([
        "git fetch origin pull/7/head",
        "git log -3",
        "git status",
        "git stash list",
        "gh pr diff 7 --repo o/r",
        "gh pr view 7",
        "gh api repos/o/r/pulls/7",
        "gh api repos/o/r -X GET",
        "gh repo clone o/r /tmp/opencode/r",
        "bd show bd-1",
        "bd --json list",
        "bd dep list bd-1",
        "rg foo",
    ])("allows %s", (command) => expect(effect(command)).toBe("allow"));
    test.each([
        "git push origin main",
        "git commit -m x",
        "git reset --hard",
        "git checkout -- .",
        "git restore x",
        "git clean -fd",
        "git rebase main",
        "git merge x",
        "git branch -D x",
        "git tag -d v1",
        "git stash drop",
        "git worktree remove x",
        "git update-ref -d x",
        "git diff --output=x",
        "gh pr merge 7",
        "gh pr create",
        "gh pr comment 7",
        "gh pr review 7 --approve",
        "gh issue close 1",
        "gh release create v1",
        "gh repo delete o/r",
        "gh api repos/o/r/issues -X POST",
        "gh api repos/o/r --method DELETE",
        "gh api repos/o/r/issues -f title=x",
        "glab mr merge 3",
        "bd close bd-1",
        "bd create x",
        "bd update bd-1",
        "bd delete bd-1",
        "bd dep add a b",
        "bd comments add bd-1 x",
        "rm -rf x",
        "mv a b",
        "echo x > file",
        "echo x >file",
        "echo x>>file",
        "git log | tee out",
        "git -c alias.x=!rm log",
        "git --config-env=a=B log",
        "ast-grep run -p a -r b -U",
    ])("denies %s", (command) => expect(effect(command)).toBe("deny"));
    test("a frontmatter marker expands to the rules, whatever follows it", () => {
        const source = '---\npermissions:\n  # {{rules read-only-shell}}\n  - action: edit\n    resource: "*"\n    effect: deny\n---\nBody\n';
        const file = parseAgentFile(composeAgent(source), "x");
        expect(file.permissions.filter((rule) => rule.action === "shell")).toEqual(rules);
        expect(permissionEffect(file.permissions, "edit")).toBe("deny");
    });
});
