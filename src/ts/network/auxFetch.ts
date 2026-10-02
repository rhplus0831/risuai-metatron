import { addFetchLog } from "../globalApi.svelte";
import { authFetch } from "../storage/nodeStorage";
import { assertSaveAdmission, awaitSecretWrites } from "../storage/resourceSync.svelte";
import { bodyIntercepterStore } from "../stores.svelte";

/**
 * A call that uses a stored LLM credential, through `/proxy2`'s auxiliary operations (Phase 5 slice
 * 7b, `server/src/llm/auxOps.ts`): the server sends it to the operation's fixed endpoint with the
 * stored key; the tab never holds the key. The operation's method is kept (a GET carries no body).
 * It waits first for the credential writes this tab queued (a key entered just before is used), runs
 * the plugin body interceptors for `interceptor` as `globalFetch` does, and logs the request (its
 * headers carry no credential; the JWT is in the outer request only). Returns the `Response`; a
 * failed key save or a network error throws. An abort settles the call at once, even while it waits
 * for the save (which goes on), and no interceptor or request starts after it; nothing is sent once
 * saving has stopped for a restore.
 */
export async function auxFetch(
    op: string,
    url: string,
    init: {
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        /** A JSON value, a string, bytes, or `FormData` (sent with its own multipart boundary). */
        body?: unknown;
        signal?: AbortSignal;
        interceptor?: string;
        chatId?: string;
    } = {},
): Promise<Response> {
    const signal = init.signal;
    const checkAbort = () => {
        if (signal?.aborted) {
            throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
    };
    checkAbort();
    await untilAborted(awaitSecretWrites(), signal);
    const method = init.method ?? "POST";
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    let body: unknown = init.body;
    if (init.interceptor) {
        for (const interceptor of bodyIntercepterStore) {
            checkAbort();
            try {
                body =
                    (await untilAborted(Promise.resolve(interceptor.callback(body, init.interceptor)), signal)) || body;
            } catch (error) {
                checkAbort();
                console.error(error);
            }
        }
    }
    let payload: BodyInit | undefined;
    if (method === "GET") {
        payload = undefined;
    } else if (body instanceof FormData) {
        // Serialized once, so the upstream gets the same bytes and the boundary that names them.
        const serialized = new Request("http://localhost/", { method: "POST", body });
        headers["Content-Type"] = serialized.headers.get("content-type") ?? "multipart/form-data";
        payload = new Uint8Array(await untilAborted(serialized.arrayBuffer(), signal));
    } else if (body instanceof Uint8Array || body instanceof ArrayBuffer || typeof body === "string") {
        payload = body as BodyInit;
    } else if (body !== undefined) {
        headers["Content-Type"] ??= "application/json";
        payload = JSON.stringify(body);
    }
    const beforeDispatch = () => {
        checkAbort();
        assertSaveAdmission();
    };
    beforeDispatch();
    const response = await untilAborted(
        authFetch(
            "/proxy2",
            {
                method,
                headers: {
                    "risu-url": encodeURIComponent(url),
                    "risu-header": encodeURIComponent(JSON.stringify(headers)),
                    "risu-aux-op": op,
                    ...(payload !== undefined ? { "Content-Type": "application/octet-stream" } : {}),
                },
                body: payload,
                signal: init.signal,
            },
            { beforeDispatch },
        ),
        signal,
    );
    addFetchLog({
        body: typeof payload === "string" ? payload : payload === undefined ? "" : `(${op} body)`,
        headers,
        response: `${op}: ${response.status}`,
        success: response.ok,
        url,
        resType: "text",
        chatId: init.chatId,
        status: response.status,
    });
    return response;
}

/** `promise`, or a rejection with the abort reason as soon as `signal` aborts (`promise` goes on). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        // Observed first, in every case, so a rejection after the abort is never unhandled.
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * `auxFetch` answered as `globalFetch` answers (`{ ok, data, status }`): a JSON body parsed, any
 * other text as it is; a failed key save or a network error is `ok: false` with its message.
 */
export async function auxFetchJson(
    op: string,
    url: string,
    init: Parameters<typeof auxFetch>[2] = {},
): Promise<{ ok: boolean; data: any; status: number }> {
    let response: Response;
    try {
        response = await auxFetch(op, url, init);
    } catch (error) {
        return { ok: false, data: `${error}`, status: 400 };
    }
    const text = await response.text();
    try {
        return { ok: response.ok, data: JSON.parse(text), status: response.status };
    } catch {
        return { ok: false, data: text, status: response.status };
    }
}
