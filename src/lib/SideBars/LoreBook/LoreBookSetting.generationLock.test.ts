// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Chat, ChatLoreOverride, loreBook } from "../../../../shared/database.ts";

// The lorebook tab while a send of this tab (`localSends`) or a job this tab follows (`followedJobs`) runs in the
// selected chat, over the real records, chat module, and lore drafts: the chat's lore is read-only (the
// `chatGenerating` notice, disabled controls, drag off) and nothing is written until the fence drops. A character
// entry the fenced chat links is not deleted, before or after its dialog, and the local activation checkbox writes
// neither the link nor the entry's id. SortableJS, the token count route, and the dialogs are doubled.

/** The SortableJS instances the lists created (happy-dom cannot drag). */
const sortables = vi.hoisted(() => [] as { el: HTMLElement; options: Record<string, unknown>; destroyed: boolean }[]);
vi.mock("sortablejs/modular/sortable.core.esm.js", () => {
    class Sortable {
        destroyed = false;
        constructor(
            public el: HTMLElement,
            public options: Record<string, unknown>,
        ) {
            sortables.push(this);
        }
        option(name: string, value?: unknown) {
            if (value === undefined) return this.options[name];
            this.options[name] = value;
        }
        destroy() {
            this.destroyed = true;
        }
        static create(el: HTMLElement, options: Record<string, unknown>) {
            return new Sortable(el, options);
        }
    }
    return { default: Sortable };
});
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({ alertConfirm: vi.fn(async () => true) }),
);
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: vi.fn(async (_path, init) => {
            const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
            return Response.json({ counts: texts.map(() => 0) });
        }),
    }),
);

import { language } from "src/lang";
import { alertConfirm, alertError, alertNormal } from "src/ts/alert";
import { chatStatusKey } from "src/ts/process/chatStatus.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
import { followedJobs } from "src/ts/process/serverCommands";
import { characterList } from "src/ts/storage/characterStore.svelte";
import {
    acceptRemoteChat,
    findChat,
    noteRemoteStreaming,
    selectChat,
    setChatWorkListener,
} from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { closePopupEditorSession, popUpEditorStore } from "src/ts/stores.svelte";
import LoreBookSetting from "./LoreBookSetting.svelte";

const ref = { chaId: "owner", chatId: "chat" };
const feedChat = { characterId: ref.chaId, id: ref.chatId };
const entry = (name: string, extra: Partial<loreBook> = {}): loreBook => ({
    key: name,
    comment: name,
    content: `${name} content`,
    mode: "normal",
    insertorder: 100,
    alwaysActive: false,
    secondkey: "",
    selective: false,
    ...extra,
});
const child = (id: string) => entry("", { id, mode: "child", alwaysActive: true });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const globalLore = () => characterList()[0]!.globalLore;
const localLore = () => findChat(ref)!.localLore;
const chatWrites = vi.fn();
let target: HTMLDivElement;
let instance: ReturnType<typeof mount> | undefined;
const releases: (() => void)[] = [];

function install(lore: { globalLore?: loreBook[]; localLore?: loreBook[]; loreOverrides?: ChatLoreOverride[] }) {
    installFlatDatabaseWithChats({
        bulkEnabling: true,
        localActivationInGlobalLorebook: true,
        characters: [
            {
                chaId: ref.chaId,
                type: "character",
                name: "Owner",
                globalLore: lore.globalLore ?? [],
                chats: [
                    {
                        id: ref.chatId,
                        name: "Chat",
                        note: "",
                        message: [{ chatId: "reply", role: "char", data: "Reply" }],
                        localLore: copy(lore.localLore ?? []),
                        ...(lore.loreOverrides && { loreOverrides: copy(lore.loreOverrides) }),
                    },
                ],
            },
        ],
    });
    selectCharacter(ref.chaId);
    selectChat(ref.chaId, ref.chatId);
    flushSync();
    setChatWorkListener(chatWrites);
}
type Fence = "local send" | "message lock" | "followed job";
/** Raises a chat write fence and returns what releases it. */
function fence(kind: Fence) {
    if (kind === "local send") {
        const release = beginLocalSend(ref)!;
        expect(release).not.toBeNull();
        releases.push(release);
        flushSync();
        return () => {
            releases.splice(releases.indexOf(release), 1);
            release();
            flushSync();
        };
    }
    if (kind === "message lock") {
        noteRemoteStreaming([{ ...feedChat, streaming: [{ messageId: "reply", generationId: "gen", seq: 0 }] }]);
        flushSync();
        return () => {
            noteRemoteStreaming([{ ...feedChat, streaming: [] }]);
            flushSync();
        };
    }
    followedJobs.set(new Map([["job", chatStatusKey(ref)]]));
    flushSync();
    return () => {
        followedJobs.set(new Map());
        flushSync();
    };
}
function click(element: HTMLElement) {
    element.click();
    flushSync();
}
async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}
function button(name: string) {
    const found = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
        (element) => element.textContent?.trim() === name,
    );
    expect(found, `button ${name}`).toBeDefined();
    return found!;
}
/** The rendered lorebook rows (nested folder lists included), without the hidden sort markers. */
const rows = () =>
    [...target.querySelectorAll<HTMLElement>("[data-risu-idgroup]")].filter((row) => row.querySelector("button"));
const row = (name: string) => rows().find((element) => element.querySelector("button")!.textContent!.trim() === name)!;
/** A row's header buttons after its name: the always-active toggle and delete (a child link: delete only). */
const rowActions = (element: HTMLElement) =>
    [...element.querySelector(":scope > div")!.querySelectorAll("button")].slice(1);
const removeButton = (element: HTMLElement) => rowActions(element).at(-1)!;
/** The tab's footer buttons: add, export, add folder, import, and the CHAR and CHAT bulk toggles. */
const footer = () =>
    [...target.querySelectorAll<HTMLDivElement>("div.mt-2.flex")]
        .find((element) => element.parentElement === target && element.classList.contains("text-textcolor2"))!
        .querySelectorAll("button");
const disabled = (elements: Iterable<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>) =>
    [...elements].map((element) => element.disabled || ("readOnly" in element && element.readOnly));
const fields = (element: HTMLElement) => [
    ...element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"),
];
const liveSortables = () => sortables.filter((sortable) => !sortable.destroyed && sortable.el.isConnected);

beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(alertConfirm).mockReset().mockResolvedValue(true);
    vi.mocked(alertError).mockClear();
    vi.mocked(alertNormal).mockClear();
    chatWrites.mockClear();
    followedJobs.set(new Map());
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    setChatWorkListener(null);
    for (const release of releases.splice(0)) release();
    followedJobs.set(new Map());
    noteRemoteStreaming([{ ...feedChat, streaming: [] }]);
    if (instance) await unmount(instance);
    instance = undefined;
    closePopupEditorSession(popUpEditorStore.sessionId);
    target.remove();
    selectCharacter(null);
    vi.clearAllTimers();
    vi.useRealTimers();
});

it.each(["local send", "followed job"] as const)(
    "makes the chat's lore read-only during a %s and editable again when it ends",
    (kind) => {
        const stored = [
            entry("Local"),
            entry("Box", { mode: "folder", key: "box" }),
            entry("Inside", { folder: "box" }),
        ];
        install({ localLore: stored });
        instance = mount(LoreBookSetting, { target });
        flushSync();
        click(button(language.Chat));
        click(row("Local").querySelector("button")!);
        click(row("Box").querySelector("button")!);
        expect(liveSortables().length).toBeGreaterThan(0);
        const notice = () => [...target.querySelectorAll('[role="status"]')].map((element) => element.textContent);

        const end = fence(kind);
        expect(notice()).toEqual([language.chatGenerating]);
        // Export stays available; the CHAR toggle edits the character, not the chat.
        expect(disabled(footer())).toEqual([true, false, true, true, false, true]);
        expect(rows().every((element) => disabled(rowActions(element)).every(Boolean))).toBe(true);
        expect(disabled(fields(row("Local"))).every(Boolean)).toBe(true);
        expect(disabled(fields(row("Box"))).every(Boolean)).toBe(true);
        const nestedAdd = row("Box").querySelector<HTMLButtonElement>("div.mt-2.flex.gap-1 button")!;
        expect(nestedAdd.disabled).toBe(true);
        expect(liveSortables().every((sortable) => sortable.options.disabled === true)).toBe(true);

        for (const control of [...footer(), ...rows().flatMap(rowActions), nestedAdd]) click(control);
        expect(alertConfirm).not.toHaveBeenCalled();
        expect(alertError).not.toHaveBeenCalled();
        expect(chatWrites).not.toHaveBeenCalled();
        expect(localLore()).toEqual(stored);

        end();
        expect(notice()).toEqual([]);
        expect(disabled(footer())).toEqual([false, false, false, false, false, false]);
        expect(rows().some((element) => disabled(rowActions(element)).some(Boolean))).toBe(false);
        expect(disabled(fields(row("Local"))).some(Boolean)).toBe(false);
        expect(nestedAdd.disabled).toBe(false);
        expect(liveSortables().some((sortable) => sortable.options.disabled === true)).toBe(false);
        click(nestedAdd);
        expect(localLore()).toHaveLength(stored.length + 1);
        expect(alertError).not.toHaveBeenCalled();
    },
);

it("keeps a character entry the fenced chat links, refusing before and after the dialog, and deletes it once the fence ends", async () => {
    const linked = entry("Linked", { id: "linked" });
    const unlinked = entry("Unlinked", { id: "unlinked" });
    const kept = entry("Kept", { id: "kept" });
    install({ globalLore: [linked, unlinked, kept], localLore: [child("linked"), child("kept")] });
    instance = mount(LoreBookSetting, { target });
    flushSync();

    // Already fenced: refused before the dialog.
    let end = fence("local send");
    expect(removeButton(row("Linked")).disabled).toBe(false);
    click(removeButton(row("Linked")));
    await settle();
    expect(alertError).toHaveBeenCalledExactlyOnceWith(language.chatGenerating);
    expect(alertConfirm).not.toHaveBeenCalled();
    // An entry the chat does not link is deleted as usual.
    click(removeButton(row("Unlinked")));
    await settle();
    expect(alertConfirm).toHaveBeenCalledOnce();
    expect(globalLore().map((book) => book.id)).toEqual(["linked", "kept"]);
    expect(chatWrites).not.toHaveBeenCalled();
    end();

    // Fenced during the dialog: refused after it, and the entry stays.
    vi.mocked(alertError).mockClear();
    let answer!: (confirmed: boolean) => void;
    vi.mocked(alertConfirm).mockReturnValueOnce(new Promise<boolean>((resolve) => (answer = resolve)));
    click(removeButton(row("Linked")));
    end = fence("followed job");
    answer(true);
    await settle();
    expect(alertError).toHaveBeenCalledExactlyOnceWith(language.chatGenerating);
    expect(globalLore().map((book) => book.id)).toEqual(["linked", "kept"]);
    expect(localLore()).toEqual([child("linked"), child("kept")]);
    expect(chatWrites).not.toHaveBeenCalled();
    end();

    click(removeButton(row("Linked")));
    await settle();
    expect(globalLore().map((book) => book.id)).toEqual(["kept"]);
    expect(localLore()).toEqual([child("kept")]);
    expect(chatWrites).toHaveBeenCalledOnce();
});

it("disables the local activation checkbox during a send, writing neither the link nor the entry's id", () => {
    install({ globalLore: [entry("No id")] });
    instance = mount(LoreBookSetting, { target });
    flushSync();
    click(row("No id").querySelector("button")!);
    const checkbox = () =>
        [...target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
            (element) => element.alt === language.alwaysActiveInChat,
        )!;

    const end = fence("local send");
    expect(checkbox().disabled).toBe(true);
    click(checkbox());
    expect(globalLore()[0].id).toBeUndefined();
    expect(localLore()).toEqual([]);
    expect(alertError).not.toHaveBeenCalled();
    expect(chatWrites).not.toHaveBeenCalled();

    end();
    expect(checkbox().disabled).toBe(false);
    click(checkbox());
    const id = globalLore()[0].id;
    expect(id).toBeTruthy();
    expect(localLore()).toEqual([expect.objectContaining({ mode: "child", id })]);
});

const promptSources = ["chat lore", "lore override"] as const;
type PromptSource = (typeof promptSources)[number];
const fences = ["local send", "message lock", "followed job"] as const satisfies readonly Fence[];
const popupCases = promptSources.flatMap((source) => fences.map((kind) => ({ source, kind })));
const originalPrompt = entry("Popup lore", { id: "popup-lore" });
const draftText = "Typed in the popup\n  <copy this line as plain text>";
const copyMessage = () => `${language.lorePopupUnsaved}\n\n${draftText}`;

function promptList(source: PromptSource, book: loreBook) {
    return source === "chat lore" ? { localLore: [book] } : { loreOverrides: [{ entry: book, off: false }] };
}

function storedPrompt(source: PromptSource) {
    return source === "chat lore" ? localLore()[0].content : findChat(ref)!.loreOverrides![0].entry.content;
}

function expandPrompt() {
    const expand = target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`);
    expect(expand, "prompt expand button").not.toBeNull();
    click(expand!);
    expect(popUpEditorStore).toMatchObject({ open: true, value: originalPrompt.content });
    return expand!;
}

function typeInPopup(source: PromptSource) {
    install({ globalLore: [originalPrompt], ...promptList(source, originalPrompt) });
    instance = mount(LoreBookSetting, { target });
    flushSync();
    click(button(language.Chat));
    if (source === "lore override") click(button(language.chatLoreOverrides.title));
    click(button(originalPrompt.comment));
    const expand = expandPrompt();
    expect(popUpEditorStore.isReadOnly?.()).toBe(false);
    flushSync(() => {
        popUpEditorStore.value = draftText;
    });
    return expand;
}

function closePopup() {
    flushSync(() => closePopupEditorSession(popUpEditorStore.sessionId));
    expect(popUpEditorStore.open).toBe(false);
}

async function pollPopup() {
    await vi.advanceTimersByTimeAsync(100);
    flushSync();
}

it.each(popupCases)(
    "keeps the $source popup through a $kind and writes once on close after release",
    async ({ source, kind }) => {
        typeInPopup(source);

        const end = fence(kind);
        await pollPopup();
        expect(popUpEditorStore).toMatchObject({ open: true, value: draftText });
        expect(popUpEditorStore.isReadOnly?.()).toBe(true);
        expect(storedPrompt(source)).toBe(originalPrompt.content);
        expect(chatWrites).not.toHaveBeenCalled();

        end();
        await pollPopup();
        expect(popUpEditorStore).toMatchObject({ open: true, value: draftText });
        expect(popUpEditorStore.isReadOnly?.()).toBe(false);
        expect(storedPrompt(source)).toBe(originalPrompt.content);
        expect(chatWrites).not.toHaveBeenCalled();

        closePopup();
        await pollPopup();
        expect(storedPrompt(source)).toBe(draftText);
        expect(chatWrites).toHaveBeenCalledOnce();
        expect(alertNormal).not.toHaveBeenCalled();
    },
);

it.each(popupCases)(
    "offers the $source draft once on close and immediate reopen during a $kind",
    async ({ source, kind }) => {
        typeInPopup(source);
        const end = fence(kind);
        expect(popUpEditorStore).toMatchObject({ open: true, value: draftText });
        expect(popUpEditorStore.isReadOnly?.()).toBe(true);

        closePopup();
        // Reopen in the next UI update, before the closed session's first poll.
        expandPrompt();
        expect(popUpEditorStore.isReadOnly?.()).toBe(true);
        await pollPopup();
        expect(alertNormal).toHaveBeenCalledExactlyOnceWith(copyMessage());
        expect(storedPrompt(source)).toBe(originalPrompt.content);
        expect(chatWrites).not.toHaveBeenCalled();

        closePopup();
        end();
        await pollPopup();
        expect(alertNormal).toHaveBeenCalledExactlyOnceWith(copyMessage());
        expect(storedPrompt(source)).toBe(originalPrompt.content);
        expect(chatWrites).not.toHaveBeenCalled();
    },
);

it.each(promptSources)("offers the %s draft once when the lore list is replaced", async (source) => {
    const expand = typeInPopup(source);
    const end = fence("followed job");
    const replacement = { ...originalPrompt, content: "Prompt from the server" };

    const data = { ...copy(findChat(ref)!), ...promptList(source, replacement) } as Chat;
    acceptRemoteChat({ ...feedChat, revision: "r2", data });
    flushSync();

    expect(expand.isConnected).toBe(false);
    expect(popUpEditorStore.open).toBe(false);
    await pollPopup();
    end();
    await pollPopup();
    expect(alertNormal).toHaveBeenCalledExactlyOnceWith(copyMessage());
    expect(storedPrompt(source)).toBe(replacement.content);
    expect(chatWrites).not.toHaveBeenCalled();
});
