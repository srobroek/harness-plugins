import { expect, test } from "bun:test"
import { endsWithQuestion, holdsLane, isAskTool } from "./policy.ts"

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
