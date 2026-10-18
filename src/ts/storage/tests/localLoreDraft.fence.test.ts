// @vitest-environment happy-dom

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slice 1c of `docs/plan/data-loss-concurrency.md` (audit A2), the lore draft's half
// (`docs/structure/persistence.md` `localLoreDraft.svelte.ts`): over the real chat module, a change of
// the selected chat's local lorebook draft is saved through `setChatMeta`, but while a send of this
// tab (`sendingChatRef`) or a job this tab follows (`followedJobs`) runs in the chat it is refused with
// the `chatGenerating` notice and undone in the copy, and nothing is written when the fence drops.

const mocks = vi.hoisted(() => ({ alertError: vi.fn() }));

vi.mock("src/ts/alert", () => ({
    alertError: mocks.alertError,
    alertNormal: vi.fn(),
    alertConfirm: vi.fn(),
    alertToast: vi.fn(),
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
// The send pipeline is not under test: only its busy target store.
vi.mock("src/ts/process/index.svelte", async () => {
    const { writable } = await import("svelte/store");
    return { sendingChatRef: writable(null) };
});

import { language } from "src/lang";
import { chatStatusKey } from "src/ts/process/chatStatus.svelte";
import { sendingChatRef } from "src/ts/process/index.svelte";
import { followedJobs } from "src/ts/process/serverCommands";
import { findChat, selectChat, setChatWorkListener, type ChatRef } from "../chatStore.svelte";
import { selectCharacter } from "../selection.svelte";
import { useLocalLoreDraft } from "../localLoreDraft.svelte";
import { installFlatDatabaseWithChats } from "./installFlatDatabase";

const ref: ChatRef = { chaId: "c", chatId: "k" };
const entry = (content: string) => ({
    key: "k",
    secondkey: "",
    insertorder: 100,
    comment: "entry",
    content,
    mode: "normal",
    alwaysActive: false,
    selective: false,
});
const chatWork = vi.fn();
const stored = () => findChat(ref)?.localLore.map((lore) => lore.content);
const follow = (target: ChatRef | null) =>
    followedJobs.set(target ? new Map([["job-1", chatStatusKey(target)]]) : new Map());

beforeEach(() => {
    mocks.alertError.mockClear();
    chatWork.mockClear();
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chatPage: 0,
                chats: [{ id: "k", name: "K", note: "", localLore: [entry("first")], message: [] }],
            },
        ],
    } as any);
    selectCharacter("c");
    selectChat("c", "k");
    setChatWorkListener(chatWork);
    follow(null);
    sendingChatRef.set(null);
    flushSync();
});

afterEach(() => {
    setChatWorkListener(null);
    follow(null);
    sendingChatRef.set(null);
});

describe("localLoreDraft's write fence", () => {
    it("saves a change of the draft when nothing runs in the chat", () => {
        const draft = useLocalLoreDraft();
        flushSync();
        expect(draft.value.map((lore) => lore.content)).toEqual(["first"]);
        draft.value[0].content = "first, edited";
        flushSync();
        expect(stored()).toEqual(["first, edited"]);
        expect(chatWork).toHaveBeenCalled();
        expect(mocks.alertError).not.toHaveBeenCalled();
    });

    it("refuses a change with the notice while a job this tab follows runs, undoes it, and replays nothing when the job ends", () => {
        const draft = useLocalLoreDraft();
        flushSync();
        follow(ref);
        flushSync();
        chatWork.mockClear();

        draft.value[0].content = "during the job";
        flushSync();
        expect(mocks.alertError).toHaveBeenCalledWith(language.chatGenerating);
        expect(draft.value.map((lore) => lore.content)).toEqual(["first"]);
        expect(stored()).toEqual(["first"]);
        expect(chatWork).not.toHaveBeenCalled();

        draft.value.push(entry("added during the job") as any);
        flushSync();
        expect(draft.value).toHaveLength(1);
        expect(mocks.alertError).toHaveBeenCalledTimes(2);

        follow(null);
        flushSync();
        expect(stored()).toEqual(["first"]);
        expect(chatWork).not.toHaveBeenCalled();

        draft.value[0].content = "after the job";
        flushSync();
        expect(stored()).toEqual(["after the job"]);
    });

    it("is fenced by this tab's own send of the chat only", () => {
        const draft = useLocalLoreDraft();
        flushSync();
        sendingChatRef.set({ chaId: "c", chatId: "other" });
        flushSync();
        draft.value[0].content = "other chat sending";
        flushSync();
        expect(stored()).toEqual(["other chat sending"]);

        sendingChatRef.set(ref);
        flushSync();
        draft.value[0].content = "this chat sending";
        flushSync();
        expect(mocks.alertError).toHaveBeenCalledWith(language.chatGenerating);
        expect(draft.value[0].content).toBe("other chat sending");
        expect(stored()).toEqual(["other chat sending"]);
    });
});
