// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The chat panel's translation section (`ChatTranslationPanel.svelte`) shows a chat's auto-translate
// flag and, for the LLM translator, its translator preset from the chat's list entry: "Global
// (<name>)" for a chat without its own, the preset by name, or "Deleted, using global" for one that
// is gone (shown until it is back). The checkbox writes `true` or unsets the field (never `false`);
// the select writes the id or unsets it (back to the global selection); another translator hides the
// select; a chat that is not a member shows nothing, and a write as the chat goes does not throw.

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

import { createTranslatorPreset } from "../../../shared/translatorPresets.ts";
import { language } from "src/lang";
import { chatEntry, deleteChat } from "src/ts/storage/chatStore.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import ChatTranslationPanel from "./ChatTranslationPanel.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const refK = { chaId: "c", chatId: "k" };
const refJ = { chaId: "c", chatId: "j" };
const refP = { chaId: "c", chatId: "p" };
const chat = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    name: `Chat ${id.toUpperCase()}`,
    note: "",
    localLore: [],
    message: [{ role: "char", data: "hi", chatId: `m-${id}` }],
    ...fields,
});
const strings = language.chatTranslation;

function renderPanel(chatRef: { chaId: string; chatId: string }) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(ChatTranslationPanel, { target, props: { chatRef } }));
    flushSync();
    const panel = () => target.querySelector("[data-chat-translation-panel]");
    const checkbox = () => target.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const checkboxes = () => [...target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const select = () => target.querySelector<HTMLSelectElement>("select");
    /** The select's options as `[value, label]`. */
    const options = () => [...(select()?.options ?? [])].map((option) => [option.value, option.textContent?.trim()]);
    /** A change event as the browser fires it (it bubbles; Svelte handles `change` at the root). */
    const choose = (value: string) => {
        select()!.value = value;
        select()!.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
    };
    /** A flush, then the microtask Svelte's select binding re-selects on after its options changed. */
    const settle = async () => {
        flushSync();
        await tick();
    };
    return { target, panel, checkbox, checkboxes, select, options, choose, settle };
}

/** Chat `k` names `tp2` with auto-translate on; `j` names the deleted `tp-gone`; `p` has no settings. */
beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chatPage: 0,
                chats: [
                    chat("k", { translatorPresetId: "tp2", autoTranslate: true }),
                    chat("j", { translatorPresetId: "tp-gone" }),
                    chat("p"),
                ],
            },
        ],
        translatorPresets: [
            createTranslatorPreset("Global one", { id: "tp1" }),
            createTranslatorPreset("Chat two", { id: "tp2" }),
        ],
        translatorPresetId: "tp1",
        translatorType: "llm",
        translator: "ko",
        llmTranslationTarget: "message",
    } as any);
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

describe("ChatTranslationPanel", () => {
    it("shows the chat's flag and preset, the global option by the selected preset's name, and follows the selection and a rename", () => {
        const panel = renderPanel(refK);
        expect(panel.target.textContent).toContain(strings.title);
        expect(panel.checkbox().checked).toBe(true);
        expect(panel.select()!.value).toBe("tp2");
        expect(panel.options()).toEqual([
            ["", strings.global("Global one")],
            ["tp1", "Global one"],
            ["tp2", "Chat two"],
        ]);

        settings.translatorPresets.selectedId = "tp2";
        flushSync();
        expect(panel.options()[0]).toEqual(["", strings.global("Chat two")]);
        settings.translatorPresets.items[1].name = "Chat two renamed";
        flushSync();
        expect(panel.options()).toEqual([
            ["", strings.global("Chat two renamed")],
            ["tp1", "Global one"],
            ["tp2", "Chat two renamed"],
        ]);
        expect(panel.select()!.value).toBe("tp2");
    });

    it("the checkbox writes true or unsets the field (never false); the select writes the id or unsets it", () => {
        const panel = renderPanel(refP);
        expect(panel.checkbox().checked).toBe(false);
        expect(panel.select()!.value).toBe("");
        expect(chatEntry(refP)).toEqual({ id: "p", name: "Chat P", fmIndex: -1 });

        panel.checkbox().click();
        flushSync();
        expect(chatEntry(refP)).toMatchObject({ autoTranslate: true });
        expect(panel.checkbox().checked).toBe(true);
        panel.checkbox().click();
        flushSync();
        expect(chatEntry(refP)).not.toHaveProperty("autoTranslate");
        expect(panel.checkbox().checked).toBe(false);

        panel.choose("tp1");
        expect(chatEntry(refP)).toMatchObject({ translatorPresetId: "tp1" });
        expect(panel.select()!.value).toBe("tp1");
        panel.choose("tp2");
        expect(chatEntry(refP)).toMatchObject({ translatorPresetId: "tp2" });
        panel.choose("");
        expect(chatEntry(refP)).not.toHaveProperty("translatorPresetId");
        expect(panel.select()!.value).toBe("");
        expect(chatEntry(refP)).toEqual({ id: "p", name: "Chat P", fmIndex: -1 });
    });

    it("a deleted preset shows as such, selected, until it is back or another is chosen", async () => {
        const panel = renderPanel(refJ);
        expect(panel.select()!.value).toBe("tp-gone");
        expect(panel.options()).toEqual([
            ["", strings.global("Global one")],
            ["tp-gone", strings.goneUsingGlobal],
            ["tp1", "Global one"],
            ["tp2", "Chat two"],
        ]);

        // The preset comes back: shown by name, the chat untouched.
        settings.translatorPresets.items.push(createTranslatorPreset("Back", { id: "tp-gone" }));
        await panel.settle();
        expect(panel.select()!.value).toBe("tp-gone");
        expect(panel.options()).toEqual([
            ["", strings.global("Global one")],
            ["tp1", "Global one"],
            ["tp2", "Chat two"],
            ["tp-gone", "Back"],
        ]);
        expect(chatEntry(refJ)).toMatchObject({ translatorPresetId: "tp-gone" });
        settings.translatorPresets.items.splice(2, 1);
        await panel.settle();
        expect(panel.options()[1]).toEqual(["tp-gone", strings.goneUsingGlobal]);
        expect(panel.select()!.value).toBe("tp-gone");

        // Choosing the global option drops the dangling id and its option.
        panel.choose("");
        expect(chatEntry(refJ)).not.toHaveProperty("translatorPresetId");
        expect(panel.options().map(([value]) => value)).toEqual(["", "tp1", "tp2"]);
    });

    it("the bot-only row shows with the stored translation and auto-translate on, writes true or unsets, and hides for the rendered target or another translator", () => {
        const panel = renderPanel(refK);
        // Auto-translate, bot-only, and the bilingual display on the stored path.
        expect(panel.checkboxes()).toHaveLength(3);
        expect(panel.target.textContent).toContain(strings.botOnly);
        expect(panel.checkboxes()[1].checked).toBe(false);
        panel.checkboxes()[1].click();
        flushSync();
        expect(chatEntry(refK)).toMatchObject({ autoTranslate: true, translateBotOnly: true });
        expect(panel.checkboxes()[1].checked).toBe(true);
        panel.checkboxes()[1].click();
        flushSync();
        expect(chatEntry(refK)).not.toHaveProperty("translateBotOnly");
        expect(chatEntry(refK)).toMatchObject({ autoTranslate: true });

        // Without auto-translate the row is gone; turning it on brings the row (its own value kept).
        panel.checkboxes()[1].click();
        flushSync();
        panel.checkbox().click();
        flushSync();
        expect(panel.checkboxes()).toHaveLength(2);
        expect(panel.target.textContent).not.toContain(strings.botOnly);
        expect(chatEntry(refK)).toMatchObject({ translateBotOnly: true });
        expect(chatEntry(refK)).not.toHaveProperty("autoTranslate");
        panel.checkbox().click();
        flushSync();
        expect(panel.checkboxes()).toHaveLength(3);
        expect(panel.checkboxes()[1].checked).toBe(true);

        // The rendered target and another translator have no automatic requests to limit.
        settings.memoryTranslateMedia.llmTranslationTarget = "rendered";
        flushSync();
        expect(panel.checkboxes()).toHaveLength(1);
        settings.memoryTranslateMedia.llmTranslationTarget = "message";
        settings.memoryTranslateMedia.translatorType = "google";
        flushSync();
        expect(panel.checkboxes()).toHaveLength(1);
        settings.memoryTranslateMedia.translatorType = "llm";
        flushSync();
        expect(panel.checkboxes()).toHaveLength(3);

        // A chat without auto-translate starts without the row.
        const off = renderPanel(refP);
        expect(off.checkboxes()).toHaveLength(2);
    });

    it("another translator hides the preset row and keeps the checkbox; the LLM translator brings it back", () => {
        const panel = renderPanel(refK);
        settings.memoryTranslateMedia.translatorType = "google";
        flushSync();
        expect(panel.select()).toBeNull();
        expect(panel.checkbox().checked).toBe(true);
        expect(panel.target.textContent).not.toContain(strings.translatorPreset);
        settings.memoryTranslateMedia.translatorType = "llm";
        flushSync();
        expect(panel.select()!.value).toBe("tp2");
    });

    it("shows nothing for a chat that is gone or was never a member, and a write as the chat goes does not throw", () => {
        const panel = renderPanel(refK);
        const checkbox = panel.checkbox();
        deleteChat(refK);
        expect(() => checkbox.click()).not.toThrow();
        flushSync();
        expect(panel.panel()).toBeNull();
        expect(chatEntry(refK)).toBeUndefined();
        expect(chatEntry(refJ)).toMatchObject({ translatorPresetId: "tp-gone" });

        const never = renderPanel({ chaId: "c", chatId: "nope" });
        expect(never.panel()).toBeNull();
    });

    it("the bilingual rows: the check writes true or unsets; while on, the emphasis and pairing selects write or unset; hidden off the stored path", () => {
        const panel = renderPanel(refP);
        const selects = () => [...panel.target.querySelectorAll<HTMLSelectElement>("select")];
        const pick = (element: HTMLSelectElement, value: string) => {
            element.value = value;
            element.dispatchEvent(new Event("change", { bubbles: true }));
            flushSync();
        };
        // Auto-translate and the bilingual check; only the preset select.
        expect(panel.checkboxes()).toHaveLength(2);
        expect(panel.target.textContent).toContain(strings.bilingual);
        expect(selects()).toHaveLength(1);

        panel.checkboxes()[1].click();
        flushSync();
        expect(chatEntry(refP)).toMatchObject({ bilingualDisplay: true });
        const [emphasis, pairing] = selects();
        expect(selects()).toHaveLength(3);
        expect(emphasis.value).toBe("original");
        expect(pairing.value).toBe("0");
        expect([...pairing.options].map((option) => option.value)).toEqual([
            "0",
            ...Array.from({ length: 10 }, (_, index) => String(index + 1)),
        ]);

        pick(emphasis, "translation");
        pick(pairing, "3");
        expect(chatEntry(refP)).toMatchObject({ bilingualEmphasis: "translation", bilingualSentences: 3 });
        pick(selects()[0], "original");
        pick(selects()[1], "0");
        expect(chatEntry(refP)).not.toHaveProperty("bilingualEmphasis");
        expect(chatEntry(refP)).not.toHaveProperty("bilingualSentences");

        panel.checkboxes()[1].click();
        flushSync();
        expect(chatEntry(refP)).not.toHaveProperty("bilingualDisplay");
        expect(selects()).toHaveLength(1);

        // The rendered target has no stored translation to pair.
        settings.memoryTranslateMedia.llmTranslationTarget = "rendered";
        flushSync();
        expect(panel.target.textContent).not.toContain(strings.bilingual);
    });
});
