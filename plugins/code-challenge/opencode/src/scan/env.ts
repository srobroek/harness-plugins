/** The environment analyzer child processes get: an allowlist, never the caller's secrets. */

const ALLOWED = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  "TMPDIR",
  "TMP",
  "TEMP",
  // toolchains and their caches
  "CARGO_HOME",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "GOFLAGS",
  "GOPROXY",
  "GONOPROXY",
  "GONOSUMDB",
  "GOSUMDB",
  "GOTOOLCHAIN",
  "BUN_INSTALL",
  "BUN_INSTALL_CACHE_DIR",
  "NPM_CONFIG_CACHE",
  "npm_config_cache",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // proxies and CA bundles
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
])
const ALLOWED_PREFIXES = ["LC_", "UV_"]
/** Wins over the allowlist: UV_INDEX_*_PASSWORD and UV_PUBLISH_TOKEN are UV_ variables that carry credentials. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH)/i
const SECRET_PREFIX = /^(AWS_|GH_|GITHUB_)/i

/** `scheme://user:pass@host` becomes `scheme://host`: proxy and index URLs may carry credentials the analyzers must not inherit. */
export function stripUserinfo(value: string): string {
  return value.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@,]*@/gi, "$1")
}

export function childEnv(
  source: Record<string, string | undefined> = Bun.env,
  extra: Record<string, string> = { NO_COLOR: "1", FORCE_COLOR: "0" },
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (SECRET_NAME.test(name) || SECRET_PREFIX.test(name)) continue
    if (ALLOWED.has(name) || ALLOWED_PREFIXES.some((p) => name.startsWith(p))) env[name] = stripUserinfo(value)
  }
  return { ...env, ...extra }
}
