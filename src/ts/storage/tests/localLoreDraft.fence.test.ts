// @vitest-environment happy-dom

import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The lore draft's generation fence (`docs/structure/persistence.md` `localLoreDraft.svelte.ts`):
// over the real chat module, a change of the selected chat's local lorebook draft is saved through
// `setChatMeta`, but while a send of this tab (a `localSends` entry) or a job this tab follows
// (`followedJobs`) runs in the chat it is refused with the `chatGenerating` notice and undone in the
// copy, and nothing is written when the fence drops.

const mocks = vi.hoisted(() => ({ alertError: vi.fn() }));

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: mocks.alertError,
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
import { chatStatusKey } from "src/ts/process/chatStatus.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
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
/** The sends begun on the registry, released at the test's end at the latest. */
const releases: (() => void)[] = [];
const send = (target: ChatRef) => {
    const release = beginLocalSend(target)!;
    expect(release).not.toBeNull();
    releases.push(release);
    flushSync();
    return release;
};

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
    flushSync();
});

afterEach(() => {
    setChatWorkListener(null);
    follow(null);
    for (const release of releases.splice(0)) {
        release();
    }
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
        send({ chaId: "c", chatId: "other" });
        draft.value[0].content = "other chat sending";
        flushSync();
        expect(stored()).toEqual(["other chat sending"]);

        const release = send(ref);
        draft.value[0].content = "this chat sending";
        flushSync();
        expect(mocks.alertError).toHaveBeenCalledWith(language.chatGenerating);
        expect(draft.value[0].content).toBe("other chat sending");
        expect(stored()).toEqual(["other chat sending"]);

        // The send's end opens the fence again, with nothing replayed.
        release();
        flushSync();
        expect(stored()).toEqual(["other chat sending"]);
        draft.value[0].content = "after the send";
        flushSync();
        expect(stored()).toEqual(["after the send"]);
        expect(mocks.alertError).toHaveBeenCalledTimes(1);
    });
});
