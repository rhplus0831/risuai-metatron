import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeStructuredClone } from "../../polyfill";

// The tab's server authentication (`serverAuth.ts`, the auth half of the removed storage client,
// one module-level state for every caller) against a fake of the server's auth routes: the first
// run sets the password and registers this browser's key with the same digest (so the very next
// request is authorized), a wrong-key browser logs in once, parallel requests share one check, a
// failed check is tried again, and `authFetch` signs every request. The state is the module's, so
// every test boots the module afresh (`vi.resetModules()`): what the old per-instance `authChecked`
// flag showed is observed as whether the next call sends `/api/test_auth` again.

const { prompts, alerts, keypairs } = vi.hoisted(() => ({
    prompts: { answers: [] as string[], asked: [] as string[] },
    alerts: { alertError: vi.fn(), waitAlert: vi.fn(async () => undefined) },
    keypairs: new Map<string, CryptoKeyPair>(),
}));

vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertInput: vi.fn(async (message: string) => {
            prompts.asked.push(message);
            return prompts.answers.shift() ?? "";
        }),
        alertError: alerts.alertError,
        waitAlert: alerts.waitAlert,
    }),
);
vi.mock("../../util", () => ({
    base64url: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url"),
    getKeypairStore: async (name: string) => keypairs.get(name) ?? null,
    saveKeypairStore: async (name: string, pair: CryptoKeyPair) => {
        keypairs.set(name, pair);
    },
}));

type ServerAuth = typeof import("../serverAuth");
let auth$: ServerAuth;
let lang$: typeof import("src/lang");

type FakeAuth = {
    password: string | null;
    registered: Set<string>;
    calls: { path: string; body?: any; auth?: string | null }[];
    loginStatus: number;
    setPasswordFailure: { status: number; message: string; plainText?: boolean } | null;
    testAuthStatus: number;
};

function jwtPublicKeyThumb(token: string): string {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
    return `${payload.pub.x}.${payload.pub.y}`;
}

let auth: FakeAuth;

beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal("safeStructuredClone", safeStructuredClone);
    lang$ = await import("src/lang");
    lang$.changeLanguage("en");
    auth$ = await import("../serverAuth");
    auth = {
        password: null,
        registered: new Set(),
        calls: [],
        loginStatus: 200,
        setPasswordFailure: null,
        testAuthStatus: 200,
    };
    prompts.answers = [];
    prompts.asked = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (path: string, init: RequestInit = {}) => {
            const headers = new Headers(init.headers);
            const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
            const token = headers.get("risu-auth");
            auth.calls.push({ path, body, auth: token });
            switch (path) {
                case "/api/crypto":
                    return new Response(`digest(${body.data})`);
                case "/api/test_auth":
                    if (auth.testAuthStatus !== 200) {
                        return Response.json({ error: "Auth check throttled" }, { status: auth.testAuthStatus });
                    }
                    if (auth.password === null) {
                        return Response.json({ status: "unset" });
                    }
                    return Response.json({
                        status: token && auth.registered.has(jwtPublicKeyThumb(token)) ? "success" : "incorrect",
                    });
                case "/api/set_password":
                    if (auth.setPasswordFailure) {
                        const { status, message, plainText } = auth.setPasswordFailure;
                        return plainText
                            ? new Response(message, { status })
                            : Response.json({ error: message }, { status });
                    }
                    auth.password = body.password;
                    return Response.json({ success: true });
                case "/api/login":
                    if (auth.loginStatus !== 200) {
                        return Response.json({ error: "Wrong password" }, { status: auth.loginStatus });
                    }
                    if (body.password !== auth.password) {
                        return Response.json({ error: "Wrong password" }, { status: 401 });
                    }
                    auth.registered.add(`${body.publicKey.x}.${body.publicKey.y}`);
                    return Response.json({ success: true });
                case "/api/ping":
                    return Response.json({ ok: token !== null && auth.registered.has(jwtPublicKeyThumb(token)) });
                default:
                    return Response.json({ error: `unexpected ${path}` }, { status: 500 });
            }
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

const paths = () => auth.calls.map((call) => call.path);
/** Whether the module holds the check as done: a checked module sends no `/api/test_auth` for the next call. */
async function checkedState(): Promise<boolean> {
    const before = paths().filter((path) => path === "/api/test_auth").length;
    await auth$.ensureAuth();
    return paths().filter((path) => path === "/api/test_auth").length === before;
}

describe("first run", () => {
    it("sets the password once and logs this browser in with the same digest, so the next request is authorized", async () => {
        prompts.answers = ["hunter2"];
        await auth$.ensureAuth();
        expect(prompts.asked).toEqual([lang$.language.setNodePassword]);
        expect(paths()).toEqual(["/api/test_auth", "/api/crypto", "/api/set_password", "/api/login"]);
        expect(auth.password).toBe("digest(hunter2)");
        expect(auth.calls[3].body.password).toBe("digest(hunter2)");
        expect(auth.registered.size).toBe(1);
        expect(await checkedState()).toBe(true);
        expect(alerts.alertError).not.toHaveBeenCalled();
        // A later call needs no check and the signed token is accepted.
        const before = auth.calls.length;
        const token = await auth$.getNodeServerProxyAuth();
        expect(auth.calls.length).toBe(before);
        expect(auth.registered.has(jwtPublicKeyThumb(token))).toBe(true);
    });

    it.each([
        { format: "JSON", status: 503, message: "The operator must repair the password file", plainText: false },
        { format: "plain text", status: 400, message: "already set", plainText: true },
    ])("reports a rejected password setup in $format, skips login, and retries the check", async (failure) => {
        auth.setPasswordFailure = failure;
        prompts.answers = ["pw"];
        await auth$.ensureAuth().catch(() => {});
        expect(alerts.alertError).toHaveBeenCalledWith(failure.message);
        expect(paths()).not.toContain("/api/login");

        auth.setPasswordFailure = null;
        prompts.answers = ["pw"];
        const response = await auth$.authFetch("/api/ping");
        expect(paths().filter((path) => path === "/api/test_auth")).toHaveLength(2);
        expect(paths().filter((path) => path === "/api/login")).toHaveLength(1);
        expect(await response.json()).toEqual({ ok: true });
    });
});

describe("existing server", () => {
    it("retries authentication after a non-OK auth check instead of caching it as complete", async () => {
        auth.testAuthStatus = 429;
        await auth$.ensureAuth().catch(() => {});

        auth.testAuthStatus = 200;
        auth.password = "digest(pw)";
        prompts.answers = ["pw"];
        const response = await auth$.authFetch("/api/ping");
        expect(paths().filter((path) => path === "/api/test_auth")).toHaveLength(2);
        expect(await response.json()).toEqual({ ok: true });
    });

    it("asks for the password when this browser's key is unknown and logs in once", async () => {
        auth.password = "digest(pw)";
        prompts.answers = ["pw"];
        await auth$.ensureAuth();
        expect(prompts.asked).toEqual([lang$.language.inputNodePassword]);
        expect(paths()).toEqual(["/api/test_auth", "/api/crypto", "/api/login"]);
        expect(await checkedState()).toBe(true);
        // A fresh module state (a new tab: the removed storage client's second instance) checks once more,
        // finds the key known, and asks for nothing.
        vi.resetModules();
        const fresh: ServerAuth = await import("../serverAuth");
        await fresh.ensureAuth();
        expect(prompts.asked).toEqual([lang$.language.inputNodePassword]);
        expect(paths().slice(3)).toEqual(["/api/test_auth"]);
    });

    it("reports a failed login, throws, and stays unchecked", async () => {
        auth.password = "digest(pw)";
        prompts.answers = ["wrong"];
        await expect(auth$.ensureAuth()).rejects.toBe("Wrong password");
        expect(alerts.alertError).toHaveBeenCalledWith("Wrong password");
        expect(alerts.waitAlert).toHaveBeenCalledTimes(1);
        // Unchecked: the next call runs the check (and the prompt) again, and succeeds.
        prompts.answers = ["pw"];
        expect(await checkedState()).toBe(false);
        expect(prompts.asked).toEqual([lang$.language.inputNodePassword, lang$.language.inputNodePassword]);
        expect(paths()).toEqual([
            "/api/test_auth",
            "/api/crypto",
            "/api/login",
            "/api/test_auth",
            "/api/crypto",
            "/api/login",
        ]);
        expect(await checkedState()).toBe(true);
    });

    it("runs one check and one prompt for parallel requests", async () => {
        auth.password = "digest(pw)";
        prompts.answers = ["pw"];
        await Promise.all([auth$.ensureAuth(), auth$.ensureAuth(), auth$.getNodeServerProxyAuth()]);
        expect(prompts.asked).toEqual([lang$.language.inputNodePassword]);
        expect(paths().filter((path) => path === "/api/test_auth")).toHaveLength(1);
        expect(paths().filter((path) => path === "/api/login")).toHaveLength(1);
    });
});

describe("localized failures", () => {
    it("uses the selected English or Korean serverAuth message and HTTP status for empty failure bodies", async () => {
        const serverFetch = vi.mocked(fetch).getMockImplementation()!;
        for (const locale of ["en", "ko"]) {
            lang$.changeLanguage(locale);
            for (const [route, key, status] of [
                ["/api/login", "loginFailed", 401],
                ["/api/set_password", "passwordSetupFailed", 409],
                ["/api/test_auth", "authenticationFailed", 503],
                ["/api/crypto", "passwordCryptoFailed", 422],
            ] as const) {
                auth.password = route === "/api/login" ? "digest(pw)" : null;
                auth.registered.clear();
                prompts.answers = ["pw"];
                alerts.alertError.mockClear();
                vi.mocked(fetch).mockImplementation((input, init) =>
                    input === route ? Promise.resolve(new Response(null, { status })) : serverFetch(input, init),
                );

                const expected = lang$.language.serverAuth[key](status);
                expect(expected).toContain(String(status));
                expect(expected).toMatch(locale === "ko" ? /[가-힣]/ : /[a-z]/i);
                await expect(auth$.ensureAuth(), `${locale} ${key}`).rejects.toBe(expected);
                if (route === "/api/login" || route === "/api/set_password") {
                    expect(alerts.alertError).toHaveBeenCalledExactlyOnceWith(expected);
                }
            }
        }
    });
});

describe("authFetch", () => {
    it("signs the request with the module's auth state and keeps the caller's headers and options", async () => {
        auth.password = "digest(pw)";
        prompts.answers = ["pw"];
        const response = await auth$.authFetch("/api/ping", {
            method: "POST",
            headers: { "x-custom": "1" },
            cache: "no-store",
        });
        expect(await response.json()).toEqual({ ok: true });
        const ping = auth.calls.find((call) => call.path === "/api/ping")!;
        expect(ping.auth).toBeTruthy();
        const init = (fetch as any).mock.calls.find(([path]: [string]) => path === "/api/ping")[1] as RequestInit;
        expect(new Headers(init.headers).get("x-custom")).toBe("1");
        expect(init.method).toBe("POST");
        expect(init.cache).toBe("no-store");
        expect(prompts.asked).toEqual([lang$.language.inputNodePassword]);
        await auth$.authFetch("/api/ping");
        expect(prompts.asked).toEqual([lang$.language.inputNodePassword]);
    });

    it("runs beforeDispatch after the authentication and the signing, right before the request, and a throw stops it (7b)", async () => {
        // The module state is fresh (`beforeEach`), so the authentication runs inside this test.
        const { authFetch: freshAuthFetch } = auth$;
        auth.password = "digest(pw)";
        prompts.answers = ["pw"];
        const order: string[] = [];
        const response = await freshAuthFetch(
            "/api/ping",
            {},
            {
                beforeDispatch: () => {
                    order.push(`dispatch after ${paths().join(",")}`);
                },
            },
        );
        expect(await response.json()).toEqual({ ok: true });
        // The check ran once the password prompt and the login were done, with no ping sent yet.
        expect(order).toEqual(["dispatch after /api/test_auth,/api/crypto,/api/login"]);
        expect(paths().at(-1)).toBe("/api/ping");
        const before = auth.calls.length;
        await expect(
            freshAuthFetch(
                "/api/ping",
                {},
                {
                    beforeDispatch: () => {
                        throw new Error("Saving stopped: the server data was restored");
                    },
                },
            ),
        ).rejects.toThrow("Saving stopped");
        expect(auth.calls.length).toBe(before);
    });
});
