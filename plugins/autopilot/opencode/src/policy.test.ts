import { describe, expect, test } from "bun:test"
import { categorize, decideAsk, endsWithQuestion, holdsLane, isAskTool } from "./policy.ts"

test.each([
  ["question", true],
  ["parley_ask", true],
  ["parley.wait", true],
  ["tools.parley_end", true],
  ["read", false],
  ["autopilot_log", false],
])("isAskTool(%p) is %p", (tool, expected) => {
  expect(isAskTool(tool)).toBe(expected)
})

describe("decideAsk", () => {
  test.each([
    ["shell", ["git push -u origin feat/x"], [], "allow"],
    ["shell", ["gh pr create --draft"], [], "allow"],
    ["shell", ["git push origin main"], ["merge"], "deny"],
    ["shell", ["git push origin HEAD:master"], [], "deny"],
    ["shell", ["git push --force origin feat/x"], ["merge"], "deny"],
    ["shell", ["git push --force-with-lease origin feat/x"], [], "allow"],
    ["shell", ["gh pr merge 12 --squash"], [], "deny"],
    ["shell", ["gh pr merge 12 --squash"], ["merge"], "allow"],
    ["delivery_land", [], [], "deny"],
    ["shell", ["npx cdk deploy MyStack"], [], "deny"],
    ["shell", ["aws cloudformation delete-stack --stack-name s"], ["deploy"], "allow"],
    ["shell", ["aws s3 ls"], [], "allow"],
  ] as const)("%s %p with %p → %s", (action, resources, grants, effect) => {
    expect(decideAsk(action, resources, grants, false).effect).toBe(effect)
  })

  test("names the missing grant", () => {
    expect(decideAsk("shell", ["terraform apply"], [], false)).toEqual({ effect: "deny", reason: "deploy is not granted for this run (--allow deploy); logged as a blocker" })
  })

  test.each([
    "git reset --hard origin/main",
    "git clean -fdx",
    "git branch -D feat/old",
    "git push origin --delete feat/old",
    "git stash drop",
    "rm -rf build",
    "bd delete p-1",
  ])("parks the irreversible %p unless --full", (command) => {
    expect(decideAsk("shell", [command], [], false).effect).toBe("deny")
    expect(decideAsk("shell", [command], [], true).effect).toBe("allow")
  })

  test("--full never allows a force push", () => {
    expect(decideAsk("shell", ["git push -f origin feat/x"], ["merge", "deploy"], true).effect).toBe("deny")
  })

  test.each([
    "git -C . push --force origin feat/x",
    "git -c core.x=y push -f origin feat/x",
    "git push origin +HEAD:feat/x",
    "git push origin +feat/x",
    "git -C repo push origin main",
    "git push origin feat/x:refs/heads/master",
    "git push origin '+HEAD:feat/x'",
    "git push origin 'HEAD:main'",
    'git push origin "main"',
  ])("denies %p even with every grant", (command) => {
    expect(decideAsk("shell", [command], ["merge", "deploy"], true).effect).toBe("deny")
  })

  test("a quoted git command passed as data is not a push", () => {
    expect(decideAsk("shell", ["printf '%s\\n' 'git push origin main' > commands.txt"], [], false).effect).toBe("allow")
  })

  test("a compound command needs every grant it touches", () => {
    expect(decideAsk("shell", ["gh pr merge 12 --squash && rm -rf build"], ["merge"], false).effect).toBe("deny")
    expect(decideAsk("shell", ["gh pr merge 12 --squash && rm -rf build"], ["merge"], true).effect).toBe("allow")
    expect(decideAsk("shell", ["npx cdk deploy S", "gh pr merge 3"], ["deploy"], false).effect).toBe("deny")
  })
})

test("categorize ignores a push of a branch named like main-fix", () => {
  expect(categorize("shell", ["git push origin main-fix"])).toBe("other")
})

test.each([
  ["explore", false],
  ["code-reviewer", false],
  ["researcher", false],
  ["coder", true],
  ["general", true],
  [undefined, true],
])("holdsLane(%p) is %p", (agent, expected) => {
  expect(holdsLane(agent)).toBe(expected)
})

test.each([
  ["Done. Should I also update the docs?", true],
  ["Plan:\n\nLet me know which one you prefer.", true],
  ["Closed the bead. What is left: nothing?\n\nMoving on to the next item.", false],
  ["", false],
])("endsWithQuestion(%p)", (text, expected) => {
  expect(endsWithQuestion(text)).toBe(expected)
})
