// @vitest-environment node
import type http from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { ChatOp } from "../../../shared/chats.ts";
import type { EventFeedFrame } from "../../../shared/events.ts";
import { type CallbackResult, type GenerationEvent, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import type { MemoryControl, RunningJob } from "../jobs/generationJobs.ts";
import { allowListenerOrigin, createSigner, createTestServer, json, sleep, waitFor } from "./testSupport.ts";

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

describe("generation jobs over HTTP and WebSocket", () => {
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

    /**
     * Runs the test's steps as they arrive, until one returns `"end"` or the job is aborted. A job's
     * abort wakes its own run, so a job a test leaves running ends at teardown instead of waiting out
     * the abort grace.
     */
    const runner = async (job: RunningJob) => {
        const run = (async () => {
            let wakeSelf: (() => void) | null = null;
            const onAbort = () => wakeSelf?.();
            job.signal.addEventListener("abort", onAbort);
            try {
                for (;;) {
                    if (steps.length === 0) {
                        if (job.signal.aborted) {
                            return;
                        }
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                            wakeSelf = resolve;
                        });
                        wakeSelf = null;
                        continue;
                    }
                    const step = steps.shift()!;
                    if ((await step(job)) === ("end" as never)) {
                        return;
                    }
                }
            } finally {
                job.signal.removeEventListener("abort", onAbort);
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

    async function closeServer() {
        steps = [];
        wake = null;
        runners = [];
        await server?.close();
        if (node) {
            node.closeAllConnections();
            await new Promise((resolve) => node?.close(resolve));
            node = undefined;
        }
    }

    beforeAll(async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        // One boot, login, and seed before the first test: its cold cost (module code, the first
        // ECDSA key, SQLite, the sockets) stays out of every test's timeout.
        await listen();
        await closeServer();
    }, 60_000);
    afterAll(() => {
        vi.restoreAllMocks();
    });
    afterEach(closeServer);

    async function listen() {
        server = createTestServer({ password: "pw", generationRunner: runner });
        const started = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
        node = started;
        await new Promise<void>((resolve) => started.once("listening", () => resolve()));
        allowListenerOrigin(started);
        server.context.attachWebSocket(started);
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

    type Followed = { events: GenerationEvent[]; closed: Promise<number>; ws: WsClient; fence(): Promise<void> };
    /**
     * Opens the owner socket. It closes itself at the terminal (`done` or `error`) unless `keepOpen`;
     * `fence` resolves once every frame the server sent before it is in `events`.
     */
    async function follow(
        jobId: string,
        options: { clientId?: string; token?: string; attach?: number; keepOpen?: boolean } = {},
    ): Promise<Followed> {
        const token = options.token ?? (await signer.jwt());
        const query =
            `?risu-auth=${encodeURIComponent(token)}&clientId=${encodeURIComponent(options.clientId ?? "tab")}` +
            (options.attach === undefined ? "" : `&attach=${options.attach}`);
        const ws = new WsClient(`${base.replace("http", "ws")}/api/generations/${jobId}/ws${query}`);
        const events: GenerationEvent[] = [];
        const opened = new Promise<void>((resolve) => ws.once("open", () => resolve()));
        const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
        ws.on("message", (data) => {
            const event = JSON.parse(String(data)) as GenerationEvent;
            if (event.type !== "ping") {
                events.push(event);
            }
            if (!options.keepOpen && (event.type === "done" || event.type === "error")) {
                ws.close();
            }
        });
        ws.on("error", () => {});
        // Attached (the snapshot is on its way) or refused: emits after this cannot race the handshake.
        await Promise.race([opened, closed]);
        // The server answers a ping after the frames it sent before reading it, the attach batch included.
        const fence = () =>
            new Promise<void>((resolve, reject) => {
                if (ws.readyState !== WsClient.OPEN) {
                    reject(new Error("fence: the socket is not open"));
                    return;
                }
                const closed = () => reject(new Error("fence: the socket closed before the pong"));
                ws.once("close", closed);
                ws.once("pong", () => {
                    ws.off("close", closed);
                    resolve();
                });
                ws.ping();
            });
        return { events, closed, ws, fence };
    }
    const types = (events: GenerationEvent[]) => events.map((event) => event.type);
    const until = (followed: Followed, count: number) => waitFor(() => followed.events.length >= count);
    /** The stored text of message `id` as a `chatPatch` carries it (undefined when the patch lacks the row). */
    const rowText = (event: unknown, id: string): string | undefined =>
        (event as { messages?: { message: { chatId: string; data: string } }[] }).messages?.find(
            (row) => row.message.chatId === id,
        )?.message.data;
    /** A `chatPatch`'s rows as `[id, after, text]`. */
    const rows = (event: unknown) =>
        (
            (event as { messages?: { after: string | null; message: { chatId: string; data: string } }[] }).messages ??
            []
        ).map((row) => [row.message.chatId, row.after, row.message.data]);

    it("validates the body and needs a JWT (never the password) on every route", async () => {
        await listen();
        const body = { kind: "send", context: await context(), clientId: "tab" };
        expect((await fetch(`${base}/api/generations`, json(body))).status).toBe(400);
        // The stored password is not a JWT: `checkAuth` refuses it (its existing status for a token
        // that does not parse), on every route.
        for (const res of [
            await request("/api/generations", json(body), { jwt: "pw" }),
            await request("/api/generations/x?clientId=tab", {}, { jwt: "pw" }),
            await request("/api/generations/x?clientId=tab", { method: "DELETE" }, { jwt: "pw" }),
        ]) {
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).not.toBe(404);
        }
        for (const [bad, message] of [
            [{ ...body, kind: "dance" }, /kind must be one of/],
            [{ ...body, clientId: 5 }, /clientId/],
            [{ ...body, context: "x" }, /context must be an object/],
            [{ ...body, context: { ...body.context, chatId: "" } }, /characterId and chatId/],
            [{ ...body, context: { ...body.context, presetId: 1 } }, /presetId/],
            [{ ...body, context: { ...body.context, modelPresetId: 1 } }, /modelPresetId/],
            [{ ...body, context: { ...body.context, input: 1 } }, /mode and .*input/],
            [{ ...body, context: { ...body.context, chatRevision: null } }, /chatRevision/],
            [{ ...body, context: { ...body.context, triggerId: "" } }, /triggerId/],
        ] as [Record<string, unknown>, RegExp][]) {
            const res = await create(bad);
            expect(res.status, JSON.stringify(bad)).toBe(400);
            expect(res.body.error).toMatch(message);
        }
        expect((await request("/api/generations/x?clientId=tab")).status).toBe(404);
        expect((await request("/api/generations/x?clientId=tab", { method: "DELETE" })).status).toBe(404);
    });

    it("admits one job per chat, streams the chat hydration, accepted, chunks, and done to the owner with the epoch, and answers the status DTO", async () => {
        await listen();
        const ctx = await context();
        expect(await create({ kind: "send", context: ctx, clientId: "tab" }, { epoch: "nope" })).toMatchObject({
            status: 412,
            body: { error: "EpochMismatch", epoch },
        });
        expect((await create({ kind: "send", context: { ...ctx, chatId: "zz" }, clientId: "tab" })).status).toBe(404);
        expect(
            await create({ kind: "send", context: { ...ctx, chatRevision: `${epoch}:1:999` }, clientId: "tab" }),
        ).toMatchObject({
            status: 409,
            body: { error: "stale" },
        });
        const jobId = await createOk();
        // Busy before stale: a reloaded tab with an old revision learns the job id.
        expect(
            await create({ kind: "send", context: { ...ctx, chatRevision: `${epoch}:1:999` }, clientId: "other" }),
        ).toEqual({
            status: 409,
            body: { error: "chatBusy", jobId },
        });
        const owner = await follow(jobId);
        step((job) => {
            const applied = job.write(() => ({
                chats: [group(job.context.chatRevision, [{ op: "begin", id: "r", generationId: "g1" }])],
            }));
            job.emit({
                type: "accepted",
                jobId: job.id,
                messageId: "r",
                userMessageId: "u",
                generationId: "g1",
                revision: applied.chats[0].revision!,
                text: "",
            });
            job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "one", seq: 1 });
            job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "one two", seq: 2 });
            // Dropped: an older sequence and a foreign generation.
            job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "one", seq: 1 });
            job.emit({ type: "chunk", messageId: "r", generationId: "g0", text: "stale", seq: 9 });
            job.emit({ type: "preset", presetId: "p1" });
            job.emit({ type: "progress", payload: { stage: "x" } });
        });
        await until(owner, 7);
        const status = await (await request(`/api/generations/${jobId}?clientId=tab`)).json();
        expect(status).toEqual({
            jobId,
            kind: "send",
            characterId: "c",
            chatId: "k",
            epoch,
            state: "running",
            messageId: "r",
            generationId: "g1",
        });
        expect((await request(`/api/generations/${jobId}?clientId=other`)).status).toBe(404);
        step((job) => {
            const applied = job.write(
                () => ({ chats: [group(job.context.chatRevision, [checkpoint(1, "one two", true)])] }),
                { covers: [{ messageId: "r", generationId: "g1", seq: 2 }] },
            );
            job.emit({ type: "done", revision: applied.chats[0].revision, messageId: "r" });
            return "end" as never;
        });
        const code = await owner.closed;
        expect(code).not.toBe(4001);
        // The attach snapshot, then the hydration that precedes every `accepted`, then the stream,
        // then the terminal hydration and the result. The job chat's events are `chatPatch`es: the
        // change since the copy a socket last took.
        expect(types(owner.events)).toEqual([
            "chatPatch",
            "chatPatch",
            "accepted",
            "chunk",
            "chunk",
            "preset",
            "progress",
            "chatPatch",
            "done",
        ]);
        expect(owner.events.every((event) => "epoch" in event && event.epoch === epoch)).toBe(true);
        const [snapshot, hydration, accepted, first, second, , , finalChat, done] = owner.events as any[];
        // The attach snapshot: from the admission copy (the revision the owner named) to itself.
        expect(snapshot).toMatchObject({
            type: "chatPatch",
            characterId: "c",
            id: "k",
            baseRevision: ctx.chatRevision,
            revision: ctx.chatRevision,
            count: 2,
            streaming: [],
        });
        expect(snapshot).not.toHaveProperty("messages");
        expect(snapshot).not.toHaveProperty("meta");
        expect(snapshot).not.toHaveProperty("removed");
        // The hydration before `accepted`: the reply's row (the job began its generation on it), after `u`.
        expect(hydration).toMatchObject({
            type: "chatPatch",
            characterId: "c",
            id: "k",
            baseRevision: ctx.chatRevision,
            revision: accepted.revision,
            count: 2,
            streaming: [{ messageId: "r", generationId: "g1", seq: 0 }],
        });
        expect(rows(hydration)).toEqual([["r", "u", ""]]);
        expect(accepted).toMatchObject({ messageId: "r", userMessageId: "u", generationId: "g1", seq: 0, text: "" });
        // The chunks are deltas from the text the socket holds: `accepted`'s (seq 0), then the first chunk's.
        expect(first).toEqual({
            type: "chunk",
            epoch,
            messageId: "r",
            generationId: "g1",
            seq: 1,
            base: 0,
            keep: 0,
            text: "one",
        });
        expect(second).toEqual({
            type: "chunk",
            epoch,
            messageId: "r",
            generationId: "g1",
            seq: 2,
            base: 1,
            keep: 3,
            text: " two",
        });
        const afterFirst = accepted.text.slice(0, first.keep) + first.text;
        expect(afterFirst.slice(0, second.keep) + second.text).toBe("one two");
        // The terminal hydration: the reply is final, so nothing is streaming any more; its stored
        // text comes along (a generated row is always carried).
        expect(finalChat).toMatchObject({ type: "chatPatch", baseRevision: hydration.revision, streaming: [] });
        expect(rowText(finalChat, "r")).toBe("one two");
        expect(done).toMatchObject({ type: "done", messageId: "r", revision: finalChat.revision });
        expect(await (await request(`/api/generations/${jobId}?clientId=tab`)).json()).toMatchObject({
            state: "ended",
            terminal: { type: "done" },
        });
        // The slot is free: a new job on the chat is admitted.
        expect((await create({ kind: "send", context: await context(), clientId: "tab" })).status).toBe(200);
    });

    it("keeps one delivery stream per job, orders handshakes by their attach stamp, replays the latest stage on attach, and refuses the password, another client, and an unknown job", async () => {
        await listen();
        const jobId = await createOk();
        step((job) => {
            job.emit({ type: "progress", payload: 1 });
            job.emit({ type: "stage", stage: "preparing" });
        });
        expect(await (await follow(jobId, { token: "pw" })).closed).not.toBe(1000);
        expect(await (await follow(jobId, { clientId: "other" })).closed).not.toBe(1000);
        expect(await (await follow("unknown")).closed).not.toBe(1000);
        const a = await follow(jobId, { attach: 5 });
        await a.fence();
        expect(a.events.filter((event) => event.type === "stage")).toEqual([
            { type: "stage", epoch, stage: "preparing" },
        ]);
        // An older stamp never displaces the newest attachment: refused, and `a` keeps the stream.
        const b = await follow(jobId, { attach: 3 });
        expect(await b.closed).not.toBe(1000);
        expect(b.events).toEqual([]);
        step((job) => {
            job.emit({ type: "stage", stage: "memory" });
            job.emit({ type: "progress", payload: 2 });
        });
        await until(a, 4);
        expect(types(a.events)).toEqual(["chatPatch", "stage", "stage", "progress"]);
        // A newer stamp supersedes: `a` is closed with 4001 and `c` gets the fresh snapshot.
        const c = await follow(jobId, { attach: 6 });
        expect(await a.closed).toBe(4001);
        await c.fence();
        expect(c.events.filter((event) => event.type === "stage")).toEqual([{ type: "stage", epoch, stage: "memory" }]);
        step((job) => {
            job.emit({ type: "progress", payload: 3 });
        });
        await until(c, 3);
        expect(types(c.events)).toEqual(["chatPatch", "stage", "progress"]);
        expect(a.events).toHaveLength(4);
        c.ws.close();
        await c.closed;
        // The runner reaches the owner's messages through `onClientMessage`.
        const received: unknown[] = [];
        step((job) => {
            job.onClientMessage((message) => received.push(message));
        });
        // A handshake without a stamp is stamp 0: older than 6, so it would be refused.
        expect(await (await follow(jobId)).closed).not.toBe(1000);
        const d = await follow(jobId, { attach: 7 });
        await d.fence();
        d.ws.send(JSON.stringify({ answer: 42 }));
        d.ws.send("not json");
        await waitFor(() => received.length >= 1);
        expect(received).toEqual([{ answer: 42 }]);
        step((job) => {
            job.emit({ type: "done", revision: null });
            return "end" as never;
        });
        await d.closed;
    });

    it("publishes each applied write's coverage, retires the reply at its final, and re-sends the fresh records and the result on every attach", async () => {
        await listen();
        const jobId = await createOk();
        const snapshot = async () => {
            const f = await follow(jobId, { keepOpen: true });
            await f.fence();
            f.ws.close();
            await f.closed;
            return f.events as any[];
        };
        // A chunk ahead of the stored text, then a checkpoint claiming it.
        step((job) => {
            job.write(() => ({
                chats: [group(job.context.chatRevision, [{ op: "begin", id: "r", generationId: "g1" }])],
            }));
            job.emit({
                type: "accepted",
                jobId: job.id,
                messageId: "r",
                generationId: "g1",
                revision: job.context.chatRevision,
                text: "",
            });
            job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "ten", seq: 10 });
            job.emitRecords({ refs: [{ kind: "characters", id: "c" }] });
            job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(1, "processed ten")])] }), {
                covers: [{ messageId: "r", generationId: "g1", seq: 10 }],
            });
        });
        await sleep(50);
        let events = await snapshot();
        // The job chat as a patch (the events while no socket was open did not move its base: the
        // admission copy), the record whole, the current reply.
        expect(types(events)).toEqual(["chatPatch", "resource", "accepted"]);
        expect(events[0]).toMatchObject({
            type: "chatPatch",
            streaming: [{ messageId: "r", generationId: "g1", seq: 10 }],
        });
        expect(rowText(events[0], "r")).toBe("processed ten");
        let handed = events[0].revision as string;
        expect(events[1]).toMatchObject({ kind: "characters", id: "c", data: { chaId: "c", name: "C" } });
        expect(events[2]).toMatchObject({ type: "accepted", text: "ten", seq: 10 });
        // A replacement without `covers` claims 0; a lower claim replaces a higher one. The tracked
        // record is read fresh on each attach.
        await request("/api/resources/characters/c", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ baseRevision: events[1].revision, data: { chaId: "c", name: "C renamed" } }),
        });
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(2, "uncovered")])] }));
        });
        await sleep(50);
        events = await snapshot();
        expect(types(events)).toEqual(["chatPatch", "resource", "accepted"]);
        expect(events[0].streaming).toEqual([{ messageId: "r", generationId: "g1", seq: 0 }]);
        // Each attach's patch is based on the copy the previous attach handed over.
        expect(events[0].baseRevision).toBe(handed);
        expect(rowText(events[0], "r")).toBe("uncovered");
        handed = events[0].revision;
        expect(events[1]).toMatchObject({ kind: "characters", data: { name: "C renamed" } });
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(3, "captured five")])] }), {
                covers: [{ messageId: "r", generationId: "g1", seq: 5 }],
            });
        });
        await sleep(50);
        events = await snapshot();
        expect(types(events)).toEqual(["chatPatch", "resource", "accepted"]);
        expect(events[0].streaming).toEqual([{ messageId: "r", generationId: "g1", seq: 5 }]);
        expect(events[0].baseRevision).toBe(handed);
        handed = events[0].revision;
        // An ignored write (a foreign generation) publishes nothing.
        step((job) => {
            expect(
                job.write(
                    () => ({ chats: [group(job.context.chatRevision, [checkpoint(9, "foreign", false, "g0")])] }),
                    { covers: [{ messageId: "r", generationId: "g0", seq: 99 }] },
                ).chats[0].checkpoints,
            ).toEqual(["ignored"]);
        });
        await sleep(50);
        events = await snapshot();
        expect(types(events)).toEqual(["chatPatch", "resource", "accepted"]);
        expect(events[0].streaming).toEqual([{ messageId: "r", generationId: "g1", seq: 5 }]);
        // The final: the reply is no longer streaming, and the job (still running) sends no `accepted`.
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(4, "final text", true)])] }));
        });
        await sleep(50);
        events = await snapshot();
        expect(types(events)).toEqual(["chatPatch", "resource"]);
        expect(events[0].streaming).toEqual([]);
        expect(rowText(events[0], "r")).toBe("final text");
        expect(await (await request(`/api/generations/${jobId}?clientId=tab`)).json()).not.toHaveProperty("messageId");
        // After the end: the job chat whole (no patch base is kept for an ended job), the fresh
        // records, and the terminal event.
        step((job) => {
            job.emit({ type: "done", revision: null, messageId: "r", alternatives: ["alt"] });
            return "end" as never;
        });
        await sleep(50);
        events = await snapshot();
        expect(types(events)).toEqual(["resource", "resource", "done"]);
        expect(events[0]).toMatchObject({ kind: "chats", characterId: "c", id: "k", streaming: [] });
        expect(events[0].data.message[1].data).toBe("final text");
        expect(events[2]).toMatchObject({ messageId: "r", alternatives: ["alt"], epoch });
    });

    it("DELETE aborts the owner's job: the runner persists the text so far, the owner gets error 499, and the lock is released", async () => {
        await listen();
        const jobId = await createOk();
        const owner = await follow(jobId);
        step(async (job) => {
            job.write(() => ({
                chats: [group(job.context.chatRevision, [{ op: "begin", id: "r", generationId: "g1" }])],
            }));
            job.emit({
                type: "accepted",
                jobId: job.id,
                messageId: "r",
                generationId: "g1",
                revision: job.context.chatRevision,
                text: "",
            });
            // Three checkpoints, then nothing until the abort: no write can land between the
            // test's revision read and its refused edit.
            let seq = 0;
            for (; seq < 3; seq += 1) {
                job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: `t${seq + 1}`, seq: seq + 1 });
                job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(seq + 1, `t${seq + 1}`)])] }));
            }
            await new Promise<void>((resolve) => {
                if (job.signal.aborted) {
                    resolve();
                } else {
                    job.signal.addEventListener("abort", () => resolve());
                }
            });
            job.write(() => ({
                chats: [group(job.context.chatRevision, [checkpoint(seq + 1, `t${seq} stopped`, true)])],
            }));
            return "end" as never;
        });
        await until(owner, 5);
        // The locked reply is refused for a client meanwhile, with reason generating.
        const current = await revision();
        const refused = await request(
            "/api/resources/batch",
            json({ chats: [group(current.revision, [{ op: "setText", id: "r", text: "mine" }])] }),
        );
        expect(refused.status).toBe(409);
        expect(((await refused.json()) as { conflicts: unknown[] }).conflicts).toEqual([
            {
                kind: "chat",
                characterId: "c",
                id: "k",
                revision: current.revision,
                reason: "generating",
                messageIds: ["r"],
            },
        ]);
        expect((await request(`/api/generations/${jobId}?clientId=other`, { method: "DELETE" })).status).toBe(404);
        const aborted = await request(`/api/generations/${jobId}?clientId=tab`, { method: "DELETE" });
        expect(await aborted.json()).toEqual({ aborted: true });
        await owner.closed;
        const last = owner.events.at(-1)!;
        expect(last).toMatchObject({ type: "error", reason: "aborted", status: 499, epoch });
        const terminalChat = owner.events.at(-2) as any;
        expect(terminalChat).toMatchObject({ type: "chatPatch", characterId: "c", id: "k", streaming: [] });
        expect(rowText(terminalChat, "r")).toBe("t3 stopped");
        expect(await (await request(`/api/generations/${jobId}?clientId=tab`, { method: "DELETE" })).json()).toEqual({
            aborted: false,
        });
        expect(await (await request(`/api/generations/${jobId}?clientId=tab`)).json()).toMatchObject({
            state: "ended",
            terminal: { type: "error", reason: "aborted" },
        });
        const after = await revision();
        expect(after.data.message[1].data).toBe(rowText(terminalChat, "r"));
        const edit = await request(
            "/api/resources/batch",
            json({ chats: [group(after.revision, [{ op: "setText", id: "r", text: "mine" }])] }),
        );
        expect(edit.status).toBe(200);
    });

    it("POST memory-stop stops the owner's registered memory run after a valid body and the epoch check: 400 for a malformed body, 404 for another client or job, 409 for another run, no run, or an ended job", async () => {
        await listen();
        const jobId = await createOk();
        let control: MemoryControl | undefined;
        step((job) => {
            control = job.registerMemoryControl!("run-1");
        });
        await waitFor(() => control !== undefined);
        const stop = (
            body: unknown,
            options: { epoch?: string | null; jwt?: string } = {},
            id = jobId,
            clientId = "tab",
        ) => request(`/api/generations/${id}/memory-stop?clientId=${clientId}`, json(body), options);
        const status = async (res: Response) => [res.status, await res.json()] as const;

        // The password is not a JWT: refused before the body, on this route as on the others.
        const denied = await stop({ runId: "run-1" }, { jwt: "pw" });
        expect(denied.status).toBeGreaterThanOrEqual(400);
        expect(denied.status).not.toBe(404);
        for (const bad of ["run-1", { runId: 5 }, {}, { runId: "not a run id!" }, { runId: "x".repeat(65) }]) {
            const res = await stop(bad);
            expect(res.status, JSON.stringify(bad)).toBe(400);
        }
        expect(await status(await stop({ runId: "run-1" }, { epoch: "other" }))).toEqual([
            412,
            { error: "EpochMismatch", epoch },
        ]);
        expect((await stop({ runId: "run-1" }, {}, jobId, "other")).status).toBe(404);
        expect((await stop({ runId: "run-1" }, {}, "nope")).status).toBe(404);
        expect(await status(await stop({ runId: "run-2" }))).toEqual([409, { error: "otherMemoryRun" }]);
        expect(control!.stopRequested()).toBe(false);

        const stopped = await stop({ runId: "run-1" });
        expect(stopped.headers.get("cache-control")).toBe("no-store");
        expect(await status(stopped)).toEqual([200, { stopped: true }]);
        expect(control!.stopRequested()).toBe(true);
        expect(await status(await stop({ runId: "run-1" }))).toEqual([200, { stopped: true }]);
        control!.release();
        expect(await status(await stop({ runId: "run-1" }))).toEqual([409, { error: "noMemoryRun" }]);

        step((job) => {
            job.registerMemoryControl!("run-3");
            job.emit({ type: "accepted", jobId: job.id, revision: job.context.chatRevision, text: "" });
            job.emit({ type: "done", revision: job.context.chatRevision });
            return "end" as never;
        });
        await waitFor(
            async () =>
                ((await (await request(`/api/generations/${jobId}?clientId=tab`)).json()) as { state: string })
                    .state === "ended",
        );
        expect(await status(await stop({ runId: "run-3" }))).toEqual([409, { error: "jobEnded" }]);
    });

    it("POST drained frees the lane a callback the job's abort cancelled kept, so the owner's next job gets its callback: auth before the body, 400 for a malformed body, 404 for another client or job, `{ drained: false }` for a callback that holds none, `{ drained: true }` once, also after the job ended", async () => {
        await listen();
        const hooks = { ...NO_GENERATION_HOOKS, scripts: ["editoutput"] };
        const command = { type: "button", data: "" };
        const first = await create({ kind: "command", command, context: await context(), clientId: "tab", hooks });
        expect(first.status).toBe(200);
        const jobId = first.body.jobId as string;
        const owner = await follow(jobId, { keepOpen: true });
        const outcome: { first?: CallbackResult; second?: CallbackResult } = {};
        step(async (job) => {
            outcome.first = await job.channel.callback("editoutput", { text: "t" });
        });
        await waitFor(() => owner.events.some((event) => event.type === "callback"));
        const callbackId = (owner.events.find((event) => event.type === "callback") as { id: string }).id;
        const drained = (
            body: unknown,
            options: { epoch?: string | null; jwt?: string } = {},
            id = jobId,
            clientId = "tab",
        ) => request(`/api/generations/${id}/drained?clientId=${clientId}`, json(body), options);
        const status = async (res: Response) => [res.status, await res.json()] as const;
        // A callback the server still waits for holds no lane.
        expect(await status(await drained({ callbackId }))).toEqual([200, { drained: false }]);

        // Stop: the job ends, the owner is told to cancel the callback, and the lane stays held for
        // it (its hook may still run in the tab), although the job ended.
        expect((await request(`/api/generations/${jobId}?clientId=tab`, { method: "DELETE" })).status).toBe(200);
        await waitFor(() => owner.events.some((event) => event.type === "error"));
        expect(outcome.first).toMatchObject({ outcome: "aborted" });
        expect(types(owner.events)).toContain("cancel");
        // The owner's next job, in another chat: its root callback waits behind the held lane.
        const seeded = await request(
            "/api/resources/batch",
            json({
                chats: [
                    {
                        characterId: "c",
                        chatId: "k2",
                        baseRevision: null,
                        ops: [
                            {
                                op: "create",
                                chat: {
                                    name: "K2",
                                    modelPresetId: bound.modelPresetId,
                                    promptPresetId: bound.presetId,
                                    bindedPersona: bound.personaId,
                                    message: [m("u2", "hi")],
                                },
                            },
                        ],
                    },
                ],
            }),
        );
        expect(seeded.status).toBe(200);
        const read = await request("/api/resources/read", json({ chats: [{ characterId: "c", id: "k2" }] }));
        const chatRevision = ((await read.json()) as { chats: { revision: string }[] }).chats[0].revision;
        const second = await create({
            kind: "command",
            command,
            context: { ...(await context()), chatId: "k2", chatRevision },
            clientId: "tab",
            hooks,
        });
        expect(second.status).toBe(200);
        const nextJob = second.body.jobId as string;
        const next = await follow(nextJob, { keepOpen: true });
        step(async (job) => {
            outcome.second = await job.channel.callback("editoutput", { text: "u" });
            job.emit({ type: "accepted", jobId: job.id, revision: job.context.chatRevision, text: "" });
            job.emit({ type: "done", revision: job.context.chatRevision });
            return "end" as never;
        });

        // The password is not a JWT: refused before the body, on this route as on the others.
        const denied = await drained({ callbackId }, { jwt: "pw" });
        expect(denied.status).toBeGreaterThanOrEqual(400);
        expect(denied.status).not.toBe(404);
        for (const bad of [
            "cb",
            { callbackId: 5 },
            {},
            { callbackId: "not a callback id!" },
            { callbackId: "x".repeat(65) },
        ]) {
            const res = await drained(bad);
            expect(res.status, JSON.stringify(bad)).toBe(400);
        }
        expect((await drained({ callbackId }, {}, jobId, "other")).status).toBe(404);
        expect((await drained({ callbackId }, {}, "nope")).status).toBe(404);
        expect(await status(await drained({ callbackId }, {}, nextJob))).toEqual([200, { drained: false }]);
        expect(await status(await drained({ callbackId: "unknown" }))).toEqual([200, { drained: false }]);
        // Nothing above released the lane: the next job's callback has not been sent.
        await next.fence();
        expect(types(next.events)).not.toContain("callback");

        const freed = await drained({ callbackId });
        expect(freed.headers.get("cache-control")).toBe("no-store");
        expect(await status(freed)).toEqual([200, { drained: true }]);
        await waitFor(() => next.events.some((event) => event.type === "callback"));
        expect(await status(await drained({ callbackId }))).toEqual([200, { drained: false }]);
        const nextCallback = next.events.find((event) => event.type === "callback") as { id: string };
        next.ws.send(JSON.stringify({ type: "answer", id: nextCallback.id, outcome: "answered", value: "v" }));
        await waitFor(() => next.events.some((event) => event.type === "done"));
        expect(outcome.second).toEqual({ outcome: "answered", value: "v" });
        owner.ws.close();
        next.ws.close();
    });

    it("runs a command job without a message, in the chat's slot", async () => {
        await listen();
        const jobId = await createOk("command");
        expect((await create({ kind: "send", context: await context(), clientId: "tab" })).status).toBe(409);
        const owner = await follow(jobId);
        step((job) => {
            job.emit({ type: "accepted", jobId: job.id, revision: job.context.chatRevision, text: "" });
            job.emit({ type: "done", revision: job.context.chatRevision });
            return "end" as never;
        });
        await owner.closed;
        expect(types(owner.events)).toEqual(["chatPatch", "chatPatch", "accepted", "chatPatch", "done"]);
        // A job that writes nothing transfers no message: each patch is the count alone.
        for (const index of [0, 1, 3]) {
            expect(owner.events[index]).toMatchObject({ count: 2, streaming: [] });
            expect(owner.events[index]).not.toHaveProperty("messages");
            expect(owner.events[index]).not.toHaveProperty("meta");
            expect(owner.events[index]).not.toHaveProperty("removed");
        }
        expect(owner.events[2]).not.toHaveProperty("messageId");
        expect(owner.events[2]).toMatchObject({ seq: 0 });
        expect(owner.events[4]).not.toHaveProperty("messageId");
    });

    it("validates form commands and preserves an own __proto__ field as runner data", async () => {
        await listen();
        const body = { kind: "command", clientId: "tab", context: await context() };
        const form = { type: "form", key: "survey", values: { answer: "yes" } };
        // Multibyte text crosses 64 KiB while remaining below 64 Ki characters.
        const tooLarge = "한".repeat(Math.floor((64 * 1024) / 3) + 1);
        const invalid = [
            ["missing key", { type: "form", values: {} }],
            ["non-string key", { ...form, key: 1 }],
            ["missing values", { type: "form", key: "survey" }],
            ["null values", { ...form, values: null }],
            ["array values", { ...form, values: [] }],
            ["string values", { ...form, values: "yes" }],
            ["non-string value", { ...form, values: { answer: 1 } }],
            ["non-string array member", { ...form, values: { answer: ["yes", 1] } }],
            ["key over 64 KiB UTF-8", { ...form, key: tooLarge }],
            ["values JSON over 64 KiB UTF-8", { ...form, values: { answer: tooLarge } }],
        ] as const;
        for (const [reason, command] of invalid) {
            expect((await create({ ...body, command })).status, reason).toBe(400);
        }

        const command = {
            type: "form",
            key: "survey",
            values: { answer: "yes", choices: ["", "second"], ["__proto__"]: ["kept", "as data"] },
        };
        let receive!: (command: RunningJob["command"]) => void;
        const received = new Promise<RunningJob["command"]>((resolve) => {
            receive = resolve;
        });
        step((job) => receive(job.command));
        expect((await create({ ...body, command })).status).toBe(200);
        const actual = await received;
        expect(actual).toEqual(command);
        if (actual?.type !== "form") {
            throw new Error("The runner did not receive a form command");
        }
        expect(Object.hasOwn(actual.values, "__proto__")).toBe(true);
        expect(actual.values.__proto__).toEqual(["kept", "as data"]);
        expect(Object.getPrototypeOf(actual.values)).not.toEqual(["kept", "as data"]);
    });

    it("refuses a form command while its chat has a running job", async () => {
        await listen();
        const jobId = await createOk();
        expect(
            await create({
                kind: "command",
                clientId: "tab",
                context: await context(),
                command: { type: "form", key: "survey", values: { answer: "yes" } },
            }),
        ).toEqual({ status: 409, body: { error: "chatBusy", jobId } });
    });

    it("sends the job chat as a patch from the copy a socket last took (rows with their anchor, removed ids, the meta when it changed), whole on `resync`, on a reorder, and after the end; an event no socket took does not move the base", async () => {
        await listen();
        const chatRef = { characterId: "c", id: "k" };
        const jobId = await createOk();
        const admitted = (await revision()).revision;
        let owner = await follow(jobId);
        await until(owner, 1);
        expect(owner.events[0]).toMatchObject({
            type: "chatPatch",
            baseRevision: admitted,
            revision: admitted,
            count: 2,
            streaming: [],
        });
        expect(owner.events[0]).not.toHaveProperty("messages");
        // A write the runner publishes: the new message and the reply the job began, each after its
        // predecessor in stored order; the meta did not change. The receipt names the patch's revision.
        const receipts: unknown[] = [];
        step((job) => {
            job.write(() => ({
                chats: [
                    group(job.context.chatRevision, [
                        { op: "append", messages: [m("u2", "second")], anchor: { after: "u" } },
                        { op: "begin", id: "r", generationId: "g1" },
                    ]),
                ],
            }));
            receipts.push(...job.emitRecords({ chats: [chatRef] }));
        });
        await until(owner, 2);
        const first = owner.events[1] as any;
        expect(first).toMatchObject({
            type: "chatPatch",
            characterId: "c",
            id: "k",
            baseRevision: admitted,
            count: 3,
            streaming: [{ messageId: "r", generationId: "g1", seq: 0 }],
        });
        expect(rows(first)).toEqual([
            ["u2", "u", "second"],
            ["r", "u2", ""],
        ]);
        expect(first).not.toHaveProperty("meta");
        expect(first).not.toHaveProperty("removed");
        expect(receipts).toEqual([{ kind: "chats", id: "k", characterId: "c", revision: first.revision }]);
        // The meta, whole, only when it changed; the generated reply's row comes along every time.
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [{ op: "meta", set: { note: "noted" } }])] }));
            job.emitRecords({ chats: [chatRef] });
        });
        await until(owner, 3);
        const second = owner.events[2] as any;
        expect(second).toMatchObject({
            type: "chatPatch",
            baseRevision: first.revision,
            count: 3,
            meta: { id: "k", name: "K", note: "noted" },
        });
        expect(second.meta).not.toHaveProperty("message");
        expect(rows(second)).toEqual([["r", "u2", ""]]);
        // A removal: the id, and the reply's anchor moves to its surviving predecessor.
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [{ op: "remove", ids: ["u2"] }])] }));
            job.emitRecords({ chats: [chatRef] });
        });
        await until(owner, 4);
        const third = owner.events[3] as any;
        expect(third).toMatchObject({ type: "chatPatch", baseRevision: second.revision, removed: ["u2"], count: 2 });
        expect(rows(third)).toEqual([["r", "u", ""]]);
        expect(third).not.toHaveProperty("meta");
        // No socket: the checkpoint's event is lost and the base stays at the last copy a socket
        // took, so the next attach's patch carries the checkpoint.
        owner.ws.close();
        await owner.closed;
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(1, "one")])] }), {
                covers: [{ messageId: "r", generationId: "g1", seq: 1 }],
            });
            job.emitRecords({ chats: [chatRef] });
        });
        await sleep(50);
        owner = await follow(jobId);
        await until(owner, 1);
        const reattached = owner.events[0] as any;
        expect(reattached).toMatchObject({
            type: "chatPatch",
            baseRevision: third.revision,
            count: 2,
            streaming: [{ messageId: "r", generationId: "g1", seq: 1 }],
        });
        expect(rows(reattached)).toEqual([["r", "u", "one"]]);
        // `resync` from the current socket: the chat whole, and the next patch is based on that copy.
        owner.ws.send(JSON.stringify({ type: "resync" }));
        await until(owner, 2);
        const whole = owner.events[1] as any;
        expect(whole).toMatchObject({
            type: "resource",
            kind: "chats",
            characterId: "c",
            id: "k",
            revision: reattached.revision,
            streaming: [{ messageId: "r", generationId: "g1", seq: 1 }],
        });
        expect(whole.data.message.map((x: any) => [x.chatId, x.data])).toEqual([
            ["u", "hi"],
            ["r", "one"],
        ]);
        expect(whole.data.note).toBe("noted");
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(2, "one two")])] }), {
                covers: [{ messageId: "r", generationId: "g1", seq: 2 }],
            });
            job.emitRecords({ chats: [chatRef] });
        });
        await until(owner, 3);
        expect(owner.events[2]).toMatchObject({ type: "chatPatch", baseRevision: whole.revision, count: 2 });
        expect(rows(owner.events[2])).toEqual([["r", "u", "one two"]]);
        // A reorder of the surviving messages (a trigger's `replace`): the chat goes whole.
        step(async (job) => {
            const current = await revision();
            const reordered = { ...current.data, message: [current.data.message[1], current.data.message[0]] };
            job.write(() => ({ chats: [group(current.revision, [{ op: "replace", chat: reordered as never }])] }));
            job.emitRecords({ chats: [chatRef] });
        });
        await until(owner, 4);
        const reorder = owner.events[3] as any;
        expect(reorder).toMatchObject({ type: "resource", kind: "chats", characterId: "c", id: "k" });
        expect(reorder.data.message.map((x: any) => x.chatId)).toEqual(["r", "u"]);
        // The end: the terminal patch from that whole copy, then the result. An attach after the end
        // gets the chat whole.
        step((job) => {
            job.emit({ type: "done", revision: null });
            return "end" as never;
        });
        await owner.closed;
        expect(types(owner.events.slice(4))).toEqual(["chatPatch", "done"]);
        expect(owner.events[4]).toMatchObject({
            type: "chatPatch",
            baseRevision: reorder.revision,
            revision: reorder.revision,
            count: 2,
            streaming: [],
        });
        const after = await follow(jobId);
        await after.closed;
        expect(types(after.events)).toEqual(["resource", "done"]);
        expect(after.events[0]).toMatchObject({ type: "resource", kind: "chats", characterId: "c", id: "k" });
    });

    it("answers `resync` with the chat whole and then the current reply while its generation still owns the message (a command job's `accepted` too), and with the chat alone once the reply is final", async () => {
        await listen();
        const jobId = await createOk();
        const owner = await follow(jobId);
        step((job) => {
            job.write(() => ({
                chats: [group(job.context.chatRevision, [{ op: "begin", id: "r", generationId: "g1" }])],
            }));
            job.emit({
                type: "accepted",
                jobId: job.id,
                messageId: "r",
                generationId: "g1",
                revision: job.context.chatRevision,
                text: "",
            });
            job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "so far", seq: 2 });
        });
        await until(owner, 4);
        expect(types(owner.events)).toEqual(["chatPatch", "chatPatch", "accepted", "chunk"]);
        owner.ws.send(JSON.stringify({ type: "resync" }));
        await until(owner, 6);
        expect(types(owner.events.slice(4))).toEqual(["resource", "accepted"]);
        expect(owner.events[4]).toMatchObject({
            kind: "chats",
            streaming: [{ messageId: "r", generationId: "g1", seq: 0 }],
        });
        // The newest chunk's text and sequence, as an attach replays it.
        expect(owner.events[5]).toMatchObject({ messageId: "r", generationId: "g1", text: "so far", seq: 2 });
        // The reply's final write releases it: a resync brings the chat alone.
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(3, "final", true)])] }));
        });
        await sleep(50);
        owner.ws.send(JSON.stringify({ type: "resync" }));
        await until(owner, 7);
        await owner.fence();
        expect(types(owner.events.slice(6))).toEqual(["resource"]);
        expect((owner.events[6] as any).streaming).toEqual([]);
        expect((owner.events[6] as any).data.message[1].data).toBe("final");
        // A resync of another client's socket, or after the end, is ignored.
        step((job) => {
            job.emit({ type: "done", revision: null, messageId: "r" });
            return "end" as never;
        });
        await owner.closed;
        expect(types(owner.events.slice(7))).toEqual(["chatPatch", "done"]);

        // A command job: its `accepted` has no message, and comes back after the whole chat.
        const command = await createOk("command");
        const commander = await follow(command);
        step((job) => {
            job.emit({ type: "accepted", jobId: job.id, revision: job.context.chatRevision, text: "" });
        });
        await until(commander, 3);
        commander.ws.send(JSON.stringify({ type: "resync" }));
        await until(commander, 5);
        expect(types(commander.events)).toEqual(["chatPatch", "chatPatch", "accepted", "resource", "accepted"]);
        expect(commander.events[4]).not.toHaveProperty("messageId");
        step((job) => {
            job.emit({ type: "done", revision: null });
            return "end" as never;
        });
        await commander.closed;
    });

    it("includes another tab's running job locks and the current stored revision in the feed hello, then omits them after the job ends", async () => {
        // Freeze the job's expiry clock and the socket heartbeat while the runner waits for work.
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        try {
            await listen();
            const running = new Promise<RunningJob>((resolve) => step(resolve));
            await createOk("command", "other-tab");
            const job = await running;
            const written = job.write(
                () => ({
                    chats: [
                        group(job.context.chatRevision, [
                            { op: "begin", id: "r", generationId: "g1" },
                            checkpoint(1, "waiting for provider"),
                        ]),
                    ],
                }),
                { covers: [{ messageId: "r", generationId: "g1", seq: 3 }] },
            );
            // A later metadata write makes the stored revision differ from the job's last write.
            const updated = await request(
                "/api/resources/batch",
                json({
                    chats: [group(written.chats[0].revision, [{ op: "meta", set: { note: "another writer" } }])],
                }),
            );
            expect(updated.status).toBe(200);
            const stored = await revision();
            expect(stored.revision).not.toBe(written.chats[0].revision);

            const readHello = async () => {
                const ws = new WsClient(`${base.replace("http", "ws")}/api/events/ws?risu-auth=${await signer.jwt()}`);
                const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
                try {
                    return await new Promise<EventFeedFrame>((resolve, reject) => {
                        ws.once("message", (data) => resolve(JSON.parse(String(data)) as EventFeedFrame));
                        ws.once("error", reject);
                        ws.once("close", () => reject(new Error("feed closed before hello")));
                    });
                } finally {
                    ws.terminate();
                    await closed;
                }
            };

            expect(await readHello()).toMatchObject({
                type: "hello",
                epoch,
                streaming: [
                    {
                        characterId: "c",
                        id: "k",
                        streaming: [{ messageId: "r", generationId: "g1", seq: 3 }],
                        revision: stored.revision,
                    },
                ],
            });
            // Ending without a final write releases ownership while the stored chat stays put.
            job.emit({ type: "done", revision: stored.revision });
            step(() => "end" as never);
            expect(await readHello()).toMatchObject({ type: "hello", epoch, streaming: [] });
        } finally {
            await closeServer();
            vi.useRealTimers();
        }
    });

    it("dispatches upgrades by path: an unknown path is destroyed, the live-update socket works beside the generation socket, and shutdown removes the listener", async () => {
        await listen();
        const unknown = await new Promise<string>((resolve) => {
            const ws = new WebSocket(`${base.replace("http", "ws")}/nowhere/ws`);
            ws.onopen = () => resolve("open");
            ws.onerror = () => {};
            ws.onclose = () => resolve("closed");
        });
        expect(unknown).toBe("closed");
        // The live-update socket on the same dispatcher: a JWT is admitted and gets `hello`.
        const feedFrames: { type: string; epoch?: string }[] = [];
        let feedOpened = false;
        const feedJwt = await signer.jwt();
        const feedClosed = new Promise<number>((resolve) => {
            const ws = new WebSocket(`${base.replace("http", "ws")}/api/events/ws?risu-auth=${feedJwt}`);
            ws.onopen = () => {
                feedOpened = true;
            };
            ws.onmessage = (message) => feedFrames.push(JSON.parse(String(message.data)));
            ws.onerror = () => {};
            ws.onclose = (event) => resolve(event.code);
        });
        await waitFor(() => feedFrames.length > 0);
        expect(feedOpened).toBe(true);
        expect(feedFrames[0]).toEqual({ type: "hello", epoch, streaming: [], memoryTasks: [] });
        const generation = await createOk();
        const owner = await follow(generation);
        await until(owner, 1);
        // A job's write (the runner's in-process `applyChanges` with its token) is a commit: the
        // feed socket sees the chat change with the revision the write returned.
        let written = "";
        step((job) => {
            written = job.write(() => ({
                chats: [group(job.context.chatRevision, [{ op: "begin", id: "r", generationId: "g1" }])],
            })).chats[0].revision!;
        });
        await waitFor(() => feedFrames.some((frame) => frame.type === "change"));
        expect(feedFrames.find((frame) => frame.type === "change")).toMatchObject({
            epoch,
            changes: { resources: [], chats: [{ characterId: "c", id: "k", revision: written }], chatOrders: [] },
        });
        server.context.beginShutdown();
        expect(await feedClosed).toBe(1001);
        // Jobs were aborted at time zero; the socket got the terminal event.
        await owner.closed;
        expect(owner.events.at(-1)).toMatchObject({ type: "error", reason: "shutdown", status: 503 });
        expect(await (await follow(generation)).closed).not.toBe(1000);
    });
});
