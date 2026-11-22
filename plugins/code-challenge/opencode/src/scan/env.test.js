import { describe, expect, test } from "bun:test";
import { childEnv } from "./env.ts";
describe("childEnv", () => {
    test("keeps path, locale, toolchain, proxy and CA variables", () => {
        const source = {
            PATH: "/bin",
            HOME: "/h",
            TMPDIR: "/t",
            LANG: "en_US.UTF-8",
            LC_ALL: "C",
            CARGO_HOME: "/c",
            GOMODCACHE: "/g",
            UV_CACHE_DIR: "/u",
            HTTPS_PROXY: "http://p:1",
            SSL_CERT_FILE: "/ca.pem",
            NODE_EXTRA_CA_CERTS: "/ca2.pem",
        };
        expect(childEnv(source, {})).toEqual(source);
    });
    test("drops credentials, even ones with an allowed prefix, and everything unlisted", () => {
        const env = childEnv({
            PATH: "/bin",
            GITHUB_TOKEN: "x",
            GH_TOKEN: "x",
            NPM_TOKEN: "x",
            AWS_ACCESS_KEY_ID: "x",
            AWS_PROFILE: "x",
            OPENAI_API_KEY: "x",
            MY_SECRET: "x",
            UV_INDEX_PRIVATE_PASSWORD: "x",
            UV_PUBLISH_TOKEN: "x",
            SSH_AUTH_SOCK: "/s",
            EDITOR: "vim",
        });
        expect(Object.keys(env).sort()).toEqual(["FORCE_COLOR", "NO_COLOR", "PATH"]);
    });
    test.each([
        ["HTTPS_PROXY", "http://user:pa%40ss@proxy.corp:3128", "http://proxy.corp:3128"],
        ["http_proxy", "http://user@proxy.corp:3128/", "http://proxy.corp:3128/"],
        ["UV_INDEX_URL", "https://__token__:abc@pypi.corp/simple", "https://pypi.corp/simple"],
        ["UV_EXTRA_INDEX_URL", "https://a:b@one/simple https://c:d@two/simple", "https://one/simple https://two/simple"],
        ["UV_INDEX", "private=https://u:p@host/simple", "private=https://host/simple"],
        ["GOPROXY", "https://u:p@goproxy.corp,direct", "https://goproxy.corp,direct"],
        ["NO_PROXY", "localhost,.corp", "localhost,.corp"],
        ["UV_CACHE_DIR", "/home/me@work/cache", "/home/me@work/cache"],
    ])("%s keeps its host and drops the credentials: %s", (name, value, expected) => {
        expect(childEnv({ [name]: value }, {})[name]).toBe(expected);
    });
});
