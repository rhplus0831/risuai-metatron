// Measurements of the Structured Memory evaluation that need no story (not a test file itself): the
// vector cache's reads beside `addText`, a checkpoint save over many runs with its replayed attribution,
// the health read over many events and runs, and the revisions route under the real limiter on a real
// listening server. Each builds what it measures on a temp dir and removes it.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import type { Chat } from "../../../../../../shared/database.ts";
import type { MemoryRun } from "../../../../../../shared/structuredMemory.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../../data/kinds.ts";
import type { MemoryChatRef, MemoryEventWrite } from "../../../../data/memoryStore.ts";
import { createResourceStore, type ResourceStore } from "../../../../data/resourceStore.ts";
import { createVectorCache } from "../../../../data/vectorCache.ts";
import { createGenerationLock } from "../../../../jobs/generationLock.ts";
import { createEmbeddings, HypaProcesser } from "../../../../prompt/embeddings.ts";
import type { TransformersService } from "../../../../prompt/transformers.ts";
import { memoryRecords } from "../../../memoryFixtures.ts";
import { createSigner, createTestServer, json as jsonInit } from "../../../testSupport.ts";
import { UNHURRIED_SCRIPT_WORKERS } from "../../../unhurriedLimits.ts";
import { median, quantile } from "./evaluate.ts";

/** The file system a path is on, by its `statfs` magic; the magic in hex when it is none of the known ones. */
export function fileSystemOf(dir: string): string {
    const magic = Number(statfsSync(dir).type);
    const known: Record<number, string> = {
        0x01021994: "tmpfs",
        0xef53: "ext4",
        0x58465342: "xfs",
        0x9123683e: "btrfs",
        0x2fc12fc1: "zfs",
        0x6969: "nfs",
        0x65735546: "fuse",
        0xff534d42: "cifs",
        0x4d44: "vfat",
    };
    return known[magic] ?? `0x${magic.toString(16)}`;
}

/** The journal and synchronous modes of a SQLite file, read on a connection of its own. */
export function sqliteModes(file: string): { journal: string; synchronous: number } {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const journal = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
        const synchronous = (db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
        return { journal, synchronous };
    } finally {
        db.close();
    }
}

// ---------------------------------------------------------------------------------------------
// A scratch store

export const SCRATCH_CHARACTER = "c";
export const SCRATCH_CHAT = "k";

/** A store on a temp dir under `parent` with one character and `chats` empty chats, `k`, `k1`, ... */
export function openScratchStore(parent: string | undefined, chats = 1) {
    const dir = mkdtempSync(path.join(parent ?? os.tmpdir(), "risu-memory-scratch-"));
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const store = createResourceStore({
        file: path.join(dir, "resources.sqlite"),
        kinds,
        guard: createGenerationLock(),
    });
    store.put(
        kinds.get("characters")!,
        SCRATCH_CHARACTER,
        { chaId: SCRATCH_CHARACTER, type: "character", name: "Cara", firstMessage: "Hello", desc: "", globalLore: [] },
        null,
    );
    const chatIds = Array.from({ length: chats }, (_, index) =>
        index === 0 ? SCRATCH_CHAT : `${SCRATCH_CHAT}${index}`,
    );
    store.applyChanges({
        chats: chatIds.map((chatId) => ({
            characterId: SCRATCH_CHARACTER,
            chatId,
            baseRevision: null,
            ops: [{ op: "create" as const, chat: { id: chatId, name: chatId, message: [] } as unknown as Chat }],
        })),
    });
    const refs: MemoryChatRef[] = chatIds.map((chatId) => ({ characterId: SCRATCH_CHARACTER, chatId }));
    return {
        dir,
        file: path.join(dir, "resources.sqlite"),
        store,
        kinds,
        chatIds,
        refs,
        /** Writes `changes` to `chatId` on its current memory revision. */
        write(chatId: string, changes: Parameters<ResourceStore["memory"]["write"]>[3]) {
            const contents = store.memory.readContents(SCRATCH_CHARACTER, chatId)!;
            return store.memory.write(
                SCRATCH_CHARACTER,
                chatId,
                { epoch: store.epoch(), baseRevision: contents.revision },
                changes,
            );
        },
        dispose() {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

export type ScratchStore = ReturnType<typeof openScratchStore>;

// ---------------------------------------------------------------------------------------------
// Cache reads beside addText

export type CacheReadRow = {
    texts: number;
    distinctKeys: number;
    /** `cache.get` calls one `addText` over `texts` made. */
    cacheGets: number;
    cacheReadsMs: number;
    addTextMs: number;
};

/**
 * On a warm cache of `max(sizes)` vectors of `dimensions`, for each size: the median of `repeats` of
 * reading the keys alone and of a fresh processor's `addText` over the texts. Both read the real cache;
 * the embedding upstream is never reached.
 */
export async function timeCacheReads(
    parent: string | undefined,
    sizes: readonly number[],
    repeats: number,
    dimensions = 256,
) {
    const dir = mkdtempSync(path.join(parent ?? os.tmpdir(), "risu-memory-cache-"));
    const cache = createVectorCache({ file: path.join(dir, "vectors.sqlite"), now: () => 0 });
    let gets = 0;
    const counted = { ...cache, get: (key: string) => (gets++, cache.get(key)) };
    const embeddings = createEmbeddings({
        cache: counted,
        transformers: {} as TransformersService,
        fetchImpl: async () => {
            throw new Error("A warm cache asks the embedding upstream nothing");
        },
    });
    const env = embeddings.forJob({
        db: { hypaModel: "ada", hypaCustomSettings: undefined, voyageApiKey: "" } as never,
        supaMemoryKey: "k",
        signal: new AbortController().signal,
    });
    try {
        const total = Math.max(...sizes);
        const texts = Array.from(
            { length: total },
            (_, i) => `Record ${String(i).padStart(5, "0")}: ${"a shared prefix of the story ".repeat(4)}${i}`,
        );
        const vector = Array.from({ length: dimensions }, () => 1 / Math.sqrt(dimensions));
        for (const text of texts) {
            cache.set(`${text}|ada`, vector, cache.generation());
        }
        const rows: CacheReadRow[] = [];
        for (const size of sizes) {
            const list = texts.slice(0, size);
            const readTimes: number[] = [];
            const addTimes: number[] = [];
            let perAddText = 0;
            for (let repeat = 0; repeat < repeats; repeat++) {
                let started = performance.now();
                for (const text of list) {
                    cache.get(`${text}|ada`);
                }
                readTimes.push(performance.now() - started);
                const processor = new HypaProcesser(env, "ada");
                const before = gets;
                started = performance.now();
                await processor.addText(list);
                addTimes.push(performance.now() - started);
                perAddText = gets - before;
            }
            rows.push({
                texts: size,
                distinctKeys: new Set(list).size,
                cacheGets: perAddText,
                cacheReadsMs: median(readTimes),
                addTextMs: median(addTimes),
            });
        }
        return rows;
    } finally {
        cache.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------------------------
// Checkpoint saves

/** `runs` recorded runs whose `input` is `inputBytes` of ASCII, written in batches. */
export function writeSyntheticRuns(scratch: ScratchStore, runs: number, inputBytes: number): void {
    const input = '{"role":"system","content":"long instruction\\n"}\n'
        .repeat(Math.ceil(inputBytes / 48))
        .slice(0, inputBytes);
    for (let start = 0; start < runs; start += 500) {
        const ids = Array.from({ length: Math.min(500, runs - start) }, (_, i) => `run-${start + i}`);
        scratch.write(SCRATCH_CHAT, {
            runs: memoryRecords(ids).runs.map((run): MemoryRun => ({ ...run, input })),
        });
    }
}

/** One checkpoint save through the real transaction, timed. */
export function timeCheckpointSave(store: ResourceStore, characterId: string, chatId: string, name: string): number {
    const started = performance.now();
    store.applyChanges({}, { inTransaction: { before: (tx) => void tx.save(characterId, chatId, name, "auto") } });
    return performance.now() - started;
}

export type ReplayAttribution = {
    round: number;
    totalMs: number;
    parts: {
        read: number;
        stringify: number;
        byteLength: number;
        idHash: number;
        join: number;
        pageHash: number;
        insert: number;
    };
    residualMs: number;
    rawBytes: number;
    encodedBytes: number;
    pages: number;
    inserted: number;
};

const MAX_PAGE_ROWS = 64;
const MAX_PAGE_BYTES = 1024 * 1024;

/**
 * The checkpoint's page work replayed over the chat's memory rows and messages, read from the store's
 * file on a connection of their own, into a scratch page table, twice: the second round finds every page
 * present. An attribution of where a save's time goes, by the same steps in the same order, with the
 * residual shown; not an instrumented split of the real save, which also writes the checkpoint rows.
 */
export function replayCheckpointPages(file: string, chatId: string, parent?: string): ReplayAttribution[] {
    const source = new DatabaseSync(file, { readOnly: true });
    const dir = mkdtempSync(path.join(parent ?? os.tmpdir(), "risu-memory-replay-"));
    const replay = new DatabaseSync(path.join(dir, "replay.sqlite"));
    try {
        replay.exec(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE p(hash TEXT PRIMARY KEY, text TEXT)",
        );
        const insert = replay.prepare("INSERT OR IGNORE INTO p VALUES (?, ?)");
        const { seq } = source.prepare("SELECT seq FROM chats WHERE id = ?").get(chatId) as { seq: number };
        const tables = ["memory_pages", "memory_events", "memory_threads", "memory_runs"];
        const rounds: ReplayAttribution[] = [];
        for (let round = 0; round < 2; round++) {
            const parts = { read: 0, stringify: 0, byteLength: 0, idHash: 0, join: 0, pageHash: 0, insert: 0 };
            const timed = <T>(key: keyof typeof parts, work: () => T): T => {
                const started = performance.now();
                const result = work();
                parts[key] += performance.now() - started;
                return result;
            };
            let rowTexts: string[] = [];
            let pageBytes = 0;
            let rawBytes = 0;
            let encodedBytes = 0;
            let pages = 0;
            let inserted = 0;
            const flush = () => {
                if (rowTexts.length === 0) {
                    return;
                }
                const text = timed("join", () => `[${rowTexts.join(",")}]`);
                const hash = timed("pageHash", () => createHash("sha256").update(text, "utf8").digest("hex"));
                inserted += Number(timed("insert", () => insert.run(hash, text)).changes);
                pages++;
                rowTexts = [];
                pageBytes = 0;
            };
            const walk = (rows: Iterable<{ id: string; data: string }>, rowText: (data: string) => string) => {
                const iterator = rows[Symbol.iterator]();
                for (;;) {
                    const next = timed("read", () => iterator.next());
                    if (next.done) {
                        break;
                    }
                    const { id, data } = next.value;
                    rawBytes += Buffer.byteLength(data, "utf8");
                    const text = timed("stringify", () => rowText(data));
                    rowTexts.push(text);
                    const bytes = timed("byteLength", () => Buffer.byteLength(text, "utf8"));
                    pageBytes += bytes;
                    encodedBytes += bytes;
                    const anchor = timed(
                        "idHash",
                        () => createHash("sha256").update(id, "utf8").digest()[0] % 16 === 0,
                    );
                    if (anchor || rowTexts.length >= MAX_PAGE_ROWS || pageBytes >= MAX_PAGE_BYTES) {
                        flush();
                    }
                }
                flush();
            };
            const started = performance.now();
            replay.exec("BEGIN IMMEDIATE");
            walk(
                source
                    .prepare("SELECT id, data FROM messages WHERE chatSeq = ? ORDER BY position")
                    .iterate(seq) as Iterable<{
                    id: string;
                    data: string;
                }>,
                (data) => data,
            );
            for (const table of tables) {
                const seqs = source.prepare(`SELECT seq FROM ${table} WHERE chatSeq = ? ORDER BY seq`);
                const row = source.prepare(`SELECT id, data FROM ${table} WHERE seq = ?`);
                walk(
                    (function* () {
                        for (const { seq: rowSeq } of seqs.iterate(seq) as Iterable<{ seq: number }>) {
                            yield row.get(rowSeq) as { id: string; data: string };
                        }
                    })(),
                    (data) => JSON.stringify(data),
                );
            }
            replay.exec("COMMIT");
            const totalMs = performance.now() - started;
            const accounted = Object.values(parts).reduce((sum, value) => sum + value, 0);
            rounds.push({
                round,
                totalMs,
                parts,
                residualMs: totalMs - accounted,
                rawBytes,
                encodedBytes,
                pages,
                inserted,
            });
        }
        return rounds;
    } finally {
        replay.close();
        source.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------------------------
// The health read

export type HealthShape = { chats: number; events: number; runs: number; bodyBytes: number };

/** A scratch store whose chats each hold `events` events of `bodyBytes` summaries, `runs` runs, and two small pages. */
export function createHealthStore(parent: string | undefined, shape: HealthShape): ScratchStore {
    const scratch = openScratchStore(parent, shape.chats);
    const body = "x".repeat(shape.bodyBytes);
    for (const chatId of scratch.chatIds) {
        scratch.write(chatId, { pages: memoryRecords(["a", "b"], "Small page").pages });
        for (let start = 0; start < shape.events; start += 1000) {
            const ids = Array.from({ length: Math.min(1000, shape.events - start) }, (_, i) => `e${start + i}`);
            scratch.write(chatId, {
                events: memoryRecords(ids).events.map((event): MemoryEventWrite => ({ ...event, summary: body })),
            });
        }
        for (let start = 0; start < shape.runs; start += 1000) {
            const ids = Array.from({ length: Math.min(1000, shape.runs - start) }, (_, i) => `r${start + i}`);
            scratch.write(chatId, { runs: memoryRecords(ids).runs });
        }
    }
    return scratch;
}

/** The median of `repeats` synchronous `readHealth` calls over `refs`, and how many refs the last answered. */
export function timeHealth(
    scratch: ScratchStore,
    budgetBytes: number,
    repeats: number,
): { medianMs: number; answered: number } {
    const times: number[] = [];
    let answered = 0;
    for (let repeat = 0; repeat < repeats; repeat++) {
        const started = performance.now();
        const facts = scratch.store.memory.readHealth(scratch.refs, budgetBytes);
        times.push(performance.now() - started);
        answered = facts.length;
    }
    return { medianMs: median(times), answered };
}

// ---------------------------------------------------------------------------------------------
// The revisions route under the limiter

export type RateCase = {
    name: string;
    chats: number;
    /** Added after each revision call, as a slower network would. */
    callDelayMs: number;
    /** A `POST /api/resources/read` of the chat before each revision call, as a load of an evicted chat. */
    loadBefore: boolean;
    /** A concurrent loop on another authenticated route, sharing the limiter. */
    neighbour: boolean;
    seconds: number;
};

export type RateResult = {
    name: string;
    chats: number;
    callDelayMs: number;
    loadBefore: boolean;
    revisionRequests: number;
    loadRequests: number;
    firstMinuteRequests: number;
    denied: number;
    firstDeniedAtS: number | null;
    revisionLatencyMs: { median: number; p95: number };
    /** The neighbour's requests and refusals per ten seconds, when it ran. */
    neighbour?: { bucketS: number; requests: number; denied: number }[];
    /** The limiter's answer for the client, as the first response said it. */
    limit: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One case on a fresh real server with the default limits, listening on loopback: a serial walker
 * over `chats` chats that calls the revisions route for one chat whenever that chat's last check settled
 * two seconds or more ago (the client's recheck window), for `seconds` of real time.
 */
export async function runRateCase(testCase: RateCase): Promise<RateResult> {
    const server = createTestServer({ password: "pw", scriptWorkerOptions: UNHURRIED_SCRIPT_WORKERS });
    const node = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
    await new Promise<void>((resolve) => node.once("listening", () => resolve()));
    const port = (node.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const signer = await createSigner();
    try {
        await fetch(`${base}/api/login`, jsonInit({ password: "pw", publicKey: signer.publicJwk }));
        const jwt = await signer.jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        let epoch = "";
        const api = async (url: string, init: RequestInit = {}) => {
            const headers: Record<string, string> = {
                "risu-auth": jwt,
                "content-type": "application/json",
                ...(epoch ? { "x-resource-epoch": epoch } : {}),
            };
            return fetch(`${base}${url}`, { ...init, headers });
        };
        const ui = (await (await api("/api/resources/ui/main")).json()) as {
            epoch: string;
            revision: string;
            data: Record<string, unknown>;
        };
        epoch = ui.epoch;
        await api("/api/resources/ui/main", {
            method: "PUT",
            body: JSON.stringify({
                baseRevision: ui.revision,
                data: { ...ui.data, memoryAlgorithmType: "structuredMemory" },
            }),
        });
        const owner = await api("/api/resources/characters/c", {
            method: "PUT",
            body: JSON.stringify({
                baseRevision: null,
                data: { chaId: "c", type: "character", name: "Cara", firstMessage: "Hello", desc: "", globalLore: [] },
            }),
        });
        if (owner.status !== 200) {
            throw new Error(`Seeding the character failed: ${owner.status} ${await owner.text()}`);
        }
        const chatIds = Array.from({ length: testCase.chats }, (_, i) => `chat-${i}`);
        for (let start = 0; start < chatIds.length; start += 100) {
            const created = await api("/api/resources/batch", {
                method: "POST",
                body: JSON.stringify({
                    chats: chatIds.slice(start, start + 100).map((chatId) => ({
                        characterId: "c",
                        chatId,
                        baseRevision: null,
                        ops: [
                            {
                                op: "create",
                                chat: {
                                    id: chatId,
                                    name: chatId,
                                    message: [{ chatId: "m1", role: "user", data: "Hello" }],
                                },
                            },
                        ],
                    })),
                }),
            });
            if (created.status !== 200) {
                throw new Error(`Seeding the chats failed: ${created.status} ${await created.text()}`);
            }
        }
        // The seeding requests above came from the same loopback address, so they count against the
        // same per-IP window as the timed calls; the first timed call's headers say how many are left.

        const settled = new Array<number>(testCase.chats).fill(-Infinity);
        const latencies: number[] = [];
        let revisionRequests = 0;
        let loadRequests = 0;
        let denied = 0;
        let firstDeniedAt: number | null = null;
        let firstMinuteRequests = 0;
        let limit: string | null = null;
        const started = performance.now();
        const elapsed = () => (performance.now() - started) / 1000;
        const count = (status: number, headers: Headers) => {
            if (elapsed() < 60) {
                firstMinuteRequests++;
            }
            limit ??= headers.get("RateLimit-Limit");
            if (status === 429) {
                denied++;
                firstDeniedAt ??= elapsed();
            }
        };
        const neighbourBuckets = new Map<number, { requests: number; denied: number }>();
        let stop = false;
        const neighbour = testCase.neighbour
            ? (async () => {
                  while (!stop) {
                      const res = await api("/api/resources/ui/main");
                      const bucket = Math.floor(elapsed() / 10) * 10;
                      const entry = neighbourBuckets.get(bucket) ?? { requests: 0, denied: 0 };
                      entry.requests++;
                      if (res.status === 429) {
                          entry.denied++;
                      }
                      neighbourBuckets.set(bucket, entry);
                      count(res.status, res.headers);
                      await sleep(10);
                  }
              })()
            : Promise.resolve();
        while (elapsed() < testCase.seconds) {
            let visited = false;
            for (let index = 0; index < testCase.chats && elapsed() < testCase.seconds; index++) {
                if (performance.now() - settled[index] < 2000) {
                    continue;
                }
                visited = true;
                if (testCase.loadBefore) {
                    const read = await api("/api/resources/read", {
                        method: "POST",
                        body: JSON.stringify({ chats: [{ characterId: "c", id: chatIds[index] }] }),
                    });
                    loadRequests++;
                    count(read.status, read.headers);
                }
                const before = performance.now();
                const res = await api("/api/memory/structured/revisions", {
                    method: "POST",
                    body: JSON.stringify({ chats: [{ characterId: "c", chatId: chatIds[index] }] }),
                });
                latencies.push(performance.now() - before);
                revisionRequests++;
                count(res.status, res.headers);
                settled[index] = performance.now();
                if (testCase.callDelayMs > 0) {
                    await sleep(testCase.callDelayMs);
                }
            }
            if (!visited) {
                const next = Math.min(...settled) + 2000 - performance.now();
                await sleep(Math.max(1, Math.min(next, 100)));
            }
        }
        stop = true;
        await neighbour;
        return {
            name: testCase.name,
            chats: testCase.chats,
            callDelayMs: testCase.callDelayMs,
            loadBefore: testCase.loadBefore,
            revisionRequests,
            loadRequests,
            firstMinuteRequests,
            denied,
            firstDeniedAtS: firstDeniedAt,
            revisionLatencyMs: { median: median(latencies), p95: quantile(latencies, 0.95) },
            ...(testCase.neighbour
                ? {
                      neighbour: [...neighbourBuckets]
                          .sort(([a], [b]) => a - b)
                          .map(([bucketS, entry]) => ({ bucketS, ...entry })),
                  }
                : {}),
            limit,
        };
    } finally {
        node.closeAllConnections();
        await new Promise((resolve) => node.close(resolve));
        await server.close();
    }
}
