import type { Context } from "@opencode/plugin/promise/plugin"

// The directory of the invoking session. Fails closed: a session we cannot resolve must not make
// a tool act on the plugin's own base directory.
export async function sessionDirectory(ctx: Context, sessionID: string, tool: string): Promise<string> {
  const session = await ctx.session.get({ sessionID }).catch((cause: unknown) => {
    throw new Error(`${tool}: cannot read session ${sessionID} to find its directory`, { cause })
  })
  const found = session.location?.directory
  if (typeof found !== "string" || found === "") throw new Error(`${tool}: session ${sessionID} has no directory`)
  return found
}
