// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Chat as ChatRecord } from "../../../shared/database.ts";
import { runRegexScripts } from "../../../shared/scripts/regex.ts";
import type { TransformContinueRequest, TransformRequest, TransformResponse } from "../../../shared/transform.ts";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import * as globalApi from "src/ts/globalApi.svelte";
import { pluginHooks } from "src/ts/plugins/pluginHooks";
import { characterList } from "src/ts/storage/characterStore.svelte";
import {
    acceptRemoteChat,
    ackChatWork,
    applyServerGeneration,
    chatHasUnackedWork,
    chatInstallVersion,
    endServerJob,
    findChat,
    quarantineChat,
    refusedChatItems,
    retryRefusedChat,
    seedChats,
    selectChat,
    setMessageText,
    takeChatWork,
    type ChatWork,
} from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import * as serverAuth from "src/ts/storage/serverAuth";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { createSimpleCharacter, ReloadGUIPointer } from "src/ts/stores.svelte";
import Chat from "./Chat.svelte";
import ChatBody from "./ChatBody.svelte";

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

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

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

function render(id = "row") {
    const index = findChat(ref)!.message.findIndex((message) => message.chatId === id);
    const target = document.createElement("div");
    document.body.append(target);
    const instance = mount(Chat, {
        target,
        props: {
            chatRef: ref,
            messageId: id,
            message: findChat(ref)!.message[index].data,
            idx: index,
            role: "char",
            name: "Owner",
            character: createSimpleCharacter(characterList()[0]),
            isLastMemory: false,
        },
    });
    mounted.push(instance);
    flushSync();
    return {
        text: () => target.querySelector(".chattext")?.textContent?.trim(),
        remove: async () => {
            mounted.splice(mounted.indexOf(instance), 1);
            await unmount(instance);
            target.remove();
        },
    };
}

function acknowledge(work = takeChatWork(new Set())) {
    stored = clone(findChat(ref)!) as ChatRecord;
    storedVersion += 1;
    ackChatWork(
        work,
        work.groups.map((group) => ({
            characterId: group.characterId,
            id: group.chatId,
            revision: revision(storedVersion),
        })),
        [],
    );
}

function remoteAppend(id: string) {
    stored.message.push({ role: "user", chatId: id, data: id });
    storedVersion += 1;
    acceptRemoteChat({
        characterId: ref.chaId,
        id: ref.chatId,
        revision: revision(storedVersion),
        data: clone(stored),
    });
}

const targets = (id = "row") =>
    requests.flatMap((request) => request.targets).filter((target) => target.messageId === id);

beforeEach(() => {
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
            { role: "user", chatId: "peer", data: "[peer]" },
            { role: "char", chatId: "stream", data: "[stream]" },
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
    endServerJob("streaming-job");
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("settled display renders", () => {
    it("renders an unsaved edit once more with stored history after acknowledgment, through the cache", async () => {
        const initialVersion = chatInstallVersion(ref);
        let observedVersion = initialVersion;
        let observedUnacked = false;
        onTestFinished(
            $effect.root(() => {
                $effect(() => {
                    observedVersion = chatInstallVersion(ref);
                });
                $effect(() => {
                    observedUnacked = chatHasUnackedWork(ref);
                });
            }),
        );
        flushSync();
        setMessageText(ref, "history", "[saved history]");
        setMessageText(ref, "row", "[edited row]");
        const row = render();
        await settle(16);
        expect(row.text()).toBe("[edited row][stored history]");
        expect(observedUnacked).toBe(true);
        expect(observedVersion).toBe(initialVersion);
        await drain();
        expect(targets()).toHaveLength(1);

        const work = takeChatWork(new Set());
        await drain();
        expect(targets()).toHaveLength(1);
        acknowledge(work);
        await drain();
        expect(observedUnacked).toBe(false);
        expect(observedVersion).toBe(initialVersion + 1);
        expect(row.text()).toBe("[edited row][saved history]");
        expect(targets()).toHaveLength(2);
        expect(targets().map((target) => target.noCache)).toEqual([undefined, undefined]);
        await drain();
        expect(targets()).toHaveLength(2);
    });

    it.each(["first answer", "plugin continuation"])(
        "renders once more when acknowledgment and a remote append arrive before the %s",
        async (gap) => {
            const release = deferred<void>();
            if (gap === "first answer") {
                answer = async (_body, result) => {
                    await release.promise;
                    return Response.json(result);
                };
            } else {
                pluginHooks.editdisplay.add(async (text) => {
                    await release.promise;
                    return text;
                });
            }
            const row = render();
            await settle(16);
            expect(targets()).toHaveLength(1);
            expect(continuations).toHaveLength(0);
            // The clean render has already loaded the old server transcript. Neither change alters its source.
            setMessageText(ref, "history", "[saved history]");
            acknowledge();
            remoteAppend("remote");
            await drain();
            expect(targets()).toHaveLength(1);

            release.resolve();
            await settle();
            expect(row.text()).toBe("[row][stored history]");
            await drain();
            expect(row.text()).toBe("[row][saved history]");
            expect(targets()).toHaveLength(2);
            expect(targets().every((target) => target.noCache === undefined)).toBe(true);
            expect(continuations).toHaveLength(gap === "plugin continuation" ? 2 : 0);
            await drain();
            expect(targets()).toHaveLength(2);
        },
    );

    it("keeps a completed row waiting for another message's lock and renders once on unlock without an append", async () => {
        setMessageText(ref, "history", "[saved history]");
        applyServerGeneration(ref, {
            jobId: "streaming-job",
            messageId: "stream",
            generationId: "generation",
            text: "streaming",
            seq: 0,
        });
        const row = render();
        await settle(16);
        acknowledge();
        await drain();
        expect(row.text()).toBe("[row][stored history]");
        expect(targets()).toHaveLength(1);

        endServerJob("streaming-job");
        await drain();
        expect(row.text()).toBe("[row][saved history]");
        expect(targets()).toHaveLength(2);
        await drain();
        expect(targets()).toHaveLength(2);
    });

    it("coalesces reports from every affected mounted row and several installs before the drain", async () => {
        setMessageText(ref, "history", "[saved history]");
        const row = render();
        const peer = render("peer");
        await settle(16);
        expect(targets()).toHaveLength(1);
        expect(targets("peer")).toHaveLength(1);

        acknowledge();
        flushSync();
        remoteAppend("remote-one");
        flushSync();
        remoteAppend("remote-two");
        flushSync();
        expect(targets()).toHaveLength(1);
        await drain();
        expect(row.text()).toBe("[row][saved history]");
        expect(peer.text()).toBe("[peer][saved history]");
        expect(targets()).toHaveLength(2);
        expect(targets("peer")).toHaveLength(2);
        await drain();
        expect(targets()).toHaveLength(2);
        expect(targets("peer")).toHaveLength(2);
    });

    it("keeps a quarantined row waiting through retry until its work is acknowledged", async () => {
        setMessageText(ref, "history", "[saved history]");
        const row = render();
        await settle(16);
        const work: ChatWork = takeChatWork(new Set());
        quarantineChat(work.groups[0], "refused");
        await drain();
        expect(targets()).toHaveLength(1);
        expect(row.text()).toBe("[row][stored history]");

        expect(retryRefusedChat(refusedChatItems().find((item) => item.chaId === ref.chaId)!.key)).toBe(true);
        await drain();
        expect(targets()).toHaveLength(1);
        acknowledge();
        await drain();
        expect(row.text()).toBe("[row][saved history]");
        expect(targets()).toHaveLength(2);
        await drain();
        expect(targets()).toHaveLength(2);
    });

    it("does not render a row whose answer finished before the unacknowledged-work window", async () => {
        const row = render();
        await settle(16);
        expect(row.text()).toBe("[row][stored history]");
        setMessageText(ref, "history", "[saved history]");
        const affected = render("peer");
        await settle(16);
        acknowledge();
        remoteAppend("remote");
        await drain();
        expect(targets("peer")).toHaveLength(2);
        expect(affected.text()).toBe("[peer][saved history]");
        expect(targets()).toHaveLength(1);
        expect(row.text()).toBe("[row][stored history]");
        await drain();
        expect(targets()).toHaveLength(1);
    });
});

describe("confirmed text on remount", () => {
    async function warm() {
        const row = render();
        await settle(16);
        expect(row.text()).toBe("[row][stored history]");
        await row.remove();
        // The real chat switch reset retains confirmed text but fences the outgoing renders.
        ReloadGUIPointer.update((value) => value + 1);
    }

    it("shows confirmed text while a remount's same answer is held and downloads no replacement text", async () => {
        await warm();
        const release = deferred<void>();
        answer = async (body) => {
            await release.promise;
            return Response.json({
                results: [],
                same: body.targets.map((target) => ({ id: target.id, key: target.knownKey })),
            });
        };
        const row = render();
        await settle(16);
        expect(targets()).toHaveLength(2);
        expect(targets()[1].knownKey).toBe("1/row/[row]");
        expect(row.text()).toBe("[row][stored history]");
        release.resolve();
        await drain();
        expect(row.text()).toBe("[row][stored history]");
        expect(targets()).toHaveLength(2);
    });

    it("replaces provisional text with a differing full answer without requesting it again", async () => {
        await warm();
        const release = deferred<void>();
        answer = async (_body, result) => {
            await release.promise;
            return Response.json({
                results: result.results.map((entry) => ({ ...entry, text: "**Updated display**", key: "updated" })),
            });
        };
        const row = render();
        await settle(16);
        expect(row.text()).toBe("[row][stored history]");
        release.resolve();
        await drain();
        expect(row.text()).toBe("Updated display");
        expect(targets()).toHaveLength(2);

        await row.remove();
        answer = (body) =>
            Response.json({
                results: [],
                same: body.targets.map((target) => ({ id: target.id, key: target.knownKey })),
            });
        const remounted = render();
        await settle(16);
        expect(targets().at(-1)!.knownKey).toBe("updated");
        expect(remounted.text()).toBe("Updated display");
    });

    it.each([
        "an install during the correction's asset wait",
        "an install before the correction captures",
        "unacknowledged work when the correction captures",
        "no intervening work",
    ])("settles a handed-off answer with %s", async (gap) => {
        const assetEntered = deferred<void>();
        const assetRelease = deferred<void>();
        let holdAsset = false;
        vi.spyOn(globalApi, "getFileSrc").mockImplementation(async () => {
            if (holdAsset) {
                holdAsset = false;
                assetEntered.resolve();
                await assetRelease.promise;
            }
            return "data:image/png;base64,AA==";
        });
        characterList()[0].image = "assets/owner.png";
        setMessageText(ref, "row", '<img src="{{source::char}}">[row]');
        acknowledge();
        await warm();

        const answerRelease = deferred<void>();
        answer = async (_body, result) => {
            await answerRelease.promise;
            return Response.json({
                results: result.results.map((entry) => ({
                    ...entry,
                    text: entry.ok ? entry.text.replace("[stored history]", "[intermediate history]") : "",
                    key: "intermediate",
                })),
            });
        };
        const row = render();
        await settle(16);
        expect(row.text()).toBe("[row][stored history]");
        expect(targets()).toHaveLength(2);
        const initialVersion = chatInstallVersion(ref);
        holdAsset = true;

        if (
            gap === "an install before the correction captures" ||
            gap === "unacknowledged work when the correction captures"
        ) {
            // Hold the scheduled Svelte correction after the transport answer completes, before
            // it can capture. Promise continuations still run; no product function is replaced.
            const tasks: VoidFunction[] = [];
            const scheduler = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
                tasks.push(task);
            });
            answerRelease.resolve();
            // Drain the transport promises while the queued render tasks remain held.
            await vi.advanceTimersByTimeAsync(0);
            setMessageText(ref, "history", "[saved history]");
            if (gap === "an install before the correction captures") acknowledge();
            scheduler.mockRestore();
            for (const task of tasks) queueMicrotask(task);
        } else {
            answerRelease.resolve();
        }
        await assetEntered.promise;
        if (gap === "an install during the correction's asset wait") {
            expect(chatInstallVersion(ref)).toBe(initialVersion);
            setMessageText(ref, "history", "[saved history]");
            acknowledge();
        }
        answer = (_body, result) => Response.json(result);
        assetRelease.resolve();
        await settle();
        // The handoff itself must not issue a request, even when it reports mixed state.
        expect(row.text()).toBe("[row][intermediate history]");
        expect(targets()).toHaveLength(2);

        if (gap === "unacknowledged work when the correction captures") {
            expect(chatInstallVersion(ref)).toBe(initialVersion);
            expect(chatHasUnackedWork(ref)).toBe(true);
            await drain();
            expect(targets()).toHaveLength(2);
            acknowledge();
        }
        const changed = gap !== "no intervening work";
        expect(chatInstallVersion(ref)).toBe(initialVersion + Number(changed));
        expect(chatHasUnackedWork(ref)).toBe(false);
        await drain();
        expect(row.text()).toBe(changed ? "[row][saved history]" : "[row][intermediate history]");
        expect(targets()).toHaveLength(changed ? 3 : 2);
        await drain();
        expect(targets()).toHaveLength(changed ? 3 : 2);
    });

    it("shows the raw input when a provisional answer fails without another correction request", async () => {
        await warm();
        const release = deferred<void>();
        answer = async () => {
            await release.promise;
            return Response.json({ error: "Unavailable" }, { status: 503 });
        };
        const row = render();
        await settle(16);
        expect(row.text()).toBe("[row][stored history]");
        release.resolve();
        await drain();
        expect(row.text()).toBe("[row]");
        expect(targets()).toHaveLength(2);
    });

    it("waits for the confirmed transform before using cached display text as a translation input", async () => {
        await warm();
        settings.memoryTranslateMedia.translatorType = "google";
        settings.memoryTranslateMedia.legacyTranslation = true;
        settings.memoryTranslateMedia.translateBeforeHTMLFormatting = false;
        settings.memoryTranslateMedia.useExperimentalGoogleTranslator = false;
        settings.memoryTranslateMedia.combineTranslation = false;
        const translatedInputs: string[] = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = new URL(String(input));
            expect(url.hostname).toBe("translate.googleapis.com");
            translatedInputs.push(url.searchParams.get("q")!);
            return Response.json([[["Translated fresh display"]]]);
        });
        const release = deferred<void>();
        answer = async (_body, result) => {
            await release.promise;
            return Response.json({
                results: result.results.map((entry) => ({
                    ...entry,
                    text: "Fresh translation input",
                    key: "fresh-input",
                })),
            });
        };
        const target = document.createElement("div");
        document.body.append(target);
        const instance = mount(ChatBody, {
            target,
            props: {
                character: createSimpleCharacter(characterList()[0]),
                idx: 1,
                msgDisplay: "[row]",
                role: "char",
                translated: true,
                autoTranslate: true,
                translating: false,
                retranslate: false,
            },
        });
        mounted.push(instance);
        await settle(16);
        expect(targets()).toHaveLength(2);
        expect(targets()[1].knownKey).toBe("1/row/[row]");
        expect(translatedInputs).toEqual([]);
        release.resolve();
        await drain();
        await instance.whenRendered();
        expect(translatedInputs.map((text) => text.trim())).toEqual(["Fresh translation input"]);
        expect(target.textContent?.trim()).toBe("Translated fresh display");
    });

    it("requests settled state for both same and replaced provisional answers when the chat moved while they waited", async () => {
        const initial = [render(), render("peer")];
        await settle(16);
        expect(initial.map((row) => row.text())).toEqual(["[row][stored history]", "[peer][stored history]"]);
        for (const row of initial) await row.remove();
        const release = deferred<void>();
        answer = async (body, result) => {
            await release.promise;
            return Response.json({
                results: result.results
                    .filter((entry) => body.targets.find((t) => t.id === entry.id)?.messageId === "peer")
                    .map((entry) => ({ ...entry, text: "[peer][intermediate history]", key: "intermediate" })),
                same: body.targets
                    .filter((target) => target.messageId === "row")
                    .map((target) => ({ id: target.id, key: target.knownKey })),
            });
        };
        const row = render();
        const peer = render("peer");
        await settle(16);
        expect(row.text()).toBe("[row][stored history]");
        expect(peer.text()).toBe("[peer][stored history]");
        setMessageText(ref, "history", "[saved history]");
        acknowledge();
        remoteAppend("remote");
        await drain();
        expect(targets()).toHaveLength(2);
        expect(targets("peer")).toHaveLength(2);

        answer = (_body, result) => Response.json(result);
        release.resolve();
        await drain();
        expect(row.text()).toBe("[row][saved history]");
        expect(peer.text()).toBe("[peer][saved history]");
        expect(targets()).toHaveLength(3);
        expect(targets("peer")).toHaveLength(3);
        await drain();
        expect(targets()).toHaveLength(3);
        expect(targets("peer")).toHaveLength(3);
    });
});
