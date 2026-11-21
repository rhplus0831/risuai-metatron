// @vitest-environment node
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { LLMTokenizer } from "../../../shared/llm.ts";
import { createTokenizers } from "../prompt/tokenizers/index.ts";
import type { TokenizerWorkerCall, TokenizerWorkerData, TokenizerWorkerMessage } from "../prompt/tokenizers/worker.ts";
import {
    createWorkerTokenizers,
    startTokenizerWorker,
    type TokenizerWorkerPort,
} from "../prompt/tokenizers/workerHost.ts";
import { isTokenizerTextRefusal } from "../prompt/tokens.ts";
import { TOKEN_COUNT_PATH } from "../routes/tokens.ts";
import { createResourceTestClient } from "./testSupport.ts";
import { fixture, materialize, REPO_ROOT } from "./tokenFixtures.ts";

class ScriptedPort extends EventEmitter implements TokenizerWorkerPort {
    readonly posted: TokenizerWorkerCall[] = [];
    referenced = true;
    ref() {
        this.referenced = true;
    }
    unref = vi.fn(() => {
        this.referenced = false;
    });
    terminate = vi.fn(async () => {});

    postMessage(call: TokenizerWorkerCall) {
        this.posted.push(call);
    }

    answer(index: number, reply: { value?: number | Uint32Array } | { error: string } = {}) {
        this.emit("message", { id: this.posted[index].id, ...reply });
    }
}

function workerSet(options: Omit<Parameters<typeof createWorkerTokenizers>[0], "rootDir"> = {}) {
    const set = createWorkerTokenizers({ rootDir: REPO_ROOT, ...options });
    onTestFinished(() => set.dispose());
    return set;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const refusal = "The text contains a special token that is not allowed: <|endoftext|>";
const disposed = new Error("The tokenizers are disposed");

describe("the tokenizer worker queue", () => {
    it("posts load, encode and count in arrival order and holds a ref until the last answer", async () => {
        const port = new ScriptedPort();
        const startWorker = vi.fn(() => port);
        const set = workerSet({ startWorker });
        await setImmediate();
        expect(startWorker).not.toHaveBeenCalled();

        const text = "<|endoftext|>";
        const loaded = set.load("llama");
        const encoded = set.encode("cl100k_base", text);
        const counted = set.count("llama", "last");
        const results = Promise.allSettled([loaded, encoded, counted]);

        expect(port.posted).toEqual([{ id: expect.any(Number), op: "load", family: "llama" }]);
        // Drain promise callbacks with the scripted port still holding the load.
        expect(await Promise.race([loaded, setImmediate("pending")])).toBe("pending");
        port.answer(0);
        await expect(loaded).resolves.toBeUndefined();
        expect(port.posted.slice(1)).toEqual([{ id: expect.any(Number), op: "encode", family: "cl100k_base", text }]);
        port.answer(1, { error: refusal });
        await expect(encoded).rejects.toHaveProperty("message", refusal);
        await expect(encoded).rejects.toSatisfy(isTokenizerTextRefusal);
        expect(port.posted.slice(2)).toEqual([{ id: expect.any(Number), op: "count", family: "llama", text: "last" }]);
        expect(port.unref).not.toHaveBeenCalled();

        port.answer(2, { value: 7 });
        await results;
        await expect(counted).resolves.toBe(7);
        expect(port.referenced).toBe(false);

        // The first call after idle has to keep the process alive even when it has no successor.
        const alone = set.load("llama");
        const referencedWhileAlone = port.referenced;
        port.answer(3);
        await alone;
        expect(referencedWhileAlone).toBe(true);
        expect(port.referenced).toBe(false);
        expect(startWorker).toHaveBeenCalledTimes(1);
    });

    it.each(["exit", "error then exit"])("keeps queued calls on %s and starts one replacement at exit", async (end) => {
        const first = new ScriptedPort();
        const replacement = new ScriptedPort();
        const startWorker = vi.fn(() => replacement).mockReturnValueOnce(first);
        const set = workerSet({ startWorker });
        const running = set.count("llama", "running");
        const queued = Promise.allSettled([set.count("llama", "second"), set.count("llama", "third")]);

        if (end === "error then exit") {
            first.emit("error", new Error("thread fault"));
            await expect(running).rejects.toThrow(/The tokenizer worker stopped.*thread fault/);
            expect(startWorker).toHaveBeenCalledTimes(1);
            expect(first.posted).toMatchObject([{ text: "running" }]);
            expect(first.unref).not.toHaveBeenCalled();
        }
        first.emit("exit", 17);
        if (end === "exit") await expect(running).rejects.toThrow(/The tokenizer worker stopped.*17/);
        expect(startWorker).toHaveBeenCalledTimes(2);
        expect(replacement.posted).toMatchObject([{ text: "second" }]);
        replacement.answer(0, { value: 2 });
        expect(replacement.posted).toMatchObject([{ text: "second" }, { text: "third" }]);
        replacement.answer(1, { value: 3 });
        expect(await queued).toEqual([
            { status: "fulfilled", value: 2 },
            { status: "fulfilled", value: 3 },
        ]);
        expect(startWorker).toHaveBeenCalledTimes(2);
    });

    it("charges each failed start to one queued call", async () => {
        const first = new ScriptedPort();
        const replacement = new ScriptedPort();
        const startWorker = vi
            .fn(() => replacement)
            .mockReturnValueOnce(first)
            .mockImplementationOnce(() => {
                throw new Error("first start failed");
            })
            .mockImplementationOnce(() => {
                throw new Error("second start failed");
            });
        const set = workerSet({ startWorker });
        const running = set.load("llama");
        const queued = Promise.allSettled(["one", "two", "three"].map((text) => set.count("llama", text)));

        first.emit("exit", 1);
        await expect(running).rejects.toThrow(/The tokenizer worker stopped/);
        expect(startWorker).toHaveBeenCalledTimes(4);
        expect(replacement.posted).toMatchObject([{ text: "three" }]);
        replacement.answer(0, { value: 3 });
        expect(await queued).toEqual([
            { status: "rejected", reason: new Error("first start failed") },
            { status: "rejected", reason: new Error("second start failed") },
            { status: "fulfilled", value: 3 },
        ]);
    });

    it("disposes running and queued calls and waits for one termination", async () => {
        const end = deferred<void>();
        const port = new ScriptedPort();
        port.terminate.mockImplementation(() => end.promise);
        const startWorker = vi.fn(() => port);
        const set = workerSet({ startWorker });
        const calls = Promise.allSettled([set.load("llama"), set.encode("llama", "waiting")]);
        try {
            const first = set.dispose();
            const second = set.dispose();
            expect(await calls).toEqual([
                { status: "rejected", reason: disposed },
                { status: "rejected", reason: disposed },
            ]);
            expect(port.posted).toMatchObject([{ op: "load" }]);
            expect(port.terminate).toHaveBeenCalledTimes(1);
            port.emit("exit", 1);
            expect(await Promise.race([first, second, setImmediate("pending")])).toBe("pending");
            end.resolve();
            await Promise.all([first, second]);
            await expect(set.count("llama", "after disposal")).rejects.toEqual(disposed);
            expect(startWorker).toHaveBeenCalledTimes(1);
        } finally {
            end.resolve();
        }
    });
});

describe("the tokenizer thread", () => {
    it("returns the in-thread llama ids as a Uint32Array and preserves cl100k_base refusals", async () => {
        const worker = workerSet();
        const local = createTokenizers({ rootDir: REPO_ROOT });
        onTestFinished(() => local.dispose());
        const text = materialize(fixture.texts.mixed);
        const ids = await worker.encode("llama", text);
        expect(ids).toBeInstanceOf(Uint32Array);
        expect(Array.from(ids)).toEqual(Array.from(await local.encode("llama", text)));

        const refused = worker.encode("cl100k_base", materialize(fixture.texts.special));
        await expect(refused).rejects.toSatisfy(isTokenizerTextRefusal);
        await expect(refused).rejects.toHaveProperty("message", refusal);
    });

    it("rejects the call held inside a terminated thread and answers the next on a new thread", async () => {
        const held = deferred<Worker>();
        const latch = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        const startWorker = vi
            .fn(({ rootDir }: TokenizerWorkerData) => startTokenizerWorker({ rootDir }))
            .mockImplementationOnce((data) => {
                const worker = startTokenizerWorker(data);
                worker.on("message", (message: TokenizerWorkerMessage) => {
                    if ("type" in message && message.type === "held") held.resolve(worker);
                });
                return worker;
            });
        const set = workerSet({ latch, startWorker });
        const running = set.count("llama", "held");
        const next = set.encode("llama", materialize(fixture.texts.ascii));
        const results = Promise.allSettled([running, next]);
        const first = await held.promise;
        await first.terminate();
        await results;
        await expect(running).rejects.toThrow(/The tokenizer worker stopped/);
        expect(startWorker).toHaveBeenCalledTimes(2);
        expect({ ids: Array.from(await next) }).toEqual(fixture.families.llama.ascii);
    });
});

it("posts an encode for the first authenticated local count through the server context", async () => {
    const posts = vi.spyOn(Worker.prototype, "postMessage");
    onTestFinished(() => {
        posts.mockRestore();
    });
    const tokenizerCalls = () =>
        posts.mock.calls
            .map(([message]) => message)
            .filter((message) => ["load", "count", "encode"].includes(message?.op));
    const client = await createResourceTestClient();
    onTestFinished(() => client.close());
    const text = materialize(fixture.texts.ascii);

    expect(tokenizerCalls()).toEqual([]);
    const response = await client.json(TOKEN_COUNT_PATH, {
        scope: {
            aiModel: "gpt-3.5-turbo",
            modelTokenizer: LLMTokenizer.tiktokenCl100kBase,
            customTokenizer: "tik",
            currentPluginProvider: "",
            pluginTokenizer: "none",
            googleClaudeTokenizing: false,
            useTokenizerCaching: false,
        },
        texts: [text],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ counts: [2] }); // Frozen cl100k_base count for the ASCII fixture.
    expect(tokenizerCalls()).toEqual([{ id: expect.any(Number), op: "encode", family: "cl100k_base", text }]);
});
