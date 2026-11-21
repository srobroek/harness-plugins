/**
 * A small validator for the JSON Schema keywords the shipped schemas use, so the tests need no
 * dependency. It throws on a keyword it does not know, so a schema cannot start using one silently.
 */

export type Schema = {
  type?: "object" | "array" | "string" | "integer" | "number" | "boolean"
  enum?: unknown[]
  required?: string[]
  properties?: Record<string, Schema>
  additionalProperties?: boolean
  items?: Schema
  minItems?: number
  minimum?: number
  minLength?: number
  pattern?: string
  $ref?: string
  $defs?: Record<string, Schema>
  [annotation: string]: unknown
}

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$defs"])
const KEYWORDS = new Set([
  "type", "enum", "required", "properties", "additionalProperties", "items", "minItems", "minimum", "minLength", "pattern", "$ref",
])

/** Errors for `value` against `schema`, empty when it is valid. `root` resolves `#/$defs/...` references. */
export function validate(schema: Schema, value: unknown, root: Schema = schema, at = "$"): string[] {
  for (const key of Object.keys(schema))
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`unsupported schema keyword: ${key}`)
  if (schema.$ref !== undefined) {
    const target = schema.$ref.replace(/^#\/\$defs\//, "")
    const resolved = root.$defs?.[target]
    if (!resolved) throw new Error(`unresolved reference: ${schema.$ref}`)
    return validate(resolved, value, root, at)
  }
  const errors: string[] = []
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`)
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value
  const matches = (type: string) => (type === "integer" ? Number.isInteger(value) : type === "number" ? kind === "number" : type === kind)
  if (schema.type && !matches(schema.type)) return [...errors, `${at}: expected ${schema.type}, got ${kind}`]
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`)
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`)
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`)
    for (const [index, item] of value.entries())
      if (schema.items) errors.push(...validate(schema.items, item, root, `${at}[${index}]`))
  }
  if (kind === "object") {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!(key in record)) errors.push(`${at}: missing ${key}`)
    for (const [key, entry] of Object.entries(record)) {
      const property = schema.properties?.[key]
      if (property) errors.push(...validate(property, entry, root, `${at}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${at}: unexpected property ${key}`)
    }
  }
  return errors
}
