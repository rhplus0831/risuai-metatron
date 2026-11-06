/**
 * Two isolated browsers share a real server generation held at its first provider chunk.
 * Locked writes are refused visibly, independent edits survive, and completion releases the lock.
 * A delayed change-feed frame also exercises the documented generating-refusal recovery.
 * Covers src/ts/storage/chatStore.svelte.ts, src/ts/storage/resourceSync.svelte.ts,
 * src/ts/storage/characterStore.svelte.ts, src/ts/storage/draftJournal.ts,
 * src/ts/storage/recoveryDrafts.svelte.ts, src/ts/network/eventFeed.ts, src/ts/alert.ts,
 * src/ts/process/index.svelte.ts, src/lib/ChatScreens/DefaultChatScreen.svelte,
 * src/lib/ChatScreens/Chat.svelte, server/src/data/chatStore.ts,
 * server/src/jobs/generationLock.ts, server/src/jobs/generationJobs.ts and server/src/prompt/runner.ts.
 */
import http from "node:http";
import type { WebSocketRoute } from "@playwright/test";
import type { ChatOp } from "../shared/chats";
import { EVENT_FEED_PATH, type EventFeedFrame } from "../shared/events";
import { modelFixtureOps } from "../util/playwright/modelProfiles.mjs";
import { openCharacterChat } from "../util/playwright/stack.mjs";
import { expect, settle, test } from "./fixtures";
import {
    CONVERGENCE_TIMEOUT,
    cleanupCharacter,
    createSession,
    edits,
    expectQuiet,
    expectState,
    prepareSessions,
    restoreRecords,
    seedCharacter,
    seedState,
    serverChat,
    serverRecord,
    type Answer,
    type BatchAnswer,
    type BatchBody,
    type ExpectedState,
    type Seed,
    type Session,
} from "./multiClient";

const FIRST_CHUNK = "Held first chunk.";
const REMAINDER = " Released remainder.";
const PROMPT = "Please hold this reply while another client edits the conversation.";
const restore = new Map<string, unknown>();
let a: Session;
let b: Session;
let seed: Seed | undefined;
let provider: http.Server;
let providerUrl: string;
let held: Promise<void>;
let releaseProvider: () => void = () => {};
let releaseFeed: (() => void) | undefined;
let providerReleased = false;
let streams: { closed: boolean }[] = [];
let providerErrors: string[] = [];
let ownerFrames: EventFeedFrame[] = [];

declare global {
    interface Window {
        __multiClientContinue: Promise<boolean>;
    }
}

test.beforeAll(async () => {
    provider = http.createServer(async (request, response) => {
        try {
            const parts: Buffer[] = [];
            for await (const chunk of request) parts.push(chunk as Buffer);
            const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
            if (body.stream !== true) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({ choices: [{ message: { role: "assistant", content: "Small reply." } }] }),
                );
                return;
            }
            const stream = { closed: false };
            streams.push(stream);
            response.on("close", () => (stream.closed = true));
            response.writeHead(200, { "content-type": "text/event-stream" });
            const write = (content: string) =>
                response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            write(FIRST_CHUNK);
            await held;
            if (response.destroyed) return;
            write(REMAINDER);
            response.end("data: [DONE]\n\n");
        } catch (error) {
            providerErrors.push(String(error));
            response.destroy();
        }
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
});

test.beforeEach(async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    seed = undefined;
    streams = [];
    providerErrors = [];
    ownerFrames = [];
    releaseFeed = undefined;
    providerReleased = false;
    held = new Promise<void>((resolve) => {
        releaseProvider = () => {
            providerReleased = true;
            resolve();
        };
    });
    a = await createSession(browser, baseURL!);
    b = await createSession(browser, baseURL!);
    a.page.on("websocket", (socket) => {
        if (new URL(socket.url()).pathname !== EVENT_FEED_PATH) return;
        socket.on("framereceived", ({ payload }) => ownerFrames.push(JSON.parse(String(payload))));
    });
    seed = await seedCharacter(a, restore);
    const [modelPresets, modelProfiles, providers, ui] = await Promise.all(
        ["modelPresets", "modelProfiles", "providers", "ui"].map((kind) => serverRecord(a, kind)),
    );
    for (const [kind, record] of [
        ["modelPresets", modelPresets],
        ["modelProfiles", modelProfiles],
        ["providers", providers],
        ["ui", ui],
    ] as const) {
        if (!restore.has(kind)) restore.set(kind, record.data);
    }
    const answer = await a.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                ...modelFixtureOps(
                    {
                        aiModel: "reverse_proxy",
                        forceReplaceUrl: providerUrl,
                        customProxyRequestModel: "mock",
                        customTokenizer: "tik",
                    },
                    modelPresets,
                    modelProfiles,
                ),
                {
                    kind: "providers",
                    id: "main",
                    baseRevision: providers.revision,
                    data: { ...providers.data, useStreaming: true },
                },
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: ui.revision,
                    data: {
                        ...ui.data,
                        useAutoSuggestions: false,
                        sendWithEnter: true,
                        language: "en",
                        useSayNothing: false,
                    },
                },
            ],
        }),
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
});

test.afterEach(async ({}, info) => {
    releaseFeed?.();
    releaseProvider();
    const cleanupErrors: string[] = [];
    // Release the real job before deleting its character, including when an assertion failed.
    if (seed) await waitForJobEnd().catch((error) => cleanupErrors.push(String(error)));
    for (const [name, session] of [
        ["A", a],
        ["B", b],
    ] as const) {
        if (!session) continue;
        await session.assertDocument().catch((error) => cleanupErrors.push(`${name}: ${String(error)}`));
        await info.attach(`client-${name}`, {
            body: JSON.stringify(
                {
                    batches: session.batches,
                    transports: session.transports,
                    reads: session.reads,
                    errors: session.errors,
                    observations: await session.observations().catch(() => null),
                    drafts: await session.drafts().catch(() => null),
                    navigations: session.navigations,
                },
                null,
                2,
            ),
            contentType: "application/json",
        });
    }
    await info.attach("provider-and-owner-feed", {
        body: JSON.stringify({ streams, providerErrors, ownerFrames }, null, 2),
        contentType: "application/json",
    });
    console.log(JSON.stringify({ test: info.title, annotations: info.annotations }));
    await a?.context.close();
    await b?.context.close();
    if (seed) await cleanupCharacter(a, seed.chaId);
    expect(cleanupErrors).toEqual([]);
    expect(providerErrors).toEqual([]);
});

test.afterAll(async () => {
    try {
        if (a) await restoreRecords(a, restore);
    } finally {
        releaseProvider();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
});

async function openSessions() {
    await prepareSessions([a, b], seed!.chaId);
    for (const session of [a, b]) {
        await session.guard(async () => {
            await openCharacterChat(session.page, seed!.chaId);
            await session.page.evaluate(async () => (await import("/src/ts/globalApi.svelte.ts")).changeChatTo("s1"));
            await expect(session.page.locator("textarea.input-text").first()).toBeVisible();
            await settle(session.page, CONVERGENCE_TIMEOUT);
        });
        await session.reset();
    }
}

function mirrorMessages(session: Session) {
    return session.guard(() =>
        session.page.evaluate(async (chaId) => {
            const { findChat } = await import("/src/ts/storage/chatStore.svelte.ts");
            return findChat({ chaId, chatId: "s1" })?.message.map((message) => ({
                id: message.chatId!,
                role: message.role,
                text: message.data,
            }));
        }, seed!.chaId),
    );
}

function locked(session: Session, id: string) {
    return session.guard(() =>
        session.page.evaluate(
            async ({ chaId, id }) => {
                const { isMessageLocked } = await import("/src/ts/storage/chatStore.svelte.ts");
                return isMessageLocked({ chaId, chatId: "s1" }, id);
            },
            { chaId: seed!.chaId, id },
        ),
    );
}

async function waitForJobEnd() {
    await expect
        .poll(
            async () => {
                const answer = await a.api(`/api/generations/current?characterId=${seed!.chaId}&chatId=s1`);
                return answer.status;
            },
            { timeout: CONVERGENCE_TIMEOUT, message: "the held server job must end before cleanup" },
        )
        .toBe(404);
}

async function expectNoNotice(session: Session) {
    await expectQuiet(session);
    const generating = await session.guard(() =>
        session.page.evaluate(async () => (await import("/src/lang/index.ts")).language.chatGenerating),
    );
    const observations = await session.observations();
    expect(observations.alerts.filter((entry) => entry.value.msg === generating)).toEqual([]);
    expect(observations.reloads.filter((entry) => entry.value !== null)).toEqual([]);
}

function hasText(body: BatchBody, id: string, text: string) {
    return (
        body.chats?.some(
            (group) =>
                group.chatId === "s1" &&
                group.ops.some((op) => op.op === "setText" && op.id === id && op.text === text),
        ) ?? false
    );
}

async function rawWrite(ops: ChatOp[]) {
    const chat = await serverChat(b, seed!.chaId, "s1");
    return b.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({ chats: [{ characterId: seed!.chaId, chatId: "s1", baseRevision: chat.revision, ops }] }),
    });
}

function generatingRefusal(answer: Answer<BatchAnswer>, messageId?: string) {
    expect(answer.status, JSON.stringify(answer.body)).toBe(409);
    const conflict = answer.body.conflicts?.find(
        (entry) => entry.kind === "chat" && "id" in entry && entry.id === "s1",
    );
    expect(conflict).toMatchObject({ kind: "chat", characterId: seed!.chaId, id: "s1", reason: "generating" });
    if (messageId) expect(conflict).toMatchObject({ messageIds: expect.arrayContaining([messageId]) });
    else expect(conflict).not.toHaveProperty("messageIds");
}

async function expectHeldReply(id: string, text: string) {
    expect(providerReleased).toBe(false);
    expect(streams).toEqual([{ closed: false }]);
    const stored = await serverChat(a, seed!.chaId, "s1");
    expect(stored.data!.message.filter((message) => message.chatId === id).map((message) => message.data)).toEqual([
        text,
    ]);
}

async function expectCompleted(expected: ExpectedState, replyId: string) {
    await waitForJobEnd();
    await expectState(a, [a, b], seed!.chaId, expected);
    for (const session of [a, b]) {
        await session.guard(async () => {
            const row = session.page.locator(`.risu-chat[data-chat-id="${replyId}"]`);
            await expect(row).toHaveCount(1);
            await expect(row.locator(".chattext")).toContainText(
                expected.chats.s1.messages.find((message) => message.id === replyId)!.text,
            );
        });
    }
    await a.guard(() => expect(a.page.locator('button[aria-labelledby="cancel"]')).toHaveCount(0));
    await expect.poll(() => locked(b, replyId), { timeout: CONVERGENCE_TIMEOUT }).toBe(false);
    expect(streams).toHaveLength(1);
}

test("a held reply refuses locked writes, preserves another message edit, and becomes editable on completion", async () => {
    await openSessions();
    const { chaId } = seed!;
    const expected = seedState(seed!);
    let replyId: string;

    await test.step("the observer renders the first chunk and refuses edits of the locked reply", async () => {
        await a.guard(async () => {
            const input = a.page.locator("textarea.input-text").first();
            await input.fill(PROMPT);
            await input.press("Enter");
            await expect(a.page.locator('button[aria-labelledby="cancel"]')).toBeVisible();
        });
        await expect
            .poll(async () => (await mirrorMessages(b))?.at(-1)?.text, { timeout: CONVERGENCE_TIMEOUT })
            .toBe(FIRST_CHUNK);
        const messages = (await mirrorMessages(b))!;
        expect(messages).toHaveLength(6);
        const inputId = messages.at(-2)!.id;
        replyId = messages.at(-1)!.id;
        expect(inputId).toBeTruthy();
        expect(replyId).toBeTruthy();
        expected.chats.s1.messages.push(
            { id: inputId, role: "user", text: PROMPT },
            { id: replyId, role: "char", text: FIRST_CHUNK },
        );
        await b.guard(async () => {
            const row = b.page.locator(`.risu-chat[data-chat-id="${replyId}"]`);
            await expect(row.locator(".chattext")).toContainText(FIRST_CHUNK);
            await expect(row).toBeVisible();
            await expect(row.locator(".button-icon-edit")).toBeDisabled();
            await expect(row.locator(".button-icon-remove")).toBeDisabled();
        });
        expect(await locked(b, replyId)).toBe(true);
        await expect(
            edits(b, chaId, [{ type: "text", chatId: "s1", id: replyId, text: "Refused local overwrite" }]),
        ).rejects.toThrow("This message is being generated; wait until it finishes");
        const refused = await rawWrite([{ op: "setText", id: replyId, text: "Refused raw overwrite" }]);
        generatingRefusal(refused, replyId);
        await test.info().attach("locked-message-refusal", {
            body: JSON.stringify(refused, null, 2),
            contentType: "application/json",
        });
        await expectHeldReply(replyId, FIRST_CHUNK);
        await expectState(a, [a, b], chaId, expected);
        await expectNoNotice(a);
        await expectNoNotice(b);
    });

    const otherText = "B edited the earlier message while the reply was held.";
    await test.step("an edit of another message is acknowledged while the reply stays held", async () => {
        await edits(b, chaId, [{ type: "text", chatId: "s1", id: "m1", text: otherText }]);
        const carrying = () => b.batches.filter((batch) => hasText(batch.body, "m1", otherText));
        await expect
            .poll(() => carrying().find((batch) => batch.response)?.response?.status, { timeout: CONVERGENCE_TIMEOUT })
            .toBe(200);
        expect(carrying().every((batch) => batch.response?.status === 200)).toBe(true);
        const revision = carrying()[0].response!.body.chats!.find((chat) => chat.id === "s1")!.revision;
        await expect
            .poll(
                () =>
                    ownerFrames.some(
                        (frame) =>
                            frame.type === "change" &&
                            frame.changes.chats.some(
                                (chat) => chat.characterId === chaId && chat.id === "s1" && chat.revision === revision,
                            ),
                    ),
                { timeout: CONVERGENCE_TIMEOUT, message: "A receives the frame announcing B's acknowledged edit" },
            )
            .toBe(true);
        expected.chats.s1.messages[0].text = otherText;
        await expectState(b, [b], chaId, expected);
        await expectHeldReply(replyId, FIRST_CHUNK);
        await expectNoNotice(a);
        await expectNoNotice(b);
        const owner = (await mirrorMessages(a))!;
        const duringHold = owner.find((message) => message.id === "m1")!.text;
        test.info().annotations.push({
            type: "owner mirror during hold",
            description: JSON.stringify({
                acceptedRevision: revision,
                frameReceived: true,
                expectedText: otherText,
                actualText: duringHold,
                reply: owner.find((message) => message.id === replyId),
                showsEdit: duringHold === otherText,
            }),
        });
        if (duringHold === otherText) await expectState(a, [a, b], chaId, expected);
        else expect(duringHold).toBe(seed!.chats.s1.message[0].data);
        // The owner's whole-chat refresh waits for its own stream. Completion below must adopt B's edit.
    });

    await test.step("permanent character deletion and whole-chat deletion are refused during generation", async () => {
        await expect(
            b.guard(() =>
                b.page.evaluate(async (chaId) => {
                    const { removeCharacter } = await import("/src/ts/storage/characterStore.svelte.ts");
                    removeCharacter(chaId);
                }, chaId),
            ),
        ).rejects.toThrow("the character is generating a reply");
        const refused = await rawWrite([{ op: "delete" }]);
        generatingRefusal(refused);
        await test
            .info()
            .attach("chat-delete-refusal", { body: JSON.stringify(refused, null, 2), contentType: "application/json" });
        await expectHeldReply(replyId, FIRST_CHUNK);
        await expectState(b, [b], chaId, expected);
        for (const session of [a, b]) {
            const present = await session.guard(() =>
                session.page.evaluate(async (chaId) => {
                    const { findCharacter } = await import("/src/ts/storage/characterStore.svelte.ts");
                    const { findChat } = await import("/src/ts/storage/chatStore.svelte.ts");
                    return { character: !!findCharacter(chaId), chat: !!findChat({ chaId, chatId: "s1" }) };
                }, chaId),
            );
            expect(present).toEqual({ character: true, chat: true });
        }
    });

    await test.step("completion keeps the full reply once and allows the observer's next edit", async () => {
        releaseProvider();
        expected.chats.s1.messages.at(-1)!.text = FIRST_CHUNK + REMAINDER;
        await expectCompleted(expected, replyId);
        const editedReply = "B edited the completed reply.";
        await edits(b, chaId, [{ type: "text", chatId: "s1", id: replyId, text: editedReply }]);
        expected.chats.s1.messages.at(-1)!.text = editedReply;
        await expectState(a, [a, b], chaId, expected);
        await expectNoNotice(a);
        await expectNoNotice(b);
    });
});

test("an edit before the continue lock frame is refused with a reload notice and the whole reply is recovered", async () => {
    const { chaId } = seed!;
    const expected = seedState(seed!);
    const buffered: {
        socket: WebSocketRoute;
        message: string | Buffer;
        frame: Extract<EventFeedFrame, { type: "change" }>;
    }[] = [];
    let armed = false;
    // Intercept only the resource feed, before B's first navigation. Heartbeats and HMR flow normally.
    await b.page.routeWebSocket(
        (url) => url.pathname === EVENT_FEED_PATH,
        (socket) => {
            const server = socket.connectToServer();
            server.onMessage((message) => {
                const frame = JSON.parse(String(message)) as EventFeedFrame;
                if (armed && frame.type === "change") buffered.push({ socket, message, frame });
                else socket.send(message);
            });
        },
    );
    releaseFeed = () => {
        armed = false;
        for (const { socket, message } of buffered.splice(0)) socket.send(message);
    };
    await openSessions();
    armed = true;
    await a.guard(() =>
        a.page.evaluate(async (chaId) => {
            const { sendChat } = await import("/src/ts/process/index.svelte.ts");
            window.__multiClientContinue = sendChat(-1, { target: { chaId, chatId: "s1" }, continue: true });
        }, chaId),
    );
    await expect
        .poll(
            () =>
                buffered.some(({ frame }) =>
                    frame.streaming?.some(
                        (chat) =>
                            chat.characterId === chaId &&
                            chat.id === "s1" &&
                            chat.streaming.some((message) => message.messageId === "m4"),
                    ),
                ),
            {
                timeout: CONVERGENCE_TIMEOUT,
                message: "B's held change frame names the existing reply's generation lock",
            },
        )
        .toBe(true);
    const continuedFirst = seed!.chats.s1.message[3].data + FIRST_CHUNK;
    await expect
        .poll(async () => (await serverChat(a, chaId, "s1")).data!.message[3].data, { timeout: CONVERGENCE_TIMEOUT })
        .toBe(continuedFirst);
    const localText = "B's edit made before the lock frame arrived.";
    // Observe the optimistic write in the same turn, before the save loop can recover its refusal.
    const local = await b.guard(() =>
        b.page.evaluate(
            async ({ chaId, localText }) => {
                const { findChat, isMessageLocked, setMessageText } =
                    await import("/src/ts/storage/chatStore.svelte.ts");
                const ref = { chaId, chatId: "s1" };
                const wasLocked = isMessageLocked(ref, "m4");
                setMessageText(ref, "m4", localText);
                return { wasLocked, text: findChat(ref)!.message.find((message) => message.chatId === "m4")!.data };
            },
            { chaId, localText },
        ),
    );
    expect(local).toEqual({ wasLocked: false, text: localText });
    const refused = () => b.batches.find((batch) => hasText(batch.body, "m4", localText) && batch.response)?.response;
    await expect.poll(refused, { timeout: CONVERGENCE_TIMEOUT }).toBeDefined();
    generatingRefusal(refused()!, "m4");
    const reloadMessage = await b.guard(() =>
        b.page.evaluate(async () => (await import("/src/lang/index.ts")).language.resourceReloaded),
    );
    await expect
        .poll(
            async () => {
                const observations = await b.observations();
                return {
                    reload: observations.reloads.some((entry) => entry.value === reloadMessage),
                    discards: observations.discards,
                };
            },
            { timeout: CONVERGENCE_TIMEOUT },
        )
        .toEqual({ reload: true, discards: [`chats/${chaId}/s1`] });
    expected.chats.s1.messages[3].text = continuedFirst;
    await expectState(a, [a, b], chaId, expected);
    expect(
        b.reads.some((body) =>
            (body as { chats?: { characterId: string; id: string }[] }).chats?.some(
                (chat) => chat.characterId === chaId && chat.id === "s1",
            ),
        ),
        "the observer reads the refused chat back whole",
    ).toBe(true);
    await expectHeldReply("m4", continuedFirst);
    await test.info().attach("buffered-lock-frames", {
        body: JSON.stringify(
            buffered.map(({ frame }) => frame),
            null,
            2,
        ),
        contentType: "application/json",
    });
    test.info().annotations.push({
        type: "before-lock edit",
        description:
            "Continued existing m4 with B's change frames held. B was unlocked, its edit received 409 generating, and resourceReloaded plus a discard preceded the whole-chat recovery.",
    });
    releaseFeed();
    releaseProvider();
    expected.chats.s1.messages[3].text = continuedFirst + REMAINDER;
    await expectCompleted(expected, "m4");
    expect(await a.guard(() => a.page.evaluate(() => window.__multiClientContinue))).toBe(true);
    await expectNoNotice(a);
    await b.guard(() => settle(b.page, CONVERGENCE_TIMEOUT));
    expect(b.errors).toEqual([]);
    const observations = await b.observations();
    expect(observations.alerts.filter((entry) => entry.value.type === "error")).toEqual([]);
    expect(observations.reloads.filter((entry) => entry.value).map((entry) => entry.value)).toEqual([reloadMessage]);
    expect(observations.discards).toEqual([`chats/${chaId}/s1`]);
    // Conflict capture preserves the dropped intent for Review after adopting the server's reply.
    await expect
        .poll(() => b.drafts(), { timeout: CONVERGENCE_TIMEOUT })
        .toEqual([
            expect.objectContaining({
                type: "draft",
                scope: "chat",
                target: `${chaId}\u0000s1`,
                layers: {
                    resend: expect.objectContaining({
                        value: expect.objectContaining({
                            inDoubt: false,
                            ops: [{ op: "setText", id: "m4", text: localText }],
                        }),
                    }),
                },
            }),
        ]);
    const drafts = await b.drafts();
    await expect
        .poll(
            () =>
                b.guard(() =>
                    b.page.evaluate(async () => {
                        const { recoveryDrafts } = await import("/src/ts/storage/recoveryDrafts.svelte.ts");
                        return recoveryDrafts.entries.map((draft) => draft.id);
                    }),
                ),
            { timeout: CONVERGENCE_TIMEOUT },
        )
        .toEqual([drafts[0].id]);
});
