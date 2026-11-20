import { describe, expect, test } from "bun:test"
import { categorize, decideAsk, endsWithQuestion, isAskTool } from "./policy.ts"

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
    ["shell", ["git push --force origin feat/x"], ["merge"], "deny"],
    ["shell", ["git push --force-with-lease origin feat/x"], [], "allow"],
    ["shell", ["gh pr merge 12 --squash"], [], "deny"],
    ["shell", ["gh pr merge 12 --squash"], ["merge"], "allow"],
    ["delivery_land", [], [], "deny"],
    ["shell", ["npx cdk deploy MyStack"], [], "deny"],
    ["shell", ["aws cloudformation delete-stack --stack-name s"], ["deploy"], "allow"],
    ["shell", ["aws s3 ls"], [], "allow"],
  ] as const)("%s %p with %p → %s", (action, resources, grants, effect) => {
    expect(decideAsk(action, resources, grants).effect).toBe(effect)
  })

  test("names the missing grant", () => {
    expect(decideAsk("shell", ["terraform apply"], [])).toEqual({ effect: "deny", reason: "deploy is not granted for this run (--allow deploy); logged as a blocker" })
  })
})

test("categorize ignores a push of a branch named like main-fix", () => {
  expect(categorize("shell", ["git push origin main-fix"])).toBe("other")
})

test.each([
  ["Done. Should I also update the docs?", true],
  ["Plan:\n\nLet me know which one you prefer.", true],
  ["Closed the bead. What is left: nothing?\n\nMoving on to the next item.", false],
  ["", false],
])("endsWithQuestion(%p)", (text, expected) => {
  expect(endsWithQuestion(text)).toBe(expected)
})
