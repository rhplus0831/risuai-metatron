// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    clampRequestHistoryLimit,
    createRequestHistory,
    REQUEST_HISTORY_BOUNDS,
    REQUEST_HISTORY_DEFAULT_LIMIT,
    REQUEST_HISTORY_EXCHANGE_OVERHEAD,
    REQUEST_HISTORY_MAX_BYTES,
    REQUEST_HISTORY_MAX_LIMIT,
    REQUEST_HISTORY_MIN_LIMIT,
    REQUEST_HISTORY_ROW_OVERHEAD,
    type RequestHistory,
    type RequestHistoryBegin,
} from "../data/requestHistory.ts";
import type { FetchLogEntry } from "../llm/transport.ts";

// Request history slice 2: the durable LLM request history (`server/src/data/requestHistory.ts`).
// The rows: a `pending` row begun once (a duplicate id ignored, an id over 256 bytes or empty not
// begun), its model filled by `describe`, the first `firstByte` and the first `finish` winning, a
// late exchange after `finish` still kept, a summary row with content off (no prompt, no exchanges,
// an exchange not even counted, the bounded error kept). The bounds: every cut at a UTF-8 boundary
// and in the truncation record with its original and stored bytes (the prompt, the exchange fields
// `date` and `responseType` included, the error, a display field), an id kept whole up to 2 KiB and
// otherwise not stored, the caller's `cuts` merged as the larger original, the first 32 exchanges
// kept and the later ones only counted. The accounting: a row's bytes are the fixed overheads plus
// every stored text, the totals match a sum after every write and after a reopen, a cleared field
// drops its truncation record. The caps: the oldest rows by begin order go first, a pending one
// included, under the count cap and the byte cap, after every write (the limit getter read then),
// an oversized row evicting itself, and no prune at open. The lifecycle: a reopen sweeping `pending`
// to `interrupted`, an unsupported version leaving the file byte-identical and the store inert, an
// unopenable file inert, a locked database skipping the write with one warning, injected callbacks
// that throw never escaping, `close` idempotent. The reads: `list` newest first with its exclusive
// `seq` cursor (an old cursor past every row begun after `deleteAll`), the page size clamped, the
// filters combined; `get` with the exchanges in order; `deleteAll` cascading to the exchanges;
// `setShared` atomic over a deduplicated id list.

const KIB = 1024;
const MIB = 1024 * KIB;

const dirs: string[] = [];
const stores: RequestHistory[] = [];
let warn: ReturnType<typeof vi.spyOn>;

function tempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-request-history-"));
    dirs.push(dir);
    return dir;
}
function tempFile(): string {
    return path.join(tempDir(), "request-history.sqlite");
}
function open(options: Partial<Parameters<typeof createRequestHistory>[0]> = {}) {
    const store = createRequestHistory({ file: options.file ?? tempFile(), ...options });
    stores.push(store);
    return store;
}

/** A begin with every optional field absent and content on, overridable. */
function row(id: string, overrides: Partial<RequestHistoryBegin> = {}): RequestHistoryBegin {
    return {
        id,
        jobId: null,
        source: "send",
        mode: "main",
        chaId: null,
        chatId: null,
        messageId: null,
        content: true,
        ...overrides,
    };
}

function entry(overrides: Partial<FetchLogEntry> = {}): FetchLogEntry {
    return {
        url: "https://api.example/v1",
        header: '{"a":"b"}',
        body: '{"q":1}',
        response: "ok",
        success: true,
        date: "2026-10-13T00:00:00.000Z",
        ...overrides,
    };
}

function utf8(text: string | null | undefined): number {
    return typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
}

/** The bytes a begun row counts: the overhead, the id, every stored text, and the truncation JSON. */
function beginBytes(
    summary: RequestHistoryBegin,
    stored: {
        prompt?: string | null;
        truncation?: string | null;
        fields?: Partial<Record<string, string | null>>;
    } = {},
): number {
    const fields = {
        jobId: summary.jobId,
        source: summary.source,
        mode: summary.mode,
        chaId: summary.chaId,
        chatId: summary.chatId,
        messageId: summary.messageId,
        modelId: summary.modelId,
        profileId: summary.profileId,
        profileName: summary.profileName,
        provider: summary.provider,
        ...stored.fields,
    };
    const prompt =
        stored.prompt !== undefined
            ? stored.prompt
            : summary.content && summary.prompt !== undefined
              ? JSON.stringify(summary.prompt)
              : null;
    let bytes = REQUEST_HISTORY_ROW_OVERHEAD + utf8(summary.id) + utf8(prompt) + utf8(stored.truncation);
    for (const value of Object.values(fields)) {
        bytes += utf8(value);
    }
    return bytes;
}

function exchangeBytes(
    e: Record<"url" | "header" | "body" | "response" | "date", string> & { responseType?: string | null },
): number {
    return (
        REQUEST_HISTORY_EXCHANGE_OVERHEAD +
        utf8(e.url) +
        utf8(e.header) +
        utf8(e.body) +
        utf8(e.response) +
        utf8(e.date) +
        utf8(e.responseType)
    );
}

function ids(store: RequestHistory, query?: Parameters<RequestHistory["list"]>[0]): string[] {
    return store.list(query).items.map((item) => item.id);
}

function sha256(file: string): string {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
    warn.mockRestore();
});

describe("the rows", () => {
    it("begins a pending row, fills its model, keeps the first firstByte and finish, and reads it back", () => {
        let now = 1_000;
        const store = open({ now: () => now });
        store.begin(
            row("r1", {
                jobId: "job1",
                chaId: "cha1",
                chatId: "chat1",
                messageId: "msg1",
                startedAt: 500,
                prompt: [{ role: "user", content: "hi" }],
            }),
        );
        const pending = store.get("r1");
        expect(pending).toMatchObject({
            id: "r1",
            jobId: "job1",
            source: "send",
            mode: "main",
            chaId: "cha1",
            chatId: "chat1",
            messageId: "msg1",
            modelId: null,
            profileId: null,
            profileName: null,
            provider: null,
            startedAt: 500,
            firstByteAt: null,
            completedAt: null,
            status: "pending",
            httpStatus: null,
            providerCode: null,
            hasError: false,
            error: null,
            requestBytes: null,
            responseBytes: null,
            content: true,
            exchangeCount: 0,
            storedExchanges: 0,
            truncated: false,
            sharedAt: null,
            prompt: '[{"role":"user","content":"hi"}]',
            exchanges: [],
            truncation: {},
        });
        // `describe` changes only the fields given.
        store.describe("r1", { modelId: "gpt-5", provider: "OpenAI" });
        store.describe("r1", { profileId: "prof1", profileName: "Main" });
        expect(store.get("r1")).toMatchObject({
            modelId: "gpt-5",
            provider: "OpenAI",
            profileId: "prof1",
            profileName: "Main",
        });
        // The first first-byte wins; one without a time is "now".
        store.firstByte("r1", 700);
        store.firstByte("r1", 800);
        store.firstByte("r1");
        expect(store.get("r1")?.firstByteAt).toBe(700);
        // One exchange, then the outcome.
        store.exchange("r1", entry({ status: 200, responseType: "stream" }));
        now = 2_000;
        store.finish("r1", {
            status: "success",
            httpStatus: 200,
            providerCode: "ok",
            requestBytes: 120,
            responseBytes: 340,
        });
        const done = store.get("r1");
        expect(done).toMatchObject({
            status: "success",
            completedAt: 2_000,
            httpStatus: 200,
            providerCode: "ok",
            hasError: false,
            error: null,
            requestBytes: 120,
            responseBytes: 340,
            exchangeCount: 1,
            storedExchanges: 1,
            truncated: false,
        });
        expect(done?.exchanges).toEqual([
            {
                url: "https://api.example/v1",
                header: '{"a":"b"}',
                body: '{"q":1}',
                response: "ok",
                success: true,
                status: 200,
                date: "2026-10-13T00:00:00.000Z",
                responseType: "stream",
            },
        ]);
        // The first finish wins, and a finished row takes no model, first byte, or second outcome.
        store.finish("r1", { status: "error", error: "late", httpStatus: 500 });
        store.describe("r1", { modelId: "other" });
        store.firstByte("r1", 900);
        expect(store.get("r1")).toMatchObject({
            status: "success",
            httpStatus: 200,
            error: null,
            hasError: false,
            modelId: "gpt-5",
            firstByteAt: 700,
        });
        // A late exchange after the finish is still kept.
        store.exchange("r1", entry({ body: "late" }));
        expect(store.get("r1")).toMatchObject({ exchangeCount: 2, storedExchanges: 2 });
        expect(store.get("r1")?.exchanges?.[1].body).toBe("late");
        // The summary carries no content and no error text.
        const [summary] = store.list().items;
        expect(summary).not.toHaveProperty("prompt");
        expect(summary).not.toHaveProperty("error");
        expect(summary).not.toHaveProperty("exchanges");
        expect(warn).not.toHaveBeenCalled();
    });

    it("ignores a duplicate begin, an empty id, and an id over 256 bytes; a finish with an unknown status", () => {
        const store = open();
        store.begin(row("r1", { source: "send" }));
        store.begin(row("r1", { source: "memory", jobId: "late" }));
        expect(store.get("r1")).toMatchObject({ source: "send", jobId: null });
        expect(store.stats().rows).toBe(1);
        store.begin(row(""));
        store.begin(row("x".repeat(REQUEST_HISTORY_BOUNDS.id + 1)));
        store.begin(row("한".repeat(86))); // 258 bytes
        expect(store.stats().rows).toBe(1);
        const longest = "x".repeat(REQUEST_HISTORY_BOUNDS.id);
        store.begin(row(longest));
        expect(store.get(longest)?.id).toBe(longest);
        store.finish("r1", { status: "pending" as never });
        store.finish("r1", { status: "interrupted" as never });
        expect(store.get("r1")?.status).toBe("pending");
        expect(warn).not.toHaveBeenCalled();
    });

    it("keeps a summary row with content off: no prompt, no exchanges, an exchange not counted, the error kept", () => {
        const store = open();
        const summary = row("off", { content: false, prompt: { big: "x".repeat(1000) } });
        store.begin(summary);
        const bytes = beginBytes(summary);
        expect(store.stats()).toEqual({ rows: 1, bytes });
        store.exchange("off", entry({ body: "x".repeat(500) }));
        store.exchange("off", entry());
        store.finish("off", { status: "error", httpStatus: 401, providerCode: "invalid_api_key", error: "bad key" });
        expect(store.get("off")).toMatchObject({
            content: false,
            prompt: null,
            exchanges: null,
            exchangeCount: 0,
            storedExchanges: 0,
            truncated: false,
            truncation: {},
            status: "error",
            httpStatus: 401,
            providerCode: "invalid_api_key",
            error: "bad key",
            hasError: true,
            bytes: bytes + utf8("invalid_api_key") + utf8("bad key"),
        });
        expect(store.stats()).toEqual({ rows: 1, bytes: bytes + utf8("invalid_api_key") + utf8("bad key") });
    });

    it("stores no prompt for an absent, null-content, or unserializable one, and `[]` exchanges with none", () => {
        const store = open();
        store.begin(row("none"));
        store.begin(row("bigint", { prompt: { n: 1n } }));
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        store.begin(row("cyclic", { prompt: cyclic }));
        store.begin(row("undef", { prompt: undefined }));
        for (const id of ["none", "bigint", "cyclic", "undef"]) {
            expect(store.get(id)).toMatchObject({ prompt: null, exchanges: [], truncation: {}, truncated: false });
            expect(store.get(id)?.bytes).toBe(beginBytes(row(id), { prompt: null }));
        }
        expect(warn).not.toHaveBeenCalled();
    });

    it("normalizes a log entry's missing or odd fields and stores an invalid number as null", () => {
        let now = 5_000;
        const store = open({ now: () => now });
        store.begin(row("n", { startedAt: 2 ** 53 }));
        expect(store.get("n")?.startedAt).toBe(5_000);
        store.firstByte("n", Number.POSITIVE_INFINITY);
        expect(store.get("n")?.firstByteAt).toBe(5_000);
        store.exchange("n", {
            url: "u",
            header: "h",
            body: undefined as unknown as string,
            response: 12 as unknown as string,
            success: "yes" as unknown as boolean,
            date: undefined as unknown as string,
            status: 2 ** 53,
            responseType: undefined,
        });
        store.exchange("n", entry({ status: 200.7, success: false }));
        expect(store.get("n")?.exchanges).toEqual([
            {
                url: "u",
                header: "h",
                body: "",
                response: "12",
                success: true,
                status: null,
                date: "",
                responseType: null,
            },
            expect.objectContaining({ status: 200, success: false }),
        ]);
        now = 6_000;
        store.finish("n", {
            status: "success",
            completedAt: Number.NaN,
            httpStatus: 2 ** 53,
            requestBytes: -1,
            responseBytes: 1.9,
        });
        expect(store.get("n")).toMatchObject({
            completedAt: 6_000,
            httpStatus: null,
            requestBytes: null,
            responseBytes: 1,
        });
        // The page stays readable (a stored unsafe integer would fail the whole read).
        expect(ids(store)).toEqual(["n"]);
        const bytes =
            beginBytes(row("n")) +
            exchangeBytes({ url: "u", header: "h", body: "", response: "12", date: "" }) +
            exchangeBytes(entry());
        expect(store.stats()).toEqual({ rows: 1, bytes });
        expect(warn).not.toHaveBeenCalled();
    });
});

describe("the bounds", () => {
    it("cuts the prompt at a UTF-8 boundary and records the cut", () => {
        const store = open();
        // The JSON is a quote, 700,000 three-byte characters, and a quote: 2,100,002 bytes. The cut
        // at 2 MiB lands on the second byte of a character, so it backs up one byte.
        const text = "한".repeat(700_000);
        const summary = row("p", { prompt: text });
        store.begin(summary);
        const record = store.get("p")!;
        const expectedPrompt = '"' + "한".repeat(699_050);
        expect(utf8(expectedPrompt)).toBe(REQUEST_HISTORY_BOUNDS.prompt - 1);
        expect(record.prompt).toBe(expectedPrompt);
        expect(record.prompt).not.toContain("�");
        expect(record.truncation).toEqual({
            prompt: { originalBytes: 2_100_002, storedBytes: REQUEST_HISTORY_BOUNDS.prompt - 1 },
        });
        expect(record.truncated).toBe(true);
        expect(record.bytes).toBe(
            beginBytes(summary, { prompt: expectedPrompt, truncation: JSON.stringify(record.truncation) }),
        );
        expect(store.stats()).toEqual({ rows: 1, bytes: record.bytes });
        // Exactly the bound is kept whole.
        const exact = "x".repeat(REQUEST_HISTORY_BOUNDS.prompt - 2);
        store.begin(row("exact", { prompt: exact }));
        expect(store.get("exact")?.truncation).toEqual({});
        expect(store.get("exact")?.prompt).toBe(JSON.stringify(exact));
    });

    it("cuts a display field at 1 KiB on a character boundary and keeps an id whole or not at all", () => {
        const store = open();
        const modelId = "한".repeat(400); // 1,200 bytes
        const chatId = "한".repeat(512); // a resource id's longest form: 1,536 bytes
        const chaId = "x".repeat(REQUEST_HISTORY_BOUNDS.identity + 1);
        const jobId = "x".repeat(REQUEST_HISTORY_BOUNDS.identity);
        const summary = row("ids", { modelId, chatId, chaId, jobId, messageId: "한".repeat(683) });
        store.begin(summary);
        const record = store.get("ids")!;
        expect(record.modelId).toBe("한".repeat(341));
        expect(utf8(record.modelId)).toBe(1023);
        expect(record.chatId).toBe(chatId);
        expect(record.jobId).toBe(jobId);
        expect(record.chaId).toBeNull();
        // 683 × 3 = 2,049 bytes: not stored.
        expect(record.messageId).toBeNull();
        expect(record.truncation).toEqual({
            modelId: { originalBytes: 1200, storedBytes: 1023 },
            chaId: { originalBytes: REQUEST_HISTORY_BOUNDS.identity + 1, storedBytes: 0 },
            messageId: { originalBytes: 2049, storedBytes: 0 },
        });
        expect(record.truncated).toBe(true);
        expect(record.bytes).toBe(
            beginBytes(summary, {
                truncation: JSON.stringify(record.truncation),
                fields: { modelId: record.modelId, chaId: null, messageId: null },
            }),
        );
        // The whole id filters.
        expect(ids(store, { chatId })).toEqual(["ids"]);
        expect(ids(store, { jobId })).toEqual(["ids"]);
        expect(ids(store, { chatId: "한".repeat(511) })).toEqual([]);
    });

    it("cuts every exchange field, `date` and `responseType` included, and records each cut", () => {
        const store = open();
        store.begin(row("x"));
        const base = beginBytes(row("x"));
        const big = entry({
            url: "u".repeat(REQUEST_HISTORY_BOUNDS.url + 1),
            header: "h".repeat(REQUEST_HISTORY_BOUNDS.header + 7),
            body: "b".repeat(REQUEST_HISTORY_BOUNDS.body + 1),
            response: "é".repeat(REQUEST_HISTORY_BOUNDS.response / 2 + 1), // 4 MiB + 2 bytes
            date: "d".repeat(REQUEST_HISTORY_BOUNDS.short + 1),
            responseType: "t".repeat(REQUEST_HISTORY_BOUNDS.short + 1),
        });
        store.exchange("x", big);
        const record = store.get("x")!;
        const [stored] = record.exchanges!;
        expect(utf8(stored.url)).toBe(REQUEST_HISTORY_BOUNDS.url);
        expect(utf8(stored.header)).toBe(REQUEST_HISTORY_BOUNDS.header);
        expect(utf8(stored.body)).toBe(REQUEST_HISTORY_BOUNDS.body);
        expect(utf8(stored.response)).toBe(REQUEST_HISTORY_BOUNDS.response);
        expect(stored.response).toBe("é".repeat(REQUEST_HISTORY_BOUNDS.response / 2));
        expect(utf8(stored.date)).toBe(REQUEST_HISTORY_BOUNDS.short);
        expect(utf8(stored.responseType)).toBe(REQUEST_HISTORY_BOUNDS.short);
        expect(record.truncation).toEqual({
            "exchange.0.url": {
                originalBytes: REQUEST_HISTORY_BOUNDS.url + 1,
                storedBytes: REQUEST_HISTORY_BOUNDS.url,
            },
            "exchange.0.header": {
                originalBytes: REQUEST_HISTORY_BOUNDS.header + 7,
                storedBytes: REQUEST_HISTORY_BOUNDS.header,
            },
            "exchange.0.body": {
                originalBytes: REQUEST_HISTORY_BOUNDS.body + 1,
                storedBytes: REQUEST_HISTORY_BOUNDS.body,
            },
            "exchange.0.response": {
                originalBytes: REQUEST_HISTORY_BOUNDS.response + 2,
                storedBytes: REQUEST_HISTORY_BOUNDS.response,
            },
            "exchange.0.date": {
                originalBytes: REQUEST_HISTORY_BOUNDS.short + 1,
                storedBytes: REQUEST_HISTORY_BOUNDS.short,
            },
            "exchange.0.responseType": {
                originalBytes: REQUEST_HISTORY_BOUNDS.short + 1,
                storedBytes: REQUEST_HISTORY_BOUNDS.short,
            },
        });
        expect(record.truncated).toBe(true);
        expect(record.bytes).toBe(base + exchangeBytes(stored) + utf8(JSON.stringify(record.truncation)));
        expect(store.stats().bytes).toBe(record.bytes);
    });

    it("cuts the error at 64 KiB and the provider code at 1 KiB, recording both", () => {
        const store = open();
        store.begin(row("e"));
        const base = beginBytes(row("e"));
        store.finish("e", {
            status: "error",
            error: "e".repeat(REQUEST_HISTORY_BOUNDS.error + 3),
            providerCode: "c".repeat(REQUEST_HISTORY_BOUNDS.short + 1),
        });
        const record = store.get("e")!;
        expect(utf8(record.error)).toBe(REQUEST_HISTORY_BOUNDS.error);
        expect(utf8(record.providerCode)).toBe(REQUEST_HISTORY_BOUNDS.short);
        expect(record.truncation).toEqual({
            error: { originalBytes: REQUEST_HISTORY_BOUNDS.error + 3, storedBytes: REQUEST_HISTORY_BOUNDS.error },
            providerCode: {
                originalBytes: REQUEST_HISTORY_BOUNDS.short + 1,
                storedBytes: REQUEST_HISTORY_BOUNDS.short,
            },
        });
        expect(record.hasError).toBe(true);
        expect(record.bytes).toBe(
            base +
                REQUEST_HISTORY_BOUNDS.error +
                REQUEST_HISTORY_BOUNDS.short +
                utf8(JSON.stringify(record.truncation)),
        );
        expect(store.stats().bytes).toBe(record.bytes);
    });

    it("merges the caller's `cuts` as the larger original and ignores one smaller than the text", () => {
        const store = open();
        store.begin(row("c"));
        store.exchange("c", entry({ response: "abc", body: "abcd" }), { response: 5000, body: 1 });
        store.exchange("c", entry({ response: "x".repeat(REQUEST_HISTORY_BOUNDS.response + 10) }), {
            response: 10_000_000,
            url: Number.NaN,
        });
        store.exchange("c", entry({ header: "hh" }), { header: 2.9 });
        const record = store.get("c")!;
        expect(record.truncation).toEqual({
            "exchange.0.response": { originalBytes: 5000, storedBytes: 3 },
            "exchange.1.response": { originalBytes: 10_000_000, storedBytes: REQUEST_HISTORY_BOUNDS.response },
        });
        expect(record.exchanges?.map((e) => utf8(e.response))).toEqual([3, REQUEST_HISTORY_BOUNDS.response, 2]);
        expect(store.list().items[0].truncated).toBe(true);
    });

    it("keeps the first 32 exchanges in order and only counts the later ones", () => {
        let limit = 20;
        const store = open({ limit: () => limit });
        for (let i = 1; i <= 12; i++) {
            store.begin(row(`r${String(i).padStart(2, "0")}`));
        }
        const base = beginBytes(row("r12"));
        let bytes = base;
        for (let i = 0; i < 32; i++) {
            const e = entry({ body: `body ${i}` });
            store.exchange("r12", e);
            bytes += exchangeBytes(e);
        }
        expect(store.get("r12")).toMatchObject({ exchangeCount: 32, storedExchanges: 32, truncated: false, bytes });
        // The 33rd is counted, not stored, not accounted; the write still prunes with the live limit.
        limit = 10;
        store.exchange("r12", entry({ body: "x".repeat(10_000) }), { body: 20_000 });
        const record = store.get("r12")!;
        expect(record).toMatchObject({
            exchangeCount: 33,
            storedExchanges: 32,
            truncated: true,
            truncation: {},
            bytes,
        });
        expect(record.exchanges?.map((e) => e.body)).toEqual(Array.from({ length: 32 }, (_, i) => `body ${i}`));
        expect(ids(store).length).toBe(10);
        expect(store.get("r01")).toBeNull();
        expect(store.get("r02")).toBeNull();
        expect(store.list().items[0].truncated).toBe(true);
    });
});

describe("the accounting", () => {
    it("sums the overheads and every stored text, through describe, exchange, finish, and a reopen", () => {
        const file = tempFile();
        const store = open({ file });
        const summary = row("a", {
            jobId: "job",
            chaId: "cha",
            chatId: "chat",
            messageId: "msg",
            modelId: "m",
            profileId: "p",
            profileName: "Prof",
            provider: "Anthropic",
            prompt: { messages: [{ role: "system", content: "héllo" }] },
        });
        store.begin(summary);
        let bytes = beginBytes(summary);
        expect(store.stats()).toEqual({ rows: 1, bytes });
        // A longer name replaces the shorter one.
        store.describe("a", { profileName: "Longer name", provider: null });
        bytes += utf8("Longer name") - utf8("Prof") - utf8("Anthropic");
        expect(store.get("a")?.bytes).toBe(bytes);
        expect(store.stats()).toEqual({ rows: 1, bytes });
        const first = entry({ responseType: "json", body: "{}" });
        const second = entry({ response: "é".repeat(10) });
        store.exchange("a", first);
        store.exchange("a", second);
        bytes += exchangeBytes(first) + exchangeBytes(second);
        expect(store.stats()).toEqual({ rows: 1, bytes });
        store.finish("a", { status: "error", providerCode: "rate_limited", error: "too many: é" });
        bytes += utf8("rate_limited") + utf8("too many: é");
        expect(store.get("a")?.bytes).toBe(bytes);
        expect(store.stats()).toEqual({ rows: 1, bytes });
        store.close();
        const reopened = open({ file });
        expect(reopened.stats()).toEqual({ rows: 1, bytes });
        expect(reopened.get("a")?.bytes).toBe(bytes);
        expect(reopened.get("a")?.exchanges?.length).toBe(2);
    });

    it("drops a field's truncation record when the field is cleared, and keeps an omitted field", () => {
        const store = open();
        store.begin(row("d", { modelId: "m" }));
        const base = beginBytes(row("d", { modelId: "m" }));
        const long = "n".repeat(REQUEST_HISTORY_BOUNDS.short + 100);
        store.describe("d", { profileName: long });
        let record = store.get("d")!;
        expect(record.profileName).toBe("n".repeat(REQUEST_HISTORY_BOUNDS.short));
        expect(record.truncation).toEqual({
            profileName: {
                originalBytes: REQUEST_HISTORY_BOUNDS.short + 100,
                storedBytes: REQUEST_HISTORY_BOUNDS.short,
            },
        });
        expect(record.bytes).toBe(base + REQUEST_HISTORY_BOUNDS.short + utf8(JSON.stringify(record.truncation)));
        expect(record.modelId).toBe("m");
        store.describe("d", { profileName: null });
        record = store.get("d")!;
        expect(record).toMatchObject({
            profileName: null,
            modelId: "m",
            truncation: {},
            truncated: false,
            bytes: base,
        });
        // A too-long id given later is not stored, and its record goes when it is replaced.
        store.describe("d", { profileId: "x".repeat(REQUEST_HISTORY_BOUNDS.identity + 1) });
        expect(store.get("d")).toMatchObject({
            profileId: null,
            truncation: { profileId: { originalBytes: REQUEST_HISTORY_BOUNDS.identity + 1, storedBytes: 0 } },
        });
        store.describe("d", { profileId: "short" });
        expect(store.get("d")).toMatchObject({ profileId: "short", truncation: {}, bytes: base + utf8("short") });
        store.describe("d", {});
        expect(store.get("d")?.bytes).toBe(base + utf8("short"));
        expect(store.stats()).toEqual({ rows: 1, bytes: base + utf8("short") });
    });
});

describe("the caps", () => {
    it("removes the oldest rows by begin order under the count cap, a pending one included", () => {
        const store = open({ limit: () => REQUEST_HISTORY_MIN_LIMIT });
        for (let i = 1; i <= 12; i++) {
            const id = `r${String(i).padStart(2, "0")}`;
            store.begin(row(id));
            if (i > 1) {
                store.finish(id, { status: "success" });
            }
        }
        // r01 is still pending; it and r02 went anyway.
        expect(ids(store)).toEqual(["r12", "r11", "r10", "r09", "r08", "r07", "r06", "r05", "r04", "r03"]);
        expect(store.stats()).toEqual({ rows: 10, bytes: 10 * beginBytes(row("r03")) });
        // A later write to a removed row is skipped.
        const before = store.stats();
        store.finish("r01", { status: "success", error: "late" });
        store.exchange("r01", entry());
        store.describe("r01", { modelId: "m" });
        store.firstByte("r01", 1);
        store.exchange("r02", entry());
        expect(store.get("r01")).toBeNull();
        expect(store.get("r02")).toBeNull();
        expect(store.stats()).toEqual(before);
        expect(warn).not.toHaveBeenCalled();
    });

    it("removes the oldest rows under the byte cap, an exchange or an oversized row pushing them out", () => {
        const store = open({ maxBytes: 1000, limit: () => 100 });
        const small = row("b1", { source: "", mode: "", content: false });
        const each = beginBytes(small); // 258
        expect(each).toBe(258);
        for (const id of ["b1", "b2", "b3", "b4"]) {
            store.begin({ ...small, id });
        }
        // Four rows (1,032) pass the cap: the oldest goes.
        expect(ids(store)).toEqual(["b4", "b3", "b2"]);
        expect(store.stats()).toEqual({ rows: 3, bytes: 3 * each });
        // An exchange of 564 bytes on b4 pushes b2 and b3 out (1,338 → 1,080 → 822).
        store.begin(row("b5", { source: "", mode: "" }));
        const e = entry({ url: "", header: "", body: "x".repeat(500), response: "", date: "" });
        expect(exchangeBytes(e)).toBe(564);
        store.exchange("b5", e);
        expect(ids(store)).toEqual(["b5"]);
        expect(store.stats()).toEqual({ rows: 1, bytes: each + 564 });
        // A row over the cap on its own evicts everything, itself included, and the store goes on.
        store.begin(row("huge", { prompt: "x".repeat(2000) }));
        expect(store.stats()).toEqual({ rows: 0, bytes: 0 });
        expect(store.get("huge")).toBeNull();
        expect(ids(store)).toEqual([]);
        store.begin({ ...small, id: "after" });
        expect(store.stats()).toEqual({ rows: 1, bytes: beginBytes({ ...small, id: "after" }) });
        expect(warn).not.toHaveBeenCalled();
    });

    it("reads the limit at every write, prunes explicitly, and does not prune at open", () => {
        const file = tempFile();
        let limit = 20;
        const store = open({ file, limit: () => limit });
        for (let i = 1; i <= 15; i++) {
            store.begin(row(`r${String(i).padStart(2, "0")}`));
        }
        expect(store.stats().rows).toBe(15);
        limit = 12;
        // A write that changes no byte prunes too.
        expect(store.setShared(["r15"], 1)).toBe(1);
        expect(store.stats().rows).toBe(12);
        expect(ids(store).at(-1)).toBe("r04");
        store.firstByte("r15", 5);
        limit = 11;
        store.firstByte("r14", 5);
        expect(store.stats().rows).toBe(11);
        store.prune(10);
        expect(store.stats().rows).toBe(10);
        // Below the floor is the floor; a non-number is the default.
        store.prune(1);
        expect(store.stats().rows).toBe(10);
        store.prune();
        expect(store.stats().rows).toBe(10);
        store.close();
        limit = 5;
        const reopened = open({ file, limit: () => limit });
        expect(reopened.stats().rows).toBe(10);
        reopened.begin(row("r16"));
        expect(reopened.stats().rows).toBe(10);
        expect(ids(reopened)).toEqual(["r16", "r15", "r14", "r13", "r12", "r11", "r10", "r09", "r08", "r07"]);
        expect(warn).not.toHaveBeenCalled();
    });

    it("clamps the count cap and falls back from an invalid byte cap", () => {
        expect(clampRequestHistoryLimit(undefined)).toBe(REQUEST_HISTORY_DEFAULT_LIMIT);
        expect(clampRequestHistoryLimit("50")).toBe(REQUEST_HISTORY_DEFAULT_LIMIT);
        expect(clampRequestHistoryLimit(Number.NaN)).toBe(REQUEST_HISTORY_DEFAULT_LIMIT);
        expect(clampRequestHistoryLimit(Number.POSITIVE_INFINITY)).toBe(REQUEST_HISTORY_DEFAULT_LIMIT);
        expect(clampRequestHistoryLimit(1)).toBe(REQUEST_HISTORY_MIN_LIMIT);
        expect(clampRequestHistoryLimit(10.4)).toBe(10);
        expect(clampRequestHistoryLimit(99.6)).toBe(100);
        expect(clampRequestHistoryLimit(1e9)).toBe(REQUEST_HISTORY_MAX_LIMIT);
        expect(REQUEST_HISTORY_MAX_BYTES).toBe(512 * MIB);
        // `maxBytes: NaN` is the default: a 100 KiB row stays.
        const store = open({ maxBytes: Number.NaN });
        store.begin(row("big", { prompt: "x".repeat(100 * KIB) }));
        expect(store.stats().rows).toBe(1);
        const zero = open({ maxBytes: 0 });
        zero.begin(row("big", { prompt: "x".repeat(100 * KIB) }));
        expect(zero.stats().rows).toBe(1);
        const fraction = open({ maxBytes: 1000.5 });
        fraction.begin(row("big", { prompt: "x".repeat(100 * KIB) }));
        expect(fraction.stats().rows).toBe(1);
        // A valid one applies.
        const small = open({ maxBytes: 1000 });
        small.begin(row("big", { prompt: "x".repeat(100 * KIB) }));
        expect(small.stats().rows).toBe(0);
    });
});

describe("the lifecycle", () => {
    it("sweeps pending rows to interrupted at reopen and keeps the totals", () => {
        const file = tempFile();
        const store = open({ file, now: () => 100 });
        store.begin(row("pending", { prompt: "p" }));
        store.exchange("pending", entry());
        store.firstByte("pending", 150);
        store.begin(row("done"));
        store.finish("done", { status: "success", httpStatus: 200 });
        const stats = store.stats();
        store.close();
        const reopened = open({ file, now: () => 999 });
        expect(reopened.stats()).toEqual(stats);
        expect(reopened.get("pending")).toMatchObject({
            status: "interrupted",
            completedAt: null,
            firstByteAt: 150,
            exchangeCount: 1,
            prompt: '"p"',
        });
        expect(reopened.get("done")).toMatchObject({ status: "success", httpStatus: 200 });
        expect(ids(reopened, { status: "interrupted" })).toEqual(["pending"]);
        // An interrupted row takes no outcome, model, or first byte, but a late exchange is kept.
        reopened.finish("pending", { status: "success" });
        reopened.describe("pending", { modelId: "m" });
        reopened.firstByte("pending", 1);
        expect(reopened.get("pending")).toMatchObject({ status: "interrupted", modelId: null, firstByteAt: 150 });
        reopened.exchange("pending", entry({ body: "late" }));
        expect(reopened.get("pending")?.exchangeCount).toBe(2);
        reopened.close();
        // A third open keeps it interrupted (nothing pending now).
        const third = open({ file });
        expect(third.get("pending")?.status).toBe("interrupted");
        expect(third.stats()).toEqual({ rows: 2, bytes: stats.bytes + exchangeBytes(entry({ body: "late" })) });
        expect(warn).not.toHaveBeenCalled();
    });

    it("leaves a newer version's file byte-identical and runs inert, with one warning", () => {
        const dir = tempDir();
        const file = path.join(dir, "request-history.sqlite");
        // A hand-built file in the default rollback-journal mode, as a newer server might leave one.
        const db = new DatabaseSync(file);
        db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
        db.exec("INSERT INTO meta (key, value) VALUES ('version', '2')");
        db.exec("CREATE TABLE requests (seq INTEGER PRIMARY KEY, id TEXT, status TEXT, future TEXT)");
        db.exec("INSERT INTO requests (id, status, future) VALUES ('r1', 'pending', 'x')");
        db.close();
        const hash = sha256(file);
        const store = open({ file });
        store.begin(row("r2"));
        store.exchange("r2", entry());
        store.finish("r2", { status: "success" });
        expect(store.stats()).toEqual({ rows: 0, bytes: 0 });
        expect(store.list()).toEqual({ items: [], next: null });
        expect(store.get("r1")).toBeNull();
        expect(store.deleteAll()).toBe(0);
        expect(store.setShared(["r1"], 1)).toBe(0);
        store.prune(10);
        store.close();
        expect(sha256(file)).toBe(hash);
        expect(existsSync(`${file}-wal`)).toBe(false);
        expect(existsSync(`${file}-journal`)).toBe(false);
        const check = new DatabaseSync(file);
        expect(check.prepare("SELECT value FROM meta WHERE key = 'version'").get()).toEqual({ value: "2" });
        expect(check.prepare("SELECT id, status, future FROM requests").all()).toEqual([
            { id: "r1", status: "pending", future: "x" },
        ]);
        expect(check.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
        check.close();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][1])).toContain("Unsupported request history version 2");
    });

    it("reopens its own file, keeping the version and WAL mode, with no warning", () => {
        const file = tempFile();
        const store = open({ file });
        store.begin(row("r1"));
        store.close();
        const again = open({ file });
        again.begin(row("r2"));
        expect(ids(again)).toEqual(["r2", "r1"]);
        again.close();
        const check = new DatabaseSync(file);
        expect(check.prepare("SELECT value FROM meta WHERE key = 'version'").get()).toEqual({ value: "1" });
        expect(check.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
        check.close();
        expect(warn).not.toHaveBeenCalled();
    });

    it("is inert when the file cannot be opened, and after close (idempotent)", () => {
        const dir = tempDir();
        const blocker = path.join(dir, "blocker");
        writeFileSync(blocker, "not a directory");
        const inert = open({ file: path.join(blocker, "nested", "request-history.sqlite") });
        inert.begin(row("r1"));
        inert.describe("r1", { modelId: "m" });
        inert.firstByte("r1", 1);
        inert.exchange("r1", entry());
        inert.finish("r1", { status: "success" });
        expect(inert.stats()).toEqual({ rows: 0, bytes: 0 });
        expect(inert.list()).toEqual({ items: [], next: null });
        expect(inert.get("r1")).toBeNull();
        expect(inert.deleteAll()).toBe(0);
        expect(inert.setShared(["r1"], 1)).toBe(0);
        inert.prune();
        inert.close();
        inert.close();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockClear();
        const store = open();
        store.begin(row("r1"));
        store.close();
        store.close();
        store.begin(row("r2"));
        expect(store.stats()).toEqual({ rows: 0, bytes: 0 });
        expect(store.get("r1")).toBeNull();
        expect(store.list()).toEqual({ items: [], next: null });
        expect(warn).not.toHaveBeenCalled();
    });

    it("skips a write while another connection holds the write lock, warns once, and resumes after", () => {
        const file = tempFile();
        const store = open({ file });
        store.begin(row("r1"));
        const before = store.stats();
        const other = new DatabaseSync(file);
        try {
            other.exec("BEGIN IMMEDIATE");
            store.begin(row("r2"));
            store.firstByte("r1", 5);
            store.exchange("r1", entry());
            store.finish("r1", { status: "success" });
            expect(store.setShared(["r1"], 1)).toBe(0);
            expect(store.deleteAll()).toBe(0);
            store.prune(10);
            // The reads go on (WAL), and nothing changed.
            expect(ids(store)).toEqual(["r1"]);
            expect(store.get("r1")).toMatchObject({ status: "pending", firstByteAt: null, exchangeCount: 0 });
            expect(store.stats()).toEqual(before);
            expect(warn).toHaveBeenCalledTimes(1);
            other.exec("ROLLBACK");
        } finally {
            other.close();
        }
        store.begin(row("r2"));
        store.exchange("r1", entry());
        store.finish("r1", { status: "success" });
        expect(ids(store)).toEqual(["r2", "r1"]);
        expect(store.get("r1")).toMatchObject({ status: "success", exchangeCount: 1 });
        expect(store.stats()).toEqual({ rows: 2, bytes: 2 * beginBytes(row("r1")) + exchangeBytes(entry()) });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("never lets an injected callback's throw escape, whatever it throws", () => {
        const bare = Object.create(null) as never;
        const poisoned = new Error("x");
        Object.defineProperty(poisoned, "message", {
            get() {
                throw new Error("no message");
            },
        });
        let limitThrows: unknown = bare;
        const store = open({
            limit: () => {
                throw limitThrows;
            },
        });
        // The row is written; only the prune after it fails.
        expect(() => store.begin(row("r1"))).not.toThrow();
        expect(store.get("r1")?.status).toBe("pending");
        limitThrows = poisoned;
        expect(() => store.finish("r1", { status: "success" })).not.toThrow();
        expect(store.get("r1")?.status).toBe("success");
        expect(() => store.prune()).not.toThrow();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockClear();
        const clock = open({
            now: () => {
                throw bare;
            },
        });
        // A begin that needs the clock is skipped; one with its own time is written.
        expect(() => clock.begin(row("a"))).not.toThrow();
        expect(clock.get("a")).toBeNull();
        expect(() => clock.begin(row("b", { startedAt: 7 }))).not.toThrow();
        expect(clock.get("b")?.startedAt).toBe(7);
        expect(() => clock.firstByte("b")).not.toThrow();
        expect(() => clock.finish("b", { status: "success" })).not.toThrow();
        expect(clock.get("b")?.status).toBe("pending");
        expect(() => clock.finish("b", { status: "success", completedAt: 9 })).not.toThrow();
        expect(clock.get("b")).toMatchObject({ status: "success", completedAt: 9 });
        expect(clock.stats()).toEqual({ rows: 1, bytes: beginBytes(row("b")) });
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe("the reads and the bulk writes", () => {
    it("pages newest first with an exclusive cursor, clamps the page size, and ignores a bad cursor", () => {
        const store = open();
        for (let i = 1; i <= 7; i++) {
            store.begin(row(`r${i}`));
        }
        const first = store.list({ limit: 3 });
        expect(first.items.map((item) => item.id)).toEqual(["r7", "r6", "r5"]);
        expect(first.next).toMatch(/^[1-9][0-9]*$/);
        const second = store.list({ limit: 3, cursor: first.next });
        expect(second.items.map((item) => item.id)).toEqual(["r4", "r3", "r2"]);
        const third = store.list({ limit: 3, cursor: second.next });
        expect(third).toMatchObject({ next: null });
        expect(third.items.map((item) => item.id)).toEqual(["r1"]);
        // Exactly a page is the last page.
        expect(store.list({ limit: 7 })).toMatchObject({ next: null });
        expect(store.list({ limit: 7 }).items.length).toBe(7);
        for (const cursor of ["abc", "0", "-1", "1e3", "01", "", " 3", "99999999999999999999"]) {
            expect(ids(store, { cursor, limit: 2 })).toEqual(["r7", "r6"]);
        }
        expect(ids(store, { cursor: null, limit: 1 })).toEqual(["r7"]);
        expect(ids(store, { limit: 0 })).toEqual(["r7"]);
        expect(ids(store, { limit: -5 })).toEqual(["r7"]);
        expect(ids(store, { limit: Number.NaN }).length).toBe(7);
        // A cursor from before `deleteAll` is past every row begun after it.
        store.deleteAll();
        store.begin(row("r8"));
        expect(store.list({ cursor: first.next })).toEqual({ items: [], next: null });
        expect(ids(store)).toEqual(["r8"]);
    });

    it("caps a page at 200 and defaults to 50", () => {
        const store = open();
        for (let i = 1; i <= 201; i++) {
            store.begin(row(`r${i}`));
        }
        expect(store.list().items.length).toBe(50);
        expect(store.list({ limit: 1000 }).items.length).toBe(200);
        expect(store.list({ limit: 1000 }).next).not.toBeNull();
        expect(store.list({ limit: 201 }).items.length).toBe(200);
    });

    it("filters by character, chat, job, and status, combined", () => {
        const store = open();
        store.begin(row("a1", { chaId: "A", chatId: "A-1", jobId: "j1" }));
        store.begin(row("a2", { chaId: "A", chatId: "A-1", jobId: "j1" }));
        store.begin(row("a3", { chaId: "A", chatId: "A-2", jobId: "j2" }));
        store.begin(row("b1", { chaId: "B", chatId: "B-1", jobId: "j3" }));
        store.begin(row("t1", { source: "tab" }));
        store.finish("a1", { status: "success" });
        store.finish("a3", { status: "error", error: "e" });
        store.finish("b1", { status: "aborted" });
        expect(ids(store)).toEqual(["t1", "b1", "a3", "a2", "a1"]);
        expect(ids(store, { chaId: "A" })).toEqual(["a3", "a2", "a1"]);
        expect(ids(store, { chatId: "A-1" })).toEqual(["a2", "a1"]);
        expect(ids(store, { jobId: "j1" })).toEqual(["a2", "a1"]);
        expect(ids(store, { status: "pending" })).toEqual(["t1", "a2"]);
        expect(ids(store, { status: "error" })).toEqual(["a3"]);
        expect(ids(store, { status: "aborted" })).toEqual(["b1"]);
        expect(ids(store, { chaId: "A", status: "success" })).toEqual(["a1"]);
        expect(ids(store, { chaId: "A", chatId: "A-1", jobId: "j1", status: "pending" })).toEqual(["a2"]);
        expect(ids(store, { chaId: "A", chatId: "B-1" })).toEqual([]);
        expect(ids(store, { chaId: "none" })).toEqual([]);
        expect(ids(store, { chaId: null, chatId: null, jobId: null, status: null }).length).toBe(5);
        // The filtered pages cursor within the filter.
        const page = store.list({ chaId: "A", limit: 2 });
        expect(page.items.map((item) => item.id)).toEqual(["a3", "a2"]);
        expect(ids(store, { chaId: "A", limit: 2, cursor: page.next })).toEqual(["a1"]);
        expect(store.list().items.find((item) => item.id === "a3")).toMatchObject({ hasError: true, status: "error" });
    });

    it("deletes every row with its exchanges, pending ones included, and keeps the sequence", () => {
        const file = tempFile();
        const store = open({ file });
        store.begin(row("r1"));
        store.exchange("r1", entry());
        store.exchange("r1", entry());
        store.begin(row("r2"));
        store.finish("r2", { status: "success" });
        store.begin(row("r3"));
        expect(store.deleteAll()).toBe(3);
        expect(store.stats()).toEqual({ rows: 0, bytes: 0 });
        expect(store.list()).toEqual({ items: [], next: null });
        expect(store.deleteAll()).toBe(0);
        // The exchanges went with their rows (WAL lets a second connection read meanwhile).
        const check = new DatabaseSync(file);
        expect(check.prepare("SELECT COUNT(*) AS n FROM exchanges").get()).toEqual({ n: 0 });
        check.close();
        // A later write to a deleted row is skipped; a new row goes on.
        store.exchange("r1", entry());
        store.finish("r3", { status: "success" });
        expect(store.stats()).toEqual({ rows: 0, bytes: 0 });
        store.begin(row("r1"));
        expect(store.get("r1")).toMatchObject({ status: "pending", exchangeCount: 0, exchanges: [] });
        expect(warn).not.toHaveBeenCalled();
    });

    it("prunes the exchanges with their rows", () => {
        const file = tempFile();
        const store = open({ file, limit: () => REQUEST_HISTORY_MIN_LIMIT });
        store.begin(row("first"));
        store.exchange("first", entry());
        for (let i = 2; i <= 11; i++) {
            store.begin(row(`r${i}`));
        }
        expect(store.get("first")).toBeNull();
        const check = new DatabaseSync(file);
        expect(check.prepare("SELECT COUNT(*) AS n FROM exchanges").get()).toEqual({ n: 0 });
        check.close();
    });

    it("sets and clears sharedAt on a deduplicated id list, counting the rows found", () => {
        const store = open();
        store.begin(row("a"));
        store.begin(row("b"));
        expect(store.setShared(["a", "b", "b", "missing"], 1234)).toBe(2);
        expect(store.get("a")?.sharedAt).toBe(1234);
        expect(store.get("b")?.sharedAt).toBe(1234);
        expect(store.list().items.map((item) => item.sharedAt)).toEqual([1234, 1234]);
        expect(store.setShared(["a"], null)).toBe(1);
        expect(store.get("a")?.sharedAt).toBeNull();
        expect(store.get("b")?.sharedAt).toBe(1234);
        expect(store.setShared(["b"], Number.NaN)).toBe(0);
        expect(store.setShared(["b"], 2 ** 53)).toBe(0);
        expect(store.get("b")?.sharedAt).toBe(1234);
        expect(store.setShared([], 5)).toBe(0);
        expect(store.setShared(["missing"], 5)).toBe(0);
        expect(store.setShared(["b"], 7.9)).toBe(1);
        expect(store.get("b")?.sharedAt).toBe(7);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe("setPrompt (request history slice 3)", () => {
    // The request layer writes the prompt after the row began (its redactor exists only then):
    // a pending row with content on and no prompt takes it once, bounded like `begin`'s prompt
    // and counted in the row's bytes; every other row ignores it; the write prunes.
    it("sets a pending row's prompt once, bounded at a character boundary with the cut recorded and its bytes counted; a row with a prompt, content off, a finished row, a missing row, and a non-string are ignored", () => {
        const store = open();
        store.begin(row("r"));
        expect(store.get("r")?.prompt).toBeNull();
        store.setPrompt("r", "[1]");
        expect(store.get("r")).toMatchObject({ prompt: "[1]", bytes: beginBytes(row("r"), { prompt: "[1]" }) });
        store.setPrompt("r", "[2]");
        expect(store.get("r")?.prompt).toBe("[1]");

        store.begin(row("p", { prompt: [0] }));
        store.setPrompt("p", "[9]");
        expect(store.get("p")?.prompt).toBe("[0]");

        store.begin(row("off", { content: false }));
        store.setPrompt("off", "[1]");
        expect(store.get("off")).toMatchObject({ prompt: null, bytes: beginBytes(row("off", { content: false })) });

        store.begin(row("done"));
        store.finish("done", { status: "success" });
        store.setPrompt("done", "[1]");
        expect(store.get("done")?.prompt).toBeNull();

        store.setPrompt("missing", "[1]");
        store.begin(row("bad"));
        store.setPrompt("bad", 5 as never);
        expect(store.get("bad")?.prompt).toBeNull();

        // 3-byte characters: the bound is not a multiple of 3, so the cut backs up to a boundary.
        const chars = Math.ceil(REQUEST_HISTORY_BOUNDS.prompt / 3) + 1;
        const storedBytes = REQUEST_HISTORY_BOUNDS.prompt - (REQUEST_HISTORY_BOUNDS.prompt % 3);
        store.begin(row("big"));
        store.setPrompt("big", "€".repeat(chars));
        const big = store.get("big")!;
        const cut = { originalBytes: chars * 3, storedBytes };
        expect(big.prompt).toBe("€".repeat(storedBytes / 3));
        expect(big.truncation).toEqual({ prompt: cut });
        expect(big.truncated).toBe(true);
        expect(big.bytes).toBe(
            beginBytes(row("big"), { prompt: big.prompt, truncation: JSON.stringify({ prompt: cut }) }),
        );
        const rows = store.list({ limit: 200 }).items;
        expect(store.stats()).toEqual({ rows: rows.length, bytes: rows.reduce((sum, item) => sum + item.bytes, 0) });
        expect(warn).not.toHaveBeenCalled();
    });

    it("prunes after the write: a prompt that takes the history over its byte cap evicts the oldest row", () => {
        const store = open({ maxBytes: 1000 });
        store.begin(row("old"));
        store.begin(row("new"));
        const before = store.stats();
        expect(before.rows).toBe(2);
        store.setPrompt("new", "x".repeat(1000 - before.bytes + 1));
        expect(store.get("old")).toBeNull();
        expect(store.get("new")?.prompt).toHaveLength(1000 - before.bytes + 1);
        expect(store.stats().rows).toBe(1);
        expect(store.stats().bytes).toBeLessThanOrEqual(1000);
        expect(warn).not.toHaveBeenCalled();
    });
});
