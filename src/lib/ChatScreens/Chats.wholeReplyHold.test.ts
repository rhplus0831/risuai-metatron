// @vitest-environment happy-dom

// The transcript keeps a whole reply held (`Chat.svelte`'s `held`) through the real chat store and job events: a
// Half Streaming continue keeps showing the reply it extends, and a feed observer holds the row across a remount.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Chat as ChatRecord } from "../../../shared/database.ts";
import { runRegexScripts } from "../../../shared/scripts/regex.ts";
import type { TransformContinueRequest, TransformRequest, TransformResponse } from "../../../shared/transform.ts";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { pluginHooks } from "src/ts/plugins/pluginHooks";
import { characterList } from "src/ts/storage/characterStore.svelte";
import {
    endServerJob,
    findChat,
    isMessageLocked,
    isMessageStreamed,
    noteRemoteChat,
    noteRemoteStreaming,
    replaceFeedLocks,
    seedChats,
    selectChat,
    streamingEntry,
} from "src/ts/storage/chatStore.svelte";
import { setResourceEpoch } from "src/ts/storage/resourceClient";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import * as serverAuth from "src/ts/storage/serverAuth";
import { applyGenerationEvent } from "src/ts/network/generationJobs";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import Chats from "./Chats.svelte";

const epoch = "00000000-0000-0000-0000-000000000000";
const revision = (n: number) => `${epoch}:1:${n}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const mounted: ReturnType<typeof mount>[] = [];
let counter = 0;
let ref: { chaId: string; chatId: string };
let stored: ChatRecord;
let storedVersion: number;
let requests: TransformRequest[];
let continuations: TransformContinueRequest[];
let answer: (body: TransformRequest, result: TransformResponse) => Response | Promise<Response>;

// Only the transport runs this script, against its detached stored transcript. The real browser
// CBS pre-pass and markdown parser cannot manufacture the history suffix asserted below.
function serverDisplay(body: TransformRequest): TransformResponse {
    return {
        results: body.targets.map((target) => ({
            id: target.id,
            ok: true,
            text: runRegexScripts(
                target.source,
                [
                    {
                        in: "\\[(?:stored|saved) history\\]",
                        out: "@@repeat_back end",
                        type: "editdisplay",
                        comment: "stored history",
                    },
                ],
                {
                    mode: "editdisplay",
                    chatID: target.chatIndex,
                    parse: (text) => text,
                    repeatBackSource: () => {
                        const role = stored.message[target.chatIndex].role;
                        return (
                            stored.message.slice(0, target.chatIndex).findLast((message) => message.role === role) ??
                            stored.message[0]
                        ).data;
                    },
                },
            ).data,
            emotions: [],
            key: `${storedVersion}/${target.messageId}/${target.source}`,
            cached: false,
        })),
    };
}

async function settle(ms = 0) {
    flushSync();
    await vi.advanceTimersByTimeAsync(ms);
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}

// Two controlled frames allow the settled-chat drain and the resulting transform batch to run.
async function drain() {
    await settle(16);
    await settle(16);
    await settle();
}

const targets = (id = "row") =>
    requests.flatMap((request) => request.targets).filter((target) => target.messageId === id);

beforeEach(() => {
    setResourceEpoch(epoch);
    vi.useFakeTimers();
    // Both transform batching and settle draining use their fake 16 ms fallback; no real frames race them.
    vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(0);
    ref = { chaId: `owner-${++counter}`, chatId: `chat-${counter}` };
    storedVersion = 1;
    stored = {
        id: ref.chatId,
        name: "Chat",
        note: "",
        localLore: [],
        message: [
            { role: "char", chatId: "history", data: "[stored history]" },
            { role: "char", chatId: "row", data: "[row]" },
        ],
    };
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: ref.chaId,
                type: "character",
                name: "Owner",
                image: "",
                firstMessage: "Hello",
                alternateGreetings: [],
                customscript: [],
                triggerscript: [],
                emotionImages: [],
                additionalAssets: [],
                chats: [clone(stored)],
            },
        ],
        personas: [{ id: "persona", name: "User", personaPrompt: "", icon: "" }],
        botPresets: [{ id: "preset", name: "Preset" }],
        translator: "",
        useStreaming: false,
        halfStreaming: true,
        streamingDisplayOptimizationMode: "off",
        theme: "standard",
        zoomsize: 100,
        lineHeight: 1.25,
        iconsize: 100,
        clickToEdit: false,
        enableBlockPartialEdit: false,
        enableDragPartialEdit: false,
    });
    seedChats(
        [{ characterId: ref.chaId, id: ref.chatId, revision: revision(1) }],
        [{ characterId: ref.chaId, revision: revision(1), ids: [ref.chatId] }],
    );
    selectChat(ref.chaId, ref.chatId);
    selectCharacter(ref.chaId);
    requests = [];
    continuations = [];
    answer = (_body, result) => Response.json(result);
    const snapshots = new Map<string, TransformResponse>();
    vi.spyOn(serverAuth, "authFetch").mockImplementation(async (path, init) => {
        if (path === "/api/transform/continue") {
            const body = JSON.parse(init!.body as string) as TransformContinueRequest;
            continuations.push(body);
            return Response.json(snapshots.get(body.snapshotId)!);
        }
        expect(path).toBe("/api/transform");
        const body = JSON.parse(init!.body as string) as TransformRequest;
        expect(body.mode).toBe("editdisplay");
        requests.push(body);
        const result = serverDisplay(body);
        if (body.handlers) {
            const snapshotId = `snapshot-${requests.length}`;
            snapshots.set(snapshotId, result);
            return answer(body, {
                results: [],
                snapshotId,
                pending: body.targets.map((target) => ({ id: target.id, text: target.source })),
            });
        }
        return answer(body, result);
    });
});

afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    pluginHooks.editdisplay.clear();
    endServerJob("continue-job");
    replaceFeedLocks([]);
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
});

function renderTranscript() {
    const scroller = document.createElement("div");
    document.body.append(scroller);
    const instance = mount(Chats, {
        target: scroller,
        props: {
            get messages() {
                return findChat(ref)!.message;
            },
            currentCharacter: characterList()[0],
            currentUsername: "User",
            userIcon: "",
            onReroll: () => {},
            unReroll: () => {},
            loadPages: 6,
        },
    });
    mounted.push(instance);
    flushSync();
    const body = () => scroller.querySelector('[data-chat-id="row"] .chattext');
    return {
        body,
        text: () => body()?.textContent?.trim(),
        spinner: () => !!body()?.querySelector('[style*="animation: spin"]'),
        remove: async () => {
            mounted.splice(mounted.indexOf(instance), 1);
            await unmount(instance);
            scroller.remove();
        },
    };
}

it("keeps a Half Streaming continue's previous reply in the same body until its transformed final row", async () => {
    const transcript = renderTranscript();
    await settle(1200); // Let the normal opening reveal finish before the reader starts Continue.
    const previousBody = transcript.body();
    expect(previousBody?.closest(".chat-row-pending")).toBeNull();
    const previousText = transcript.text();
    expect(previousText).toBe("[row][stored history]");

    const jobId = "continue-job";
    const generationId = `continue-${counter}`;
    const dispatch = (event: Parameters<typeof applyGenerationEvent>[2]) => applyGenerationEvent(jobId, ref, event);
    const lock = [{ messageId: "row", generationId, seq: 0 }];
    storedVersion = 2;
    dispatch({
        type: "chatPatch",
        epoch,
        characterId: ref.chaId,
        id: ref.chatId,
        baseRevision: revision(1),
        revision: revision(2),
        count: 2,
        streaming: lock,
    });
    await drain();
    expect(transcript.text()).toBe(previousText);
    expect(transcript.body()).toBe(previousBody);
    expect(isMessageLocked(ref, "row")).toBe(true);
    expect(streamingEntry(ref)).toBeNull();

    // The server sends accepted with the unchanged prefix, before assembling/requesting the reply.
    dispatch({ type: "accepted", epoch, jobId, messageId: "row", generationId, revision: revision(2), text: "[row]" });
    await drain();
    expect(isMessageLocked(ref, "row")).toBe(true);
    expect(isMessageStreamed(ref, "row")).toBe(false);
    expect(streamingEntry(ref)?.messageId).toBe("row");
    expect(transcript.body()).toBe(previousBody);
    expect(transcript.text()).toBe(previousText);
    expect(transcript.spinner()).toBe(false);

    const tail = (version: number, data: string, streaming: typeof lock) => {
        storedVersion = version;
        stored.message[1].data = data;
        dispatch({
            type: "chatPatch",
            epoch,
            characterId: ref.chaId,
            id: ref.chatId,
            baseRevision: revision(version - 1),
            revision: revision(version),
            count: 2,
            messages: [{ after: "history", message: clone(stored.message[1]) }],
            streaming,
        });
    };
    tail(3, "raw continuation", lock);
    await drain();
    expect(findChat(ref)!.message[1].data).toBe("raw continuation");
    expect(transcript.body()).toBe(previousBody);
    expect(transcript.text()).toBe(previousText);
    tail(4, "processed continuation", []);
    await drain();
    expect(isMessageLocked(ref, "row")).toBe(false);
    expect(transcript.text()).toBe("processed continuation[stored history]");
    expect(targets().map((target) => target.source)).toEqual(["[row]", "processed continuation"]);
});

it("holds an observer's whole reply across a hello and a remount and transforms its final feed row", async () => {
    const generationId = `observer-${counter}`;
    const lock = [{ messageId: "row", generationId, seq: 0 }];
    const update = (data: string, streaming: typeof lock) => {
        const baseRevision = revision(storedVersion);
        storedVersion += 1;
        stored.message[1].data = data;
        expect(
            noteRemoteChat(ref, revision(storedVersion), {
                baseRevision,
                count: 2,
                messages: [{ after: "history", message: clone(stored.message[1]) }],
            }),
        ).toBe("ignored");
        noteRemoteStreaming([{ characterId: ref.chaId, id: ref.chatId, streaming }]);
    };

    update("raw observer reply", lock);
    const first = renderTranscript();
    await drain();
    expect(first.spinner()).toBe(true);
    expect(targets()).toHaveLength(0);
    expect(streamingEntry(ref)).toBeNull();

    await first.remove();
    replaceFeedLocks([{ characterId: ref.chaId, id: ref.chatId, revision: revision(storedVersion), streaming: lock }]);
    const second = renderTranscript();
    await drain();
    expect(second.spinner()).toBe(true);
    expect(targets()).toHaveLength(0);

    update("processed observer reply", []);
    await drain();
    expect(second.spinner()).toBe(false);
    expect(second.text()).toBe("processed observer reply[stored history]");
    expect(targets()).toHaveLength(1);
});
