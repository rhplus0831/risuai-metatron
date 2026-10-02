import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `NodeStorage` auth against a fake of the server's auth routes: the first run sets the password
// and registers this browser's key with the same digest (so the very next request is authorized),
// a wrong-key browser logs in once, parallel requests share one check, and `authFetch` signs every
// request.

const { prompts, alerts, keypairs } = vi.hoisted(() => ({
    prompts: { answers: [] as string[], asked: [] as string[] },
    alerts: { alertError: vi.fn(), waitAlert: vi.fn(async () => undefined) },
    keypairs: new Map<string, CryptoKeyPair>(),
}));

vi.mock("../../alert", () => ({
    alertInput: vi.fn(async (message: string) => {
        prompts.asked.push(message);
        return prompts.answers.shift() ?? "";
    }),
    alertError: alerts.alertError,
    waitAlert: alerts.waitAlert,
}));
vi.mock("src/lang", () => ({ language: { setNodePassword: "set password", inputNodePassword: "input password" } }));
vi.mock("../../util", () => ({
    base64url: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url"),
    getKeypairStore: async (name: string) => keypairs.get(name) ?? null,
    saveKeypairStore: async (name: string, pair: CryptoKeyPair) => {
        keypairs.set(name, pair);
    },
}));

import { authFetch, NodeStorage } from "../nodeStorage";

type FakeAuth = {
    password: string | null;
    registered: Set<string>;
    calls: { path: string; body?: any; auth?: string | null }[];
    loginStatus: number;
};

function jwtPublicKeyThumb(token: string): string {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8"));
    return `${payload.pub.x}.${payload.pub.y}`;
}

let auth: FakeAuth;

beforeEach(() => {
    auth = { password: null, registered: new Set(), calls: [], loginStatus: 200 };
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
                    if (auth.password === null) {
                        return Response.json({ status: "unset" });
                    }
                    return Response.json({
                        status: token && auth.registered.has(jwtPublicKeyThumb(token)) ? "success" : "incorrect",
                    });
                case "/api/set_password":
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

describe("first run", () => {
    it("sets the password once and logs this browser in with the same digest, so the next request is authorized", async () => {
        prompts.answers = ["hunter2"];
        const storage = new NodeStorage();
        await storage.ensureAuth();
        expect(prompts.asked).toEqual(["set password"]);
        expect(paths()).toEqual(["/api/test_auth", "/api/crypto", "/api/set_password", "/api/login"]);
        expect(auth.password).toBe("digest(hunter2)");
        expect(auth.calls[3].body.password).toBe("digest(hunter2)");
        expect(auth.registered.size).toBe(1);
        expect(storage.authChecked).toBe(true);
        expect(alerts.alertError).not.toHaveBeenCalled();
        // A later call needs no check and the signed token is accepted.
        const before = auth.calls.length;
        const token = await storage.getProxyAuth();
        expect(auth.calls.length).toBe(before);
        expect(auth.registered.has(jwtPublicKeyThumb(token))).toBe(true);
    });
});

describe("existing server", () => {
    it("asks for the password when this browser's key is unknown and logs in once", async () => {
        auth.password = "digest(pw)";
        prompts.answers = ["pw"];
        const storage = new NodeStorage();
        await storage.ensureAuth();
        expect(prompts.asked).toEqual(["input password"]);
        expect(paths()).toEqual(["/api/test_auth", "/api/crypto", "/api/login"]);
        expect(storage.authChecked).toBe(true);
        const fresh = new NodeStorage();
        await fresh.ensureAuth();
        expect(prompts.asked).toEqual(["input password"]);
        expect(paths().slice(3)).toEqual(["/api/test_auth"]);
    });

    it("reports a failed login, throws, and stays unchecked", async () => {
        auth.password = "digest(pw)";
        prompts.answers = ["wrong"];
        const storage = new NodeStorage();
        await expect(storage.ensureAuth()).rejects.toBe("Wrong password");
        expect(alerts.alertError).toHaveBeenCalledWith("Wrong password");
        expect(alerts.waitAlert).toHaveBeenCalledTimes(1);
        expect(storage.authChecked).toBe(false);
        prompts.answers = ["pw"];
        await storage.ensureAuth();
        expect(storage.authChecked).toBe(true);
    });

    it("runs one check and one prompt for parallel requests", async () => {
        auth.password = "digest(pw)";
        prompts.answers = ["pw"];
        const storage = new NodeStorage();
        await Promise.all([storage.ensureAuth(), storage.ensureAuth(), storage.getProxyAuth()]);
        expect(prompts.asked).toEqual(["input password"]);
        expect(paths().filter((path) => path === "/api/test_auth")).toHaveLength(1);
        expect(paths().filter((path) => path === "/api/login")).toHaveLength(1);
    });
});

describe("authFetch", () => {
    it("signs the request with the shared instance and keeps the caller's headers and options", async () => {
        auth.password = "digest(pw)";
        prompts.answers = ["pw"];
        const response = await authFetch("/api/ping", {
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
        expect(prompts.asked).toEqual(["input password"]);
        await authFetch("/api/ping");
        expect(prompts.asked).toEqual(["input password"]);
    });

    it("runs beforeDispatch after the authentication and the signing, right before the request, and a throw stops it (7b)", async () => {
        // A fresh shared instance, so the authentication runs inside this test.
        vi.resetModules();
        const { authFetch: freshAuthFetch } = (await import("../nodeStorage")) as typeof import("../nodeStorage");
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
