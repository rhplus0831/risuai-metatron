// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "src/ts/storage/tests/storeBackedServer";

const transport = vi.hoisted(() => ({ server: null as StoreBackedServer | null }));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: (path, init) => transport.server!.fetch(path, init),
    }),
);
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));

import * as chats from "src/ts/storage/chatStore.svelte";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import { reconcileSelection } from "src/ts/storage/settingsViews.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import ChatMemoryPanel from "./ChatMemoryPanel.svelte";

const ref = { chaId: "c", chatId: "k" };
let instance: ReturnType<typeof mount> | undefined;
let release: (() => void) | undefined;

beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const server = (transport.server = await StoreBackedServer.create());
    const characters = server.kind("characters");
    server.store.applyChanges({
        ops: [
            {
                kind: characters,
                id: "c",
                baseRevision: null,
                data: { chaId: "c", name: "C", type: "character", supaMemory: true, supaMemoryOnCount: 4 },
            },
        ],
        chats: ["k", "sibling"].map((id) => ({
            characterId: "c",
            chatId: id,
            baseRevision: null,
            ops: [
                {
                    op: "create",
                    chat: {
                        id,
                        name: id,
                        note: "",
                        localLore: [],
                        message: [],
                        memoryEnabled: false,
                        memoryTrimAck: 4,
                    },
                },
            ],
        })),
    });
    const read = server.store.readKinds([characters], { chatSummaries: true });
    initializeRecords(takeRecordFields({ characters: read.kinds.characters.map((row) => row.data) }));
    reconcileSelection();
    selectCharacter(null);
    chats.seedChats(read.chatSummaries!, read.chatOrders!);
    chats.assembleChats(characterList(), read.chatSummaries!, read.chatOrders!);
});

afterEach(async () => {
    if (instance) await unmount(instance);
    instance = undefined;
    release?.();
    release = undefined;
    document.body.replaceChildren();
    transport.server?.close();
    transport.server = null;
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("ChatMemoryPanel", () => {
    it.each(["loaded", "unloaded"])(
        "switches a %s chat and persists acknowledgement removal without changing its owner or sibling",
        async (state) => {
            const server = transport.server!;
            const owner = server.store.get(server.kind("characters"), "c");
            if (state === "loaded") {
                release = chats.pinChat(ref);
                await chats.loadChat(ref);
                expect(chats.findChat(ref)).toBeDefined();
            } else expect(chats.findChat(ref)).toBeUndefined();
            const target = document.createElement("div");
            document.body.appendChild(target);
            instance = mount(ChatMemoryPanel, { target, props: { chatRef: ref } });
            flushSync();
            const checkbox = target.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
            expect(checkbox.checked).toBe(false);
            const persist = () => {
                const work = chats.takeChatWork(new Set());
                const result = server.store.applyChanges({ chats: work.groups, chatOrders: work.orders });
                chats.ackChatWork(work, result.chats, result.chatOrders);
                return server.store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0].data;
            };
            checkbox.click();
            flushSync();
            expect(checkbox.checked).toBe(true);
            expect(chats.chatEntry(ref)).toHaveProperty("memoryEnabled", true);
            expect(chats.chatEntry(ref)).not.toHaveProperty("memoryTrimAck");
            const on = persist();
            expect(on).toHaveProperty("memoryEnabled", true);
            expect(on).not.toHaveProperty("memoryTrimAck");
            checkbox.click();
            flushSync();
            expect(checkbox.checked).toBe(false);
            expect(persist()).toHaveProperty("memoryEnabled", false);
            expect(chats.chatEntry(ref)).toHaveProperty("memoryEnabled", false);
            if (state === "unloaded") expect(chats.findChat(ref)).toBeUndefined();
            else expect(chats.findChat(ref)).not.toHaveProperty("memoryTrimAck");
            expect(chats.chatEntry({ chaId: "c", chatId: "sibling" })).toMatchObject({
                memoryEnabled: false,
                memoryTrimAck: 4,
            });
            expect(server.store.get(server.kind("characters"), "c")).toEqual(owner);
            expect(characterList()[0]).toMatchObject({ supaMemory: true, supaMemoryOnCount: 4 });
        },
    );
});

it.each(["loaded", "unloaded"])("stores explicit modes and unsets Legacy for a %s chat", async (state) => {
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    const { language } = await import("src/lang");
    settings.ui.memoryAlgorithmType = "hypaV3";
    Object.assign(settings.memoryTranslateMedia, {
        hypaV3: true,
        hypav2: false,
        hanuraiEnable: false,
        supaModelType: "none",
    });
    const server = transport.server!;
    if (state === "loaded") {
        release = chats.pinChat(ref);
        await chats.loadChat(ref);
    }
    const target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(ChatMemoryPanel, { target, props: { chatRef: ref } });
    flushSync();
    const select = target.querySelector("select")!;
    expect([...select.options].map(({ value }) => value)).toEqual(["legacy", "hypaV3", "structuredMemory"]);
    expect(select.options[0].textContent).toBe(language.chatMemory.legacy(`${language.HypaMemory} V3`));
    expect(select.value).toBe("legacy");
    for (const mode of ["structuredMemory", "hypaV3", "legacy"]) {
        select.value = mode;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
        const work = chats.takeChatWork(new Set());
        const result = server.store.applyChanges({ chats: work.groups, chatOrders: work.orders });
        chats.ackChatWork(work, result.chats, result.chatOrders);
        const saved = server.chat("c", "k")!.data;
        expect(select.value).toBe(mode);
        if (mode === "legacy") {
            expect(chats.chatEntry(ref)).not.toHaveProperty("memoryMode");
            expect(saved).not.toHaveProperty("memoryMode");
            expect(work.groups[0].ops).toEqual([{ op: "meta", set: {}, unset: ["memoryMode"] }]);
        } else {
            expect(chats.chatEntry(ref)).toHaveProperty("memoryMode", mode);
            expect(saved).toHaveProperty("memoryMode", mode);
        }
    }
    if (state === "unloaded") expect(chats.findChat(ref)).toBeUndefined();
    else expect(chats.findChat(ref)).not.toHaveProperty("memoryMode");
    expect(server.chat("c", "sibling")!.data).not.toHaveProperty("memoryMode");
    settings.ui.memoryAlgorithmType = "structuredMemory";
    flushSync();
    expect(select.options[0].textContent).toBe(language.chatMemory.legacy(language.structuredMemory.name));
});

it.each(["loaded", "unloaded"])(
    "selects, clears and preserves a deleted memory preset for a %s chat",
    async (state) => {
        const { createHypaV3Preset } = await import("../../../shared/hypaV3Presets.ts");
        const { settings } = await import("src/ts/storage/settingsViews.svelte");
        const { language } = await import("src/lang");
        settings.hypaV3Presets.items = [
            createHypaV3Preset("Settings preset", {}, "default"),
            createHypaV3Preset("Chat preset", {}, "personal"),
        ];
        settings.hypaV3Presets.selectedId = "default";
        const server = transport.server!;
        if (state === "loaded") {
            release = chats.pinChat(ref);
            await chats.loadChat(ref);
        }
        const target = document.createElement("div");
        document.body.append(target);
        instance = mount(ChatMemoryPanel, { target, props: { chatRef: ref } });
        flushSync();
        const select = [...target.querySelectorAll("select")].find((control) =>
            [...control.options].some((option) => option.textContent === "Chat preset"),
        )!;
        const persist = () => {
            const work = chats.takeChatWork(new Set());
            const result = server.store.applyChanges({ chats: work.groups, chatOrders: work.orders });
            chats.ackChatWork(work, result.chats, result.chatOrders);
            return server.chat("c", "k")!.data;
        };
        const choose = (label: string) => {
            select.value = [...select.options].find((option) => option.textContent === label)!.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            flushSync();
        };
        const defaultLabel = language.chatMemory.defaultPreset("Settings preset");
        expect([...select.options].map((option) => option.textContent)).toEqual([
            defaultLabel,
            "Settings preset",
            "Chat preset",
        ]);
        expect(select.selectedIndex).toBe(0);
        choose("Chat preset");
        expect(persist()).toHaveProperty("memoryPresetId", "personal");
        expect(chats.chatEntry(ref)).toHaveProperty("memoryPresetId", "personal");
        choose(defaultLabel);
        expect(persist()).not.toHaveProperty("memoryPresetId");
        expect(chats.chatEntry(ref)).not.toHaveProperty("memoryPresetId");
        choose("Chat preset");
        persist();
        settings.hypaV3Presets.items = settings.hypaV3Presets.items.filter(({ id }) => id !== "personal");
        flushSync();
        // Svelte reselects after the option list changes in a MutationObserver callback.
        await Promise.resolve();
        flushSync();
        expect(select.options[select.selectedIndex].textContent).toBe(language.chatMemory.deletedPreset("personal"));
        expect(select.options[0].textContent).toBe(defaultLabel);
        expect(persist()).toHaveProperty("memoryPresetId", "personal");
        expect(chats.chatEntry(ref)).toHaveProperty("memoryPresetId", "personal");
        expect(settings.hypaV3Presets.selectedId).toBe("default");
        expect(server.chat("c", "sibling")!.data).not.toHaveProperty("memoryPresetId");
        if (state === "unloaded") expect(chats.findChat(ref)).toBeUndefined();
        else expect(chats.findChat(ref)).toHaveProperty("memoryPresetId", "personal");
    },
);
