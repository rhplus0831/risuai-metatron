import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext, Page, Request as PlaywrightRequest, Route } from "@playwright/test";
import type { Chat, Message } from "../shared/database";
import type { ChatGroup, ChatOrderChange } from "../shared/chats";
import type {
    ResourceBatchOp,
    ResourceBatchResult,
    ResourceBatchConflictBody,
    ResourceReadRefsResult,
    ResourceRecord,
    RecordWritePatch,
} from "../shared/resources";
import type { DraftEntry } from "../src/ts/storage/draftJournal";
import { clearSafeBootAttempts, isolateContext, openApp } from "../util/playwright/stack.mjs";
import { chatBindingFixture } from "../util/playwright/modelProfiles.mjs";
import { expect, settle } from "./fixtures";

// The offline save loop can back off for 30 seconds before reconnecting.
export const CONVERGENCE_TIMEOUT = 90_000;
export const BATCH_URL = "**/api/resources/batch";
export type RecordOp = ResourceBatchOp | { kind: string; id: string; baseRevision: string; patch: RecordWritePatch };
export type BatchBody = { ops?: RecordOp[]; chats?: ChatGroup[]; chatOrders?: ChatOrderChange[] };
export type BatchAnswer = Partial<ResourceBatchResult & ResourceBatchConflictBody>;
export type Answer<T> = { status: number; body: T; time: number; rawBody?: string };
export type Batch = { body: BatchBody; time: number; response?: Answer<BatchAnswer>; failure?: string };
export type Transport = { body: BatchBody; keepalive: boolean; time: number };
export type DocumentStamp = { token: string; navigation: number };
export type Navigation = { time: number; reason: string; url?: string; payload?: unknown };
export type Observations = {
    reloads: { value: string | null; time: number }[];
    alerts: { value: { type: string; msg: string }; time: number }[];
    discards: string[];
};

declare global {
    interface Window {
        __multiClient: Omit<Observations, "discards"> & { discardStart: number; unsubscribe: (() => void)[] };
        __multiClientTransport(value: Transport): Promise<void>;
        __multiClientDocument: { token: string; unloading: boolean };
    }
}

export interface Session {
    context: BrowserContext;
    page: Page;
    errors: string[];
    batches: Batch[];
    transports: Transport[];
    reads: unknown[];
    navigations: Navigation[];
    api<T = BatchAnswer>(path: string, init?: { method?: string; body?: string }): Promise<Answer<T>>;
    open(): Promise<void>;
    setEpoch(epoch: string): void;
    observe(): Promise<void>;
    observations(): Promise<Observations>;
    reset(): Promise<void>;
    drafts(): Promise<DraftEntry[]>;
    document(): Promise<DocumentStamp>;
    armDocument(stamp: DocumentStamp): void;
    assertDocument(): Promise<void>;
    guard<T>(work: () => Promise<T>): Promise<T>;
}

/** An isolated document with real HTTP, sockets, stores, and durable IndexedDB. */
export async function session(context: BrowserContext, baseURL: string): Promise<Session> {
    await clearSafeBootAttempts(context);
    await isolateContext(context);
    const page = await context.newPage();
    const batches: Batch[] = [];
    const transports: Transport[] = [];
    const reads: unknown[] = [];
    const errors: string[] = [];
    const byRequest = new WeakMap<PlaywrightRequest, Batch>();
    let auth = "";
    let epoch = "";
    const navigations: Navigation[] = [];
    let navigation = 0;
    let pendingNavigation = false;
    let armed: DocumentStamp | undefined;
    let navigationFailure: Error | undefined;
    let signalNavigation: ((error: Error) => void) | undefined;
    let navigationFailed: Promise<Error> | undefined;
    const noteNavigation = (event: Navigation) => {
        navigations.push(event);
        if (armed && !navigationFailure) {
            navigationFailure = new Error(
                `Client document navigated during the case (${event.reason}, ${event.url ?? page.url()}); its loaded chats and observers are no longer valid. Navigation history: ${JSON.stringify(navigations)}`,
            );
            signalNavigation?.(navigationFailure);
        }
    };
    page.on("request", (request) => {
        if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
        navigation++;
        pendingNavigation = true;
        noteNavigation({ time: Date.now(), reason: "main-frame request", url: request.url() });
    });
    page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) pendingNavigation = false;
    });
    page.on("websocket", (socket) => {
        socket.on("framereceived", ({ payload }) => {
            try {
                const message = JSON.parse(String(payload));
                if (message.type === "full-reload") {
                    const path = new URL(page.url()).pathname;
                    if (
                        typeof message.path === "string" &&
                        message.path.endsWith(".html") &&
                        message.path !== "/index.html" &&
                        message.path !== path &&
                        message.path !== `${path}index.html`
                    )
                        return;
                    pendingNavigation = true;
                    noteNavigation({ time: Date.now(), reason: "Vite full-reload", payload: message });
                }
            } catch {
                /* The resource feed and non-JSON socket frames are unrelated. */
            }
        });
    });
    const document = async (): Promise<DocumentStamp> => {
        const held = await page.evaluate(() => window.__multiClientDocument);
        if (!held || held.unloading || pendingNavigation) throw new Error("Client document is navigating during setup");
        return { token: held.token, navigation };
    };
    const assertDocument = async () => {
        if (navigationFailure) throw navigationFailure;
        if (!armed || page.isClosed()) return;
        let current: DocumentStamp;
        try {
            current = await document();
        } catch {
            noteNavigation({ time: Date.now(), reason: "prepared document is unavailable" });
            throw navigationFailure;
        }
        if (current.token !== armed.token || current.navigation !== armed.navigation) {
            noteNavigation({ time: Date.now(), reason: "document token changed" });
            throw navigationFailure;
        }
    };
    const guard = async <T>(work: () => Promise<T>): Promise<T> => {
        await assertDocument();
        try {
            const result = await (navigationFailed
                ? Promise.race([
                      work(),
                      navigationFailed.then((error) => {
                          throw error;
                      }),
                  ])
                : work());
            await assertDocument();
            return result;
        } catch (error) {
            await assertDocument();
            throw error;
        }
    };
    // Chromium can detach the page before emitting its keepalive request to Playwright. Observe
    // native fetch as well, without delaying or changing the request during pagehide.
    await context.exposeBinding("__multiClientTransport", (_, value: Transport) => transports.push(value));
    await context.addInitScript(() => {
        window.__multiClientDocument = { token: crypto.randomUUID(), unloading: false };
        addEventListener("beforeunload", () => {
            window.__multiClientDocument.unloading = true;
        });
        const nativeFetch = window.fetch;
        window.fetch = function (input, init) {
            const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
            if (url.pathname === "/api/resources/batch" && typeof init?.body === "string") {
                void window.__multiClientTransport({
                    body: JSON.parse(init.body),
                    keepalive: init.keepalive ?? (input instanceof Request ? input.keepalive : false),
                    time: Date.now(),
                });
            }
            return nativeFetch.call(this, input, init);
        };
    });
    // Prefer context events so replies that remain observable after page close are retained too.
    context.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
        const path = new URL(request.url()).pathname;
        if (request.method() !== "POST") return;
        if (path === "/api/resources/read") reads.push(request.postDataJSON());
        if (path === "/api/resources/batch") {
            const batch = { body: request.postDataJSON() as BatchBody, time: Date.now() };
            batches.push(batch);
            byRequest.set(request, batch);
        }
    });
    context.on("response", async (response) => {
        if (response.headers()["x-resource-epoch"]) epoch = response.headers()["x-resource-epoch"];
        const batch = byRequest.get(response.request());
        if (batch) {
            const rawBody = await response.text().catch(() => undefined);
            let body: BatchAnswer = {};
            try {
                body = JSON.parse(rawBody ?? "");
            } catch {
                /* Preserve non-JSON failures in rawBody. */
            }
            batch.response = {
                status: response.status(),
                body,
                rawBody,
                time: Date.now(),
            };
        }
    });
    context.on("requestfailed", (request) => {
        const batch = byRequest.get(request);
        if (batch) batch.failure = request.failure()?.errorText;
    });
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("dialog", (dialog) => dialog.accept());
    return {
        context,
        page,
        batches,
        transports,
        reads,
        errors,
        navigations,
        document,
        assertDocument,
        guard,
        armDocument(stamp) {
            armed = stamp;
            navigationFailed = new Promise((resolve) => {
                signalNavigation = resolve;
            });
        },
        async api<T>(path: string, init = {}): Promise<Answer<T>> {
            const response = await fetch(baseURL + path, {
                ...init,
                headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
                signal: AbortSignal.timeout(30_000),
            });
            return { status: response.status, body: (await response.json()) as T, time: Date.now() };
        },
        async open() {
            if (armed) throw new Error("Cannot reopen a client after the case has started");
            await expect(async () => {
                await openApp(page, baseURL);
                const opened = await document();
                await expect.poll(() => auth, { timeout: 20_000 }).not.toBe("");
                await settle(page);
                expect(await document(), "open must finish on the document it loaded").toEqual(opened);
            }).toPass({ timeout: CONVERGENCE_TIMEOUT });
        },
        setEpoch(value) {
            epoch = value;
        },
        async observe() {
            await guard(() =>
                page.evaluate(async () => {
                    const { reloadNotice } = await import("/src/ts/alert.ts");
                    const { alertStore } = await import("/src/ts/stores.svelte.ts");
                    const { chatDiscardSequence } = await import("/src/ts/storage/chatStore.svelte.ts");
                    window.__multiClient?.unsubscribe.forEach((stop) => stop());
                    const held: Window["__multiClient"] = {
                        reloads: [],
                        alerts: [],
                        discardStart: chatDiscardSequence(),
                        unsubscribe: [],
                    };
                    window.__multiClient = held;
                    held.unsubscribe.push(
                        reloadNotice.subscribe((value) => held.reloads.push({ value, time: Date.now() })),
                        alertStore.subscribe((value) =>
                            held.alerts.push({ value: { type: value.type, msg: value.msg }, time: Date.now() }),
                        ),
                    );
                }),
            );
        },
        async observations() {
            return guard(() =>
                page.evaluate(async () => {
                    const { chatDiscardsSince } = await import("/src/ts/storage/chatStore.svelte.ts");
                    const { reloads, alerts, discardStart } = window.__multiClient;
                    return { reloads, alerts, discards: chatDiscardsSince(discardStart).map((key) => `chats/${key}`) };
                }),
            );
        },
        async reset() {
            batches.length = transports.length = reads.length = errors.length = 0;
            await this.observe();
        },
        async drafts() {
            return guard(() =>
                page.evaluate(async () => {
                    const { pageDraftJournal } = await import("/src/ts/storage/draftJournal.ts");
                    const journal = pageDraftJournal();
                    if (!journal.enabled) throw new Error("Durable draft journal is disabled");
                    return journal.listDrafts();
                }),
            );
        },
    };
}

export async function createSession(browser: Browser, baseURL: string): Promise<Session> {
    return session(await browser.newContext(), baseURL);
}

/** A reload retires pins and subscriptions. Rebuild both clients before arming the case's navigation guard. */
export async function prepareSessions(sessions: Session[], chaId: string, ids: string[] = SEED_IDS) {
    await expect(async () => {
        const documents: DocumentStamp[] = [];
        for (const s of sessions) {
            await s.open();
            const opened = await s.document();
            await loadChats(s, chaId, ids);
            await settle(s.page, CONVERGENCE_TIMEOUT);
            await s.reset();
            expect(await s.drafts()).toEqual([]);
            expect(await s.document(), "chat pins and observers must belong to the prepared document").toEqual(opened);
            documents.push(opened);
        }
        // Opening the second client can discover a dependency that makes Vite reload both clients.
        for (const [index, s] of sessions.entries()) expect(await s.document()).toEqual(documents[index]);
        for (const [index, s] of sessions.entries()) s.armDocument(documents[index]);
    }).toPass({ timeout: 120_000 });
}

export async function serverRecord<T = Record<string, unknown>>(s: Session, kind: string, id = "main") {
    const answer = await s.api<ResourceRecord<T> & { epoch: string }>(`/api/resources/${kind}/${id}`);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body;
}

export async function serverChat(s: Session, characterId: string, id: string) {
    const answer = await s.api<ResourceReadRefsResult>("/api/resources/read", {
        method: "POST",
        body: JSON.stringify({ chats: [{ characterId, id }] }),
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body.chats![0];
}

export async function serverChatList(s: Session, characterId: string) {
    const answer = await s.api<ResourceReadRefsResult>("/api/resources/read", {
        method: "POST",
        body: JSON.stringify({ chatSummaryCollections: [characterId] }),
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body.chatSummaryCollections![0];
}

export type SharedRecords = Map<string, unknown>;
export const SEED_IDS = ["s1", "s2", "s3", "s4"];
export type Seed = {
    chaId: string;
    name: string;
    chats: Record<string, Chat>;
    binding: Pick<Chat, "modelPresetId" | "promptPresetId" | "bindedPersona">;
};
export const emptyChat = (id: string, binding: Seed["binding"]): Chat => ({
    id,
    name: id,
    note: "",
    localLore: [],
    fmIndex: -1,
    message: [],
    ...binding,
});

/** Seed off-page so the live save loop cannot race the raw batch's shared record revisions. */
export async function seedCharacter(s: Session, restore: SharedRecords): Promise<Seed> {
    await s.open();
    await s.page.evaluate(async () => (await import("/src/ts/storage/resourceSync.svelte.ts")).flushResources());
    await s.page.goto("about:blank");
    const ui = await serverRecord(s, "ui");
    s.setEpoch(ui.epoch);
    const order = await serverRecord<string[]>(s, "characterOrder");
    const [modelPresets, presets, personas] = await Promise.all(
        ["modelPresets", "presets", "personas"].map((kind) => serverRecord(s, kind)),
    );
    for (const [kind, data] of [
        ["ui", ui.data],
        ["characterOrder", order.data],
    ] as const) {
        if (!restore.has(kind)) restore.set(kind, data);
    }
    const chaId = randomUUID();
    const name = `Concurrent ${chaId.slice(0, 8)}`;
    const binding: Seed["binding"] = chatBindingFixture(modelPresets, presets, personas);
    const chats = Object.fromEntries(
        SEED_IDS.map((id) => [
            id,
            {
                ...emptyChat(id, binding),
                message: Array.from({ length: 4 }, (_, i): Message => ({
                    chatId: `m${i + 1}`,
                    role: i % 2 ? "char" : "user",
                    data: `${id} message m${i + 1}`,
                })),
            },
        ]),
    );
    const seeded = await s.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: ui.revision,
                    data: { ...ui.data, didFirstSetup: true, useLegacyGUI: true },
                },
                { kind: "characterOrder", id: "main", baseRevision: order.revision, data: [...order.data, chaId] },
                {
                    kind: "characters",
                    id: chaId,
                    baseRevision: null,
                    data: {
                        chaId,
                        type: "character",
                        name,
                        desc: "",
                        firstMessage: "",
                        notes: "",
                        chatFolders: [],
                        emotionImages: [],
                        bias: [],
                        viewScreen: "none",
                        globalLore: [],
                        utilityBot: false,
                        customscript: [],
                        exampleMessage: "",
                        creatorNotes: "",
                        systemPrompt: "",
                        postHistoryInstructions: "",
                        alternateGreetings: [],
                        tags: [],
                        creator: "",
                        characterVersion: "",
                        personality: "",
                        scenario: "",
                        firstMsgIndex: -1,
                        replaceGlobalNote: "",
                        triggerscript: [],
                    },
                },
            ],
            chats: Object.values(chats).map((chat) => ({
                characterId: chaId,
                chatId: chat.id,
                baseRevision: null,
                ops: [{ op: "create", chat }],
            })),
        }),
    });
    expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
    return { chaId, name, binding, chats };
}

/** Call after closing both contexts, including on a failed case. Character deletion removes its chats. */
export async function cleanupCharacter(s: Session, chaId: string) {
    const character = await serverRecord(s, "characters", chaId);
    const order = await serverRecord<string[]>(s, "characterOrder");
    const answer = await s.api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                { kind: "characters", id: chaId, baseRevision: character.revision, delete: true },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: order.data.filter((id) => id !== chaId),
                },
            ],
        }),
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

export async function restoreRecords(s: Session, restore: SharedRecords) {
    const ops: ResourceBatchOp[] = [];
    for (const [kind, data] of restore) {
        const current = await serverRecord(s, kind);
        ops.push({ kind, id: "main", baseRevision: current.revision, data });
    }
    if (!ops.length) return;
    const answer = await s.api("/api/resources/batch", { method: "POST", body: JSON.stringify({ ops }) });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
}

export async function loadChats(s: Session, chaId: string, ids: string[] = SEED_IDS) {
    await s.guard(() =>
        s.page.evaluate(
            async ({ chaId, ids }) => {
                const chats = await import("/src/ts/storage/chatStore.svelte.ts");
                chats.pinChats(chaId); // The context owns the pin's lifetime.
                for (const chatId of ids) {
                    if (!(await chats.ensureChatLoaded({ chaId, chatId })))
                        throw new Error(`Chat ${chatId} did not load`);
                }
            },
            { chaId, ids },
        ),
    );
}

export type Edit =
    | { type: "text"; chatId: string; id: string; text: string }
    | { type: "append"; chatId: string; message: Message }
    | { type: "create"; chat: Chat }
    | { type: "delete"; chatId: string }
    | { type: "reorderFirst"; ids: string[] }
    | { type: "character"; patch: Record<string, unknown> }
    | { type: "ui"; sendWithEnter: boolean };

/** All imports finish before the synchronous writes, so a mixed record/chat edit shares one cycle. */
export async function edits(s: Session, chaId: string, changes: Edit[]): Promise<string[] | null> {
    return s.guard(() =>
        s.page.evaluate(
            async ({ chaId, changes }) => {
                const chats = await import("/src/ts/storage/chatStore.svelte.ts");
                const { updateCharacter } = await import("/src/ts/storage/characterStore.svelte.ts");
                const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
                let order: string[] | null = null;
                for (const change of changes) {
                    switch (change.type) {
                        case "text":
                            chats.setMessageText({ chaId, chatId: change.chatId }, change.id, change.text);
                            break;
                        case "append":
                            chats.appendMessage({ chaId, chatId: change.chatId }, change.message);
                            break;
                        case "create":
                            chats.createChat(chaId, change.chat);
                            break;
                        case "delete":
                            chats.deleteChat({ chaId, chatId: change.chatId });
                            break;
                        case "reorderFirst":
                            order = [
                                ...change.ids,
                                ...chats
                                    .chatList(chaId)
                                    .map((chat) => chat.id)
                                    .filter((id) => !change.ids.includes(id)),
                            ];
                            chats.reorderChats(chaId, order);
                            break;
                        case "character":
                            if (!updateCharacter(chaId, change.patch)) throw new Error(`Character ${chaId} is missing`);
                            break;
                        case "ui":
                            settings.ui.sendWithEnter = change.sendWithEnter;
                            break;
                    }
                }
                return order;
            },
            { chaId, changes },
        ),
    );
}

export type ChatState = { name: string; messages: { id: string; role: string; text: string }[] };
export type ExpectedState = {
    character: { name: string; desc?: string };
    chats: Record<string, ChatState>;
    order?: string[];
    ui?: { sendWithEnter: boolean };
};
export const chatState = (chat: Chat): ChatState => ({
    name: chat.name,
    messages: chat.message.map((m) => ({ id: m.chatId!, role: m.role, text: m.data })),
});
export function seedState(seed: Seed): ExpectedState {
    return {
        character: { name: seed.name, desc: "" },
        chats: Object.fromEntries(Object.entries(seed.chats).map(([id, chat]) => [id, chatState(chat)])),
    };
}

export async function mirrorState(s: Session, chaId: string, expected: ExpectedState) {
    return s.guard(() =>
        s.page.evaluate(
            async ({ chaId, expected }) => {
                const chats = await import("/src/ts/storage/chatStore.svelte.ts");
                const { findCharacter } = await import("/src/ts/storage/characterStore.svelte.ts");
                const { settings } = await import("/src/ts/storage/settingsViews.svelte.ts");
                const character = findCharacter(chaId);
                const order = chats.chatList(chaId).map((chat) => chat.id);
                const held: Record<string, ChatState | null> = {};
                for (const id of order) {
                    // New remote chats start as summaries; loading them does not refresh already loaded mirrors.
                    const chat = await chats.ensureChatLoaded({ chaId, chatId: id });
                    held[id] = chat
                        ? {
                              name: chat.name,
                              messages: chat.message.map((m) => ({ id: m.chatId!, role: m.role, text: m.data })),
                          }
                        : null;
                }
                return {
                    character: {
                        name: character?.name,
                        ...("desc" in expected.character
                            ? { desc: character && "desc" in character ? character.desc : undefined }
                            : {}),
                    },
                    chats: held,
                    order,
                    ...(expected.ui ? { ui: { sendWithEnter: settings.ui.sendWithEnter } } : {}),
                };
            },
            { chaId, expected },
        ),
    );
}

/** Explicit content expectations first; then both mirrors must show that content and the stored order. */
export async function expectState(reader: Session, mirrors: Session[], chaId: string, expected: ExpectedState) {
    let storedOrder: string[] = [];
    await reader.guard(() =>
        expect(async () => {
            const [character, list] = await Promise.all([
                serverRecord(reader, "characters", chaId),
                serverChatList(reader, chaId),
            ]);
            expect(list.chats.map((chat) => chat.id).sort()).toEqual(Object.keys(expected.chats).sort());
            storedOrder = list.order!.ids;
            expect([...storedOrder].sort()).toEqual(Object.keys(expected.chats).sort());
            if (expected.order) expect(storedOrder).toEqual(expected.order);
            expect(character.data).toMatchObject(expected.character);
            const held: Record<string, ChatState> = {};
            for (const id of Object.keys(expected.chats)) {
                const chat = await serverChat(reader, chaId, id);
                expect(chat.data, `server chat ${id}`).not.toBeNull();
                held[id] = chatState(chat.data!);
            }
            expect(held).toEqual(expected.chats);
            if (expected.ui) expect((await serverRecord(reader, "ui")).data).toMatchObject(expected.ui);
        }).toPass({ timeout: CONVERGENCE_TIMEOUT }),
    );
    for (const s of mirrors) {
        await s.guard(() =>
            expect
                .poll(() => mirrorState(s, chaId, expected), { timeout: CONVERGENCE_TIMEOUT })
                .toEqual({ ...expected, order: storedOrder }),
        );
    }
    return storedOrder;
}

/** Hold exactly the first matching batch, with no request sent until release. Always dispose in finally. */
export async function holdBatch(s: Session, matches: (body: BatchBody) => boolean) {
    let held: Route | undefined;
    let body: BatchBody | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const handler = async (route: Route) => {
        const candidate = route.request().postDataJSON() as BatchBody;
        if (held || !matches(candidate)) return route.fallback();
        held = route;
        body = candidate;
        await gate;
        await route.continue();
    };
    await s.page.route(BATCH_URL, handler);
    return {
        async wait() {
            await s.guard(() => expect.poll(() => body, { timeout: 30_000 }).toBeDefined());
            return body!;
        },
        async release() {
            if (!held) throw new Error("No batch is held");
            const request = held.request();
            const answered = s.page.waitForResponse((response) => response.request() === request, { timeout: 30_000 });
            release();
            const response = await s.guard(() => answered);
            return { status: response.status(), body: (await response.json()) as BatchAnswer, time: Date.now() };
        },
        async dispose() {
            release();
            await s.page.unroute(BATCH_URL, handler);
        },
    };
}

export async function expectQuiet(s: Session) {
    await s.guard(() => settle(s.page, CONVERGENCE_TIMEOUT));
    expect(s.errors).toEqual([]);
    const observed = await s.observations();
    expect(observed.reloads.filter((entry) => entry.value)).toEqual([]);
    expect(observed.alerts.filter((entry) => entry.value.type === "error")).toEqual([]);
    expect(observed.discards).toEqual([]);
    expect(await s.drafts()).toEqual([]);
}
