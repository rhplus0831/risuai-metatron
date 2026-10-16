import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5 slice 7b (`request-layer-and-llm-secrets.md`): `auxFetch`, the browser's transport for
// a call that uses a stored LLM credential through `/proxy2`'s auxiliary operations. It waits for
// the queued credential writes first (a failed save fails the call), keeps the operation's method
// (a GET carries no body), runs the plugin body interceptors, serializes a `FormData` body once with
// its boundary, puts the JWT in the outer request only (`authFetch`), checks abort and save
// admission right before the request goes out (`beforeDispatch`), settles at once on an abort at
// any stage without starting a later interceptor or the request, leaves no rejection unobserved,
// and logs the request without any credential.

const { deps } = vi.hoisted(() => ({
    deps: {
        authFetch: vi.fn(),
        awaitSecretWrites: vi.fn(),
        flushResources: vi.fn(),
        assertSaveAdmission: vi.fn(),
        addFetchLog: vi.fn(),
        interceptors: [] as { id: string; callback: (body: any, type: string) => Promise<any> }[],
    },
}));

vi.mock("../storage/serverAuth", () => ({
    authFetch: (...args: unknown[]) => deps.authFetch(...args),
}));
vi.mock("../storage/resourceSync.svelte", () => ({
    awaitSecretWrites: () => deps.awaitSecretWrites(),
    flushResources: () => deps.flushResources(),
    assertSaveAdmission: () => deps.assertSaveAdmission(),
}));
vi.mock("../globalApi.svelte", () => ({
    addFetchLog: (entry: unknown) => deps.addFetchLog(entry),
}));
vi.mock("../stores.svelte", () => ({
    bodyIntercepterStore: deps.interceptors,
}));

import { auxFetch, auxFetchJson } from "./auxFetch";

type Init = { method?: string; headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal };
type Options = { beforeDispatch?: () => void };

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Lets every pending microtask and a macrotask run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The last `authFetch` call: its path, init, and options. */
const sent = () => {
    const call = deps.authFetch.mock.calls.at(-1) as [string, Init, Options] | undefined;
    return call ? { path: call[0], init: call[1], options: call[2] } : null;
};
const upstreamHeaders = (init: Init) =>
    JSON.parse(decodeURIComponent(init.headers!["risu-header"])) as Record<string, string>;

/** A plain `authFetch` stand-in: runs the dispatch check, then answers. */
function answering(response: () => Response) {
    deps.authFetch.mockImplementation(async (_path: string, _init: Init, options: Options = {}) => {
        options.beforeDispatch?.();
        return response();
    });
}

beforeEach(() => {
    deps.awaitSecretWrites.mockResolvedValue(undefined);
    deps.flushResources.mockResolvedValue(undefined);
    deps.assertSaveAdmission.mockImplementation(() => {});
    deps.interceptors.length = 0;
    answering(() => Response.json({ data: [{ id: "m" }] }, { headers: { "x-upstream": "aux" } }));
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("auxFetch", () => {
    it("waits for the queued credential writes, then sends the operation's method with the caller's headers and no credential, and logs it", async () => {
        const barrier = deferred();
        deps.awaitSecretWrites.mockReturnValue(barrier.promise);
        const call = auxFetch("anthropic-models", "https://api.anthropic.com/v1/models?x=1", {
            method: "GET",
            headers: { "anthropic-version": "2023-06-01" },
            chatId: "chat-1",
        });
        await settle();
        expect(deps.authFetch).not.toHaveBeenCalled();
        barrier.resolve();
        const response = await call;
        expect(response.status).toBe(200);
        expect(response.headers.get("x-upstream")).toBe("aux");
        const request = sent()!;
        expect(request.path).toBe("/proxy2");
        expect(request.init.method).toBe("GET");
        expect(request.init.body).toBeUndefined();
        expect(request.init.headers!["risu-aux-op"]).toBe("anthropic-models");
        expect(decodeURIComponent(request.init.headers!["risu-url"])).toBe("https://api.anthropic.com/v1/models?x=1");
        expect(upstreamHeaders(request.init)).toEqual({ "anthropic-version": "2023-06-01" });
        expect(request.init.headers).not.toHaveProperty("Content-Type");
        // No key of any name is in what the tab sends; the JWT is `authFetch`'s, in the outer request only.
        expect(JSON.stringify(request.init.headers).toLowerCase()).not.toMatch(/authorization|x-api-key|risu-auth/);
        expect(typeof request.options.beforeDispatch).toBe("function");
        expect(deps.addFetchLog).toHaveBeenCalledTimes(1);
        expect(deps.addFetchLog.mock.calls[0][0]).toEqual({
            body: "",
            headers: { "anthropic-version": "2023-06-01" },
            response: "anthropic-models: 200",
            success: true,
            url: "https://api.anthropic.com/v1/models?x=1",
            resType: "text",
            chatId: "chat-1",
            status: 200,
        });
    });

    it("sends a JSON value as its text with a JSON content type inside, a string or bytes as they are, and the bytes marker outside", async () => {
        await auxFetch("nanogpt-balance", "https://nano-gpt.com/api/check-balance", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { a: 1 },
        });
        let request = sent()!;
        expect(request.init.method).toBe("POST");
        expect(request.init.body).toBe('{"a":1}');
        expect(upstreamHeaders(request.init)).toEqual({ "Content-Type": "application/json" });
        expect(request.init.headers!["Content-Type"]).toBe("application/octet-stream");
        expect(deps.addFetchLog.mock.calls.at(-1)![0]).toMatchObject({ body: '{"a":1}' });

        await auxFetch("openai-completions", "https://api.openai.com/v1/completions", { body: { prompt: "p" } });
        request = sent()!;
        // The method defaults to POST; a JSON body gets its content type when the caller set none.
        expect(request.init.method).toBe("POST");
        expect(upstreamHeaders(request.init)).toEqual({ "Content-Type": "application/json" });

        const bytes = new Uint8Array([1, 2, 3]);
        await auxFetch("openai-whisper", "https://api.openai.com/v1/audio/transcriptions", {
            headers: { "Content-Type": "audio/wav" },
            body: bytes,
        });
        request = sent()!;
        expect(request.init.body).toBe(bytes);
        expect(upstreamHeaders(request.init)).toEqual({ "Content-Type": "audio/wav" });
        expect(deps.addFetchLog.mock.calls.at(-1)![0]).toMatchObject({ body: "(openai-whisper body)" });
    });

    it("serializes a FormData body once, with the boundary that names its parts", async () => {
        const form = new FormData();
        form.append("model", "whisper-1");
        form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "a.wav");
        await auxFetch("openai-whisper", "https://api.openai.com/v1/audio/transcriptions", { body: form });
        const request = sent()!;
        const contentType = upstreamHeaders(request.init)["Content-Type"];
        expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
        const boundary = contentType.slice("multipart/form-data; boundary=".length);
        expect(request.init.body).toBeInstanceOf(Uint8Array);
        const text = new TextDecoder().decode(request.init.body as Uint8Array);
        expect(text).toContain(`--${boundary}\r\n`);
        expect(text).toContain(`--${boundary}--`);
        expect(text).toContain('name="model"');
        expect(text).toContain("whisper-1");
        // (happy-dom names a Blob part `blob`; the browser uses the given file name.)
        expect(text).toMatch(/name="file"; filename="/);
        expect(text).toContain("Content-Type: audio/wav");
        expect(request.init.headers!["Content-Type"]).toBe("application/octet-stream");
    });

    it("runs the body interceptors of its name in order, each over the previous result, and only when a name is given", async () => {
        const seen: [unknown, string][] = [];
        deps.interceptors.push(
            {
                id: "a",
                callback: async (body, type) => {
                    seen.push([body, type]);
                    return { ...body, a: 1 };
                },
            },
            {
                id: "b",
                callback: async (body, type) => {
                    seen.push([body, type]);
                    return undefined;
                },
            },
        );
        await auxFetch("ollama-cloud-tags", "https://ollama.com/api/tags", {
            method: "GET",
            interceptor: "ollama_models",
        });
        expect(seen).toEqual([
            [undefined, "ollama_models"],
            [{ a: 1 }, "ollama_models"],
        ]);
        expect(sent()!.init.body).toBeUndefined();
        seen.length = 0;
        await auxFetch("openai-dalle", "https://api.openai.com/v1/images/generations", {
            body: { prompt: "x" },
            interceptor: "dalle",
        });
        expect(seen).toEqual([
            [{ prompt: "x" }, "dalle"],
            [{ prompt: "x", a: 1 }, "dalle"],
        ]);
        // A hook's return replaces the body; a hook returning nothing keeps it.
        expect(sent()!.init.body).toBe('{"prompt":"x","a":1}');
        seen.length = 0;
        await auxFetch("openai-dalle", "https://api.openai.com/v1/images/generations", { body: { prompt: "y" } });
        expect(seen).toEqual([]);
        expect(sent()!.init.body).toBe('{"prompt":"y"}');
    });

    it("fails before anything is sent when a queued credential write failed, and when saving is halted", async () => {
        deps.awaitSecretWrites.mockRejectedValue(new Error("The server refused a key"));
        await expect(auxFetch("openai-models", "https://api.openai.com/v1/models", { method: "GET" })).rejects.toThrow(
            "The server refused a key",
        );
        expect(deps.authFetch).not.toHaveBeenCalled();
        expect(deps.addFetchLog).not.toHaveBeenCalled();
        deps.awaitSecretWrites.mockResolvedValue(undefined);
        deps.assertSaveAdmission.mockImplementation(() => {
            throw new Error("Saving stopped: the server data was restored");
        });
        await expect(auxFetch("openai-models", "https://api.openai.com/v1/models", { method: "GET" })).rejects.toThrow(
            "Saving stopped",
        );
        expect(deps.authFetch).not.toHaveBeenCalled();
    });

    it("settles at once on an abort while the save barrier waits, and sends nothing when the barrier ends", async () => {
        const barrier = deferred();
        deps.awaitSecretWrites.mockReturnValue(barrier.promise);
        const controller = new AbortController();
        const call = auxFetch("openai-models", "https://api.openai.com/v1/models", {
            method: "GET",
            signal: controller.signal,
        });
        await settle();
        controller.abort();
        await expect(call).rejects.toMatchObject({ name: "AbortError" });
        barrier.resolve();
        await settle();
        expect(deps.authFetch).not.toHaveBeenCalled();
        // An already-aborted signal: nothing starts at all.
        const aborted = new AbortController();
        aborted.abort();
        deps.awaitSecretWrites.mockClear();
        await expect(
            auxFetch("openai-models", "https://api.openai.com/v1/models", { method: "GET", signal: aborted.signal }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(deps.awaitSecretWrites).not.toHaveBeenCalled();
        expect(deps.authFetch).not.toHaveBeenCalled();
    });

    it("settles at once on an abort during an interceptor, starts no later interceptor, and sends nothing", async () => {
        const hook = deferred<unknown>();
        const second = vi.fn(async (body: unknown) => body);
        deps.interceptors.push({ id: "slow", callback: () => hook.promise }, { id: "second", callback: second });
        const controller = new AbortController();
        const call = auxFetch("openai-dalle", "https://api.openai.com/v1/images/generations", {
            body: { prompt: "x" },
            interceptor: "dalle",
            signal: controller.signal,
        });
        await settle();
        controller.abort();
        await expect(call).rejects.toMatchObject({ name: "AbortError" });
        hook.resolve({ prompt: "late" });
        await settle();
        expect(second).not.toHaveBeenCalled();
        expect(deps.authFetch).not.toHaveBeenCalled();
    });

    it("leaves no rejection unobserved when a hook aborts synchronously and returns a rejected promise, or rejects after the abort", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on("unhandledRejection", onUnhandled);
        try {
            const controller = new AbortController();
            const second = vi.fn(async (body: unknown) => body);
            deps.interceptors.push(
                {
                    id: "sync-abort",
                    callback: () => {
                        controller.abort();
                        return Promise.reject(new Error("hook-rejection-sentinel"));
                    },
                },
                { id: "second", callback: second },
            );
            await expect(
                auxFetch("openai-dalle", "https://api.openai.com/v1/images/generations", {
                    body: { prompt: "x" },
                    interceptor: "dalle",
                    signal: controller.signal,
                }),
            ).rejects.toMatchObject({ name: "AbortError" });
            await settle();
            expect(second).not.toHaveBeenCalled();
            expect(deps.authFetch).not.toHaveBeenCalled();

            deps.interceptors.length = 0;
            const late = deferred<unknown>();
            const other = new AbortController();
            deps.interceptors.push({ id: "late", callback: () => late.promise });
            const call = auxFetch("openai-dalle", "https://api.openai.com/v1/images/generations", {
                body: { prompt: "x" },
                interceptor: "dalle",
                signal: other.signal,
            });
            await settle();
            other.abort();
            await expect(call).rejects.toMatchObject({ name: "AbortError" });
            late.reject(new Error("late-rejection-sentinel"));
            await settle();
            await settle();
            expect(unhandled).toEqual([]);
            expect(deps.authFetch).not.toHaveBeenCalled();
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });

    it("checks abort and save admission again right before the request goes out, after authentication, and settles at once on an abort meanwhile", async () => {
        // `authFetch` authenticates and signs (here: waits), then runs the dispatch check, then sends.
        const auth = deferred();
        let dispatched = 0;
        deps.authFetch.mockImplementation(async (_path: string, _init: Init, options: Options = {}) => {
            await auth.promise;
            options.beforeDispatch?.();
            dispatched += 1;
            return Response.json({ ok: true });
        });
        // A restore halts saving while the authentication waits: nothing goes out.
        const halted = auxFetch("openai-models", "https://api.openai.com/v1/models", { method: "GET" });
        await settle();
        expect(deps.authFetch).toHaveBeenCalledTimes(1);
        deps.assertSaveAdmission.mockImplementation(() => {
            throw new Error("Saving stopped: the server data was restored");
        });
        auth.resolve();
        await expect(halted).rejects.toThrow("Saving stopped");
        expect(dispatched).toBe(0);
        expect(deps.addFetchLog).not.toHaveBeenCalled();

        // An abort while the authentication waits settles the call now and fences the dispatch later.
        deps.assertSaveAdmission.mockImplementation(() => {});
        const auth2 = deferred();
        deps.authFetch.mockImplementation(async (_path: string, _init: Init, options: Options = {}) => {
            await auth2.promise;
            options.beforeDispatch?.();
            dispatched += 1;
            return Response.json({ ok: true });
        });
        const controller = new AbortController();
        const aborted = auxFetch("openai-models", "https://api.openai.com/v1/models", {
            method: "GET",
            signal: controller.signal,
        });
        await settle();
        controller.abort();
        await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
        auth2.resolve();
        await settle();
        expect(dispatched).toBe(0);
        // The signal also travels with the request itself.
        expect(sent()!.init.signal).toBe(controller.signal);
    });

    it("auxFetchJson answers like globalFetch: parsed JSON, text otherwise, and a failed call as ok: false with its message", async () => {
        expect(await auxFetchJson("openai-models", "https://api.openai.com/v1/models", { method: "GET" })).toEqual({
            ok: true,
            data: { data: [{ id: "m" }] },
            status: 200,
        });
        answering(() => new Response("plain text", { status: 502 }));
        expect(await auxFetchJson("openai-models", "https://api.openai.com/v1/models", { method: "GET" })).toEqual({
            ok: false,
            data: "plain text",
            status: 502,
        });
        answering(() => Response.json({ error: "refused" }, { status: 502 }));
        expect(await auxFetchJson("openai-models", "https://api.openai.com/v1/models", { method: "GET" })).toEqual({
            ok: false,
            data: { error: "refused" },
            status: 502,
        });
        deps.awaitSecretWrites.mockRejectedValue(new Error("A key could not be saved"));
        expect(await auxFetchJson("openai-models", "https://api.openai.com/v1/models", { method: "GET" })).toEqual({
            ok: false,
            data: "Error: A key could not be saved",
            status: 400,
        });
    });
});

describe("auxFetch profile binding", () => {
    it("flushes profiles and keys before secret writes and sends the profile only in the outer header", async () => {
        const resources = deferred();
        const secrets = deferred();
        deps.flushResources.mockReturnValue(resources.promise);
        deps.awaitSecretWrites.mockReturnValue(secrets.promise);
        const call = auxFetch("nanogpt-models", "https://nano-gpt.com/api/personalized/v1/models", {
            method: "GET",
            profileId: "edited-profile",
        });
        await settle();
        expect(deps.flushResources).toHaveBeenCalledTimes(1);
        expect(deps.awaitSecretWrites).not.toHaveBeenCalled();
        expect(deps.authFetch).not.toHaveBeenCalled();
        resources.resolve();
        await settle();
        expect(deps.awaitSecretWrites).toHaveBeenCalledTimes(1);
        expect(deps.authFetch).not.toHaveBeenCalled();
        secrets.resolve();
        await call;
        expect(sent()!.init.headers!["risu-aux-profile"]).toBe("edited-profile");
        expect(upstreamHeaders(sent()!.init)).not.toHaveProperty("risu-aux-profile");
    });
    it("refuses a failed resource flush before sending a profile request", async () => {
        deps.flushResources.mockRejectedValue(new Error("Profile could not be saved"));
        await expect(
            auxFetch("nanogpt-models", "https://nano-gpt.com/api/personalized/v1/models", {
                method: "GET",
                profileId: "edited-profile",
            }),
        ).rejects.toThrow("Profile could not be saved");
        expect(deps.awaitSecretWrites).not.toHaveBeenCalled();
        expect(deps.authFetch).not.toHaveBeenCalled();
    });
    it("keeps a call without a profile independent of resource writes", async () => {
        deps.flushResources.mockImplementation(() => {
            throw new Error("must not flush");
        });
        await auxFetch("openai-models", "https://api.openai.com/v1/models", { method: "GET" });
        expect(deps.flushResources).not.toHaveBeenCalled();
        expect(deps.awaitSecretWrites).toHaveBeenCalledTimes(1);
        expect(sent()!.init.headers).not.toHaveProperty("risu-aux-profile");
    });
});
