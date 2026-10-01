// @vitest-environment node
import type http from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { GenerationEvent } from "../../../shared/jobs.ts";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { createSigner, createTestServer, json, sleep, startUpstream, waitFor } from "./testSupport.ts";

// The generation job routes and the owner socket (`server/src/routes/generations.ts`,
// `generationJobs.handleUpgrade`) on a real listening server, with a fake runner driven by the test,
// beside the proxy stream jobs on the same upgrade dispatcher. The registry's in-process contracts
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
        wake = null;
        runners = [];
        await server?.close();
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
        server.context.attachWebSocket(started);
        server.context.attachWebSocket(started);
        const { port } = started.address() as { port: number };
        base = `http://127.0.0.1:${port}`;
        signer = await createSigner();
        await fetch(`${base}/api/login`, json({ password: "pw", publicKey: signer.publicJwk }));
        epoch = ((await (await request("/api/resources/ui")).json()) as { epoch: string }).epoch;
        const seeded = await request("/api/resources/batch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
                chats: [
                    group(null, [
                        { op: "create", chat: { name: "K", message: [m("u", "hi"), m("r", "", "char")] } as never },
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
        presetId: null,
        personaId: null,
        mode: "normal",
        input,
        chatRevision: (await revision()).revision,
    });
    const create = async (body: Record<string, unknown>, options: { epoch?: string | null } = {}) => {
        const res = await request("/api/generations", json(body), options);
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const createOk = async (kind = "send", clientId = "tab") => {
        const res = await create({ kind, context: await context(), clientId });
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
    const types = (events: GenerationEvent[]) => events.map((event) => event.type);
    const until = (followed: Followed, count: number) => waitFor(() => followed.events.length >= count);

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
        // then the terminal hydration and the result.
        expect(types(owner.events)).toEqual([
            "resource",
            "resource",
            "accepted",
            "chunk",
            "chunk",
            "preset",
            "progress",
            "resource",
            "done",
        ]);
        expect(owner.events.every((event) => "epoch" in event && event.epoch === epoch)).toBe(true);
        const [snapshot, hydration, accepted, , second, , , finalChat, done] = owner.events as any[];
        expect(snapshot).toMatchObject({ kind: "chats", characterId: "c", id: "k", streaming: [] });
        expect(hydration).toMatchObject({
            kind: "chats",
            characterId: "c",
            id: "k",
            streaming: [{ messageId: "r", generationId: "g1", seq: 0 }],
        });
        expect(hydration.data.message.map((x: { chatId: string }) => x.chatId)).toEqual(["u", "r"]);
        expect(accepted).toMatchObject({ messageId: "r", userMessageId: "u", generationId: "g1", seq: 0, text: "" });
        expect(second).toMatchObject({ text: "one two", seq: 2 });
        // The terminal hydration: the reply is final, so nothing is streaming any more.
        expect(finalChat).toMatchObject({ kind: "chats", streaming: [] });
        expect(finalChat.data.message[1].data).toBe("one two");
        expect(done).toMatchObject({ type: "done", messageId: "r", revision: finalChat.revision });
        expect(await (await request(`/api/generations/${jobId}?clientId=tab`)).json()).toMatchObject({
            state: "ended",
            terminal: { type: "done" },
        });
        // The slot is free: a new job on the chat is admitted.
        expect((await create({ kind: "send", context: await context(), clientId: "tab" })).status).toBe(200);
    });

    it("keeps one delivery stream per job, orders handshakes by their attach stamp, and refuses the password, another client, and an unknown job", async () => {
        await listen();
        const jobId = await createOk();
        step((job) => {
            job.emit({ type: "progress", payload: 1 });
        });
        expect(await (await follow(jobId, { token: "pw" })).closed).not.toBe(1000);
        expect(await (await follow(jobId, { clientId: "other" })).closed).not.toBe(1000);
        expect(await (await follow("unknown")).closed).not.toBe(1000);
        const a = await follow(jobId, { attach: 5 });
        await until(a, 1);
        // An older stamp never displaces the newest attachment: refused, and `a` keeps the stream.
        const b = await follow(jobId, { attach: 3 });
        expect(await b.closed).not.toBe(1000);
        expect(b.events).toEqual([]);
        step((job) => {
            job.emit({ type: "progress", payload: 2 });
        });
        await until(a, 2);
        expect(types(a.events)).toEqual(["resource", "progress"]);
        // A newer stamp supersedes: `a` is closed with 4001 and `c` gets the fresh snapshot.
        const c = await follow(jobId, { attach: 6 });
        expect(await a.closed).toBe(4001);
        await until(c, 1);
        step((job) => {
            job.emit({ type: "progress", payload: 3 });
        });
        await until(c, 2);
        expect(types(c.events)).toEqual(["resource", "progress"]);
        expect(a.events).toHaveLength(2);
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
        await until(d, 1);
        await sleep(20);
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
            const f = await follow(jobId);
            await until(f, 1);
            await sleep(30);
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
        expect(types(events)).toEqual(["resource", "resource", "accepted"]);
        expect(events[0]).toMatchObject({
            kind: "chats",
            streaming: [{ messageId: "r", generationId: "g1", seq: 10 }],
        });
        expect(events[0].data.message[1].data).toBe("processed ten");
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
        expect(events[0].streaming).toEqual([{ messageId: "r", generationId: "g1", seq: 0 }]);
        expect(events[1]).toMatchObject({ kind: "characters", data: { name: "C renamed" } });
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(3, "captured five")])] }), {
                covers: [{ messageId: "r", generationId: "g1", seq: 5 }],
            });
        });
        await sleep(50);
        events = await snapshot();
        expect(events[0].streaming).toEqual([{ messageId: "r", generationId: "g1", seq: 5 }]);
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
        expect(events[0].streaming).toEqual([{ messageId: "r", generationId: "g1", seq: 5 }]);
        // The final: the reply is no longer streaming, and the job (still running) sends no `accepted`.
        step((job) => {
            job.write(() => ({ chats: [group(job.context.chatRevision, [checkpoint(4, "final text", true)])] }));
        });
        await sleep(50);
        events = await snapshot();
        expect(types(events)).toEqual(["resource", "resource"]);
        expect(events[0].streaming).toEqual([]);
        expect(events[0].data.message[1].data).toBe("final text");
        expect(await (await request(`/api/generations/${jobId}?clientId=tab`)).json()).not.toHaveProperty("messageId");
        // After the end: the fresh records and the terminal event.
        step((job) => {
            job.emit({ type: "done", revision: null, messageId: "r", alternatives: ["alt"] });
            return "end" as never;
        });
        await sleep(50);
        events = await snapshot();
        expect(types(events)).toEqual(["resource", "resource", "done"]);
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
            { kind: "chat", characterId: "c", id: "k", revision: current.revision, reason: "generating" },
        ]);
        expect((await request(`/api/generations/${jobId}?clientId=other`, { method: "DELETE" })).status).toBe(404);
        const aborted = await request(`/api/generations/${jobId}?clientId=tab`, { method: "DELETE" });
        expect(await aborted.json()).toEqual({ aborted: true });
        await owner.closed;
        const last = owner.events.at(-1)!;
        expect(last).toMatchObject({ type: "error", reason: "aborted", status: 499, epoch });
        const terminalChat = owner.events.at(-2) as any;
        expect(terminalChat).toMatchObject({ type: "resource", kind: "chats", streaming: [] });
        expect(terminalChat.data.message[1].data).toBe("t3 stopped");
        expect(await (await request(`/api/generations/${jobId}?clientId=tab`, { method: "DELETE" })).json()).toEqual({
            aborted: false,
        });
        expect(await (await request(`/api/generations/${jobId}?clientId=tab`)).json()).toMatchObject({
            state: "ended",
            terminal: { type: "error", reason: "aborted" },
        });
        const after = await revision();
        expect(after.data.message[1].data).toBe(terminalChat.data.message[1].data);
        const edit = await request(
            "/api/resources/batch",
            json({ chats: [group(after.revision, [{ op: "setText", id: "r", text: "mine" }])] }),
        );
        expect(edit.status).toBe(200);
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
        expect(types(owner.events)).toEqual(["resource", "resource", "accepted", "resource", "done"]);
        expect(owner.events[2]).not.toHaveProperty("messageId");
        expect(owner.events[2]).toMatchObject({ seq: 0 });
        expect(owner.events[4]).not.toHaveProperty("messageId");
    });

    it("dispatches upgrades by path: proxy stream jobs keep working beside the generation socket, an unknown path is destroyed, and shutdown removes the listener", async () => {
        const upstream = await startUpstream();
        try {
            await listen();
            const created = await fetch(
                `${base}/proxy-stream-jobs`,
                json({ url: `${upstream.url}/echo`, method: "GET" }, { "risu-auth": "pw" }),
            );
            expect(created.status).toBe(200);
            const { jobId } = (await created.json()) as { jobId: string };
            const proxyEvents = await new Promise<string[]>((resolve) => {
                const ws = new WebSocket(`${base.replace("http", "ws")}/proxy-stream-jobs/${jobId}/ws?risu-auth=pw`);
                const seen: string[] = [];
                const timer = setTimeout(() => ws.close(), 3000);
                ws.onmessage = (message) => {
                    const event = JSON.parse(String(message.data)) as { type: string };
                    seen.push(event.type);
                    if (event.type === "done" || event.type === "error") {
                        clearTimeout(timer);
                        setTimeout(() => ws.close(), 20);
                    }
                };
                ws.onerror = () => {};
                ws.onclose = () => resolve(seen);
            });
            expect(proxyEvents[0]).toBe("job_accepted");
            expect(proxyEvents).toContain("done");
            const unknown = await new Promise<string>((resolve) => {
                const ws = new WebSocket(`${base.replace("http", "ws")}/nowhere/ws`);
                ws.onopen = () => resolve("open");
                ws.onerror = () => {};
                ws.onclose = () => resolve("closed");
            });
            expect(unknown).toBe("closed");
            const generation = await createOk();
            const owner = await follow(generation);
            await until(owner, 1);
            server.context.beginShutdown();
            // Jobs were aborted at time zero; the socket got the terminal event.
            await owner.closed;
            expect(owner.events.at(-1)).toMatchObject({ type: "error", reason: "shutdown", status: 503 });
            expect(await (await follow(generation)).closed).not.toBe(1000);
        } finally {
            upstream.close();
        }
    });
});
