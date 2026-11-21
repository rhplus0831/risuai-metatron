// @vitest-environment node
import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { projectServerEvent, type DiagnosticEventInput } from "../../../shared/diagnostics.ts";
import type { EventFeedFrame } from "../../../shared/events.ts";
import type {
    RemoteCommand,
    RemoteCommandPostBody,
    RemoteCommandState,
    RemoteCommandStateBody,
} from "../../../shared/remoteCommands.ts";
import {
    createRemoteCommands,
    type RemoteCommandLimits,
    type RemoteCommandOutcome,
    type RemoteCommands,
} from "../remoteCommands.ts";
import { allowListenerOrigin, createResourceTestClient, json } from "./testSupport.ts";

const path = "/api/remote-commands";
type SendPostBody = RemoteCommandPostBody & { command: Extract<RemoteCommand, { type: "send" }> };
const post = (commandId = "send-1", target = "desk"): SendPostBody => ({
    clientId: "phone",
    target,
    commandId,
    command: {
        type: "send",
        requestId: commandId,
        chaId: "character",
        chatId: "chat",
        userMessageId: "user-message",
        input: "private input 한글",
        inputOriginal: "private original",
        stopOverLoreBudget: true,
    },
});
const noInput = { input: "", userMessageId: undefined, inputOriginal: undefined };
const report = (state: RemoteCommandStateBody["state"], attempt = 1): RemoteCommandStateBody =>
    state === "refused" ? { clientId: "desk", attempt, state, code: "busy" } : { clientId: "desk", attempt, state };
const ok = <T>(outcome: RemoteCommandOutcome<T>): T => {
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    return outcome.body;
};
const unknown = { ok: false, status: 404, body: { error: "unknownCommand" } };

describe("remote commands over HTTP", () => {
    let client: Awaited<ReturnType<typeof createResourceTestClient>>;
    let node: http.Server;
    let host: WebSocket;

    beforeAll(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterAll(() => vi.restoreAllMocks());
    beforeEach(async () => {
        // Freeze the relay's deadlines and socket heartbeat while real HTTP/socket I/O proceeds.
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        client = await createResourceTestClient({ remoteCommandOptions: { now: () => 0 } });
        node = http.createServer();
        client.context.attachWebSocket(node);
        await new Promise<void>((resolve) => node.listen(0, "127.0.0.1", resolve));
        allowListenerOrigin(node);
        const { port } = node.address() as { port: number };
        host = new WebSocket(`ws://127.0.0.1:${port}/api/events/ws?risu-auth=${await client.signer.jwt()}`);
        const registered = new Promise<void>((resolve) => {
            host.on("message", (raw) => {
                const frame = JSON.parse(String(raw)) as EventFeedFrame;
                if (frame.type === "clients" && frame.clients.some((entry) => entry.clientId === "desk")) resolve();
            });
        });
        await new Promise<void>((resolve, reject) => {
            host.once("open", resolve);
            host.once("error", reject);
        });
        host.send(JSON.stringify({ type: "register", clientId: "desk", name: "Desk", worker: false, host: true }));
        await registered;
    });
    afterEach(async () => {
        host?.terminate();
        await client?.close();
        if (node) await new Promise<void>((resolve) => node.close(() => resolve()));
        vi.useRealTimers();
    });

    async function answer(response: Response, status: number, body: unknown) {
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toEqual(body);
    }

    it("includes every action field in retry identity while keeping plain-send identity unchanged", async () => {
        const actions = [
            [{ continue: true }, { continue: false }],
            [
                { continue: true, continueMessageId: "reply-a" },
                { continue: true, continueMessageId: "reply-b" },
            ],
            [
                { ...noInput, rerollMessageId: "reply-a" },
                { ...noInput, rerollMessageId: "reply-b" },
            ],
        ];
        const queued = { state: "queued", attempted: false, stopRequested: false, attempt: 0 };
        for (const [index, [original, changed]] of actions.entries()) {
            const body = post(`action-${index}`);
            const command = { ...body.command, ...original };
            await answer(await client.json(path, { ...body, command }), 200, queued);
            await answer(await client.json(path, { ...body, command }), 200, queued);
            await answer(await client.json(path, { ...body, command: { ...body.command, ...changed } }), 409, {
                error: "commandChanged",
            });
        }
        // The speaker is outside the identity, as it is outside the generation's request fingerprint: a
        // re-post with another speaker is the same command and the first body stands.
        const reroll = post("speaker");
        const first = { ...reroll.command, ...noInput, rerollMessageId: "reply-a", speakerChaId: "speaker-a" };
        await answer(await client.json(path, { ...reroll, command: first }), 200, queued);
        await answer(
            await client.json(path, { ...reroll, command: { ...first, speakerChaId: "speaker-b" } }),
            200,
            queued,
        );
        const read = await client.request(`${path}/speaker?clientId=desk&contractVersion=2`);
        expect(((await read.json()) as { command: unknown }).command).toEqual(first);
        const plain = post("plain");
        await answer(await client.json(path, plain), 200, queued);
        await answer(
            await client.json(path, {
                ...plain,
                command: {
                    ...plain.command,
                    continue: false,
                    inputOriginal: "another original",
                    stopOverLoreBudget: false,
                },
            }),
            200,
            queued,
        );
    });

    it("rejects invalid action fields and requires a user message id only for nonempty input", async () => {
        for (const invalid of [
            { continue: "true" },
            { continueMessageId: "" },
            { rerollMessageId: "" },
            { speakerChaId: "" },
            { continue: true, rerollMessageId: "reply" },
            { userMessageId: undefined },
            { input: "", userMessageId: "" },
        ]) {
            await answer(await client.json(path, { ...post(), command: { ...post().command, ...invalid } }), 400, {
                error: "Invalid remote command",
            });
        }
        const body: SendPostBody = {
            ...post(),
            command: {
                type: "send",
                requestId: "send-1",
                chaId: "character",
                chatId: "chat",
                input: "",
                continue: true,
                continueMessageId: "reply",
            },
        };
        await answer(await client.json(path, body), 200, {
            state: "queued",
            attempted: false,
            stopRequested: false,
            attempt: 0,
        });
        await answer(await client.request(`${path}/send-1?clientId=desk&contractVersion=2`), 200, {
            state: "delivered",
            attempted: false,
            stopRequested: false,
            attempt: 1,
            command: body.command,
        });
    });

    it.each([
        {
            action: "a Continue anchor on a plain send",
            valid: {},
            unused: { continueMessageId: "reply" },
        },
        {
            action: "a Continue anchor with continue set to false",
            valid: { continue: false },
            unused: { continueMessageId: "reply" },
        },
        {
            action: "a user message ID on Continue without input",
            valid: { ...noInput, continue: true, continueMessageId: "reply" },
            unused: { userMessageId: "user-message" },
        },
        {
            action: "input on a reroll",
            valid: { ...noInput, rerollMessageId: "reply" },
            unused: { input: "New message", userMessageId: "user-message" },
        },
        {
            action: "a user message ID on a reroll without input",
            valid: { ...noInput, rerollMessageId: "reply" },
            unused: { userMessageId: "user-message" },
        },
    ])("rejects $action before queuing or retrying the command", async ({ valid, unused }) => {
        const body = post();
        const command = { ...body.command, ...valid };
        const invalid = { ...body, command: { ...command, ...unused } };
        const error = { error: "Invalid remote command" };
        const queued = { state: "queued", attempted: false, stopRequested: false, attempt: 0 };

        await answer(await client.json(path, invalid), 400, error);
        await answer(await client.request(`${path}/${body.commandId}/status?clientId=${body.clientId}`), 404, {
            error: "unknownCommand",
        });
        await answer(await client.json(path, { ...body, command }), 200, queued);
        await answer(await client.json(path, invalid), 400, error);
        await answer(await client.json(path, { ...body, command }), 200, queued);
    });

    it("withholds action commands from older hosts, notifies the sender, and delivers to v2 hosts", async () => {
        const sender = new WebSocket(host.url);
        try {
            const registered = new Promise<void>((resolve) => {
                sender.on("message", (raw) => {
                    const frame = JSON.parse(String(raw)) as EventFeedFrame;
                    if (frame.type === "clients" && frame.clients.some((entry) => entry.clientId === "phone"))
                        resolve();
                });
            });
            await new Promise<void>((resolve, reject) => {
                sender.once("open", resolve);
                sender.once("error", reject);
            });
            sender.send(
                JSON.stringify({ type: "register", clientId: "phone", name: "Phone", worker: false, host: false }),
            );
            await registered;
            for (const [index, action] of [
                { continue: true as const },
                { ...noInput, continue: true as const, continueMessageId: "reply" },
                { ...noInput, rerollMessageId: "reply" },
                { speakerChaId: "speaker" },
            ].entries()) {
                const old = post(`old-${index}`);
                old.command = { ...old.command, ...action };
                expect((await client.json(path, old)).status).toBe(200);
                const notified = new Promise<EventFeedFrame>((resolve) => {
                    const receive = (raw: unknown) => {
                        const frame = JSON.parse(String(raw)) as EventFeedFrame;
                        if (
                            frame.type === "remoteCommandState" &&
                            frame.commandId === old.commandId &&
                            frame.state === "refused"
                        ) {
                            sender.off("message", receive);
                            resolve(frame);
                        }
                    };
                    sender.on("message", receive);
                });
                await answer(await client.request(`${path}/${old.commandId}?clientId=desk`), 410, {
                    error: "unsupported",
                    state: "refused",
                });
                await answer(await client.request(`${path}/${old.commandId}/status?clientId=phone`), 200, {
                    state: "refused",
                    code: "unsupported",
                    attempted: false,
                    stopRequested: false,
                    attempt: 0,
                });
                expect(await notified).toEqual({
                    type: "remoteCommandState",
                    epoch: client.epoch,
                    commandId: old.commandId,
                    state: "refused",
                    code: "unsupported",
                });
                await answer(await client.request(`${path}/${old.commandId}?clientId=desk&contractVersion=2`), 410, {
                    error: "commandClosed",
                    state: "refused",
                });
                const current = post(`v2-${index}`);
                current.command = { ...current.command, ...action };
                expect((await client.json(path, current)).status).toBe(200);
                await answer(
                    await client.request(`${path}/${current.commandId}?clientId=desk&contractVersion=2`),
                    200,
                    {
                        state: "delivered",
                        attempted: false,
                        stopRequested: false,
                        attempt: 1,
                        command: current.command,
                    },
                );
            }
            const plain = post("plain");
            expect((await client.json(path, plain)).status).toBe(200);
            await answer(await client.request(`${path}/plain?clientId=desk`), 200, {
                state: "delivered",
                attempted: false,
                stopRequested: false,
                attempt: 1,
                command: plain.command,
            });
        } finally {
            sender.terminate();
        }
    });

    it("keeps an already attempted action uncertain when an older host reads it", async () => {
        const body = post();
        body.command = { ...body.command, ...noInput, rerollMessageId: "reply" };
        expect((await client.json(path, body)).status).toBe(200);
        expect((await client.request(`${path}/send-1?clientId=desk&contractVersion=2`)).status).toBe(200);
        expect((await client.json(`${path}/send-1/state`, report("running"))).status).toBe(200);
        await answer(await client.request(`${path}/send-1?clientId=desk`), 410, {
            error: "unsupported",
            state: "uncertain",
        });
        await answer(await client.request(`${path}/send-1/status?clientId=phone`), 200, {
            state: "uncertain",
            code: "unsupported",
            attempted: true,
            stopRequested: false,
            attempt: 1,
        });
    });

    it("accepts reloads without requestId and identifies retries by type and mode", async () => {
        for (const mode of ["plugins", "page"] as const) {
            const body: RemoteCommandPostBody = {
                clientId: "phone",
                target: "desk",
                commandId: `reload-${mode}`,
                command: { type: "reload", mode },
            };
            const queued = { state: "queued", attempted: false, stopRequested: false, attempt: 0 };
            await answer(await client.json(path, body), 200, queued);
            await answer(await client.json(path, body), 200, queued);
            await answer(
                await client.json(path, {
                    ...body,
                    command: { type: "reload", mode: mode === "plugins" ? "page" : "plugins" },
                }),
                409,
                { error: "commandChanged" },
            );
            await answer(await client.json(path, post(body.commandId)), 409, { error: "commandChanged" });
            await answer(await client.request(`${path}/${body.commandId}?clientId=desk`), 200, {
                state: "delivered",
                attempted: false,
                stopRequested: false,
                attempt: 1,
                command: { type: "reload", mode },
            });
        }
    });

    it("rejects an invalid reload mode without relaxing send validation", async () => {
        for (const command of [
            { type: "reload", mode: "everything" },
            { ...post().command, requestId: undefined },
        ]) {
            await answer(await client.json(path, { ...post(), command }), 400, { error: "Invalid remote command" });
        }
    });

    it("delivers the body only to the target and reports its result only to the sender", async () => {
        await answer(await client.json(path, post("absent", "offline")), 404, { error: "targetUnavailable" });
        await answer(await client.request(`${path}/absent/status?clientId=phone`), 404, { error: "unknownCommand" });
        await answer(await client.json(path, post()), 200, {
            state: "queued",
            attempted: false,
            stopRequested: false,
            attempt: 0,
        });
        for (const response of [
            await client.request(`${path}/send-1?clientId=intruder`),
            await client.json(`${path}/send-1/state`, { ...report("running"), clientId: "intruder" }),
            await client.json(`${path}/send-1/cancel`, { clientId: "intruder" }),
            await client.request(`${path}/send-1/status?clientId=intruder`),
        ])
            await answer(response, 404, { error: "unknownCommand" });
        await answer(await client.request(`${path}/send-1/status?clientId=phone`), 200, {
            state: "queued",
            attempted: false,
            stopRequested: false,
            attempt: 0,
        });
        await answer(await client.request(`${path}/send-1?clientId=desk`), 200, {
            command: post().command,
            state: "delivered",
            attempted: false,
            stopRequested: false,
            attempt: 1,
        });
        await answer(await client.json(`${path}/send-1/state`, report("running")), 200, {
            state: "running",
            stopRequested: false,
            attempt: 1,
        });
        const result = { messageId: "assistant-message", outcome: { text: "private reply" } };
        await answer(await client.json(`${path}/send-1/state`, { ...report("done"), result }), 200, {
            state: "done",
            stopRequested: false,
            attempt: 1,
        });
        await answer(await client.request(`${path}/send-1/status?clientId=phone`), 200, {
            state: "done",
            attempted: true,
            stopRequested: false,
            attempt: 1,
            result,
        });
        const closed = await client.request(`${path}/send-1?clientId=desk`);
        expect(closed.status).toBe(410);
        expect(await closed.text()).not.toContain(post().command.input);
    });

    it("requires authentication and the current epoch on all five routes", async () => {
        await client.json(path, post());
        const requests = [
            [path, json(post())],
            [`${path}/send-1?clientId=desk`, {}],
            [`${path}/send-1/state`, json(report("running"))],
            [`${path}/send-1/cancel`, json({ clientId: "phone" })],
            [`${path}/send-1/status?clientId=phone`, {}],
        ] as const;
        for (const [url, init] of requests) {
            const unauthenticated = await client.app.request(url, init);
            expect(unauthenticated.status, url).toBe(400);
            expect(unauthenticated.headers.get("cache-control"), url).toBe("no-store");
            await answer(await client.request(url, init, "stale-epoch"), 412, {
                error: "EpochMismatch",
                epoch: client.epoch,
            });
        }
        await answer(await client.request(`${path}/send-1/status?clientId=phone`), 200, {
            state: "queued",
            attempted: false,
            stopRequested: false,
            attempt: 0,
        });
    });

    it("keeps the first retry body and rejects changed input or sender even after completion", async () => {
        const original = post();
        await client.json(path, original);
        const retry = {
            ...original,
            command: { ...original.command, inputOriginal: "later original", stopOverLoreBudget: false },
        };
        await answer(await client.json(path, retry), 200, {
            state: "queued",
            attempted: false,
            stopRequested: false,
            attempt: 0,
        });
        await answer(await client.request(`${path}/send-1?clientId=desk`), 200, {
            state: "delivered",
            attempted: false,
            stopRequested: false,
            attempt: 1,
            command: original.command,
        });
        for (const closed of [false, true]) {
            if (closed) await client.json(`${path}/send-1/state`, { ...report("done"), result: { saved: true } });
            // The conflict wins even when the newly named target is unavailable.
            for (const changed of [
                { ...retry, target: "offline", command: { ...retry.command, input: "different action" } },
                { ...retry, target: "offline", clientId: "another-sender" },
            ])
                await answer(await client.json(path, changed), 409, { error: "commandChanged" });
        }
        await answer(await client.json(path, { ...retry, target: "offline" }), 200, {
            state: "done",
            attempted: false,
            stopRequested: false,
            attempt: 1,
            result: { saved: true },
        });
    });

    it("caps every POST body at exactly 1 MiB of UTF-8 JSON", async () => {
        const padded = (body: object, bytes: number) => {
            const value = { ...body, padding: "한" };
            return JSON.stringify({
                ...value,
                padding: value.padding + "x".repeat(bytes - Buffer.byteLength(JSON.stringify(value))),
            });
        };
        const cases = [
            [path, post(), "queued", 0],
            [`${path}/send-1/state`, report("running"), "running", 1],
            [`${path}/send-1/cancel`, { clientId: "phone" }, "running", 1],
        ] as const;
        for (const [url, body, state, attempt] of cases) {
            if (url.endsWith("/state")) await client.request(`${path}/send-1?clientId=desk`);
            for (const [bytes, status] of [
                [1_048_577, 413],
                [1_048_576, 200],
            ] as const) {
                const response = await client.request(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: padded(body, bytes),
                });
                expect(response.status, `${url}: ${bytes} bytes`).toBe(status);
                expect(response.headers.get("cache-control")).toBe("no-store");
                if (status === 413) expect(await response.json()).toEqual({ error: "Request body too large" });
                else expect(await response.json()).toMatchObject({ state, attempt });
            }
        }
    });

    it("does not reserve an unknown cancelled id and accepts its later post", async () => {
        await answer(await client.json(`${path}/send-1/cancel`, { clientId: "phone" }), 404, {
            error: "unknownCommand",
        });
        await answer(await client.request(`${path}/send-1/status?clientId=phone`), 404, { error: "unknownCommand" });
        await answer(await client.json(path, post()), 200, {
            state: "queued",
            attempted: false,
            stopRequested: false,
            attempt: 0,
        });
        await answer(await client.request(`${path}/send-1?clientId=desk`), 200, {
            state: "delivered",
            attempted: false,
            stopRequested: false,
            attempt: 1,
            command: post().command,
        });
    });
});

describe("remote command registry", () => {
    let commands: RemoteCommands;
    let epoch: string;
    let hosts: Set<string>;
    let notices: { clientId: string; frame: EventFeedFrame }[];
    let records: DiagnosticEventInput[];
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        vi.setSystemTime(0);
        epoch = "epoch-1";
        hosts = new Set(["desk", "laptop"]);
        notices = [];
        records = [];
        commands = createRemoteCommands({
            epoch: () => epoch,
            isHost: (id) => hosts.has(id),
            notify: (clientId, frame) => notices.push({ clientId, frame }),
            diagnostics: { record: (event) => records.push(event) },
        });
    });
    afterEach(() => {
        commands.close();
        vi.useRealTimers();
    });

    function enter(state: RemoteCommandState, id = "send-1") {
        ok(commands.post(post(id)));
        if (state === "expired") vi.advanceTimersByTime(30_000);
        else if (state === "cancelled") ok(commands.cancel(id, "phone"));
        else if (state !== "queued") {
            ok(commands.read(id, "desk"));
            if (state !== "delivered") ok(commands.report(id, report(state)));
        }
        notices.length = 0;
    }
    const notice = (state: string, id = "send-1", code?: string) => ({
        clientId: "phone",
        frame: { type: "remoteCommandState", epoch: "epoch-1", commandId: id, state, ...(code ? { code } : {}) },
    });
    const targetNotice = (id = "send-1", target = "desk", stop = false) => ({
        clientId: target,
        frame: { type: "remoteCommand", epoch: "epoch-1", commandId: id, ...(stop ? { stop: true } : {}) },
    });
    const states = ["queued", "delivered", "running", "uncertain", "done", "refused", "expired", "cancelled"] as const;

    it.each(states)("accepts only the permitted host reports from %s", (from) => {
        for (const to of ["running", "uncertain", "refused", "done"] as const) {
            const id = `${from}-${to}`;
            enter(from, id);
            const open = ["delivered", "running", "uncertain"].includes(from);
            const repeated = from === to;
            // A `running` after the same attempt's `uncertain` is a late copy and changes nothing.
            const expected =
                (to === "refused" && (from === "running" || from === "uncertain")) ||
                (to === "running" && from === "uncertain")
                    ? "uncertain"
                    : to;
            const before = ok(commands.status(id, "phone"));
            const outcome = commands.report(id, report(to));
            if (!open && !repeated) {
                expect(outcome, `${from} -> ${to}`).toEqual({
                    ok: false,
                    status: 409,
                    body: { error: "invalidTransition", state: from },
                });
                expect(ok(commands.status(id, "phone"))).toEqual(before);
                expect(notices).toEqual([]);
                continue;
            }
            expect(ok(outcome)).toEqual({ state: expected, stopRequested: false, attempt: 1 });
            expect(ok(commands.status(id, "phone"))).toEqual({
                state: expected,
                attempted: [from, to].includes("running") || [from, to].includes("uncertain"),
                stopRequested: false,
                attempt: 1,
                ...(to === "refused" ? { code: "busy" } : {}),
            });
            const changed = from !== expected;
            expect(notices).toEqual(changed ? [notice(expected, id, to === "refused" ? "busy" : undefined)] : []);
            if (expected === "done" || expected === "refused")
                expect(commands.read(id, "desk")).toMatchObject({ ok: false, status: 410 });
            else
                expect(ok(commands.read(id, "desk"))).toMatchObject({
                    command: post(id).command,
                    state: expected,
                    attempt: 2,
                });
        }
    });

    it.each(states)("cancels %s without claiming that an already delivered command never ran", (state) => {
        enter(state);
        const before = ok(commands.status("send-1", "phone"));
        const open = ["queued", "delivered", "running", "uncertain"].includes(state);
        const expected = state === "queued" ? "cancelled" : state;
        const stopped = open || state === "cancelled";
        expect(ok(commands.cancel("send-1", "phone"))).toEqual({
            state: expected,
            stopRequested: stopped,
            attempt: before.attempt,
        });
        expect(ok(commands.status("send-1", "phone"))).toEqual({ ...before, state: expected, stopRequested: stopped });
        expect(notices).toEqual(
            state === "queued" ? [notice("cancelled")] : open ? [targetNotice("send-1", "desk", true)] : [],
        );
        if (!open || state === "queued") {
            expect(commands.read("send-1", "desk")).toMatchObject({ ok: false, status: 410 });
        } else {
            expect(ok(commands.read("send-1", "desk"))).toMatchObject({
                command: post().command,
                state,
                stopRequested: true,
                attempt: 2,
            });
            if (state !== "delivered") {
                expect(ok(commands.report("send-1", report(state as "running" | "uncertain", 2)))).toEqual({
                    state,
                    stopRequested: true,
                    attempt: 2,
                });
            }
            notices.length = 0;
            // The next Send re-posts the command: its stop is cleared and the target is told again without it.
            expect(ok(commands.post(post()))).toMatchObject({ state, stopRequested: false });
            expect(notices).toEqual([targetNotice()]);
            expect(ok(commands.status("send-1", "phone"))).toMatchObject({ state, stopRequested: false });
            expect(ok(commands.read("send-1", "desk"))).toMatchObject({ state, stopRequested: false, attempt: 3 });
        }
    });

    it("expires an unread command at 30 seconds and forgets its closed record after 10 minutes", () => {
        ok(commands.post(post()));
        expect(notices).toEqual([targetNotice()]);
        notices.length = 0;
        vi.advanceTimersByTime(29_999);
        expect(ok(commands.status("send-1", "phone"))).toEqual({
            state: "queued",
            attempted: false,
            stopRequested: false,
            attempt: 0,
        });
        expect(notices).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(notices).toEqual([notice("expired")]);
        expect(ok(commands.status("send-1", "phone"))).toEqual({
            state: "expired",
            attempted: false,
            stopRequested: false,
            attempt: 0,
        });
        expect(commands.read("send-1", "desk")).toMatchObject({ ok: false, status: 410 });
        notices.length = 0;
        vi.advanceTimersByTime(599_999);
        expect(ok(commands.status("send-1", "phone"))).toMatchObject({ state: "expired" });
        vi.advanceTimersByTime(1);
        expect(commands.status("send-1", "phone")).toEqual(unknown);
        expect(notices).toEqual([]);
    });

    it("drops an open command 40 minutes after its last change and tells its sender forgotten", () => {
        enter("delivered");
        vi.advanceTimersByTime(60_000);
        ok(commands.report("send-1", report("running")));
        notices.length = 0;
        vi.advanceTimersByTime(2_399_999);
        // Neither a repeated report nor another body read prolongs the current state.
        ok(commands.report("send-1", report("running")));
        expect(ok(commands.read("send-1", "desk"))).toMatchObject({ state: "running", attempt: 2 });
        expect(notices).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(notices).toEqual([notice("forgotten")]);
        expect(commands.status("send-1", "phone")).toEqual(unknown);
        expect(commands.read("send-1", "desk")).toEqual(unknown);
    });

    it("supersedes lower attempts and treats the first report of a newer attempt as a change", () => {
        enter("running");
        vi.advanceTimersByTime(2_399_999);
        expect(ok(commands.read("send-1", "desk"))).toMatchObject({ attempt: 2, attempted: true });
        expect(commands.report("send-1", report("done", 3))).toEqual({
            ok: false,
            status: 409,
            body: { error: "invalidTransition", state: "running" },
        });
        expect(
            ok(commands.report("send-1", { clientId: "desk", attempt: 1, state: "done", result: { stale: true } })),
        ).toEqual({
            state: "running",
            stopRequested: false,
            attempt: 2,
            superseded: true,
        });
        expect(notices).toEqual([]);
        expect(ok(commands.status("send-1", "phone"))).toEqual({
            state: "running",
            attempted: true,
            stopRequested: false,
            attempt: 2,
        });
        expect(ok(commands.report("send-1", report("running", 2)))).toEqual({
            state: "running",
            stopRequested: false,
            attempt: 2,
        });
        expect(notices).toEqual([notice("running")]);
        notices.length = 0;
        vi.advanceTimersByTime(1);
        expect(ok(commands.status("send-1", "phone"))).toMatchObject({ state: "running" });
        ok(commands.report("send-1", report("running", 2)));
        expect(notices).toEqual([]);
        vi.advanceTimersByTime(2_399_999);
        expect(notices).toEqual([notice("forgotten")]);
    });

    it("limits each target to 16 open commands and frees capacity when one closes", () => {
        const openStates = ["queued", "delivered", "running", "uncertain"] as const;
        for (let i = 0; i < 16; i++) enter(openStates[i % openStates.length], `send-${i}`);
        expect(commands.post(post("overflow"))).toEqual({ ok: false, status: 409, body: { error: "targetFull" } });
        expect(commands.status("overflow", "phone")).toEqual(unknown);
        ok(commands.post(post("other-host", "laptop")));
        ok(commands.cancel("send-0", "phone"));
        expect(ok(commands.post(post("overflow")))).toMatchObject({ state: "queued", attempt: 0 });
    });

    it("keeps an uncertain result when the same attempt's abandoned running report arrives late", () => {
        const result = { ok: false, settled: false, reports: [{ kind: "error", text: "no answer" }] };
        enter("delivered");
        ok(commands.report("send-1", { clientId: "desk", attempt: 1, state: "uncertain", result }));
        const before = ok(commands.status("send-1", "phone"));
        expect(before).toMatchObject({ state: "uncertain", attempted: true, result });
        notices.length = 0;
        vi.advanceTimersByTime(1_000);
        expect(ok(commands.report("send-1", report("running")))).toEqual({
            state: "uncertain",
            stopRequested: false,
            attempt: 1,
        });
        expect(ok(commands.status("send-1", "phone"))).toEqual(before);
        expect(notices).toEqual([]);
        // The late copy did not restart the open-command lifetime.
        vi.advanceTimersByTime(2_399_000);
        expect(notices).toEqual([notice("forgotten")]);
    });

    it("keeps an uncertain result when a reload recovery repeats uncertain without one", () => {
        // The host reloaded before the first report's answer arrived and reports from its saved id.
        const result = { ok: false, settled: false, reports: [{ kind: "error", text: "no answer" }] };
        enter("running");
        ok(commands.report("send-1", { clientId: "desk", attempt: 1, state: "uncertain", result }));
        const before = ok(commands.status("send-1", "phone"));
        notices.length = 0;
        expect(ok(commands.report("send-1", report("uncertain")))).toMatchObject({ state: "uncertain" });
        expect(ok(commands.status("send-1", "phone"))).toEqual(before);
        expect(notices).toEqual([]);
        // A repeat that carries a result replaces it, as any report of the current attempt does.
        const newer = { ...result, reports: [] };
        ok(commands.report("send-1", { clientId: "desk", attempt: 1, state: "uncertain", result: newer }));
        expect(ok(commands.status("send-1", "phone"))).toMatchObject({ result: newer });
    });

    it("refuses a result that is larger than the body cap as stored, and keeps the command's state", () => {
        commands.close();
        commands = createRemoteCommands({
            epoch: () => epoch,
            isHost: () => true,
            notify: (clientId, frame) => notices.push({ clientId, frame }),
            limits: { bodyBytes: 1_000 },
        });
        enter("running");
        const before = ok(commands.status("send-1", "phone"));
        // 60 numbers that a request can write as `1e20` (4 bytes) and JSON stores as 21 digits each.
        const result = { values: Array.from({ length: 60 }, () => 1e20) };
        expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(1_000);
        expect(commands.report("send-1", { clientId: "desk", attempt: 1, state: "done", result })).toEqual({
            ok: false,
            status: 413,
            body: { error: "Request body too large" },
        });
        expect(ok(commands.status("send-1", "phone"))).toEqual(before);
    });

    it("accepts running from a new read of an uncertain command", () => {
        enter("uncertain");
        ok(commands.post(post()));
        expect(ok(commands.read("send-1", "desk"))).toMatchObject({ attempt: 2, attempted: true });
        expect(ok(commands.report("send-1", report("running", 2)))).toMatchObject({ state: "running" });
        expect(ok(commands.status("send-1", "phone"))).toMatchObject({ state: "running", attempted: true });
    });

    it("marks a command attempted when its host reports only uncertain, so a later refusal certifies nothing", () => {
        // A host page that reloaded before its `running` arrived reports `uncertain` from its saved id.
        enter("delivered");
        ok(commands.report("send-1", report("uncertain")));
        ok(commands.post(post()));
        expect(ok(commands.read("send-1", "desk"))).toMatchObject({ attempt: 2, attempted: true });
        expect(ok(commands.report("send-1", report("refused", 2)))).toMatchObject({ state: "uncertain" });
    });

    describe("whole-relay bounds", () => {
        const bounded = (limits: Partial<RemoteCommandLimits>) => {
            commands.close();
            commands = createRemoteCommands({
                epoch: () => epoch,
                isHost: () => true,
                notify: (clientId, frame) => notices.push({ clientId, frame }),
                limits,
            });
        };
        const full = { ok: false, status: 409, body: { error: "targetFull" } };

        it("refuses a new id at the total entry count, counting closed commands and every target", () => {
            bounded({ maxEntries: 3 });
            enter("done", "closed");
            enter("running", "open");
            ok(commands.post(post("third", "laptop")));
            expect(commands.post(post("fourth", "another-host"))).toEqual(full);
            expect(commands.status("fourth", "phone")).toEqual(unknown);
            // Nothing accepted was evicted for room, and a retry of a held id is still answered.
            expect(ok(commands.status("closed", "phone"))).toMatchObject({ state: "done" });
            expect(ok(commands.post(post("open")))).toMatchObject({ state: "running" });
            vi.advanceTimersByTime(600_000);
            expect(ok(commands.post(post("fourth", "another-host")))).toMatchObject({ state: "queued" });
        });

        it("counts an open command as its body and a full result, and a closed one as the result it kept", () => {
            const body = Buffer.byteLength(JSON.stringify(post("a").command));
            const result = { reports: [{ kind: "error", text: "x".repeat(400) }] };
            const kept = Buffer.byteLength(JSON.stringify(result));
            expect(kept).toBeLessThan(body + 1_000);
            // Room for two open commands of this size (each reserves 1,000 bytes for a result) and one kept result.
            bounded({ bodyBytes: 1_000, retainedBytes: 2 * (body + 1_000) + kept });
            ok(commands.post(post("a")));
            ok(commands.post(post("b", "laptop")));
            expect(commands.post(post("c", "third-host"))).toEqual(full);
            ok(commands.read("a", "desk"));
            ok(commands.report("a", { clientId: "desk", attempt: 1, state: "done", result }));
            // Closing gave back the body and the reserve; the entry now counts as the result it kept.
            ok(commands.post(post("c", "third-host")));
            expect(commands.post(post("d", "fourth-host"))).toEqual(full);
        });

        it("lets a post replace its own closed entry at the bound", () => {
            bounded({ maxEntries: 1 });
            enter("cancelled");
            expect(ok(commands.post(post()))).toMatchObject({ state: "queued" });
            expect(commands.post(post("other"))).toEqual(full);
        });
    });

    it("silently drops entries from another epoch before access or notification", () => {
        enter("running");
        epoch = "epoch-2";
        expect(commands.read("send-1", "desk")).toEqual(unknown);
        expect(commands.status("send-1", "phone")).toEqual(unknown);
        commands.onRegister({ clientId: "desk", name: "Desk", worker: false, host: true });
        expect(notices).toEqual([]);
        expect(ok(commands.post(post()))).toEqual({
            state: "queued",
            attempted: false,
            stopRequested: false,
            attempt: 0,
        });
        expect(notices).toEqual([
            { clientId: "desk", frame: { type: "remoteCommand", epoch: "epoch-2", commandId: "send-1" } },
        ]);
    });

    it.each(["delivered", "running", "uncertain"] as const)(
        "re-notifies %s retries and moves them only after their host leaves",
        (state) => {
            enter(state);
            const before = ok(commands.status("send-1", "phone"));
            expect(ok(commands.post(post("send-1", "laptop")))).toEqual(before);
            expect(notices).toEqual([targetNotice()]);
            notices.length = 0;
            hosts.delete("desk");
            expect(ok(commands.post(post("send-1", "laptop")))).toEqual(before);
            expect(notices).toEqual([targetNotice("send-1", "laptop")]);
            expect(commands.read("send-1", "desk")).toEqual(unknown);
            expect(ok(commands.read("send-1", "laptop"))).toEqual({ ...before, command: post().command, attempt: 2 });
        },
    );

    it("preserves attempted knowledge on admission and retry and cannot certify a refusal afterwards", () => {
        for (const retry of [false, true]) {
            const id = retry ? "retry" : "new";
            if (retry) ok(commands.post(post(id)));
            expect(ok(commands.post({ ...post(id), uncertain: true }))).toEqual({
                state: "queued",
                attempted: true,
                stopRequested: false,
                attempt: 0,
            });
            expect(ok(commands.read(id, "desk"))).toMatchObject({ state: "delivered", attempted: true, attempt: 1 });
            expect(ok(commands.report(id, report("refused")))).toEqual({
                state: "uncertain",
                stopRequested: false,
                attempt: 1,
            });
            expect(ok(commands.status(id, "phone"))).toEqual({
                state: "uncertain",
                attempted: true,
                stopRequested: false,
                attempt: 1,
                code: "busy",
            });
            expect(notices.at(-1)).toEqual(notice("uncertain", id, "busy"));
        }
    });

    it.each(["expired", "cancelled", "refused"] as const)(
        "replaces a matching %s command with a fresh admission",
        (state) => {
            enter(state);
            const retry = post("send-1", "laptop");
            retry.command.inputOriginal = "replacement original";
            expect(ok(commands.post(retry))).toEqual({
                state: "queued",
                attempted: false,
                stopRequested: false,
                attempt: 0,
            });
            expect(notices).toEqual([targetNotice("send-1", "laptop")]);
            expect(ok(commands.read("send-1", "laptop"))).toEqual({
                state: "delivered",
                attempted: false,
                stopRequested: false,
                attempt: 1,
                command: retry.command,
            });
        },
    );

    it("records only command ids, types, states and UTF-8 sizes in diagnostics", () => {
        const body = post();
        ok(commands.post(body));
        ok(commands.read("send-1", "desk"));
        ok(
            commands.report("send-1", {
                clientId: "desk",
                attempt: 1,
                state: "done",
                result: { text: "private result" },
            }),
        );
        const expected = ["queued", "delivered", "done"].map((state) => ({
            kind: "remoteCommand",
            commandId: "send-1",
            command: "send",
            state,
            bytes: Buffer.byteLength(JSON.stringify(body.command)),
        }));
        expect(records).toEqual(expected);
        expect(
            records.map((record) =>
                projectServerEvent({
                    ...record,
                    at: 0,
                    input: body.command.input,
                    inputOriginal: body.command.inputOriginal,
                }),
            ),
        ).toEqual(expected.map((record) => ({ ...record, at: 0 })));
        expect(notices).toEqual([targetNotice(), notice("delivered"), notice("done")]);
    });
});
