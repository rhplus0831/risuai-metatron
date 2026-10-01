/**
 * The request layer's HTTP transport on the server: the client's `globalFetch` and `fetchNative`
 * (`src/ts/globalApi.svelte.ts`) with the browser routing gone. Every call goes straight from the
 * server to the provider (no `/proxy2` hop, no userscript fetch, no plain-fetch switch); the
 * local-network timeout and the `interceptor` hook stay. Results and errors keep the browser path's
 * shapes: `fetchBuffered` answers as `fetchWithProxy` does (a JSON body parsed, any other text a
 * failure carrying it), `fetchStream` returns the `Response` and throws on a network error.
 *
 * Log entries are built as the client builds them (`addFetchLog` and `addFetchLogInGlobalFetch`)
 * and handed to `log`, which redacts them before they leave the server.
 */

export type FetchLogEntry = {
    body: string;
    header: string;
    response: string;
    success: boolean;
    date: string;
    url: string;
    responseType?: string;
    chatId?: string;
    status?: number;
};

export type BufferedFetchArgs = {
    plainFetchForce?: boolean;
    plainFetchDeforce?: boolean;
    body?: any;
    headers?: { [key: string]: string };
    rawResponse?: boolean;
    method?: "POST" | "GET";
    abortSignal?: AbortSignal | null;
    useRisuToken?: boolean;
    chatId?: string;
    interceptor?: string;
    requestTimeoutMs?: number;
    networkRoute?: "auto" | "local_network";
};

export type BufferedFetchResult = {
    ok: boolean;
    data: any;
    headers: { [key: string]: string };
    status: number;
};

export type StreamFetchArgs = {
    body?: string | Uint8Array | ArrayBuffer;
    headers?: { [key: string]: string };
    method?: "POST" | "GET" | "PUT" | "DELETE";
    signal?: AbortSignal | null;
    useRisuTk?: boolean;
    chatId?: string;
    interceptor?: string;
    logFetch?: boolean;
    requestTimeoutMs?: number;
    networkRoute?: "auto" | "local_network";
};

export type LogInput = {
    body: any;
    headers?: { [key: string]: string };
    response: any;
    success: boolean;
    url: string;
    resType?: string;
    chatId?: string;
    status?: number;
};

export type Transport = {
    fetchBuffered(url: string, arg?: BufferedFetchArgs): Promise<BufferedFetchResult>;
    fetchStream(url: string, arg: StreamFetchArgs): Promise<Response>;
    /** The client's `addFetchLog`. */
    addLog(arg: LogInput): number;
};

export type TransportOptions = {
    /** The request's own signal: every fetch is aborted with it. */
    signal: AbortSignal;
    log: (entry: FetchLogEntry) => void;
    /** `bodyIntercepter` (a job callback), or none: the body is sent as it is. */
    intercept?: (body: unknown, type: string) => Promise<unknown>;
    /** Removes the request's credentials from a text the server logs or returns. */
    redact?: (text: string) => string;
    fetchImpl?: typeof fetch;
};

/**
 * A network failure names the URL it could not reach, from the server: a provider on the
 * browser's `localhost` is not on the server's (in Docker, the container's).
 */
function unreachable(url: string, error: unknown, redact: (text: string) => string): Error {
    let shown = url;
    try {
        const parsed = new URL(url);
        shown = `${parsed.origin}${parsed.pathname}`;
    } catch {}
    const cause = (error as { cause?: { message?: string } })?.cause?.message;
    return new Error(
        redact(
            `The server could not reach ${shown}: ${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ""}`,
        ),
    );
}

function isAbort(error: unknown): boolean {
    return (error as { name?: string })?.name === "AbortError" || (error as { name?: string })?.name === "TimeoutError";
}

/**
 * One signal for a fetch: aborted by any of `signals` for the whole exchange (the body included),
 * and by `timeoutMs` until `clearTimer` (the client clears its timeout once the headers arrive).
 */
function timeoutSignal(
    signals: (AbortSignal | null | undefined)[],
    timeoutMs: number | undefined,
): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    for (const signal of signals) {
        if (!signal) {
            continue;
        }
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    const timer =
        timeoutMs && timeoutMs > 0
            ? setTimeout(() => controller.abort(new DOMException("The request timed out", "TimeoutError")), timeoutMs)
            : undefined;
    return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

function stringify(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

export function createTransport(options: TransportOptions): Transport {
    const fetchImpl = options.fetchImpl ?? fetch;
    const redact = options.redact ?? ((text: string) => text);
    const logError = (error: unknown) =>
        console.error("[LLM]", redact(error instanceof Error ? error.message : String(error)));

    function addLog(arg: LogInput): number {
        options.log({
            body: typeof arg.body === "string" ? arg.body : stringify(arg.body),
            header: stringify(arg.headers ?? {}),
            response: typeof arg.response === "string" ? arg.response : stringify(arg.response),
            responseType: arg.resType ?? "json",
            success: arg.success,
            date: new Date().toLocaleTimeString(),
            url: arg.url,
            chatId: arg.chatId,
            status: arg.status,
        });
        return 0;
    }

    // `addFetchLogInGlobalFetch`.
    function logBuffered(response: unknown, success: boolean, url: string, arg: BufferedFetchArgs, status?: number) {
        let text: string;
        try {
            text = stringify(response);
        } catch {
            text = `${response}`;
        }
        options.log({
            body: stringify(arg.body),
            header: stringify(arg.headers ?? {}),
            response: text,
            success,
            date: new Date().toLocaleTimeString(),
            url,
            chatId: arg.chatId,
            status,
        });
    }

    async function fetchBuffered(url: string, arg: BufferedFetchArgs = {}): Promise<BufferedFetchResult> {
        try {
            if (arg.abortSignal?.aborted || options.signal.aborted) {
                return { ok: false, data: "aborted", headers: {}, status: 400 };
            }
            new URL(url);
            if (arg.interceptor && options.intercept) {
                try {
                    arg.body = (await options.intercept(arg.body, arg.interceptor)) || arg.body;
                } catch (error) {
                    logError(error);
                    if (options.signal.aborted) {
                        return { ok: false, data: "aborted", headers: {}, status: 400 };
                    }
                }
            }
            const timeout = timeoutSignal([arg.abortSignal, options.signal], arg.requestTimeoutMs);
            try {
                const isForm = arg.body instanceof URLSearchParams;
                const headers: { [key: string]: string } = {
                    "Content-Type": isForm ? "application/x-www-form-urlencoded" : "application/json",
                    ...arg.headers,
                };
                const method = arg.method ?? "POST";
                const response = await fetchImpl(url, {
                    body: method === "GET" ? undefined : isForm ? arg.body.toString() : JSON.stringify(arg.body),
                    headers,
                    method,
                    signal: timeout.signal,
                });
                const isSuccess = response.ok && response.status >= 200 && response.status < 300;
                const responseHeaders = Object.fromEntries(response.headers);
                if (arg.rawResponse) {
                    const data = new Uint8Array(await response.arrayBuffer());
                    logBuffered("Uint8Array Response", isSuccess, url, arg, response.status);
                    return { ok: isSuccess, data, headers: responseHeaders, status: response.status };
                }
                const text = await response.text();
                try {
                    const data = JSON.parse(text);
                    logBuffered(data, isSuccess, url, arg, response.status);
                    return { ok: isSuccess, data, headers: responseHeaders, status: response.status };
                } catch {
                    const errorMsg = text.startsWith("<!DOCTYPE")
                        ? "Responded HTML. Is your URL, API key, and password correct?"
                        : text;
                    logBuffered(text, false, url, arg, response.status);
                    return { ok: false, data: errorMsg, headers: responseHeaders, status: response.status };
                }
            } finally {
                timeout.cleanup();
            }
        } catch (error) {
            logError(error);
            if (isAbort(error) || options.signal.aborted) {
                return { ok: false, data: `${error}`, headers: {}, status: 400 };
            }
            return { ok: false, data: `${unreachable(url, error, redact).message}`, headers: {}, status: 400 };
        }
    }

    async function fetchStream(url: string, arg: StreamFetchArgs): Promise<Response> {
        if (arg.body === undefined && (arg.method === "POST" || arg.method === "PUT")) {
            throw new Error("Body is required for POST and PUT requests");
        }
        arg.method = arg.method ?? "POST";
        const headers = arg.headers ?? {};
        let realBody: Uint8Array | undefined;
        if (arg.method === "GET" || arg.method === "DELETE") {
            realBody = undefined;
        } else if (typeof arg.body === "string") {
            let body: string = arg.body;
            if (arg.interceptor && options.intercept) {
                try {
                    body = ((await options.intercept(body, arg.interceptor)) as string) || body;
                } catch (error) {
                    logError(error);
                    if (options.signal.aborted) {
                        throw error;
                    }
                }
            }
            realBody = new TextEncoder().encode(body);
        } else if (arg.body instanceof Uint8Array) {
            realBody = arg.body;
        } else if (arg.body instanceof ArrayBuffer) {
            realBody = new Uint8Array(arg.body);
        } else {
            throw new Error("Invalid body type");
        }

        const timeout = timeoutSignal([arg.signal, options.signal], arg.requestTimeoutMs);
        if (arg.logFetch ?? true) {
            addLog({
                body: new TextDecoder().decode(realBody),
                headers: arg.headers,
                response: "Streamed Fetch",
                success: true,
                url,
                resType: "stream",
                chatId: arg.chatId,
            });
        }
        try {
            return await fetchImpl(url, {
                body: realBody as RequestInit["body"],
                headers,
                method: arg.method,
                signal: timeout.signal,
            });
        } catch (error) {
            if (isAbort(error) || timeout.signal.aborted) {
                throw error;
            }
            throw unreachable(url, error, redact);
        } finally {
            timeout.cleanup();
        }
    }

    return { fetchBuffered, fetchStream, addLog };
}

/** The client's `textifyReadableStream`. */
export function textifyReadableStream(stream: ReadableStream<Uint8Array>) {
    return new Response(stream).text();
}
