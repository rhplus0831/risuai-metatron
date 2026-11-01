import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { DraftEntry, DraftInput, DraftJournal, RecordLayerValues } from "src/ts/storage/draftJournal";
import { createFakeLockManager } from "src/ts/storage/tests/fakeLockManager";
import { bootMutations, m, plain, refK, warmMutationGraph } from "src/ts/storage/tests/mutationStoresHarness";
import type { StoreBackedServer } from "src/ts/storage/tests/storeBackedServer";

const io = vi.hoisted(() => ({
    server: null as StoreBackedServer | null,
    confirm: vi.fn<typeof import("src/ts/alert").alertConfirm>(),
    normal: vi.fn<typeof import("src/ts/alert").alertNormal>(),
    error: vi.fn<typeof import("src/ts/alert").alertError>(),
    download: vi.fn<typeof import("src/ts/globalApi.svelte").downloadFile>(),
}));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: (path, init) => io.server!.fetch(path, init),
    }),
);
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: io.confirm,
        alertNormal: io.normal,
        alertError: io.error,
    }),
);
vi.mock("src/ts/diagnostics/collector", async () =>
    (await import("src/ts/diagnostics/tests/collectorMock")).createCollectorMock(),
);
// Downloads are the I/O boundary; recovery, mutation stores and saving all run unchanged.
vi.mock("src/ts/globalApi.svelte", async (original) => ({
    ...(await original<typeof import("src/ts/globalApi.svelte")>()),
    downloadFile: io.download,
}));

let h: Awaited<ReturnType<typeof bootMutations>>;
let journal: DraftJournal;
let drafts: typeof import("src/ts/storage/recoveryDrafts.svelte");
let recovery: typeof import("src/ts/storage/journalRecovery");
let language: typeof import("src/lang").language;
let target: HTMLDivElement;
let svelte: typeof import("svelte");
let mounted: ReturnType<typeof svelte.mount> | undefined;
const listeners: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
const batchPath = (path: string) => path === "/api/resources/batch";
const epoch = () => h.fake.store.epoch();
const recordTarget = "ui\0main";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    await journal.listDrafts();
    await svelte.tick();
    svelte.flushSync();
}

async function put(input: DraftInput): Promise<DraftEntry> {
    const id = await journal.putDraft(input);
    expect(id).not.toBeNull();
    await drafts.recoveryDrafts.refresh();
    return drafts.recoveryDrafts.entries.find((entry) => entry.id === id)!;
}

// The download must preserve the durable payload; the JSON envelope is not part of the user contract.
function strings(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (value && typeof value === "object") return Object.values(value).flatMap(strings);
    return [];
}

function recordInput(): DraftInput {
    return {
        epoch: epoch(),
        scope: "record",
        target: recordTarget,
        layers: {
            latest: {
                op: "update",
                baseRevision: h.fake.record("ui", "main")!.revision,
                text: JSON.stringify({ ...plain(h.fake.record("ui", "main")!.data), theme: "recovered" }),
            },
        },
    };
}

function chatInput(ops: ChatOp[], chatId = "k"): DraftInput & { scope: "chat" } {
    return {
        epoch: epoch(),
        scope: "chat",
        target: `c\0${chatId}`,
        layers: {
            pending: {
                baseRevision: h.fake.chat("c", chatId)?.revision ?? null,
                groupId: "old-page-group",
                ops: ops.map((op) => ({ op })),
            },
        },
    };
}

const snapshot = () => ({
    id: "gone",
    name: "Lost story",
    note: "durable note",
    localLore: [],
    message: [m("snapshot-message", "Saved snapshot text", "char")],
});

function inputFor(kind: string): DraftInput {
    if (kind === "record") return recordInput();
    if (kind === "order")
        return {
            epoch: epoch(),
            scope: "order",
            target: "c",
            layers: { latest: { baseRevision: null, ids: ["j", "k"] } },
        };
    if (kind === "another epoch") return { ...recordInput(), epoch: "before-restore" };
    const input = chatInput([{ op: "setText", id: "a", text: "draft message" }], kind === "chat" ? "k" : "gone");
    if (kind === "gone chat with snapshot") input.layers.pending!.createSnapshot = snapshot();
    return input;
}

async function render(notice = false) {
    const component = notice
        ? (await import("./ReloadNotice.svelte")).default
        : (await import("./RecoveryDrafts.svelte")).default;
    mounted = svelte.mount(component, { target });
    svelte.flushSync();
    await settle();
}

function button(label: string, root: ParentNode = target) {
    const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
    );
    expect(found, `Button ${label}`).toBeDefined();
    return found!;
}

function row() {
    const found = target.querySelector("li");
    expect(found).not.toBeNull();
    return found!;
}

function sentRecords() {
    return h.fake.batchBodies().flatMap((body) => body.ops ?? []);
}

beforeAll(() =>
    warmMutationGraph(async () => {
        await import("src/ts/storage/journalRecovery");
        await import("./RecoveryDrafts.svelte");
        await import("./ReloadNotice.svelte");
        await import("src/ts/setting/advancedSettingsData");
    }),
);

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    vi.spyOn(navigator, "locks", "get").mockReturnValue(createFakeLockManager());
    // A fresh module graph represents a page. Remove every page listener at teardown.
    for (const object of [window, document]) {
        const add = object.addEventListener.bind(object);
        vi.spyOn(object, "addEventListener").mockImplementation((name, listener, options) => {
            if (listener) listeners.push([object, name, listener]);
            add(name, listener, options);
        });
    }
    io.confirm.mockResolvedValue(true);
    io.download.mockResolvedValue();
    svelte = await import("svelte");
    h = await bootMutations((server) => (io.server = server));
    journal = (await import("src/ts/storage/draftJournal")).pageDraftJournal();
    expect(await journal.start()).toBe(true);
    drafts = await import("src/ts/storage/recoveryDrafts.svelte");
    recovery = await import("src/ts/storage/journalRecovery");
    language = (await import("src/lang")).language;
    target = document.createElement("div");
    document.body.appendChild(target);
});

afterEach(async () => {
    if (mounted) await svelte.unmount(mounted);
    mounted = undefined;
    target?.remove();
    h?.sync.stopResourceSync();
    io.server?.releaseBatch?.();
    io.server?.releaseBatchResponse?.();
    await journal?.close();
    drafts?.recoveryDrafts.close();
    drafts?.recoveryDrafts.replace([], epoch());
    for (const [object, name, listener] of listeners.splice(0)) object.removeEventListener(name, listener);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    io.server?.close();
    io.server = null;
});

describe("recovery drafts", () => {
    it.each(["record", "chat", "gone chat with snapshot", "gone chat without snapshot", "order", "another epoch"])(
        "exports %s without removal and discards it only after confirmation",
        async (kind) => {
            const input = inputFor(kind);
            const entry = await put(input);
            const before = h.serverText();
            await render();
            const canApply = kind !== "gone chat without snapshot" && kind !== "another epoch";
            expect([...row().querySelectorAll("button")].some((node) => node.textContent === language.apply)).toBe(
                canApply,
            );
            expect(recovery.recoveryDraftDetails(entry).canApply).toBe(canApply);
            if (!canApply) {
                await expect(recovery.applyRecoveryDraft(entry)).rejects.toThrow();
                expect(h.fake.batchCount()).toBe(0);
            }

            button(language.export, row()).click();
            await settle();
            expect(io.download).toHaveBeenCalledTimes(1);
            const [filename, json] = io.download.mock.calls[0];
            expect(filename).toMatch(/\.json$/);
            expect(strings(JSON.parse(json as string))).toEqual(expect.arrayContaining(strings(input.layers)));
            await drafts.exportDrafts();
            expect(strings(JSON.parse(io.download.mock.calls[1][1] as string))).toEqual(
                expect.arrayContaining(strings(input.layers)),
            );
            expect((await journal.listDrafts()).map((draft) => draft.id)).toEqual([entry.id]);
            expect(drafts.recoveryDrafts.entries.map((draft) => draft.id)).toEqual([entry.id]);

            const answer = deferred<boolean>();
            io.confirm.mockReturnValueOnce(answer.promise);
            button(language.recoveryDrafts.discard, row()).click();
            await settle();
            expect(io.confirm).toHaveBeenCalledWith(
                language.recoveryDrafts.discardConfirm(row().querySelector("h3")!.textContent!),
            );
            expect((await journal.listDrafts()).map((draft) => draft.id)).toEqual([entry.id]);
            answer.resolve(false);
            await settle();
            expect(drafts.recoveryDrafts.entries.map((draft) => draft.id)).toEqual([entry.id]);
            button(language.recoveryDrafts.discard, row()).click();
            await settle();
            expect(await journal.listDrafts()).toEqual([]);
            expect(drafts.recoveryDrafts.entries).toEqual([]);
            expect(target.querySelector("li")).toBeNull();
            expect(h.serverText()).toBe(before);
            expect(h.fake.batchCount()).toBe(0);
        },
    );

    it.each(["latest", "sent", "refused"] as const)(
        "applies the %s record text on the current revision after a further server change",
        async (layer) => {
            const original = h.fake.record("ui", "main")!;
            const text = (theme: string) => JSON.stringify({ ...plain(original.data), theme });
            const intent: RecordLayerValues["latest"] = {
                op: "update",
                baseRevision: original.revision,
                text: text("sent"),
            };
            const entry = await put({
                epoch: epoch(),
                scope: "record",
                target: recordTarget,
                layers: {
                    refused: { op: "update", text: text("refused"), reason: "conflict" },
                    ...(layer !== "refused" ? { sent: { ...intent, dispatched: true, inDoubt: true } } : {}),
                    ...(layer === "latest" ? { latest: { ...intent, text: text("latest") } } : {}),
                },
            });
            // A live update after the draft was listed moves the current copy again.
            h.fake.set("ui", "main", { ...plain(original.data), theme: "server changed again" });
            const revision = h.fake.record("ui", "main")!.revision;
            h.sync.noteRemoteChanges({
                resources: [
                    {
                        kind: "ui",
                        id: "main",
                        revision,
                        patch: { baseRevision: original.revision, set: { theme: "server changed again" }, remove: [] },
                    },
                ],
                chats: [],
                chatOrders: [],
            });
            expect(h.settings.ui.theme).toBe("server changed again");
            h.fake.holdNextBatchResponse = true;
            const applying = recovery.applyRecoveryDraft(entry);
            // Observe rejections immediately, and always release held I/O even if an assertion fails.
            void applying.catch(() => {});
            try {
                await settle();
                const ops = sentRecords().filter((op) => op.kind === "ui" && op.id === "main");
                expect(ops).toHaveLength(1);
                expect(ops[0].baseRevision).toBe(revision);
                // The normal adapter may send a field patch or the whole JSON record.
                expect(ops[0].patch?.set?.theme ?? ops[0].data?.theme).toBe(layer);
                expect(h.fake.releaseBatchResponse).not.toBeNull();
                expect(h.fake.record("ui", "main")!.data).toEqual(JSON.parse(text(layer)));
                expect((await journal.listDrafts()).map((draft) => draft.id)).toEqual([entry.id]);
                expect(drafts.recoveryDrafts.entries.map((draft) => draft.id)).toEqual([entry.id]);
            } finally {
                h.fake.releaseBatchResponse?.();
                await applying.catch(() => {});
            }
            await applying;
            expect(await journal.listDrafts()).toEqual([]);
            expect(drafts.recoveryDrafts.entries).toEqual([]);
        },
    );

    it("confirms applying chat operations by id on the current chat and reports missing targets", async () => {
        const ops: ChatOp[] = [
            { op: "setText", id: "b", text: "Recovered B" },
            { op: "setText", id: "missing-message", text: "Cannot be placed" },
            { op: "append", anchor: { after: "c" }, messages: [m("draft-append", "New message")] },
        ];
        const entry = await put(chatInput(ops));
        h.fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: h.fake.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "a", text: "Other tab's A" }],
            },
        ]);
        const current = h.fake.chat("c", "k")!;
        await h.chat.ensureChatLoaded(refK);
        expect(h.chat.hydrateChat(current)).toBe(true);
        await render();
        expect(row().querySelector("h3")!.textContent).toContain("K");
        expect(row().querySelector("h3")!.textContent).toContain("C");
        io.confirm.mockResolvedValueOnce(false);
        button(language.apply, row()).click();
        await settle();
        expect(h.fake.batchCount()).toBe(0);
        expect(drafts.recoveryDrafts.entries.map((draft) => draft.id)).toEqual([entry.id]);
        const answer = deferred<boolean>();
        io.confirm.mockReturnValueOnce(answer.promise);
        button(language.apply, row()).click();
        await settle();
        expect(io.confirm).toHaveBeenLastCalledWith(
            language.recoveryDrafts.applyConfirm(row().querySelector("h3")!.textContent!),
        );
        expect(h.fake.batchCount()).toBe(0);
        const notified = deferred<void>();
        io.normal.mockImplementationOnce(() => notified.resolve());
        answer.resolve(true);
        await notified.promise;
        await settle();
        const groups = h.fake.batchBodies().flatMap((body) => body.chats ?? []);
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            characterId: "c",
            chatId: "k",
            baseRevision: current.revision,
            ops: [ops[0], ops[2]],
        });
        expect(groups[0].groupId).toBeTruthy();
        expect(groups[0].groupId).not.toBe("old-page-group");
        expect(groups[0].retry).not.toBe(true);
        expect(h.fake.texts("c", "k")).toEqual(["Other tab's A", "Recovered B", "C", "New message"]);
        expect(io.normal).toHaveBeenCalledWith(expect.stringContaining("missing-message"));
        expect(io.normal).toHaveBeenCalledWith(expect.stringContaining(language.recoveryDrafts.skipped));
        expect(await journal.listDrafts()).toEqual([]);
        expect(target.querySelector("li")).toBeNull();
    });

    it("replays recovered deletions without asking and preserves only a recorded retraction mark", async () => {
        h.settings.ui.memoryAlgorithmType = "structuredMemory";
        await h.sync.flushResources();
        for (const retract of [undefined, true] as const) {
            const id = retract ? "b" : "a";
            const op = { op: "remove" as const, ids: [id], ...(retract ? { retract } : {}) };
            const entry = await put(chatInput([op]));
            const fetch = vi.spyOn(h.fake, "fetch");
            const before = h.fake.batchBodies().length;
            expect(await recovery.applyRecoveryDraft(entry)).toEqual({ skipped: [] });
            expect(
                h.fake
                    .batchBodies()
                    .slice(before)
                    .flatMap((body) => body.chats ?? [])
                    .flatMap((group) => group.ops),
            ).toEqual([op]);
            expect(h.fake.chat("c", "k")!.data.message.some((message) => message.chatId === id)).toBe(false);
            expect(fetch.mock.calls.some(([path]) => path.includes("/coverage"))).toBe(false);
            expect(io.confirm).not.toHaveBeenCalled();
            expect(await journal.listDrafts()).toEqual([]);
            fetch.mockRestore();
        }
    });

    it("restores a gone chat's snapshot under a new id", async () => {
        const input = chatInput([], "gone");
        input.layers.pending!.createSnapshot = snapshot();
        const entry = await put(input);
        await recovery.applyRecoveryDraft(entry);
        const groups = h.fake.batchBodies().flatMap((body) => body.chats ?? []);
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({ characterId: "c", baseRevision: null });
        expect(groups[0].chatId).toBeTruthy();
        expect(groups[0].chatId).not.toBe("gone");
        expect(groups[0].ops).toEqual([
            expect.objectContaining({
                op: "create",
                chat: expect.objectContaining({ ...snapshot(), id: groups[0].chatId }),
            }),
        ]);
        expect(h.fake.chat("c", "gone")).toBeNull();
        expect(h.fake.chat("c", groups[0].chatId)!.data).toMatchObject({ ...snapshot(), id: groups[0].chatId });
        expect(await journal.listDrafts()).toEqual([]);
        expect(drafts.recoveryDrafts.entries).toEqual([]);
    });

    it("applies chat order while dropping deleted ids and appending current chats absent from the vector", async () => {
        const entry = await put({
            epoch: epoch(),
            scope: "order",
            target: "c",
            layers: { latest: { baseRevision: "old-order-revision", ids: ["deleted-chat", "j"] } },
        });
        const revision = h.fake.order("c")!.revision;
        await recovery.applyRecoveryDraft(entry);
        const orders = h.fake.batchBodies().flatMap((body) => body.chatOrders ?? []);
        expect(orders).toEqual([{ characterId: "c", baseRevision: revision, ids: ["j", "k"] }]);
        expect(h.fake.order("c")!.ids).toEqual(["j", "k"]);
        expect(await journal.listDrafts()).toEqual([]);
        expect(drafts.recoveryDrafts.entries).toEqual([]);
    });

    it("keeps a chat draft after a lost save answer and never duplicates an append when applied again", async () => {
        const entry = await put(
            chatInput([{ op: "append", anchor: { end: true }, messages: [m("stable-append-id", "Only once")] }]),
        );
        const base = h.fake.chat("c", "k")!.revision;
        h.fake.dropNextBatchResponse = true;
        await expect(recovery.applyRecoveryDraft(entry)).rejects.toThrow();
        expect((await journal.listDrafts()).map((draft) => draft.id)).toEqual([entry.id]);
        expect(drafts.recoveryDrafts.entries.map((draft) => draft.id)).toEqual([entry.id]);
        const first = h.fake.batchBodies().flatMap((body) => body.chats ?? [])[0];
        expect(first).toMatchObject({
            baseRevision: base,
            ops: [{ op: "append", anchor: { end: true }, messages: [m("stable-append-id", "Only once")] }],
        });
        expect(first.groupId).not.toBe("old-page-group");
        await recovery.applyRecoveryDraft(entry);
        const appended = h.fake.chat("c", "k")!.data.message.filter((message) => message.chatId === "stable-append-id");
        expect(appended.map((message) => message.data)).toEqual(["Only once"]);
        expect(await journal.listDrafts()).toEqual([]);
        expect(drafts.recoveryDrafts.entries).toEqual([]);
    });

    it("retries Apply in the dialog after a lost create answer without duplicating the recovered chat", async () => {
        const input = chatInput([], "gone");
        input.layers.pending!.createSnapshot = snapshot();
        const entry = await put(input);
        await render();
        h.fake.dropNextBatchResponse = true;
        button(language.apply, row()).click();
        await settle();
        expect(io.error).toHaveBeenCalledTimes(1);
        expect((await journal.listDrafts()).map((draft) => draft.id)).toEqual([entry.id]);
        const recoveredIds = h.fake.order("c")!.ids.filter((id) => !["k", "j"].includes(id));
        expect(recoveredIds).toHaveLength(1);
        expect(h.fake.texts("c", recoveredIds[0])).toEqual(["Saved snapshot text"]);

        button(language.apply, row()).click();
        await settle();
        expect(io.confirm).toHaveBeenCalledTimes(2);
        expect(io.error).toHaveBeenCalledTimes(1);
        expect(h.fake.order("c")!.ids.filter((id) => !["k", "j"].includes(id))).toEqual(recoveredIds);
        expect(h.fake.texts("c", recoveredIds[0])).toEqual(["Saved snapshot text"]);
        expect(await journal.listDrafts()).toEqual([]);
        expect(drafts.recoveryDrafts.entries).toEqual([]);
        expect(target.querySelector("li")).toBeNull();
    });

    it.each(["conflict", "refusal"])("keeps the record draft after a save %s", async (outcome) => {
        const entry = await put(recordInput());
        if (outcome === "conflict") {
            h.fake.beforeNextBatch = () => {
                h.fake.set("ui", "main", {
                    ...plain(h.fake.record("ui", "main")!.data),
                    theme: "conflicting server copy",
                });
            };
        } else h.fake.failNext = { status: 413, times: 1, match: batchPath };
        await expect(recovery.applyRecoveryDraft(entry)).rejects.toThrow();
        expect((await journal.listDrafts()).map((draft) => draft.id)).toEqual([entry.id]);
        expect(drafts.recoveryDrafts.entries.map((draft) => draft.id)).toEqual([entry.id]);
        expect(h.fake.record("ui", "main")!.data.theme).not.toBe("recovered");
        if (outcome === "conflict") {
            await recovery.applyRecoveryDraft(entry);
            expect(h.fake.record("ui", "main")!.data.theme).toBe("recovered");
            // The applied draft is gone; the first Apply's conflict kept its dropped text as a draft of its own.
            const left = await journal.listDrafts();
            expect(left).toEqual([expect.objectContaining({ scope: "record", target: "ui\0main" })]);
            expect(left[0].id).not.toBe(entry.id);
            const kept = Object.values(left[0].layers)[0] as { value: { text: string } };
            expect(JSON.parse(kept.value.text).theme).toBe("recovered");
        }
    });

    it("keeps a draft whose delete fails: Discard alerts and keeps the row, and an Apply that saved says not to apply it again", async () => {
        const entry = await put(recordInput());
        const removeDraft = vi.spyOn(journal, "removeDraft").mockResolvedValue(false);
        await render();
        button(language.recoveryDrafts.discard, row()).click();
        await settle();
        expect(io.error).toHaveBeenCalledWith(
            `${language.recoveryDrafts.failed}\nError: ${language.recoveryDrafts.removeFailed}`,
        );
        expect(drafts.recoveryDrafts.entries.map((draft) => draft.id)).toEqual([entry.id]);
        expect(row()).not.toBeNull();

        await expect(recovery.applyRecoveryDraft(entry)).rejects.toThrow(language.recoveryDrafts.appliedNotRemoved);
        expect(h.fake.record("ui", "main")!.data.theme).toBe("recovered");
        expect(drafts.recoveryDrafts.entries.map((draft) => draft.id)).toEqual([entry.id]);
        // Applying it again would repeat the saved changes: Apply is off for it while the page lives.
        await settle();
        expect(recovery.recoveryDraftDetails(entry)).toMatchObject({
            canApply: false,
            reason: language.recoveryDrafts.appliedNotRemoved,
        });
        expect([...row().querySelectorAll("button")].some((node) => node.textContent === language.apply)).toBe(false);
        const batches = h.fake.batchCount();
        await expect(recovery.applyRecoveryDraft(entry)).rejects.toThrow(language.recoveryDrafts.appliedNotRemoved);
        expect(h.fake.batchCount()).toBe(batches);
        removeDraft.mockRestore();
        expect((await journal.listDrafts()).map((draft) => draft.id)).toEqual([entry.id]);
    });

    it("opens the recovery dialog from Review and the Advanced settings row only while drafts exist", async () => {
        const { advancedSettingsItems, advancedSettingsSections } = await import("src/ts/setting/advancedSettingsData");
        const item = advancedSettingsItems.find((item) => item.id === "adv.recoveredChanges")!;
        expect(item).toMatchObject({ type: "button", labelKey: "recoveredChanges" });
        expect(
            advancedSettingsSections.some((section) =>
                section.items.some((item) => item.id === "adv.recoveredChanges"),
            ),
        ).toBe(true);
        const ctx = {
            settings: h.settings,
            preset: h.activePreset,
            modelPreset: h.activeModelPreset,
            persona: h.activePersona,
        } as Parameters<NonNullable<typeof item.condition>>[0];
        expect(item.condition!(ctx)).toBe(false);
        await render(true);
        expect(target.querySelector('[role="status"]')).toBeNull();
        const entry = await put(recordInput());
        await settle();
        expect(item.condition!(ctx)).toBe(true);
        button(language.recoveryDrafts.review).click();
        await settle();
        expect(drafts.recoveryDrafts.isOpen).toBe(true);
        expect(target.querySelector('[role="dialog"]')).not.toBeNull();
        button(language.recoveryDrafts.close).click();
        await settle();
        expect(drafts.recoveryDrafts.isOpen).toBe(false);
        expect(target.querySelector('[role="dialog"]')).toBeNull();
        await item.options!.onClick!();
        await settle();
        expect(target.querySelector('[role="dialog"]')).not.toBeNull();
        await drafts.recoveryDrafts.remove(entry.id);
        await settle();
        expect(item.condition!(ctx)).toBe(false);
        expect(target.querySelector('[role="status"]')).toBeNull();
    });

    it("shows the record name, creation time and remaining lifetime, then removes expired drafts", async () => {
        const createdAt = Date.now() - (47 * 60 + 58) * 60_000;
        const input = recordInput();
        const entry = await put({ ...input, createdAt });
        await render();
        expect(row().querySelector("h3")!.textContent).toBe("ui");
        expect(row().querySelector("time")!.getAttribute("datetime")).toBe(new Date(createdAt).toISOString());
        expect(row().querySelector("time")!.textContent).toBe(new Date(createdAt).toLocaleString());
        expect(row().textContent).toContain(language.recoveryDrafts.expiresIn(0, 2));
        await vi.advanceTimersByTimeAsync(60_000);
        svelte.flushSync();
        expect(row().textContent).toContain(language.recoveryDrafts.expiresIn(0, 1));
        await vi.advanceTimersByTimeAsync(60_000);
        svelte.flushSync();
        expect(drafts.recoveryDrafts.entries).toEqual([]);
        expect(target.querySelector("li")).toBeNull();
        expect(await journal.listDrafts()).toEqual([]);
        await drafts.recoveryDrafts.refresh();
        expect(drafts.recoveryDrafts.entries.some((draft) => draft.id === entry.id)).toBe(false);
    });
});
