/** Canonical JSON so equal answer objects compare equal regardless of key order. */
export function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (typeof value === "object" && value !== null)
        return `{${Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
            .join(",")}}`;
    return JSON.stringify(value);
}
