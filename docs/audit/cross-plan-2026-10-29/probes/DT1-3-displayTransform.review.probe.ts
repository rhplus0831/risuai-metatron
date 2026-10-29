// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import type { TransformRequest } from "../../../shared/transform.ts";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);
vi.mock("src/ts/translator/translator", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/translator/translator")>()),
    translateHTML: vi.fn(async (html: string) => `<p>Translated: ${html}</p>`),
}));

import { language } from "src/lang";
import { doingAlert } from "src/ts/alert";
import { chatFoldedStateMessageIndex, foldChatToMessage } from "src/ts/globalApi.svelte";
import { displaySettingsItems } from "src/ts/setting/displaySettingsData.svelte";
import { captureTransform, rerenderMessage, serverProcessScript } from "src/ts/parser/transformClient";
import * as serverAuth from "src/ts/storage/serverAuth";
import * as diagnostics from "src/ts/diagnostics/collector";
import { chatCheckpointsDialog } from "src/ts/checkpoints/chatCheckpoints.svelte";
import { runServerButton, runServerJob, runServerManualTrigger } from "src/ts/process/serverCommands";
import { characterList } from "src/ts/storage/characterStore.svelte";
import {
    acceptRemoteChat,
    appendMessage,
    createChat,
    findChat,
    selectChat,
    seedChats,
    setChatMeta,
    setMessageText,
    setMessageTranslation,
    setStreamingState,
} from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import {
    bookmarkListOpen,
    chatBindingDialog,
    createSimpleCharacter,
    openModelPresetList,
    openPersonaList,
    openPresetList,
    ReloadChatPointer,
} from "src/ts/stores.svelte";
import { translateHTML } from "src/ts/translator/translator";
import BookmarkList from "../Others/BookmarkList.svelte";
import Chat from "./Chat.svelte";
import Chats from "./Chats.svelte";

const ref = { chaId: "owner", chatId: "own-chat" };
const otherRef = { chaId: "other", chatId: "other-chat" };
const mounted: ReturnType<typeof mount>[] = [];
const markup = `<input name="draft" value="initial">
    <div risu-btn="lua-action"><b>Run button</b></div>
    <span risu-trigger="manual-action"><b>Run trigger</b></span>
    <form risu-form="survey"><input name="answer" value="initial"><button>Submit</button></form>`;

function target() {
    const element = document.createElement("div");
    document.body.append(element);
    return element;
}

async function settle(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}

function renderChat(message = markup, row: { messageId?: string; idx?: number } = {}) {
    const element = target();
    const instance = mount(Chat, {
        target: element,
        props: {
            chatRef: ref,
            messageId: "message",
            message,
            idx: 0,
            role: "char",
            name: "Owner",
            character: createSimpleCharacter(characterList().find((character) => character.chaId === ref.chaId)),
            isLastMemory: false,
            ...row,
        },
    });
    mounted.push(instance);
    flushSync();
    return {
        element,
        instance,
        remove: async () => {
            mounted.splice(mounted.indexOf(instance), 1);
            await unmount(instance);
            element.remove();
        },
    };
}

function renderChats() {
    const element = target();
    const props = $state({
        messages: findChat(ref)!.message,
        currentCharacter: characterList().find((character) => character.chaId === ref.chaId)!,
        currentUsername: "User",
        userIcon: "",
        onReroll: () => {},
        unReroll: () => {},
        loadPages: 30,
        suspendTrim: false,
        hasNewUnreadMessage: false,
    });
    const instance = mount(Chats, { target: element, props });
    mounted.push(instance);
    flushSync();
    return { element, instance, props };
}

function renderBookmarks() {
    const element = target();
    bookmarkListOpen.set(true);
    mounted.push(mount(BookmarkList, { target: element }));
    flushSync();
    return element;
}

function click(element: Element, selector: string) {
    const control = element.querySelector<HTMLElement>(selector);
    expect(control).not.toBeNull();
    control!.click();
    flushSync();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(doingAlert).mockReturnValue(false);
    vi.mocked(runServerButton).mockResolvedValue("refused");
    vi.mocked(runServerManualTrigger).mockResolvedValue("refused");
    ReloadChatPointer.set({});
    bookmarkListOpen.set(false);
    chatBindingDialog.set(null);
    chatCheckpointsDialog.set(null);
    openPresetList.set(false);
    openModelPresetList.set(false);
    openPersonaList.set(false);
    seedChats([], []);
    installFlatDatabaseWithChats({
        characters: [ref, otherRef].map((address) => ({
            chaId: address.chaId,
            type: "character",
            name: address.chaId,
            image: "",
            firstMessage: "Hello",
            alternateGreetings: [],
            customscript: [],
            emotionImages: [],
            additionalAssets: [],
            triggerscript: [],
            chats: [
                {
                    id: address.chatId,
                    name: address.chatId,
                    note: "",
                    localLore: [],
                    message: [{ role: "char", chatId: "message", data: markup }],
                },
            ],
        })),
        personas: [{ id: "persona", name: "User", personaPrompt: "", icon: "" }],
        botPresets: [{ id: "preset", name: "Preset" }],
        translator: "",
        theme: "standard",
        zoomsize: 100,
        lineHeight: 1.25,
        iconsize: 100,
        clickToEdit: false,
        enableBlockPartialEdit: false,
        enableDragPartialEdit: false,
        autoScrollToNewMessage: false,
        alwaysScrollToNewMessage: false,
    });
    selectChat(ref.chaId, ref.chatId);
    selectChat(otherRef.chaId, otherRef.chatId);
    selectCharacter(ref.chaId);
});

afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    setStreamingState(ref, null);
    document.body.replaceChildren();
    vi.restoreAllMocks();
    // Resets the page-visibility mirror and drains pending display transform retries between tests.
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    flushSync();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("display transform recovery", () => {
    let requests: TransformRequest[];
    let respond: (body: TransformRequest) => Response | Promise<Response>;
    const success = (body: TransformRequest) =>
        Response.json({
            results: body.targets.map((target) => ({
                id: target.id,
                ok: true,
                text: `Rendered: ${target.source}`,
                emotions: [],
                key: target.id,
                cached: false,
            })),
        });
    const setVisible = (visible: boolean) => {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue(visible ? "visible" : "hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        flushSync();
    };
    const generation = () => captureTransform(0)!.generation;

    beforeEach(() => {
        requests = [];
        respond = success;
        // Keep batching on its 16ms fallback so retry boundaries do not depend on frame alignment.
        vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(0);
        setVisible(true);
        window.dispatchEvent(new Event("online"));
        flushSync();
        seedChats([{ characterId: ref.chaId, id: ref.chatId, revision: "r1" }], []);
        vi.spyOn(serverAuth, "authFetch").mockImplementation(async (path, init) => {
            expect(path).toBe("/api/transform");
            const body = JSON.parse(init!.body as string) as TransformRequest;
            requests.push(body);
            return respond(body);
        });
    });

    it("probe: permanent source-size refusal keeps retrying while mounted", async () => {
        const row = renderChat("x".repeat(512 * 1024 + 1));
        const notice = vi.spyOn(diagnostics, "recordClientEvent");
        await settle(16);
        const rounds: number[] = [generation()];
        for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
            await settle(delay);
            await settle(16);
            rounds.push(generation());
        }
        console.log(
            JSON.stringify({
                probe: "permanent-size-refusal",
                rounds,
                requests: requests.length,
                failureNotices: notice.mock.calls.filter(([event]) => event.notice === "transformFailed").length,
                raw: row.element.querySelector(".chattext")!.textContent!.length,
            }),
        );
        expect(rounds.at(-1)! - rounds[0]).toBe(0);
        expect(requests).toHaveLength(0);
    });
    it("probe: an HTTP 400 is retried indefinitely with new requests", async () => {
        respond = () => Response.json({ error: "source cannot be rendered" }, { status: 400 });
        renderChat("Raw reply");
        await settle(16);
        const counts = [requests.length];
        for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
            await settle(delay);
            await settle(16);
            counts.push(requests.length);
        }
        console.log(JSON.stringify({ probe: "400-retry", counts }));
        expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1]);
    });
    it("probe: successful replacement of a failed source in the same generation still retries", async () => {
        respond = () => Response.json({ error: "Unavailable" }, { status: 503 });
        const row = renderChat("Old reply");
        await settle(16);
        const replacement = 'New reply <input name="draft" value="initial">';
        const saved = JSON.parse(JSON.stringify(findChat(ref)!));
        saved.message[0].data = replacement;
        acceptRemoteChat({ characterId: ref.chaId, id: ref.chatId, revision: "r2", data: saved });
        expect(captureTransform(0)!.hadUnackedWork).toBe(false);
        respond = success;
        row.instance.updateRow({ message: replacement });
        flushSync();
        await settle(16);
        const input = row.element.querySelector<HTMLInputElement>('input[name="draft"]')!;
        input.value = "typed after success";
        const before = requests.length;
        await settle(5_000);
        await settle(16);
        const after = row.element.querySelector<HTMLInputElement>('input[name="draft"]')!;
        console.log(
            JSON.stringify({
                probe: "same-generation-replacement",
                before,
                after: requests.length,
                sameInput: input === after,
                value: after.value,
            }),
        );
        expect(after).toBe(input);
        expect(after.value).toBe("typed after success");
    });
});

it("probe: completion behind the full-screen bookmark modal is marked viewed", async () => {
    const status = await import("src/ts/process/chatStatus.svelte");
    const { setChatOpen } = await import("src/ts/storage/selection.svelte");
    const { gridOpenStore, settingsOpen } = await import("src/ts/screenVisibility");
    gridOpenStore.set(false);
    settingsOpen.set(false);
    setChatOpen(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    status.resetChatStatusForTests();
    renderChat("Reply behind modal");
    const modal = renderBookmarks();
    expect(modal.querySelector(".fixed.w-full.h-full")).not.toBeNull();
    status.noteJobDone(ref, { type: "done", epoch: "epoch", revision: "e:1:2", messageId: "new-reply" });
    console.log(
        JSON.stringify({
            probe: "modal-viewed",
            modalOpen: get(bookmarkListOpen),
            visible: status.visibleChatKey(),
            unseen: [...get(status.unseenChatKeys)],
        }),
    );
    expect([...get(status.unseenChatKeys)]).toContain(status.chatStatusKey(ref));
});
