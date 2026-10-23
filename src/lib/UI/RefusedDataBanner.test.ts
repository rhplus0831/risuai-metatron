import { flushSync, mount, tick, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefusedItem } from "src/ts/storage/resourceSync.svelte";

const mocks = vi.hoisted(() => ({
    refusedItems: vi.fn<typeof import("src/ts/storage/resourceSync.svelte").refusedItems>(),
    retryRefused: vi.fn<typeof import("src/ts/storage/resourceSync.svelte").retryRefused>(),
    discardRefused: vi.fn<typeof import("src/ts/storage/resourceSync.svelte").discardRefused>(),
    exportChat: vi.fn<typeof import("src/ts/characters").exportChat>(),
    downloadFile: vi.fn<typeof import("src/ts/globalApi.svelte").downloadFile>(),
    alertConfirm: vi.fn<typeof import("src/ts/alert").alertConfirm>(),
}));

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({ alertConfirm: mocks.alertConfirm }),
);
// Partial mocks retain the modules' typed exports; the stores and projection code run for real.
vi.mock("src/ts/storage/resourceSync.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/storage/resourceSync.svelte")>()),
    refusedItems: mocks.refusedItems,
    retryRefused: mocks.retryRefused,
    discardRefused: mocks.discardRefused,
}));
vi.mock("src/ts/characters", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/characters")>()),
    exportChat: mocks.exportChat,
}));
vi.mock("src/ts/globalApi.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/globalApi.svelte")>()),
    downloadFile: mocks.downloadFile,
}));

import { applyRaw, characterData } from "src/ts/storage/records.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import RefusedDataBanner from "./RefusedDataBanner.svelte";

const inventory = writable<RefusedItem[]>([]);
const reactiveInventory = fromStore(inventory);
const mounted: ReturnType<typeof mount>[] = [];
const openChat = {
    kind: "chat",
    key: "refusal-open",
    reason: "local text refused",
    chaId: "c",
    chatId: "open",
} as const;
const otherChat = {
    kind: "chat",
    key: "refusal-other",
    reason: "other chat refused",
    chaId: "c",
    chatId: "other",
} as const;
const deletedChat = {
    kind: "chat",
    key: "refusal-deleted",
    reason: "deletion refused",
    chaId: "c",
    chatId: "deleted",
} as const;
const order = { kind: "order", key: "refusal-order", reason: "order refused", chaId: "c" } as const;
const record = (resourceKind: string, id = "main"): RefusedItem => ({
    kind: "record",
    key: `refusal-${resourceKind}-${id}`,
    reason: `${resourceKind} refused`,
    resourceKind,
    id,
});

function render(props: { form: "app" } | { form: "chat"; chaId: string; chatId: string }) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = mount(RefusedDataBanner, { target, props });
    mounted.push(instance);
    flushSync();
    return { target, instance };
}

function action(root: ParentNode, name: "export" | "retry" | "discard") {
    const button = root.querySelector<HTMLButtonElement>(`[data-risu-refused-action="${name}"]`);
    expect(button, `${name} action`).not.toBeNull();
    return button!;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.refusedItems.mockImplementation(() => reactiveInventory.current);
    mocks.alertConfirm.mockResolvedValue(false);
    mocks.discardRefused.mockResolvedValue();
    inventory.set([]);
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "Local character",
                chatPage: 0,
                chats: ["open", "other"].map((id) => ({
                    id,
                    name: `${id} chat`,
                    note: "",
                    localLore: [],
                    message: [],
                })),
            },
        ],
    });
});

afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    document.body.replaceChildren();
});

describe("RefusedDataBanner", () => {
    it("shows the open chat's reason, exports by chat id, retries by refusal key and discards only after confirmation", async () => {
        inventory.set([openChat]);
        const { target } = render({ form: "chat", chaId: "c", chatId: "open" });
        expect(target.querySelector('[data-risu-refused-banner="chat"]')).not.toBeNull();
        expect(target.querySelector("[data-risu-refused-reason]")?.textContent).toBe(openChat.reason);
        action(target, "export").click();
        expect(mocks.exportChat).toHaveBeenCalledExactlyOnceWith("open");
        action(target, "retry").click();
        expect(mocks.retryRefused).toHaveBeenCalledExactlyOnceWith(openChat.key);

        for (const confirmed of [false, true]) {
            let answer!: (value: boolean) => void;
            const confirmation = new Promise<boolean>((resolve) => {
                answer = resolve;
            });
            mocks.alertConfirm.mockReturnValueOnce(confirmation);
            action(target, "discard").click();
            expect(mocks.alertConfirm).toHaveBeenCalledTimes(confirmed ? 2 : 1);
            expect(mocks.alertConfirm.mock.lastCall?.[0]).toContain("open chat");
            expect(mocks.discardRefused).not.toHaveBeenCalled();
            answer(confirmed);
            await confirmation;
            await tick();
            if (confirmed) expect(mocks.discardRefused).toHaveBeenCalledExactlyOnceWith(openChat.key);
            else expect(mocks.discardRefused).not.toHaveBeenCalled();
        }
    });

    it("keeps a compact app banner for every refusal outside the displayed chat and offers no export for orders or absent chats", async () => {
        const rest = [record("ui"), order, otherChat, deletedChat];
        applyRaw("ui", { language: "en" });
        inventory.set([openChat, ...rest]);
        const app = render({ form: "app" });
        const chat = render({ form: "chat", chaId: "c", chatId: "open" });
        const toggle = app.target.querySelector<HTMLButtonElement>("[data-risu-refused-toggle]")!;
        expect(app.target.querySelector('[data-risu-refused-banner="app"]')).not.toBeNull();
        expect(toggle.getAttribute("aria-expanded")).toBe("false");
        expect(app.target.querySelectorAll("[data-risu-refused-key]")).toHaveLength(0);
        toggle.click();
        flushSync();
        const rows = () => [...app.target.querySelectorAll<HTMLElement>("[data-risu-refused-key]")];
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(rows().map((row) => [row.dataset.risuRefusedKey, row.dataset.risuRefusedKind])).toEqual(
            rest.map((item) => [item.key, item.kind]),
        );
        for (const item of [order, deletedChat]) {
            const row = rows().find((row) => row.dataset.risuRefusedKey === item.key)!;
            expect(row.textContent).toContain(item.reason);
            expect(row.querySelector('[data-risu-refused-action="export"]')).toBeNull();
            expect(action(row, "retry")).toBeDefined();
            expect(action(row, "discard")).toBeDefined();
        }
        mounted.splice(mounted.indexOf(chat.instance), 1);
        await unmount(chat.instance);
        flushSync();
        expect(rows().map((row) => row.dataset.risuRefusedKey)).toEqual([openChat, ...rest].map((item) => item.key));
        inventory.set([]);
        flushSync();
        expect(app.target.querySelector('[data-risu-refused-banner="app"]')).toBeNull();
    });

    it("downloads record save projections without foreign section fields, managed credentials or character chat fields", () => {
        applyRaw("ui", { language: "ko", theme: "standard", openAIKey: "foreign section secret" });
        applyRaw("llmSecrets", {
            openAIKey: "flat secret",
            google: { accessToken: "nested secret", projectId: "local project" },
            hordeConfig: { apiKey: "horde secret", models: ["local model"] },
            novelai: { token: "novel secret", model: "local novel model" },
            OaiCompAPIKeys: { custom: "map secret" },
            credentials: { named: { key: "managed secret" } },
            vertexClientEmail: "local@example.test",
        });
        // Exercise the export's own exclusion even if a local record contains legacy chat fields.
        Object.assign(characterData()[0], {
            chats: [{ id: "private-chat", message: [{ data: "private text" }] }],
            chatPage: 7,
            reloadKeys: 42,
        });
        const records = [record("ui"), record("llmSecrets"), record("characters", "c")];
        inventory.set(records);
        const { target } = render({ form: "app" });
        target.querySelector<HTMLButtonElement>("[data-risu-refused-toggle]")!.click();
        flushSync();
        for (const row of target.querySelectorAll("[data-risu-refused-key]")) action(row, "export").click();
        expect(mocks.downloadFile).toHaveBeenCalledTimes(3);
        expect(
            mocks.downloadFile.mock.calls.map(([filename, text]) => {
                expect(filename).toMatch(/\.json$/);
                expect(typeof text).toBe("string");
                return JSON.parse(text as string);
            }),
        ).toEqual([
            { kind: "ui", id: "main", data: { language: "ko", theme: "standard" } },
            {
                kind: "llmSecrets",
                id: "main",
                data: {
                    google: { projectId: "local project" },
                    hordeConfig: { models: ["local model"] },
                    novelai: { model: "local novel model" },
                    vertexClientEmail: "local@example.test",
                },
            },
            { kind: "characters", id: "c", data: { chaId: "c", type: "character", name: "Local character" } },
        ]);
    });
});
