/**
 * Two isolated browsers write through the real stores, HTTP batches, WebSocket feed and SQLite.
 * Covers src/ts/storage/resourceSync.svelte.ts, src/ts/storage/chatStore.svelte.ts,
 * src/ts/storage/characterStore.svelte.ts, src/ts/storage/settingsViews.svelte.ts,
 * src/ts/network/eventFeed.ts, src/ts/storage/draftJournal.ts,
 * src/ts/storage/recoveryDrafts.svelte.ts, src/ts/alert.ts and server/src/data/chatStore.ts.
 * Accepted independent writes survive; a refused local edit must remain visible as recovery work.
 */
import { expect, settle, test } from "./fixtures";
import { isChatOrderConflict } from "../shared/resources.ts";
import {
    BATCH_URL,
    CONVERGENCE_TIMEOUT,
    chatState,
    cleanupCharacter,
    createSession,
    edits,
    emptyChat,
    expectQuiet,
    expectState,
    holdBatch,
    prepareSessions,
    restoreRecords,
    seedCharacter,
    seedState,
    serverChat,
    serverChatList,
    serverRecord,
    type Answer,
    type BatchAnswer,
    type BatchBody,
    type ExpectedState,
    type Seed,
    type Session,
    type RecordOp,
} from "./multiClient";

let a: Session;
let b: Session;
let seed: Seed | undefined;
const restore = new Map<string, unknown>();

test.beforeEach(async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    seed = undefined;
    a = await createSession(browser, baseURL!);
    b = await createSession(browser, baseURL!);
    seed = await seedCharacter(a, restore);
    await prepareSessions([a, b], seed.chaId);
});

test.afterEach(async ({}, info) => {
    const documentErrors: string[] = [];
    // Keep full request/answer evidence even when an invariant fails, before closing the documents.
    for (const [name, s] of [
        ["A", a],
        ["B", b],
    ] as const) {
        if (!s) continue;
        await s.assertDocument().catch((error) => documentErrors.push(`${name}: ${String(error)}`));
        const observations = s.page.isClosed() ? null : await s.observations().catch(() => null);
        const drafts = s.page.isClosed() ? null : await s.drafts().catch(() => null);
        await info.attach(`client-${name}`, {
            body: JSON.stringify(
                {
                    batches: s.batches,
                    transports: s.transports,
                    reads: s.reads,
                    errors: s.errors,
                    observations,
                    drafts,
                    navigations: s.navigations,
                },
                null,
                2,
            ),
            contentType: "application/json",
        });
    }
    console.log(JSON.stringify({ test: info.title, annotations: info.annotations }));
    await a?.context.close();
    await b?.context.close();
    if (seed) await cleanupCharacter(a, seed.chaId);
    expect(documentErrors, "a client navigated after the case's setup completed").toEqual([]);
});

test.afterAll(async () => {
    if (a) await restoreRecords(a, restore);
});

function text(expected: ExpectedState, chatId: string, id: string, value: string) {
    const message = expected.chats[chatId].messages.find((message) => message.id === id);
    if (!message) throw new Error(`Expected message ${chatId}/${id} is missing`);
    message.text = value;
}

function hasText(body: BatchBody, chatId: string, id: string, value: string) {
    return (
        body.chats?.some(
            (group) =>
                group.chatId === chatId &&
                group.ops.some((op) => op.op === "setText" && op.id === id && op.text === value),
        ) ?? false
    );
}

function applied(answer: Answer<BatchAnswer>, chatId: string) {
    expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(200);
    expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(300);
    expect(answer.body.chats?.find((group) => group.id === chatId)?.revision, JSON.stringify(answer.body)).toBeTruthy();
}

function annotate(type: string, description: string) {
    test.info().annotations.push({ type, description });
}

test("a stale client merges independent edits and recovers its edit of a deleted chat", async () => {
    const { chaId, binding } = seed!;
    const expected = seedState(seed!);
    const local = "A offline description";
    const gone = "A offline text in the deleted chat";
    await a.context.setOffline(true);
    await edits(a, chaId, [
        { type: "character", patch: { desc: local } },
        { type: "text", chatId: "s1", id: "m1", text: "A offline first" },
        { type: "text", chatId: "s1", id: "m2", text: "A offline same message" },
        { type: "text", chatId: "s2", id: "m1", text: gone },
    ]);
    await expect.poll(() => a.batches.some((batch) => batch.failure), { timeout: 30_000 }).toBe(true);
    await edits(b, chaId, [
        { type: "character", patch: { name: "B renamed character" } },
        { type: "text", chatId: "s1", id: "m2", text: "B earlier same message" },
        { type: "text", chatId: "s1", id: "m3", text: "B third message" },
        { type: "append", chatId: "s1", message: { chatId: "b-append", role: "char", data: "B appended reply" } },
        { type: "create", chat: emptyChat("s5", binding) },
        { type: "delete", chatId: "s2" },
    ]);
    await settle(b.page);
    expect(
        b.batches.some(
            (batch) => batch.response?.status === 200 && batch.response.body.chats?.some((group) => group.id === "s1"),
        ),
    ).toBe(true);
    await a.context.setOffline(false);

    expected.character = { name: "B renamed character", desc: local };
    text(expected, "s1", "m1", "A offline first");
    text(expected, "s1", "m2", "A offline same message");
    text(expected, "s1", "m3", "B third message");
    expected.chats.s1.messages.push({ id: "b-append", role: "char", text: "B appended reply" });
    delete expected.chats.s2;
    expected.chats.s5 = chatState(emptyChat("s5", binding));
    await expectState(b, [a, b], chaId, expected);
    expect((await serverChat(b, chaId, "s2")).data).toBeNull();
    await settle(a.page, CONVERGENCE_TIMEOUT);
    await expect
        .poll(
            async () => {
                const drafts = await a.drafts();
                return drafts.filter(
                    (draft) =>
                        draft.scope === "chat" &&
                        draft.target === `${chaId}\u0000s2` &&
                        JSON.stringify(draft.layers).includes(gone),
                ).length;
            },
            { timeout: 20_000, message: "the deleted chat's unsaved text must survive in the durable journal" },
        )
        .toBe(1);
    const drafts = await a.drafts();
    expect(drafts).toHaveLength(1); // The independent character fields merged without a record draft.
    await expect
        .poll(
            () =>
                a.page.evaluate(async () => {
                    const { recoveryDrafts } = await import("/src/ts/storage/recoveryDrafts.svelte.ts");
                    return recoveryDrafts.entries.map((draft) => draft.id);
                }),
            { timeout: 20_000 },
        )
        .toEqual([drafts[0].id]);
    const notices = await a.observations();
    const reloadMessage = await a.page.evaluate(
        async () => (await import("/src/lang/index.ts")).language.resourceReloaded,
    );
    expect(notices.reloads.some((entry) => entry.value === reloadMessage)).toBe(true);
    expect(notices.discards).toEqual([`chats/${chaId}/s2`]);
    expect(
        a.batches.some(
            (batch) =>
                batch.response?.status === 409 &&
                batch.response.body.conflicts?.some(
                    (conflict) => conflict.kind === "chat" && "id" in conflict && conflict.id === "s2",
                ),
        ),
    ).toBe(true);
    expect(a.errors).toEqual([]);
    expect(notices.alerts.filter((entry) => entry.value.type === "error")).toEqual([]);
    await expectQuiet(b);
});

test("a committed batch with a lost answer retries its append exactly once", async () => {
    const { chaId } = seed!;
    const expected = seedState(seed!);
    const baseline = (await serverRecord(a, "ui")).data;
    const nextValue = !baseline.sendWithEnter;
    let sent: BatchBody | undefined;
    let fetched: Answer<BatchAnswer> | undefined;
    let routeError: string | undefined;
    await a.page.route(BATCH_URL, async (route) => {
        if (sent) return route.fallback();
        sent = route.request().postDataJSON() as BatchBody;
        try {
            const response = await route.fetch({ maxRetries: 0, timeout: 30_000 });
            fetched = { status: response.status(), body: await response.json(), time: Date.now() };
        } catch (error) {
            routeError = String(error);
        } finally {
            await route.abort("failed");
        }
    });
    await edits(a, chaId, [
        {
            type: "append",
            chatId: "s3",
            message: { chatId: "lost-answer-append", role: "user", data: "Append whose answer was lost" },
        },
        { type: "ui", sendWithEnter: nextValue },
    ]);
    await expect.poll(() => fetched ?? routeError, { timeout: 40_000 }).toBeDefined();
    expect(routeError).toBeUndefined();
    applied(fetched!, "s3");
    expect(fetched!.body.results?.some((result) => result.kind === "ui")).toBe(true);
    await test.info().attach("committed-answer-dropped", {
        body: JSON.stringify({ sent, fetched }, null, 2),
        contentType: "application/json",
    });
    // A record conflict can precede the chat-only retry. Check the next definitive answer before
    // waiting for idle, so broken recognition reports the missing acknowledgement, not a save-loop timeout.
    const retryAnswer = () =>
        a.batches
            .slice(1)
            .find(
                (batch) =>
                    batch.body.chats?.some((group) => group.chatId === "s3") &&
                    batch.response &&
                    batch.response.status !== 409,
            )?.response;
    await expect.poll(retryAnswer, { timeout: CONVERGENCE_TIMEOUT }).toBeDefined();
    expect(
        { status: retryAnswer()!.status, group: retryAnswer()!.body.chats?.find((group) => group.id === "s3") },
        "a remembered group must return its original acknowledgement",
    ).toEqual({
        status: fetched!.status,
        group: fetched!.body.chats!.find((group) => group.id === "s3"),
    });
    expected.chats.s3.messages.push({ id: "lost-answer-append", role: "user", text: "Append whose answer was lost" });
    expected.ui = { sendWithEnter: nextValue };
    await expectState(b, [a, b], chaId, expected);
    await expectQuiet(a);
    await expectQuiet(b);
    const chatBatches = a.batches.filter((batch) => batch.body.chats?.some((group) => group.chatId === "s3"));
    expect(chatBatches.length).toBeGreaterThanOrEqual(2);
    const original = sent!.chats!.find((group) => group.chatId === "s3")!;
    expect(original.groupId).toBeTruthy();
    const retry = chatBatches[1].body.chats!.find((group) => group.chatId === "s3")!;
    expect(retry).toMatchObject({
        groupId: original.groupId,
        retry: true,
        ops: original.ops,
        baseRevision: original.baseRevision,
    });
    const ui = sent!.ops!.find((op) => op.kind === "ui")!;
    // The first write may be a field patch; an in-doubt resend can carry the whole sent record.
    const recordValue = (op: RecordOp): unknown => {
        if ("data" in op) return op.data;
        if (!("patch" in op) || !("set" in op.patch)) throw new Error("Expected an object field patch");
        const data = { ...baseline, ...op.patch.set };
        for (const key of op.patch.remove ?? []) delete data[key];
        return data;
    };
    const sentValue = recordValue(ui);
    expect(sentValue).toEqual({ ...baseline, sendWithEnter: nextValue });
    for (const batch of a.batches.slice(1)) {
        for (const op of batch.body.ops ?? []) {
            if (op.kind === "ui") expect(recordValue(op)).toEqual(sentValue);
        }
    }
    const acknowledged = chatBatches.slice(1).filter((batch) => batch.response?.status === 200);
    expect(acknowledged).toHaveLength(1);
    expect(a.batches.length).toBeLessThanOrEqual(3);
    const recordConflict = a.batches.some((batch) => batch.response?.status === 409);
    annotate(
        "lost-answer path",
        recordConflict
            ? "Exact ui resend conflicted; chat-only retry followed (3 batches)"
            : "Feed acknowledged ui before retry (2 batches)",
    );
});

test("overlapping edits to different messages both survive a stale chat revision", async () => {
    const { chaId } = seed!;
    const expected = seedState(seed!);
    const before = (await serverChat(a, chaId, "s3")).revision;
    const ah = await holdBatch(a, (body) => hasText(body, "s3", "m1", "A first message"));
    const bh = await holdBatch(b, (body) => hasText(body, "s3", "m3", "B third message"));
    try {
        await edits(a, chaId, [{ type: "text", chatId: "s3", id: "m1", text: "A first message" }]);
        await edits(b, chaId, [{ type: "text", chatId: "s3", id: "m3", text: "B third message" }]);
        const [ab, bb] = await Promise.all([ah.wait(), bh.wait()]);
        expect(ab.chats!.find((group) => group.chatId === "s3")!.baseRevision).toBe(before);
        expect(bb.chats!.find((group) => group.chatId === "s3")!.baseRevision).toBe(before);
        expect((await serverChat(a, chaId, "s3")).revision).toBe(before);
        applied(await ah.release(), "s3");
        applied(await bh.release(), "s3");
    } finally {
        await ah.dispose();
        await bh.dispose();
    }
    text(expected, "s3", "m1", "A first message");
    text(expected, "s3", "m3", "B third message");
    await expectState(a, [a, b], chaId, expected);
    await expectQuiet(a);
    await expectQuiet(b);
    expect([...a.batches, ...b.batches].filter((batch) => batch.response?.status === 409)).toEqual([]);
});

test("overlapping edits to the same message converge to the later accepted text", async () => {
    const { chaId } = seed!;
    const expected = seedState(seed!);
    const earlier = "A accepted text replaced by the later by-id write";
    const later = "B later accepted text";
    const before = (await serverChat(a, chaId, "s3")).revision;
    const ah = await holdBatch(a, (body) => hasText(body, "s3", "m2", earlier));
    const bh = await holdBatch(b, (body) => hasText(body, "s3", "m2", later));
    try {
        await edits(a, chaId, [{ type: "text", chatId: "s3", id: "m2", text: earlier }]);
        await edits(b, chaId, [{ type: "text", chatId: "s3", id: "m2", text: later }]);
        const [ab, bb] = await Promise.all([ah.wait(), bh.wait()]);
        expect(ab.chats!.find((group) => group.chatId === "s3")!.baseRevision).toBe(before);
        expect(bb.chats!.find((group) => group.chatId === "s3")!.baseRevision).toBe(before);
        expect((await serverChat(a, chaId, "s3")).revision).toBe(before);
        applied(await ah.release(), "s3");
        expect((await serverChat(a, chaId, "s3")).data!.message.find((message) => message.chatId === "m2")!.data).toBe(
            earlier,
        );
        applied(await bh.release(), "s3");
    } finally {
        await ah.dispose();
        await bh.dispose();
    }
    text(expected, "s3", "m2", later);
    await expectState(a, [a, b], chaId, expected);
    await expectQuiet(a);
    await expectQuiet(b);
    annotate("losing text", earlier);
});

test("concurrent chat creation deletion and reordering preserve every surviving chat", async () => {
    const { chaId, binding } = seed!;
    const expected = seedState(seed!);
    const ah = await holdBatch(a, (body) => body.chats?.some((group) => group.chatId === "x1") ?? false);
    const bh = await holdBatch(b, (body) => body.chats?.some((group) => group.chatId === "y1") ?? false);
    let requestedOrder: string[] | null = null;
    const before = (await serverChatList(a, chaId)).order!.revision;
    try {
        requestedOrder = await edits(a, chaId, [
            { type: "create", chat: emptyChat("x1", binding) },
            { type: "create", chat: emptyChat("x2", binding) },
            { type: "reorderFirst", ids: ["x2", "x1"] },
        ]);
        await edits(b, chaId, [
            { type: "create", chat: emptyChat("y1", binding) },
            { type: "delete", chatId: "s4" },
        ]);
        await Promise.all([ah.wait(), bh.wait()]);
        expect((await serverChatList(a, chaId)).order!.revision).toBe(before);
        applied(await bh.release(), "y1");
        // The held reorder can conflict, but its unrelated creates must be retried intact.
        await ah.release();
    } finally {
        await ah.dispose();
        await bh.dispose();
    }
    delete expected.chats.s4;
    for (const id of ["x1", "x2", "y1"]) expected.chats[id] = chatState(emptyChat(id, binding));
    const storedOrder = await expectState(a, [a, b], chaId, expected);
    expect((await serverChat(a, chaId, "s4")).data).toBeNull();
    await settle(a.page, CONVERGENCE_TIMEOUT);
    const observed = await a.observations();
    const orderKey = `chats/${chaId}`;
    const refusedOrder = a.batches.some(
        (batch) =>
            batch.body.chatOrders?.some((order) => order.characterId === chaId) &&
            batch.response?.status === 409 &&
            batch.response.body.conflicts?.some(
                (conflict) => isChatOrderConflict(conflict) && conflict.characterId === chaId,
            ),
    );
    const discarded =
        observed.discards.includes(orderKey) ||
        (refusedOrder && JSON.stringify(storedOrder) !== JSON.stringify(requestedOrder));
    if (discarded) expect(storedOrder).not.toEqual(requestedOrder);
    expect(observed.reloads.some((entry) => !!entry.value)).toBe(discarded);
    expect(observed.discards.filter((key) => key !== orderKey)).toEqual([]);
    expect(a.errors).toEqual([]);
    expect(observed.alerts.filter((entry) => entry.value.type === "error")).toEqual([]);
    const drafts = await a.drafts();
    expect(drafts.filter((draft) => draft.scope !== "order" || draft.target !== chaId)).toEqual([]);
    if (!discarded) expect(drafts).toEqual([]);
    await expectQuiet(b);
    annotate(
        "reorder outcome",
        JSON.stringify({ discarded, discards: observed.discards, refusedOrder, requestedOrder, storedOrder }),
    );
});

test("a graceful tab close preserves the last message edit in the server and the remaining client", async ({
    baseURL,
}) => {
    const { chaId } = seed!;
    const expected = seedState(seed!);
    const message = "A last message edit before graceful close";
    const desc = "A record edit before graceful close";
    await edits(a, chaId, [
        { type: "text", chatId: "s1", id: "m4", text: message },
        { type: "character", patch: { desc } },
    ]);
    await a.page.close({ runBeforeUnload: true });
    await expect.poll(() => a.page.isClosed(), { timeout: 20_000 }).toBe(true);
    text(expected, "s1", "m4", message);
    delete expected.character.desc; // Records use ordinary cycles only; their unload arrival is observational.
    await expectState(b, [b], chaId, expected);
    await expectQuiet(b);
    expect(a.errors).toEqual([]);
    await expect
        .poll(() => a.transports.some((batch) => hasText(batch.body, "s1", "m4", message)), { timeout: 20_000 })
        .toBe(true);
    const carrying = a.transports.filter((batch) => hasText(batch.body, "s1", "m4", message));
    expect(carrying.length).toBeGreaterThan(0);
    const transports = [
        ...new Set(
            carrying.map((batch) => {
                if (batch.keepalive) {
                    expect(Object.keys(batch.body)).toEqual(["chats"]);
                    return "pagehide keepalive";
                }
                expect(batch.body).toHaveProperty("ops");
                expect(batch.body).toHaveProperty("chatOrders");
                return "ordinary save cycle";
            }),
        ),
    ];
    const storedDesc = (await serverRecord(b, "characters", chaId)).data.desc;
    let journal: { readSucceeded: boolean; target: string; descRetained: boolean; rowTypes: string[] } | null = null;
    if (storedDesc !== desc) {
        // This idle document reads the closed tab's durable rows without booting recovery or changing them.
        const idlePage = await a.context.newPage();
        await idlePage.goto(`${baseURL}/sw/init`);
        const read = await idlePage.evaluate(
            () =>
                new Promise<{
                    readSucceeded: true;
                    rows: import("../src/ts/storage/draftJournal").JournalRow[];
                }>((resolve, reject) => {
                    const request = indexedDB.open("risu-draft-journal");
                    request.onerror = () => reject(request.error);
                    request.onblocked = () => reject(new Error("Journal read was blocked"));
                    request.onupgradeneeded = () => {
                        request.transaction?.abort();
                        reject(new Error("Expected the closed tab's existing journal database"));
                    };
                    request.onsuccess = () => {
                        const db = request.result;
                        try {
                            const tx = db.transaction("entries", "readonly");
                            const rows = tx.objectStore("entries").getAll();
                            tx.oncomplete = () => {
                                db.close();
                                resolve({ readSucceeded: true, rows: rows.result });
                            };
                            tx.onabort = tx.onerror = () => {
                                db.close();
                                reject(tx.error ?? new Error("Journal read transaction failed"));
                            };
                        } catch (error) {
                            db.close();
                            reject(error);
                        }
                    };
                }),
        );
        expect(read.readSucceeded, "the closed tab's durable journal was read successfully").toBe(true);
        const target = `characters\u0000${chaId}`;
        const recordRows = read.rows.flatMap((row) => {
            if (row.type === "composer" || row.scope !== "record" || row.target !== target) return [];
            return [
                {
                    type: row.type,
                    layers: Object.entries(row.layers).map(([name, layer]) => ({
                        name,
                        desc: typeof layer.value.text === "string" ? JSON.parse(layer.value.text).desc : null,
                    })),
                },
            ];
        });
        journal = {
            readSucceeded: read.readSucceeded,
            target,
            descRetained: recordRows.some((row) => row.layers.some((layer) => layer.desc === desc)),
            rowTypes: recordRows.map((row) => row.type),
        };
        await test.info().attach("closed-tab-character-journal", {
            body: JSON.stringify({ ...journal, recordRows }, null, 2),
            contentType: "application/json",
        });
    }
    annotate("close delivery", JSON.stringify({ transports, descArrived: storedDesc === desc, storedDesc, journal }));
    await a.context.close();
});
