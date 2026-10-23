// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `Suggestion.svelte` over the real chat module, selection, and local send registry
// (`chat-pipeline.md`, "Not in `sendChat`"): opened while no send runs, it requests suggestions for
// the selected chat; a send's start cancels and clears only its own chat's suggestions; a send's end
// requests for its chat when that chat is selected, else queues the chat for its next selection; a
// send without a chat requests for the selected chat when it ends. The request (`requestChatData`)
// is a stand-in that records the chat it was for and answers when the test says.

const mocks = vi.hoisted(() => ({
    requests: [] as { chat: string; signal: AbortSignal | null; answer: (result: string) => void }[],
}));

vi.mock("src/ts/process/request/request", () => ({
    requestChatData: vi.fn(
        (arg: { formated: { content: string }[] }, _mode: string, signal: AbortSignal | null) =>
            new Promise((resolve) => {
                mocks.requests.push({
                    // The prompt lists the chat's last messages: "User:hello from <chat>,...".
                    chat: /hello from (\w+)/.exec(arg.formated[1].content)?.[1] ?? "?",
                    signal,
                    answer: (result: string) => resolve({ type: "success", result }),
                });
            }),
    ),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/model/modellist", () => ({ getModelInfoForMode: vi.fn(() => ({ id: "gpt-test" })) }));
vi.mock("src/ts/parser/parser.svelte", () => ({ ParseMarkdown: vi.fn(async (text: string) => text) }));
vi.mock("src/ts/translator/translator", () => ({ translate: vi.fn(async (text: string) => text) }));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

import { language } from "src/lang";
import { beginLocalSend } from "src/ts/process/localSends";
import { findChat, selectChat, setChatMeta, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import Suggestion from "./Suggestion.svelte";

const chatK: ChatRef = { chaId: "c", chatId: "k" };
const chatN: ChatRef = { chaId: "c", chatId: "n" };
const mounted: ReturnType<typeof mount>[] = [];
const releases: (() => void)[] = [];
let target: HTMLElement;

const message = (chatId: string, role: "user" | "char", data: string) => ({ chatId, role, data });
/** The chats the requests so far were for, in order. */
const requested = () => mocks.requests.map((request) => request.chat);
const stored = (ref: ChatRef) => findChat(ref)?.suggestMessages;
const buttons = () => target.querySelectorAll("button").length;
const creating = () => target.textContent?.includes(language.creatingSuggestions) ?? false;

/** A send of `ref` (null: without a chat) begun on the registry, released at the test's end at the latest. */
function send(ref: ChatRef | null) {
    const release = beginLocalSend(ref);
    expect(release).not.toBeNull();
    releases.push(release!);
    return () => {
        release!();
        flushSync();
    };
}
function select(ref: ChatRef) {
    selectChat(ref.chaId, ref.chatId);
    flushSync();
}
function open() {
    mounted.push(mount(Suggestion, { target, props: { send: vi.fn(), messageInput: vi.fn() } }));
    flushSync();
}
/** Answers the request at `index` and lets its result land. */
async function answer(index: number, result = "- one\n- two") {
    mocks.requests[index].answer(result);
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
    flushSync();
}

beforeEach(() => {
    mocks.requests.length = 0;
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chatPage: 0,
                chats: [
                    { id: "k", name: "K", note: "", localLore: [], message: [message("k1", "user", "hello from k")] },
                    { id: "n", name: "N", note: "", localLore: [], message: [message("n1", "user", "hello from n")] },
                ],
            },
        ],
    } as any);
    selectCharacter("c");
    select(chatK);
    // No translator: the controls are the refresh button and two buttons per suggestion.
    settings.memoryTranslateMedia.translator = "";
    target = document.createElement("div");
    document.body.appendChild(target);
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    for (const release of releases.splice(0)) {
        release();
    }
    document.body.replaceChildren();
});

describe("Suggestion's requests follow the local sends per chat", () => {
    it("opened while no send runs, requests for the selected chat and shows the result stored on it", async () => {
        open();
        expect(requested()).toEqual(["k"]);
        expect(creating()).toBe(true);
        expect(buttons()).toBe(0);

        await answer(0);
        expect(stored(chatK)).toEqual(["one", "two"]);
        expect(stored(chatN)).toBeUndefined();
        expect(creating()).toBe(false);
        // The refresh button and two buttons per suggestion.
        expect(buttons()).toBe(5);
    });

    it("opened while the selected chat sends, waits for that send's end to request", () => {
        const end = send(chatK);
        open();
        expect(requested()).toEqual([]);
        expect(buttons()).toBe(0);

        end();
        expect(requested()).toEqual(["k"]);
    });

    it("opened while another chat sends, requests nothing until that chat is selected after its send", () => {
        const end = send(chatN);
        open();
        expect(requested()).toEqual([]);
        // The selected chat is not sending: its controls show.
        expect(buttons()).toBe(1);

        end();
        expect(requested()).toEqual([]);
        select(chatN);
        expect(requested()).toEqual(["n"]);
        // A chat selected without a queued request gets none.
        select(chatK);
        expect(requested()).toEqual(["n"]);
    });

    it("opened while a send without a chat runs, requests for the selected chat when it ends", () => {
        const end = send(null);
        open();
        expect(requested()).toEqual([]);
        expect(buttons()).toBe(1);

        end();
        expect(requested()).toEqual(["k"]);
    });

    it.each([
        { first: "the selected chat", order: [chatK, chatN] },
        { first: "the background chat", order: [chatN, chatK] },
    ])("with two sends ending, $first first, each end requests or queues for its own chat", async ({ order }) => {
        open();
        await answer(0);
        setChatMeta(chatN, { suggestMessages: ["kept"] });
        expect(stored(chatK)).toEqual(["one", "two"]);

        // Each start clears its own chat's suggestions only.
        const ends = new Map<ChatRef, () => void>([[chatK, send(chatK)]]);
        flushSync();
        expect(stored(chatK)).toEqual([]);
        expect(stored(chatN)).toEqual(["kept"]);
        expect(buttons()).toBe(0);
        ends.set(chatN, send(chatN));
        flushSync();
        expect(stored(chatN)).toEqual([]);
        expect(requested()).toEqual(["k"]);

        ends.get(order[0])!();
        ends.get(order[1])!();
        // The selected chat's end requested for it, whether or not the other send was still running.
        expect(requested()).toEqual(["k", "k"]);
        expect(buttons()).toBe(0);
        expect(creating()).toBe(true);
        // The background chat's end queued it: selected, it requests for itself.
        select(chatN);
        expect(requested()).toEqual(["k", "k", "n"]);
    });

    it("a send's start cancels the running request for its chat, whose late answer is dropped", async () => {
        open();
        expect(requested()).toEqual(["k"]);
        const end = send(chatK);
        flushSync();
        expect(mocks.requests[0].signal?.aborted).toBe(true);
        expect(creating()).toBe(false);

        await answer(0);
        // The start stored the empty list; the cancelled request's answer did not land.
        expect(stored(chatK)).toEqual([]);
        end();
        expect(requested()).toEqual(["k", "k"]);
        await answer(1, "- late");
        expect(stored(chatK)).toEqual(["late"]);
    });

    it("another chat's send start leaves the selected chat's request and suggestions alone", async () => {
        open();
        const end = send(chatN);
        flushSync();
        expect(mocks.requests[0].signal?.aborted).toBe(false);
        await answer(0);
        expect(stored(chatK)).toEqual(["one", "two"]);
        expect(buttons()).toBe(5);
        end();
        expect(requested()).toEqual(["k"]);
    });
});
