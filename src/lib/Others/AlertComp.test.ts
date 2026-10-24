// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { showHypaV2Alert, type alertData } from "src/ts/alert";
import { NEXT_DIALOG_GAP_MS, type AlertDialog } from "src/ts/alertQueue";
import { initHotkey } from "src/ts/hotkey";
import { alertStore, settingsOpen } from "src/ts/stores.svelte";
import { installFlatDatabase, installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { findCharacter } from "src/ts/storage/characterStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { assembleChats, findChat, selectChat, setChatMeta, setChatWorkListener } from "src/ts/storage/chatStore.svelte";
import SideChatList from "src/lib/SideBars/SideChatList.svelte";
import AlertComp from "./AlertComp.svelte";

const dialogs: AlertDialog[] = [];
let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
let composer: HTMLTextAreaElement;
let sidebar: ReturnType<typeof mount> | undefined;

function open(data: alertData) {
    const dialog = alertStore.open(data);
    dialogs.push(dialog);
    return dialog;
}

async function showAlert() {
    component = mount(AlertComp, { target });
    flushSync();
    await tick();
}

async function hideAlert() {
    if (component) {
        await unmount(component);
        component = undefined;
    }
    await tick();
}

function dialogPanel() {
    const panel = target.querySelector<HTMLDivElement>("[data-alert-dialog] > div");
    expect(panel).not.toBeNull();
    return panel!;
}

function stroke(key: string) {
    const active = document.activeElement!;
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    active.dispatchEvent(event);
    active.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    return event;
}

beforeAll(() => {
    initHotkey();
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    installFlatDatabase({ characters: [], botPresets: [{ id: "preset", name: "Preset" }] });
    settingsOpen.set(false);
    window.dispatchEvent(new Event("blur"));
    target = document.createElement("div");
    composer = document.createElement("textarea");
    composer.className = "text-input-area";
    document.body.append(composer, target);
    composer.focus();
});

afterEach(async () => {
    setChatWorkListener(null);
    for (const dialog of dialogs.splice(0)) dialog.cancel();
    alertStore.answer("");
    await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
    alertStore.answer("");
    alertStore.clearStatus();
    if (sidebar) await unmount(sidebar);
    sidebar = undefined;
    await hideAlert();
    await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
    document.body.replaceChildren();
    window.dispatchEvent(new Event("blur"));
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("dialogs keep their requested character and chat", () => {
    const ref = (chaId: string) => ({ chaId, chatId: `chat-${chaId}` });
    const memory = (owner: string) => ({
        lastMainChunkID: 1,
        chunks: [{ mainChunkID: 1, text: `${owner} chunk` }],
        mainChunks: [
            { id: 1, text: `${owner} summary`, chatMemos: [`message-${owner}`], lastChatMemo: `message-${owner}` },
        ],
    });
    function installChats(extraChat = false) {
        installFlatDatabaseWithChats({
            characters: ["a", "b", "c"].map((id) => ({
                chaId: id,
                type: "character",
                name: id,
                firstMessage: `Greeting ${id}`,
                alternateGreetings: [`Greeting ${id}`],
                chatFolders: [],
                chats: (id === "a" && extraChat ? ["a", "a-other"] : [id]).map((owner) => ({
                    id: `chat-${owner}`,
                    name: `Chat ${owner}`,
                    fmIndex: 0,
                    message: [{ chatId: `message-${owner}`, role: "user", data: `Branch ${owner}` }],
                    hypaV2Data: memory(owner),
                })),
            })),
        });
        select("a");
    }
    function select(id: string) {
        selectCharacter(id);
        selectChat(id, `chat-${id}`);
        flushSync();
    }
    async function showQueued(blocker: AlertDialog) {
        blocker.cancel();
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
        await showAlert();
    }
    function edit(text: string) {
        const input = target.querySelector<HTMLTextAreaElement>("textarea")!;
        expect(input).not.toBeNull();
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    }

    it("shows the requested character's branches after selection changes while queued and while open", async () => {
        installChats();
        const blocker = open({ type: "normal", msg: "Before branches" });
        const listTarget = document.createElement("div");
        document.body.append(listTarget);
        sidebar = mount(SideChatList, { target: listTarget, props: { chara: findCharacter("a")! } });
        flushSync();
        listTarget.querySelector<HTMLButtonElement>("button:has(.lucide-split)")!.click();
        select("b");
        await showQueued(blocker);

        function hoverMessage() {
            const nodes = target.querySelectorAll<HTMLElement>('[role="table"]');
            expect(nodes).toHaveLength(2); // Greeting and the one message of character a.
            nodes[1].dispatchEvent(new MouseEvent("mouseenter"));
            flushSync();
            expect(target.textContent).toContain("Branch a");
            expect(target.textContent).not.toContain("Branch b");
            expect(target.textContent).not.toContain("Branch c");
            nodes[1].dispatchEvent(new MouseEvent("mouseleave"));
            flushSync();
        }
        hoverMessage();
        select("c");
        await tick();
        hoverMessage();
    });

    it("shows and saves HypaV2 chunks and summaries to the requested chat across queued and open selection changes", async () => {
        installChats(true);
        const blocker = open({ type: "normal", msg: "Before memory" });
        showHypaV2Alert();
        select("b");
        await showQueued(blocker);
        expect(target.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("a chunk");
        edit("a chunk edited");

        selectCharacter("a");
        selectChat("a", "chat-a-other");
        flushSync();
        expect(target.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("a chunk edited");
        [...target.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Summarized")!.click();
        flushSync();
        expect(target.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("a summary");
        edit("a summary edited");

        expect(findChat(ref("a"))?.hypaV2Data).toEqual({
            ...memory("a"),
            chunks: [{ mainChunkID: 1, text: "a chunk edited" }],
            mainChunks: [{ ...memory("a").mainChunks[0], text: "a summary edited" }],
        });
        expect(findChat(ref("b"))?.hypaV2Data).toEqual(memory("b"));
        expect(findChat(ref("c"))?.hypaV2Data).toEqual(memory("c"));
        expect(findChat({ chaId: "a", chatId: "chat-a-other" })?.hypaV2Data).toEqual(memory("a-other"));

        setChatMeta(ref("a"), {}, ["hypaV2Data"]);
        const work = vi.fn();
        setChatWorkListener(work);
        expect(() => flushSync()).not.toThrow();
        expect(target.querySelector("textarea")).toBeNull();
        expect(work).not.toHaveBeenCalled();
    });

    it.each(["unloaded", "without memory"])(
        "shows no HypaV2 editor and writes nothing when the requested chat is %s",
        async (state) => {
            installChats();
            const blocker = open({ type: "normal", msg: "Before unavailable memory" });
            showHypaV2Alert();
            select("b");
            if (state === "without memory") {
                setChatMeta(ref("a"), {}, ["hypaV2Data"]);
            } else {
                const otherChat = JSON.parse(JSON.stringify(findChat(ref("b"))!));
                assembleChats(
                    [{ chaId: "a" }, { chaId: "b" }],
                    [
                        { characterId: "a", id: "chat-a", revision: "r1", name: "Chat a", fmIndex: 0 },
                        { characterId: "b", id: "chat-b", revision: "r1", data: otherChat },
                    ],
                    [
                        { characterId: "a", revision: "o1", ids: ["chat-a"] },
                        { characterId: "b", revision: "o1", ids: ["chat-b"] },
                    ],
                );
                expect(findChat(ref("a"))).toBeUndefined();
            }
            const work = vi.fn();
            setChatWorkListener(work);
            await showQueued(blocker);

            expect(target.querySelector("textarea")).toBeNull();
            expect(work).not.toHaveBeenCalled();
            expect(findChat(ref("b"))?.hypaV2Data).toEqual(memory("b"));
            expect(findChat(ref("a"))?.hypaV2Data).toBeUndefined();
        },
    );
});

describe("alert dialog focus and keyboard answers", () => {
    it.each([
        ["Enter", "yes"],
        ["Escape", ""],
    ])("takes focus from the composer so a fresh %s answers an ask dialog, then returns focus", async (key, answer) => {
        expect(document.activeElement).toBe(composer);
        const dialog = open({ type: "ask", msg: "Continue?" });
        await showAlert();
        expect(document.activeElement).toBe(dialogPanel());

        expect(stroke(key).defaultPrevented).toBe(true);
        expect(alertStore.hasDialogs()).toBe(false);
        await expect(dialog.closed).resolves.toBe(answer);
        await hideAlert();
        expect(document.activeElement).toBe(composer);
    });

    it("returns focus to the original composer only after the queued dialogs finish, across unmounts", async () => {
        const first = open({ type: "normal", msg: "First notice" });
        const second = open({ type: "pluginconfirm", msg: "Allow plugin?" });
        await showAlert();
        expect(document.activeElement).toBe(dialogPanel());
        stroke("Enter");
        expect(alertStore.dialogVisible()).toBe(false);
        await expect(first.closed).resolves.toBe("yes");

        // App unmounts AlertComp while the queue publishes type "none" between dialogs.
        await hideAlert();
        expect(alertStore.hasDialogs()).toBe(true);
        expect(document.activeElement).not.toBe(composer);
        await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
        await showAlert();
        expect(document.activeElement).toBe(dialogPanel());
        stroke("Escape");
        expect(alertStore.hasDialogs()).toBe(false);
        await expect(second.closed).resolves.toBe("");
        await hideAlert();
        expect(document.activeElement).toBe(composer);
    });

    it("preserves focus moved elsewhere before the last dialog closes", async () => {
        const dialog = open({ type: "ask", msg: "Continue?" });
        await showAlert();
        expect(document.activeElement).toBe(dialogPanel());
        const other = document.createElement("input");
        document.body.append(other);
        other.focus();
        dialog.cancel();
        await expect(dialog.closed).resolves.toBe("");
        await hideAlert();
        expect(document.activeElement).toBe(other);
    });

    it("leaves the composer focused when wait, wait2, and progress overlays appear", async () => {
        for (const type of ["wait", "wait2", "progress"] as const) {
            const data = { type, msg: "Working", submsg: "50" };
            if (type === "wait2") open(data);
            else alertStore.set(data);
            await showAlert();
            expect(document.activeElement).toBe(composer);
            // wait2 is queued, although its invisible status panel must not take focus.
            alertStore.answer("");
            alertStore.clearStatus();
            await hideAlert();
            await vi.advanceTimersByTimeAsync(NEXT_DIALOG_GAP_MS);
        }
    });

    it.each([
        ["Enter", "Edited answer"],
        ["Escape", ""],
    ])("focuses an input dialog's own field and answers a fresh %s there", async (key, answer) => {
        const dialog = open({ type: "input", msg: "Name", defaultValue: "Initial answer" });
        await showAlert();
        const input = target.querySelector<HTMLInputElement>("#alert-input")!;
        expect(input).not.toBeNull();
        expect(document.activeElement).toBe(input);

        composer.focus();
        expect(stroke("Enter").defaultPrevented).toBe(false);
        expect(alertStore.dialogVisible()).toBe(true);
        input.focus();
        input.value = "Edited answer";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await tick();
        expect(stroke(key).defaultPrevented).toBe(true);
        expect(alertStore.hasDialogs()).toBe(false);
        await expect(dialog.closed).resolves.toBe(answer);
        await hideAlert();
        expect(document.activeElement).toBe(composer);
    });
});
