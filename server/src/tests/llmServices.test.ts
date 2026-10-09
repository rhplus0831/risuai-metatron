// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeObserver } from "../llm/claudeObserver.ts";
import { collectSecrets, createRedactor, REDACTED, redactHeaderText } from "../llm/redact.ts";
import { createVertexTokenCache } from "../llm/vertexToken.ts";
import { sleep, waitFor } from "./testSupport.ts";

// Phase 5 slice 7a, the request layer's services in isolation: the secret-free projection
// (`redact.ts`: every stored credential in its raw, JSON-escaped, doubly escaped, and URL-encoded
// forms, however short; `carries` for content the tab must get unaltered; the by-name header and
// query rules), the Vertex token cache (`vertexToken.ts`: one refresh per credential shared by its
// waiters, aborted when the last waiter leaves or at `clear`), and the Claude cache warmer
// (`claudeObserver.ts`: one per server, its timer and retries owned by a registration period).

afterEach(() => {
    vi.useRealTimers();
});

describe("the redactor", () => {
    const weird = 'se/cret"\\end';

    it("replaces every form of a credential in a text, however short, and masks the named query parameters", () => {
        const redactor = createRedactor([weird, "q7", ""]);
        expect(redactor.text(`raw ${weird} json ${JSON.stringify(weird)} url ${encodeURIComponent(weird)}`)).toBe(
            `raw ${REDACTED} json "${REDACTED}" url ${REDACTED}`,
        );
        expect(redactor.text(JSON.stringify({ nested: JSON.stringify({ key: weird }) }))).not.toContain("se/cret");
        expect(redactor.text("key q7 here")).toBe(`key ${REDACTED} here`);
        expect(redactor.text("https://x.test/v1?key=abc&other=1&token=t#frag")).toBe(
            `https://x.test/v1?key=${REDACTED}&other=1&token=${REDACTED}#frag`,
        );
        // An empty credential is nothing to redact.
        expect(redactor.text("plain")).toBe("plain");
        expect(createRedactor([]).text("plain q7")).toBe("plain q7");
    });

    it("replaces a credential that contains another one whole, and learns a token added later", () => {
        const redactor = createRedactor(["LONG-SECRET", "s"]);
        expect(redactor.text("LONG-SECRET")).toBe(REDACTED);
        redactor.add("vertex-token");
        expect(redactor.text("Bearer vertex-token")).toBe(`Bearer ${REDACTED}`);
    });

    it("projects a value deeply, masking the credential headers by name and leaving other fields alone", () => {
        const redactor = createRedactor(["k1"]);
        expect(
            redactor.apply({
                Authorization: "Bearer other",
                "x-api-key": "",
                model: "gpt",
                nested: [{ "X-Goog-Api-Key": "x", text: "has k1" }],
            }),
        ).toEqual({
            Authorization: REDACTED,
            "x-api-key": "",
            model: "gpt",
            nested: [{ "X-Goog-Api-Key": REDACTED, text: `has ${REDACTED}` }],
        });
    });

    it("`carries` finds a credential in a string, an array, a value, or a property name at any depth, in any form", () => {
        const redactor = createRedactor([weird]);
        const forms = [
            weird,
            JSON.stringify(weird).slice(1, -1),
            JSON.stringify(JSON.stringify(weird)).slice(3, -3),
            encodeURIComponent(weird),
        ];
        for (const form of forms) {
            expect(redactor.carries({ outer: [{ value: `x${form}y` }] })).toBe(true);
            expect(redactor.carries({ outer: [{ [form]: "value" }] })).toBe(true);
            expect(redactor.carries(form)).toBe(true);
        }
        // Repeated use: the global expression's position does not leak between calls.
        expect([1, 2, 3].map(() => (redactor.text(weird), redactor.carries(weird)))).toEqual([true, true, true]);
        expect(redactor.carries({ clean: ["text", 1, null, { a: "b" }] })).toBe(false);
        // The by-name query rule is a text projection, not a credential: a public token is not refused.
        expect(redactor.carries("https://x.test/?token=public-value")).toBe(false);
        expect(createRedactor([]).carries("anything")).toBe(false);
    });

    it("collects every named credential's key, its colon-separated parts, and its client email, but not its name or project", () => {
        const secrets = collectSecrets({
            credentials: {
                a: { name: "Work", type: "bedrock", key: "AKIANAMED:named-secret:eu-west-1" },
                b: {
                    name: "SA",
                    type: "vertex",
                    key: "named-pem",
                    clientEmail: "named@sa.test",
                    projectId: "named-project",
                },
            },
        } as never);
        expect(secrets).toEqual(
            expect.arrayContaining([
                "AKIANAMED:named-secret:eu-west-1",
                "AKIANAMED",
                "named-secret",
                "eu-west-1",
                "named-pem",
                "named@sa.test",
            ]),
        );
        expect(secrets).not.toContain("Work");
        expect(secrets).not.toContain("named-project");
        const redactor = createRedactor(secrets);
        expect(redactor.text("upstream said: bad key named-secret for named@sa.test")).toBe(
            `upstream said: bad key ${REDACTED} for ${REDACTED}`,
        );
    });

    it("collects every credential leaf of a request, the Bedrock key's parts, and no readable sibling", () => {
        const secrets = collectSecrets({
            openAIKey: "oai",
            claudeAPIKey: "AKIA:secretpart:us-east-1",
            google: { accessToken: "goog", projectId: "my-project" },
            hordeConfig: { apiKey: "horde", model: "model-name", softPrompt: "sp" },
            novelai: { token: "nai", model: "clio-v1" },
            vertexClientEmail: "me@gserviceaccount.com",
            vertexPrivateKey: "-----BEGIN PRIVATE KEY-----x",
            OaiCompAPIKeys: { deepseek: "ds" },
        } as never);
        expect(secrets).toEqual(
            expect.arrayContaining([
                "oai",
                "AKIA:secretpart:us-east-1",
                "AKIA",
                "secretpart",
                "us-east-1",
                "goog",
                "horde",
                "nai",
                "-----BEGIN PRIVATE KEY-----x",
                "ds",
            ]),
        );
        for (const sibling of ["my-project", "model-name", "sp", "clio-v1", "me@gserviceaccount.com"]) {
            expect(secrets).not.toContain(sibling);
        }
    });

    it("masks the credential headers inside a log entry's header text, by name, case-insensitively", () => {
        const masked = JSON.parse(
            redactHeaderText(
                JSON.stringify({ Authorization: "Bearer x", "X-API-Key": "k", other: "o", "api-key": "" }),
            ),
        );
        expect(masked).toEqual({ Authorization: REDACTED, "X-API-Key": REDACTED, other: "o", "api-key": "" });
        expect(redactHeaderText("not json")).toBe("not json");
        expect(redactHeaderText("[1]")).toBe("[1]");
    });
});

describe("the Vertex token cache", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const email = "svc@gserviceaccount.com";

    function tokenServer() {
        const calls: { signal: AbortSignal; release: (token: string | null) => void }[] = [];
        const fetchImpl = (async (_url: unknown, init: RequestInit = {}) =>
            await new Promise<Response>((resolve, reject) => {
                const signal = init.signal as AbortSignal;
                signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                calls.push({
                    signal,
                    release: (token) =>
                        resolve(
                            token === null
                                ? new Response(JSON.stringify({ error: "denied" }), { status: 401 })
                                : Response.json({ access_token: token }),
                        ),
                });
            })) as typeof fetch;
        return { calls, fetchImpl };
    }

    it("shares one refresh among concurrent waiters, caches the token until its expiry, and refreshes after it", async () => {
        let now = 1_000_000;
        const { calls, fetchImpl } = tokenServer();
        const cache = createVertexTokenCache({ fetchImpl, now: () => now });
        const first = cache.get(email, privateKey);
        const second = cache.get(email, privateKey, new AbortController().signal);
        await waitFor(() => calls.length === 1);
        calls[0].release("tok-1");
        expect(await Promise.all([first, second])).toEqual(["tok-1", "tok-1"]);
        expect(await cache.get(email, privateKey)).toBe("tok-1");
        expect(calls).toHaveLength(1);
        now += 3500 * 1000 + 1;
        const refreshed = cache.get(email, privateKey);
        await waitFor(() => calls.length === 2);
        calls[1].release("tok-2");
        expect(await refreshed).toBe("tok-2");
        // Another credential is another refresh.
        const other = cache.get("other@gserviceaccount.com", privateKey);
        await waitFor(() => calls.length === 3);
        calls[2].release("tok-3");
        expect(await other).toBe("tok-3");
    });

    it("keeps a refresh alive while another waiter needs it, and aborts it when the last waiter leaves", async () => {
        const { calls, fetchImpl } = tokenServer();
        const cache = createVertexTokenCache({ fetchImpl });
        const a = new AbortController();
        const b = new AbortController();
        const first = cache.get(email, privateKey, a.signal);
        const second = cache.get(email, privateKey, b.signal);
        await waitFor(() => calls.length === 1);
        a.abort(new Error("first left"));
        await expect(first).rejects.toThrow("first left");
        expect(calls[0].signal.aborted).toBe(false);
        b.abort(new Error("last left"));
        await expect(second).rejects.toThrow("last left");
        await waitFor(() => calls[0].signal.aborted);
        // The next request starts a new refresh instead of joining the abandoned one.
        const third = cache.get(email, privateKey);
        await waitFor(() => calls.length === 2);
        calls[1].release("tok");
        expect(await third).toBe("tok");
    });

    it("rejects a pre-aborted request without a refresh, a failed refresh with its reason, and `clear` aborts every refresh", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onUnhandled);
        try {
            const { calls, fetchImpl } = tokenServer();
            const cache = createVertexTokenCache({ fetchImpl });
            const aborted = new AbortController();
            aborted.abort(new Error("gone"));
            await expect(cache.get(email, privateKey, aborted.signal)).rejects.toThrow("gone");
            await expect(cache.get("not-a-service-account", privateKey)).rejects.toThrow(/gserviceaccount/);
            expect(calls).toHaveLength(0);
            const failing = cache.get(email, privateKey);
            await waitFor(() => calls.length === 1);
            calls[0].release(null);
            await expect(failing).rejects.toThrow(/Failed to refresh google access token/);
            const cleared = cache.get(email, privateKey, new AbortController().signal);
            await waitFor(() => calls.length === 2);
            cache.clear();
            expect(calls[1].signal.aborted).toBe(true);
            await expect(cleared).rejects.toThrow();
            await sleep(5);
            expect(unhandled).toEqual([]);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});

describe("the Claude cache warmer", () => {
    function warmer(statuses: number[] = [], options: { hold?: boolean } = {}) {
        const calls: {
            url: string;
            body: unknown;
            headers: Record<string, string>;
            signal: AbortSignal;
            release: (status: number) => void;
        }[] = [];
        let now = 0;
        const fetchImpl = (async (url: string, init: RequestInit = {}) =>
            await new Promise<Response>((resolve) => {
                const release = (status: number) => resolve(new Response("{}", { status }));
                calls.push({
                    url,
                    body: JSON.parse(init.body as string),
                    headers: init.headers as Record<string, string>,
                    signal: init.signal as AbortSignal,
                    release,
                });
                if (!options.hold) {
                    release(statuses.shift() ?? 200);
                }
            })) as never;
        const observer = createClaudeObserver({ fetchImpl, now: () => now });
        // The clock and the timers move together, in the warmer's own check interval.
        const advance = async (ms: number) => {
            for (let left = ms; left > 0; left -= 20_000) {
                const step = Math.min(left, 20_000);
                now += step;
                await vi.advanceTimersByTimeAsync(step);
            }
        };
        return { observer, calls, advance };
    }
    const target = {
        url: "https://api.anthropic.com/v1/messages",
        body: { model: "claude", max_tokens: 800, messages: [] },
        headers: { "x-api-key": "k" },
    };

    it("re-sends the registered body with `max_tokens` 10 after 4.5 minutes, at most five times, and nothing before a registration", async () => {
        vi.useFakeTimers();
        const { observer, calls, advance } = warmer();
        await advance(10 * 60_000);
        expect(calls).toHaveLength(0);
        observer.register(target);
        await advance(4 * 60_000);
        expect(calls).toHaveLength(0);
        await advance(60_000);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            url: target.url,
            body: { model: "claude", max_tokens: 10, messages: [] },
            headers: { "Content-Type": "application/json", "x-api-key": "k" },
        });
        // The registered body is a copy: the caller's object keeps its `max_tokens`.
        expect(target.body.max_tokens).toBe(800);
        await advance(60 * 60_000);
        expect(calls).toHaveLength(5);
        observer.dispose();
    });

    it("retries a failed warming at most three times, and a disposed or reset warmer never retries or warms again", async () => {
        vi.useFakeTimers();
        const failing = warmer([500, 500, 500, 500, 500]);
        failing.observer.register(target);
        await failing.advance(5 * 60_000);
        await vi.advanceTimersByTimeAsync(1);
        expect(failing.calls).toHaveLength(4);
        failing.observer.dispose();

        // A warming in flight when the warmer is disposed is aborted and, failing, not retried.
        const disposed = warmer([], { hold: true });
        disposed.observer.register(target);
        await disposed.advance(5 * 60_000);
        expect(disposed.calls).toHaveLength(1);
        disposed.observer.dispose();
        expect(disposed.calls[0].signal.aborted).toBe(true);
        disposed.calls[0].release(500);
        await vi.advanceTimersByTimeAsync(1);
        expect(disposed.calls).toHaveLength(1);
        disposed.observer.register(target);
        await disposed.advance(10 * 60_000);
        expect(disposed.calls).toHaveLength(1);

        const reset = warmer();
        reset.observer.register(target);
        reset.observer.reset();
        await reset.advance(10 * 60_000);
        expect(reset.calls).toHaveLength(0);
        // A registration after the reset warms again.
        reset.observer.register(target);
        await reset.advance(5 * 60_000);
        expect(reset.calls).toHaveLength(1);
        reset.observer.dispose();
    });
});
