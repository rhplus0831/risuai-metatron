// @vitest-environment node
import type http from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { GenerationEvent } from "../../../shared/jobs.ts";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { allowListenerOrigin, createSigner, createTestServer, json, waitFor } from "./testSupport.ts";

// The generation job routes and the owner socket (`server/src/routes/generations.ts`,
// `generationJobs.handleUpgrade`) on a real listening server, with a fake runner driven by the test,
// beside the live-update socket on the same upgrade dispatcher. The registry's in-process contracts
// are in `generationJobs.test.ts`; the client transport in `src/ts/network/generationJobs.test.ts`.

type Step = (job: RunningJob) => void | Promise<void>;
const ref = { characterId: "c", chatId: "k" };
const m = (id: string, data = "", role: "user" | "char" = "user") => ({ role, data, chatId: id });
const group = (baseRevision: string | null, ops: ChatOp[]) => ({ ...ref, baseRevision, ops });
const checkpoint = (seq: number, text: string, final = false, generationId = "g1"): ChatOp => ({
    op: "setText",
    id: "r",
    text,
    generation: { id: generationId, seq, final },
});

describe("generation delta chunks on the owner socket", () => {
    let server: ReturnType<typeof createTestServer>;
    let node: http.Server | undefined;
    let base = "";
    let epoch = "";
    let signer: Awaited<ReturnType<typeof createSigner>>;
    /** The chat's binding: the default records' ids, which every job names. */
    let bound = { presetId: "", modelPresetId: "", personaId: "" };
    /** The steps the current test hands the runner, in order; the runner waits for each. */
    let steps: Step[] = [];
    let wake: (() => void) | null = null;
    let runners: Promise<void>[] = [];

    /** Runs the test's steps as they arrive, until one returns `"end"` or the job is aborted. */
    const runner = async (job: RunningJob) => {
        const run = (async () => {
            job.signal.addEventListener("abort", () => wake?.());
            for (;;) {
                if (steps.length === 0) {
                    if (job.signal.aborted) {
                        return;
                    }
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                    continue;
                }
                const step = steps.shift()!;
                if ((await step(job)) === ("end" as never)) {
                    return;
                }
            }
        })();
        runners.push(run);
        await run;
    };
    const step = (fn: Step) => {
        steps.push(fn);
        wake?.();
        wake = null;
    };

    beforeAll(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterAll(() => {
        vi.restoreAllMocks();
    });
    afterEach(async () => {
        steps = [];
        await server?.close();
        await Promise.allSettled(runners);
        wake = null;
        runners = [];
        if (node) {
            node.closeAllConnections();
            await new Promise((resolve) => node?.close(resolve));
            node = undefined;
        }
    });

    async function listen() {
        server = createTestServer({ password: "pw", generationRunner: runner });
        const started = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
        node = started;
        await new Promise<void>((resolve) => started.once("listening", () => resolve()));
        allowListenerOrigin(started);
        server.context.attachWebSocket(started);
        const { port } = started.address() as { port: number };
        base = `http://127.0.0.1:${port}`;
        signer = await createSigner();
        await fetch(`${base}/api/login`, json({ password: "pw", publicKey: signer.publicJwk }));
        epoch = ((await (await request("/api/resources/ui")).json()) as { epoch: string }).epoch;
        const firstId = async (kind: string) =>
            ((await (await request(`/api/resources/${kind}/main`)).json()) as { data: { id: string }[] }).data[0].id;
        bound = {
            presetId: await firstId("presets"),
            modelPresetId: await firstId("modelPresets"),
            personaId: await firstId("personas"),
        };
        const seeded = await request("/api/resources/batch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
                chats: [
                    group(null, [
                        {
                            op: "create",
                            chat: {
                                name: "K",
                                modelPresetId: bound.modelPresetId,
                                promptPresetId: bound.presetId,
                                bindedPersona: bound.personaId,
                                message: [m("u", "hi"), m("r", "", "char")],
                            } as never,
                        },
                    ]),
                ],
            }),
        });
        expect(seeded.status).toBe(200);
    }

    async function request(url: string, init: RequestInit = {}, options: { epoch?: string | null; jwt?: string } = {}) {
        const headers: Record<string, string> = {
            "risu-auth": options.jwt ?? (await signer.jwt()),
            ...((init.headers as Record<string, string>) ?? {}),
        };
        const value = options.epoch === undefined ? epoch : options.epoch;
        if (value !== null) {
            headers["x-resource-epoch"] = value;
        }
        return fetch(`${base}${url}`, { ...init, headers });
    }
    const revision = async () => {
        const res = await request("/api/resources/read", json({ chats: [{ characterId: "c", id: "k" }] }));
        return (
            (await res.json()) as {
                chats: { revision: string; data: { message: { chatId: string; data: string }[] } }[];
            }
        ).chats[0];
    };
    const context = async (input = "") => ({
        characterId: "c",
        chatId: "k",
        ...bound,
        mode: "normal",
        input,
        chatRevision: (await revision()).revision,
    });
    const create = async (body: Record<string, unknown>, options: { epoch?: string | null } = {}) => {
        const res = await request("/api/generations", json(body), options);
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const createOk = async (kind = "send", clientId = "tab") => {
        // A command job carries what it runs; the route refuses `command` on any other kind.
        const command = kind === "command" ? { command: { type: "button", data: "" } } : {};
        const res = await create({ kind, context: await context(), clientId, ...command });
        expect(res.status).toBe(200);
        return res.body.jobId as string;
    };

    type Followed = { events: GenerationEvent[]; closed: Promise<number>; ws: WebSocket };
    /** Opens the owner socket; `until` resolves `closed` early with the events so far. */
    async function follow(
        jobId: string,
        options: { clientId?: string; token?: string; attach?: number; maxMs?: number } = {},
    ): Promise<Followed> {
        const token = options.token ?? (await signer.jwt());
        const query =
            `?risu-auth=${encodeURIComponent(token)}&clientId=${encodeURIComponent(options.clientId ?? "tab")}` +
            (options.attach === undefined ? "" : `&attach=${options.attach}`);
        const ws = new WebSocket(`${base.replace("http", "ws")}/api/generations/${jobId}/ws${query}`);
        const events: GenerationEvent[] = [];
        const opened = new Promise<void>((resolve) => {
            ws.onopen = () => resolve();
        });
        const closed = new Promise<number>((resolve) => {
            const timer = setTimeout(() => ws.close(), options.maxMs ?? 4000);
            ws.onmessage = (message) => {
                const event = JSON.parse(String(message.data)) as GenerationEvent;
                if (event.type !== "ping") {
                    events.push(event);
                }
                if (event.type === "done" || event.type === "error") {
                    clearTimeout(timer);
                    setTimeout(() => ws.close(), 20);
                }
            };
            ws.onerror = () => {};
            ws.onclose = (event) => {
                clearTimeout(timer);
                resolve(event.code);
            };
        });
        // Attached (the snapshot is on its way) or refused: emits after this cannot race the handshake.
        await Promise.race([opened, closed]);
        return { events, closed, ws };
    }
    const until = (owner: Followed, type: GenerationEvent["type"], count = 1) =>
        waitFor(() => owner.events.filter((e) => e.type === type).length >= count);
    function begin(text: string) {
        step((job) => {
            const applied = job.write(() => ({
                chats: [group(job.context.chatRevision, [{ op: "begin", id: "r", generationId: "g1" }])],
            }));
            job.emit({
                type: "accepted",
                jobId: job.id,
                messageId: "r",
                generationId: "g1",
                revision: applied.chats[0].revision!,
                text,
            });
        });
    }

    it("sends UTF-16 prefix deltas across a continuation rewrite and a trim, but full text on attach and chat resync", async () => {
        await listen();
        const jobId = await createOk();
        const owner = await follow(jobId);
        begin("A😀old suffix");
        await until(owner, "accepted");
        step((job) => {
            job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "A😀new suffix", seq: 1 });
            job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "A😀new suffix!", seq: 2 });
            job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "A😀", seq: 3 });
        });
        await until(owner, "chunk", 3);
        const common = { type: "chunk", epoch, messageId: "r", generationId: "g1" };
        expect(owner.events.filter((e) => e.type === "chunk")).toEqual([
            { ...common, seq: 1, base: 0, keep: 3, text: "new suffix" },
            { ...common, seq: 2, base: 1, keep: 13, text: "!" },
            { ...common, seq: 3, base: 2, keep: 3, text: "" },
        ]);
        const resumed = await follow(jobId, { attach: 2 });
        await until(resumed, "accepted");
        expect(resumed.events.find((e) => e.type === "accepted")).toMatchObject({ text: "A😀", seq: 3 });
        const before = resumed.events.length;
        resumed.ws.send(JSON.stringify({ type: "resync" }));
        await until(resumed, "accepted", 2);
        expect(resumed.events.slice(before).map((e) => e.type)).toEqual(["resource", "accepted"]);
        expect(resumed.events.at(-1)).toMatchObject({ text: "A😀", seq: 3 });
        resumed.ws.close();
    });

    it("answers reply resync with only the live full reply, including an unlocked handoff, and keeps the next delta base", async () => {
        await listen();
        const jobId = await createOk();
        const owner = await follow(jobId);
        begin("seed");
        await until(owner, "accepted");
        step((job) => job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "seed next", seq: 7 }));
        await until(owner, "chunk");
        const start = owner.events.length;
        owner.ws.send(JSON.stringify({ type: "resyncReply" }));
        await until(owner, "accepted", 2);
        expect(owner.events.slice(start)).toEqual([
            {
                type: "accepted",
                epoch,
                jobId,
                messageId: "r",
                generationId: "g1",
                revision: expect.any(String),
                text: "seed next",
                seq: 7,
            },
        ]);
        step((job) => job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "seed next!", seq: 8 }));
        await until(owner, "chunk", 2);
        expect(owner.events.at(-1)).toEqual({
            type: "chunk",
            epoch,
            messageId: "r",
            generationId: "g1",
            seq: 8,
            base: 7,
            keep: 9,
            text: "!",
        });
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(1, "stored final", true)])] }));
            // The runner announces its next reply before acquiring its new lock.
            job.emit({
                type: "accepted",
                jobId: job.id,
                messageId: "r",
                generationId: "g2",
                revision: job.context.chatRevision,
                text: "handoff",
                seq: 0,
            });
        });
        await until(owner, "accepted", 3);
        const unlocked = owner.events.length;
        owner.ws.send(JSON.stringify({ type: "resyncReply" }));
        await until(owner, "accepted", 4);
        expect(owner.events.slice(unlocked)).toEqual([
            {
                type: "accepted",
                epoch,
                jobId,
                messageId: "r",
                generationId: "g2",
                revision: expect.any(String),
                text: "handoff",
                seq: 0,
            },
        ]);
        owner.ws.close();
    });

    it("sends no reply resync answer before a message exists or after the job ends", async () => {
        await listen();
        const jobId = await createOk();
        const owner = await follow(jobId);
        step((job) => job.emit({ type: "accepted", jobId: job.id, revision: job.context.chatRevision, text: "" }));
        await until(owner, "accepted");
        const start = owner.events.length;
        // A following whole-chat resync is an ordered fence on the same client socket.
        owner.ws.send(JSON.stringify({ type: "resyncReply" }));
        owner.ws.send(JSON.stringify({ type: "resync" }));
        await until(owner, "accepted", 2);
        expect(owner.events.slice(start).map((e) => e.type)).toEqual(["resource", "accepted"]);
        begin("finished");
        await until(owner, "accepted", 3);
        step((job) => {
            job.emit({ type: "done", messageId: "r", revision: null });
            return "end" as never;
        });
        await until(owner, "done");
        owner.ws.send(JSON.stringify({ type: "resyncReply" }));
        await owner.closed;
        expect(owner.events.filter((e) => e.type === "accepted")).toHaveLength(3);
    });

    it("puts committed patches on both live sockets and omits patches from HTTP batches", async () => {
        await listen();
        const sockets: WebSocket[] = [];
        const frames: Record<string, any>[][] = [[], []];
        for (const seen of frames) {
            const ws = new WebSocket(
                `${base.replace("http", "ws")}/api/events/ws?risu-auth=${encodeURIComponent(await signer.jwt())}`,
            );
            sockets.push(ws);
            ws.onmessage = (event) => seen.push(JSON.parse(String(event.data)));
        }
        try {
            await waitFor(() => frames.every((seen) => seen.length === 1));
            const baseRevision = (await revision()).revision;
            const response = await request(
                "/api/resources/batch",
                json({ chats: [group(baseRevision, [{ op: "setText", id: "r", text: "checkpoint" }])] }),
            );
            expect(response.status).toBe(200);
            const body = (await response.json()) as { chats: { revision: string }[] };
            await waitFor(() => frames.every((seen) => seen.length === 2));
            expect(body.chats[0]).toEqual({ characterId: "c", id: "k", revision: body.chats[0].revision });
            for (const seen of frames)
                expect(seen[1]).toEqual({
                    type: "change",
                    epoch,
                    changes: {
                        resources: [],
                        chatOrders: [],
                        chats: [
                            {
                                characterId: "c",
                                id: "k",
                                revision: body.chats[0].revision,
                                patch: {
                                    baseRevision,
                                    count: 2,
                                    messages: [{ after: "u", message: m("r", "checkpoint", "char") }],
                                },
                            },
                        ],
                    },
                });
        } finally {
            sockets.forEach((ws) => ws.close());
        }
    });
});
