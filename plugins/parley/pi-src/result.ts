import type { ImageContent, TextContent } from "@earendil-works/pi-ai"
import type { FileValue } from "../shared/answers.ts"
import { render, type ToolResult } from "../shared/format.ts"
import type { Question } from "../shared/questions.ts"

/** The structured result every parley tool returns (`resultOutput` in `shared/schema.ts`). */
export type ResultOutput = ReturnType<typeof render>["output"]

/**
 * A parley result as a pi tool result: the summary text, then each uploaded image as image content.
 * Text files are inlined in the text and other files named by `locate` (their path on disk).
 */
export function toolResult(
  result: ToolResult,
  questions: readonly Question[],
  locate: (file: FileValue) => string | undefined,
  format: "parley" | "native" = "parley",
): { content: (TextContent | ImageContent)[]; details: ResultOutput; structuredContent: ResultOutput } {
  const { output, content } = render(result, questions, locate, format)
  const parts: (TextContent | ImageContent)[] =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "image", data: part.uri.slice(part.uri.indexOf(",") + 1), mimeType: part.mime },
        )
  return { content: parts, details: output, structuredContent: output }
}
