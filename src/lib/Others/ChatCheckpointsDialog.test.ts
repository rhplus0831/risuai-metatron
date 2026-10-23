// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import type { Writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckpointKind, CheckpointSummary } from "../../../shared/chatCheckpoints.ts";

type Checkpoints = typeof import("src/ts/checkpoints/chatCheckpoints.svelte");
const mocks = vi.hoisted(() => ({
    list: vi.fn<Checkpoints["listCheckpoints"]>(),
    load: vi.fn<Checkpoints["loadCheckpoint"]>(),
    save: vi.fn<Checkpoints["saveCheckpoint"]>(),
    rename: vi.fn<Checkpoints["renameCheckpoint"]>(),
    remove: vi.fn<Checkpoints["deleteCheckpoint"]>(),
    readPolicy: vi.fn<Checkpoints["readCheckpointPolicy"]>(),
    writePolicy: vi.fn<Checkpoints["writeCheckpointPolicy"]>(),
    confirm: vi.fn<typeof import("src/ts/alert").alertConfirm>(),
    input: vi.fn<typeof import("src/ts/alert").alertInput>(),
    error: vi.fn(),
    normal: vi.fn(),
    stores: { busy: null as Writable<boolean> | null },
}));
vi.mock("src/ts/checkpoints/chatCheckpoints.svelte", async () => {
    const { writable } = await import("svelte/store");
    mocks.stores.busy = writable(false);
    return {
        chatCheckpointsDialog: writable(null),
        checkpointLoadBusy: mocks.stores.busy,
        listCheckpoints: mocks.list,
        loadCheckpoint: mocks.load,
        saveCheckpoint: mocks.save,
        renameCheckpoint: mocks.rename,
        deleteCheckpoint: mocks.remove,
        readCheckpointPolicy: mocks.readPolicy,
        writeCheckpointPolicy: mocks.writePolicy,
    } satisfies Checkpoints;
});
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: mocks.confirm,
        alertInput: mocks.input,
        alertError: mocks.error,
        alertNormal: mocks.normal,
    }),
);
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

import { language } from "src/lang";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import ChatCheckpointsDialog from "./ChatCheckpointsDialog.svelte";

const ref = { chaId: "c", chatId: "k" };
const close = vi.fn();
const labels = language.chatCheckpoints;
let target: HTMLDivElement;
let mounted: ReturnType<typeof mount>;
let rows: CheckpointSummary[];

function row(kind: CheckpointKind, createdAt: number): CheckpointSummary {
    return {
        id: `${kind}-${createdAt}`,
        name: `${kind} checkpoint ${createdAt}`,
        kind,
        createdAt,
        revision: `row-revision-${createdAt}`,
        userTurns: 3,
        messageCount: 6,
        preview: {
            messages: [{ role: "char", text: "A quiet evening" }],
            summaries: 2,
            loreEntries: 4,
            variables: 1,
        },
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}
/** Drain resolved dialog promises and Svelte effects without a timer or polling deadline. */
async function settle() {
    for (let i = 0; i < 12; i++) await tick();
    flushSync();
}
function button(label: string) {
    const found = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
    );
    expect(found, `Button ${label}`).toBeDefined();
    return found!;
}
function select(checkpoint: CheckpointSummary) {
    const name = [...target.querySelectorAll("button span")].find((node) => node.textContent === checkpoint.name)!;
    expect(name).toBeDefined();
    name.closest("button")!.click();
    flushSync();
}
async function render() {
    mounted = mount(ChatCheckpointsDialog, { target, props: { chatRef: ref, close } });
    flushSync();
    await settle();
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.stores.busy!.set(false);
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                name: "Character",
                chats: [{ id: "k", name: "Story", message: [], note: "", localLore: [] }],
            },
        ],
    });
    // The list endpoint promises newest first; kinds are deliberately interleaved.
    rows = [
        row("auto", 6000),
        row("manual", 5000),
        row("safety", 4000),
        row("manual", 3000),
        row("safety", 2000),
        row("auto", 1000),
    ];
    mocks.list.mockResolvedValue({ status: "ok", checkpoints: rows });
    mocks.readPolicy.mockResolvedValue({ status: "available", policy: null });
    mocks.confirm.mockResolvedValue(true);
    mocks.load.mockResolvedValue({ status: "loaded", chatRevision: "loaded-revision", safety: null });
    mocks.remove.mockResolvedValue({ status: "ok" });
    target = document.createElement("div");
    document.body.appendChild(target);
});
afterEach(async () => {
    if (mounted) await unmount(mounted);
    target.remove();
    mocks.stores.busy!.set(false);
});

describe("checkpoint dialog", () => {
    it("groups checkpoints as manual, auto and safety and keeps newest first within each group", async () => {
        await render();
        expect(mocks.list).toHaveBeenCalledExactlyOnceWith(ref);
        const groups = [...target.querySelectorAll("section")].filter((section) => section.querySelector("ul"));
        expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
            labels.kinds.manual,
            labels.kinds.auto,
            labels.kinds.safety,
        ]);
        expect(
            groups.map((group) =>
                [...group.querySelectorAll("li button span:first-child")].map((node) => node.textContent),
            ),
        ).toEqual([
            [rows[1].name, rows[3].name],
            [rows[0].name, rows[5].name],
            [rows[2].name, rows[4].name],
        ]);
        expect(groups[0].textContent).toContain(labels.counts(3, 6));
    });

    it("shows the selected preview as literal text without creating markup elements", async () => {
        const text = '<b>x</b><img src=x onerror="globalThis.previewExecuted=true">';
        rows[1].preview.messages = [
            { role: "user", text },
            { role: "char", text: "The next line" },
        ];
        await render();
        select(rows[1]);
        const preview = [...target.querySelectorAll("section")].find(
            (section) => section.getAttribute("aria-label") === labels.preview,
        )!;
        expect(preview.textContent).toContain(text);
        expect(preview.textContent).toContain("The next line");
        expect(preview.textContent).toContain(labels.previewCounts(2, 4, 1));
        expect(preview.querySelector("b, img, script")).toBeNull();
    });

    it("asks before loading, loads once and keeps every control modal while the answer is pending", async () => {
        const confirmation = deferred<boolean>();
        const answer = deferred<Awaited<ReturnType<Checkpoints["loadCheckpoint"]>>>();
        mocks.confirm.mockReturnValueOnce(confirmation.promise);
        mocks.load.mockImplementation(async () => {
            mocks.stores.busy!.set(true);
            try {
                return await answer.promise;
            } finally {
                mocks.stores.busy!.set(false);
            }
        });
        await render();
        select(rows[1]);
        button(labels.load).click();
        await settle();
        expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(labels.loadConfirm(rows[1].name));
        expect(mocks.load).not.toHaveBeenCalled();
        confirmation.resolve(true);
        await settle();
        expect(mocks.load).toHaveBeenCalledExactlyOnceWith(ref, rows[1].id);
        const dialog = target.querySelector('[role="dialog"]')!;
        expect(dialog.getAttribute("aria-modal")).toBe("true");
        expect(dialog.getAttribute("aria-busy")).toBe("true");
        for (const control of dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
            "button, input, select",
        )) {
            expect(control.disabled).toBe(true);
        }
        button(labels.load).click();
        button(labels.close).click();
        expect(close).not.toHaveBeenCalled();
        answer.resolve({ status: "loaded", chatRevision: "loaded-revision", safety: null });
        await settle();
        expect(mocks.load).toHaveBeenCalledTimes(1);
        expect(mocks.normal).toHaveBeenCalledWith(labels.loaded);
        expect(button(labels.close).disabled).toBe(false);
    });

    it("sends the selected row revision on rename and delete and re-reads a stale row", async () => {
        const selected = rows[1];
        const renamedElsewhere = { ...selected, name: "New server name", revision: "new-row-revision" };
        mocks.input.mockResolvedValue("My rename");
        mocks.rename.mockResolvedValue({ status: "error", reason: "conflict" });
        mocks.list
            .mockResolvedValueOnce({ status: "ok", checkpoints: rows })
            .mockResolvedValue({ status: "ok", checkpoints: [renamedElsewhere] });
        await render();
        select(selected);
        button(labels.rename).click();
        await settle();
        expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(
            ref,
            expect.objectContaining({ id: selected.id, revision: selected.revision }),
            "My rename",
        );
        expect(mocks.error).toHaveBeenCalledWith(labels.errors.conflict);
        expect(target.textContent).toContain(renamedElsewhere.name);
        button(labels.delete).click();
        await settle();
        expect(mocks.confirm).toHaveBeenCalledWith(labels.deleteConfirm(renamedElsewhere.name));
        expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(
            ref,
            expect.objectContaining({ id: selected.id, revision: renamedElsewhere.revision }),
        );
        expect(mocks.list).toHaveBeenCalledTimes(3);
    });

    it("alerts on a refused load and leaves the dialog open", async () => {
        mocks.load.mockResolvedValue({ status: "error", reason: "conflict" });
        await render();
        select(rows[1]);
        button(labels.load).click();
        await settle();
        expect(mocks.error).toHaveBeenCalledExactlyOnceWith(labels.errors.conflict);
        expect(mocks.normal).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        expect(target.querySelector('[role="dialog"]')).not.toBeNull();
        expect(button(labels.load).disabled).toBe(false);
        expect(mocks.list).toHaveBeenCalledTimes(2);
    });
});
