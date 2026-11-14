// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());

import { language } from "src/lang";
import { findChat, selectChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import type { InputHook } from "../../../shared/inputHooks.ts";
import ChatDraftHookPanel from "./ChatDraftHookPanel.svelte";

const ref = { chaId: "c", chatId: "target" };
const otherRef = { chaId: "c", chatId: "other" };
const missingRef = { chaId: "c", chatId: "missing" };
const draft: InputHook = { id: "draft", name: "Translate", type: "draft", prompt: "", model: { mode: "inherit" } };
const btw: InputHook = { id: "btw", name: "Explain aside", type: "btw", prompt: "", model: { mode: "inherit" } };
let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    installFlatDatabaseWithChats({
        inputHooks: [],
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chatPage: 1,
                chats: [
                    { id: "target", name: "Target", note: "keep", message: [] },
                    { id: "other", name: "Other", draftHookId: "other-hook", message: [] },
                    { id: "missing", name: "Missing", draftHookId: "gone", message: [] },
                ],
            },
        ],
    });
    selectChat(otherRef.chaId, otherRef.chatId);
    target = document.createElement("div");
    document.body.append(target);
});

afterEach(async () => {
    if (component) await unmount(component);
    component = undefined;
    target.remove();
});

function render(chatRef: ChatRef = ref) {
    component = mount(ChatDraftHookPanel, { target, props: { chatRef } });
    flushSync();
}

const select = () => target.querySelector<HTMLSelectElement>("select");
const options = () => [...(select()?.options ?? [])].map((option) => [option.value, option.textContent?.trim()]);
function choose(value: string) {
    select()!.value = value;
    select()!.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
}

describe("ChatDraftHookPanel", () => {
    it("hides without Draft hooks or a stored id and lists only Draft hooks", () => {
        render();
        expect(target.textContent).toBe("");
        expect(select()).toBeNull();
        settings.inputHooks = [btw];
        flushSync();
        expect(target.textContent).toBe("");
        expect(select()).toBeNull();
        settings.inputHooks = [btw, draft];
        flushSync();
        expect(target.textContent).toContain(language.inputHooks.panelTitle);
        expect(options()).toEqual([
            ["", language.inputHooks.none],
            ["draft", "Translate"],
        ]);
        expect(select()!.value).toBe("");
    });

    it("sets and unsets only the given chat's draftHookId", () => {
        settings.inputHooks = [draft, btw];
        render();
        const before = JSON.parse(JSON.stringify(findChat(ref)));
        const otherBefore = JSON.parse(JSON.stringify(findChat(otherRef)));
        choose("draft");
        expect(findChat(ref)).toEqual({ ...before, draftHookId: "draft" });
        expect(findChat(otherRef)).toEqual(otherBefore);
        expect(select()!.value).toBe("draft");
        choose("");
        expect(findChat(ref)).not.toHaveProperty("draftHookId");
        expect(findChat(ref)).toEqual(before);
        expect(findChat(otherRef)).toEqual(otherBefore);
        expect(select()!.value).toBe("");
    });

    it("shows missing ids without Draft hooks and clears them with None", () => {
        render(missingRef);
        expect(options()).toEqual([
            ["", language.inputHooks.none],
            ["gone", language.inputHooks.missingHook],
        ]);
        expect(select()!.value).toBe("gone");
        settings.inputHooks = [{ ...btw, id: "gone" }];
        flushSync();
        expect(options()).toEqual([
            ["", language.inputHooks.none],
            ["gone", language.inputHooks.missingHook],
        ]);
        expect(select()!.value).toBe("gone");
        const otherBefore = JSON.parse(JSON.stringify(findChat(otherRef)));
        choose("");
        expect(findChat(missingRef)).not.toHaveProperty("draftHookId");
        expect(findChat(otherRef)).toEqual(otherBefore);
        expect(select()).toBeNull();
        expect(target.textContent).toBe("");
    });
});
