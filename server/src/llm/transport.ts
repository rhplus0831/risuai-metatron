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
 *
 * `record` is the request history's sink: every exchange once, with the bytes sent and received
 * before any redaction or cut. A buffered fetch is recorded when its answer is read or it fails; a
 * streamed fetch (`logFetch` not false) when its body ends, fails, or is cancelled, or when the
 * request ends (`captures`), with the first `STREAM_CAPTURE_BYTES` of its body; an adapter's
 * `addLog` as it is. The tab's log keeps the pre-fetch "Streamed Fetch" entry, which is not
 * recorded. A `record` failure never changes the provider's answer.
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
    /**
     * Whether this call's answer can be the request's first byte (`TransportOptions.onFirstByte`);
     * default true. An acknowledgement or a poll that is not the answer passes false.
     */
    firstByte?: boolean;
};

/** The original bytes of exchange fields the transport already cut (a streamed body's capture). */
export type ExchangeCuts = Partial<Record<"url" | "header" | "body" | "response", number>>;

/** One recorded exchange beside its log entry: sizes before any redaction or cut. */
export type ExchangeDetail = {
    cuts?: ExchangeCuts;
    /** The body sent. */
    requestBytes: number;
    /** The body received; null when no answer came (a network failure). */
    responseBytes: number | null;
};

/**
 * The bytes of a streamed body the history keeps: its 4 MiB bound plus a margin, so a credential that
 * crosses the bound is still whole when the redactor runs (the store cuts at 4 MiB after it).
 */
export const STREAM_CAPTURE_BYTES = 4 * 1024 * 1024 + 16 * 1024;

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
    /**
     * A provider's answer began: the first body chunk of a buffered or streamed answer (its end, for
     * an empty body; at once for a response without a body). Called for every fetch; the caller keeps
     * the first.
     */
    onFirstByte?: () => void;
    /** The request history's sink (see above); without it nothing is captured or wrapped. */
    record?: (entry: FetchLogEntry, detail: ExchangeDetail) => void;
    /** The request's pending stream captures: the request flushes them before it reports its end. */
    captures?: Set<() => void>;
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

/** `response` whose body calls `mark` with its first chunk (or its end, when it has none). */
export function watchFirstByte(response: Response, mark: () => void): Response {
    if (!response.body) {
        mark();
        return response;
    }
    let seen = false;
    const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                if (!seen) {
                    seen = true;
                    mark();
                }
                controller.enqueue(chunk);
            },
            flush() {
                if (!seen) {
                    seen = true;
                    mark();
                }
            },
        }),
    );
    return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
}

/**
 * A response's first byte, kept until the caller knows the response ended the request: `response`
 * notes when its first chunk (or its end, without one) came, and `answered()` reports that time to
 * `hook`, if it came. Without a hook, `answered` does nothing.
 */
export function deferFirstByte(
    response: Response,
    hook: { mark(at?: number): void; now(): number } | undefined,
): { response: Response; answered: () => void } {
    if (!hook) {
        return { response, answered: () => {} };
    }
    let at: number | undefined;
    const watched = watchFirstByte(response, () => {
        at ??= hook.now();
    });
    return {
        response: watched,
        answered: () => {
            if (at !== undefined) {
                hook.mark(at);
            }
        },
    };
}

/**
 * `response` whose body passes through unchanged while its first `limit` bytes are kept: `done` is
 * called once with them and the total read so far, at the body's end, a read failure, a cancel, or
 * a flush from `captures` (the request ended), whichever comes first. Bytes read after that pass
 * through uncounted. Without a body, `done` runs at once.
 */
export function teeBody(
    response: Response,
    limit: number,
    done: (kept: Uint8Array, total: number) => void,
    captures?: Set<() => void>,
): Response {
    let chunks: Uint8Array[] = [];
    let kept = 0;
    let total = 0;
    let flushed = false;
    const flush = () => {
        if (flushed) {
            return;
        }
        flushed = true;
        captures?.delete(flush);
        const bytes = new Uint8Array(kept);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        chunks = [];
        try {
            done(bytes, total);
        } catch (error) {
            console.error("[LLM] request history capture:", error instanceof Error ? error.message : String(error));
        }
    };
    if (!response.body) {
        flush();
        return response;
    }
    captures?.add(flush);
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                let result: Awaited<ReturnType<typeof reader.read>>;
                try {
                    result = await reader.read();
                } catch (error) {
                    flush();
                    controller.error(error);
                    return;
                }
                if (result.done) {
                    flush();
                    controller.close();
                    return;
                }
                const value = result.value;
                if (!flushed) {
                    total += value.byteLength;
                    if (kept < limit) {
                        // A copy: the kept prefix holds no larger backing buffer.
                        const part = value.slice(0, limit - kept);
                        chunks.push(part);
                        kept += part.byteLength;
                    }
                }
                controller.enqueue(value);
            },
            cancel(reason) {
                flush();
                return reader.cancel(reason);
            },
        },
        { highWaterMark: 0 },
    );
    return new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText });
}

function stringify(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function utf8Bytes(value: unknown): number {
    return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

export function createTransport(options: TransportOptions): Transport {
    const fetchImpl = options.fetchImpl ?? fetch;
    const redact = options.redact ?? ((text: string) => text);
    const logError = (error: unknown) =>
        console.error("[LLM]", redact(error instanceof Error ? error.message : String(error)));

    /** Hands `entry` to the history's sink; a failure there is logged, never thrown. */
    function record(entry: FetchLogEntry, detail: ExchangeDetail) {
        if (!options.record) {
            return;
        }
        try {
            options.record(entry, detail);
        } catch (error) {
            logError(error);
        }
    }

    function logEntry(arg: LogInput): FetchLogEntry {
        return {
            body: typeof arg.body === "string" ? arg.body : stringify(arg.body),
            header: stringify(arg.headers ?? {}),
            response: typeof arg.response === "string" ? arg.response : stringify(arg.response),
            responseType: arg.resType ?? "json",
            success: arg.success,
            date: new Date().toLocaleTimeString(),
            url: arg.url,
            chatId: arg.chatId,
            status: arg.status,
        };
    }

    /**
     * One fetch's history entry, recorded exactly once: when the call settles, or, registered in
     * `captures`, when the request ends first (with what is known by then: the status, if the
     * headers came). A streamed body's capture takes it over (`handOver`) once the headers came.
     */
    function attempt(entry: FetchLogEntry, requestBytes: number) {
        let open = !!options.record;
        let status: number | undefined;
        const flush = () => settle({ response: "The request ended before its answer was read", success: false }, null);
        function settle(patch: Partial<FetchLogEntry>, responseBytes: number | null) {
            if (!open) {
                return;
            }
            open = false;
            options.captures?.delete(flush);
            record({ ...entry, status, ...patch }, { requestBytes, responseBytes });
        }
        if (open) {
            options.captures?.add(flush);
        }
        return {
            answered(next: number) {
                status = next;
            },
            settle,
            /** False when the request already ended (the entry is recorded): nothing to capture. */
            handOver(): boolean {
                if (!open) {
                    return false;
                }
                open = false;
                options.captures?.delete(flush);
                return true;
            },
        };
    }

    /** An adapter's own entry: the tab's log and the history alike. */
    function addLog(arg: LogInput): number {
        const entry = logEntry(arg);
        options.log(entry);
        record(entry, { requestBytes: utf8Bytes(entry.body), responseBytes: utf8Bytes(entry.response) });
        return 0;
    }

    // `addFetchLogInGlobalFetch`.
    function logBuffered(
        response: unknown,
        success: boolean,
        url: string,
        arg: BufferedFetchArgs,
        status: number | undefined,
        exchange: ReturnType<typeof attempt>,
        responseBytes: number,
    ) {
        let text: string;
        try {
            text = stringify(response);
        } catch {
            text = `${response}`;
        }
        const entry: FetchLogEntry = {
            body: stringify(arg.body),
            header: stringify(arg.headers ?? {}),
            response: text,
            success,
            date: new Date().toLocaleTimeString(),
            url,
            chatId: arg.chatId,
            status,
        };
        options.log(entry);
        exchange.settle({ response: entry.response, success, status }, responseBytes);
    }

    async function fetchBuffered(url: string, arg: BufferedFetchArgs = {}): Promise<BufferedFetchResult> {
        /** The history's entry, once the body is sent. */
        let exchange: ReturnType<typeof attempt> | null = null;
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
                const sent: string | undefined =
                    method === "GET" ? undefined : isForm ? arg.body.toString() : JSON.stringify(arg.body);
                const call = attempt(
                    {
                        body: stringify(arg.body),
                        header: stringify(arg.headers ?? {}),
                        response: "",
                        success: false,
                        date: new Date().toLocaleTimeString(),
                        url,
                        chatId: arg.chatId,
                    },
                    utf8Bytes(sent),
                );
                exchange = call;
                const response = await fetchImpl(url, {
                    body: sent,
                    headers,
                    method,
                    signal: timeout.signal,
                });
                call.answered(response.status);
                // The answer's first body byte, not its headers: read through the watched body.
                const answer = options.onFirstByte ? watchFirstByte(response, options.onFirstByte) : response;
                const isSuccess = response.ok && response.status >= 200 && response.status < 300;
                const responseHeaders = Object.fromEntries(response.headers);
                if (arg.rawResponse) {
                    const data = new Uint8Array(await answer.arrayBuffer());
                    logBuffered("Uint8Array Response", isSuccess, url, arg, response.status, call, data.byteLength);
                    return { ok: isSuccess, data, headers: responseHeaders, status: response.status };
                }
                const text = await answer.text();
                const received = utf8Bytes(text);
                try {
                    const data = JSON.parse(text);
                    logBuffered(data, isSuccess, url, arg, response.status, call, received);
                    return { ok: isSuccess, data, headers: responseHeaders, status: response.status };
                } catch {
                    const errorMsg = text.startsWith("<!DOCTYPE")
                        ? "Responded HTML. Is your URL, API key, and password correct?"
                        : text;
                    logBuffered(text, false, url, arg, response.status, call, received);
                    return { ok: false, data: errorMsg, headers: responseHeaders, status: response.status };
                }
            } finally {
                timeout.cleanup();
            }
        } catch (error) {
            logError(error);
            const data =
                isAbort(error) || options.signal.aborted ? `${error}` : `${unreachable(url, error, redact).message}`;
            // Sent, but no answer was read: the history keeps the attempt (the tab's log never had it).
            exchange?.settle({ response: data, success: false }, null);
            return { ok: false, data, headers: {}, status: 400 };
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
        const logged = arg.logFetch ?? true;
        // The tab's entry, before the fetch; the history records the exchange once it is known.
        const pending = logged
            ? logEntry({
                  body: new TextDecoder().decode(realBody),
                  headers: arg.headers,
                  response: "Streamed Fetch",
                  success: true,
                  url,
                  resType: "stream",
                  chatId: arg.chatId,
              })
            : null;
        if (pending) {
            options.log(pending);
        }
        const requestBytes = realBody?.byteLength ?? 0;
        const exchange = pending ? attempt(pending, requestBytes) : null;
        let response: Response;
        try {
            response = await fetchImpl(url, {
                body: realBody as RequestInit["body"],
                headers,
                method: arg.method,
                signal: timeout.signal,
            });
        } catch (error) {
            const thrown = isAbort(error) || timeout.signal.aborted ? error : unreachable(url, error, redact);
            exchange?.settle(
                { response: thrown instanceof Error ? thrown.message : String(thrown), success: false },
                null,
            );
            throw thrown;
        } finally {
            timeout.cleanup();
        }
        let out = response;
        // The request may have ended while the headers came: then the entry is already recorded.
        if (pending && exchange?.handOver()) {
            const answered = response;
            out = teeBody(
                answered,
                STREAM_CAPTURE_BYTES,
                (kept, total) =>
                    record(
                        {
                            ...pending,
                            // A cut body may end inside a character: its incomplete bytes are left out.
                            response: new TextDecoder().decode(kept, { stream: total > kept.byteLength }),
                            success: answered.ok,
                            status: answered.status,
                        },
                        {
                            ...(total > kept.byteLength ? { cuts: { response: total } } : {}),
                            requestBytes,
                            responseBytes: total,
                        },
                    ),
                options.captures,
            );
        }
        if (options.onFirstByte && arg.firstByte !== false) {
            out = watchFirstByte(out, options.onFirstByte);
        }
        return out;
    }

    return { fetchBuffered, fetchStream, addLog };
}

/** The client's `textifyReadableStream`. */
export function textifyReadableStream(stream: ReadableStream<Uint8Array>) {
    return new Response(stream).text();
}
