// @vitest-environment happy-dom
import { flushSync } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatLoreOverride, loreBook } from "../../../../shared/database.ts";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);

import { language } from "src/lang";
import { alertError } from "src/ts/alert";
import { chatStatusKey } from "src/ts/process/chatStatus.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
import { followedJobs } from "src/ts/process/serverCommands";
import { findChat, selectChat, setChatMeta, setChatWorkListener, type ChatRef } from "../chatStore.svelte";
import { useLoreOverridesDraft } from "../loreOverridesDraft.svelte";
import { useLocalLoreDraft } from "../localLoreDraft.svelte";
import { selectCharacter } from "../selection.svelte";
import { installFlatDatabaseWithChats } from "./installFlatDatabase";

const ref: ChatRef = { chaId: "owner", chatId: "chat" };
const other: ChatRef = { chaId: "owner", chatId: "other" };
const entry = (id: string, content: string): loreBook => ({
    id,
    content,
    key: id,
    comment: id,
    secondkey: "",
    insertorder: 100,
    mode: "normal",
    alwaysActive: false,
    selective: false,
});
const original = entry("dragon", "Original prompt");
const pinned: ChatLoreOverride = { entry: { ...original, content: "Pinned prompt" }, off: false };
const local = entry("local", "Local prompt");
const stored = () => findChat(ref)!;
const writes = vi.fn();
const releases: (() => void)[] = [];

function install(overrides?: ChatLoreOverride[]) {
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: ref.chaId,
                type: "character",
                name: "Owner",
                globalLore: [original],
                chats: [ref, other].map(({ chatId }) => ({
                    id: chatId,
                    name: chatId,
                    note: "",
                    message: [],
                    localLore: [local],
                    ...(chatId === ref.chatId && overrides !== undefined ? { loreOverrides: overrides } : {}),
                })),
            },
        ],
    });
    selectCharacter(ref.chaId);
    selectChat(ref.chaId, ref.chatId);
    flushSync();
    writes.mockClear();
    setChatWorkListener(writes);
}
function fence(kind: "local send" | "followed job", target: ChatRef) {
    const release =
        kind === "local send"
            ? beginLocalSend(target)!
            : (followedJobs.set(new Map([["job", chatStatusKey(target)]])), () => followedJobs.set(new Map()));
    releases.push(release);
    flushSync();
    return () => {
        release();
        flushSync();
    };
}

beforeEach(() => {
    vi.mocked(alertError).mockClear();
    followedJobs.set(new Map());
});
afterEach(() => {
    setChatWorkListener(null);
    for (const release of releases.splice(0)) release();
    followedJobs.set(new Map());
    flushSync();
});

it("syncs an absent field without creating it, including chat switches and unrelated metadata writes", () => {
    install();
    const draft = useLoreOverridesDraft();
    flushSync();
    expect(draft.value).toEqual([]);
    expect(stored()).not.toHaveProperty("loreOverrides");
    expect(writes).not.toHaveBeenCalled();
    setChatMeta(ref, { note: "Unrelated edit" });
    flushSync();
    expect(writes).toHaveBeenCalledOnce();
    expect(stored()).not.toHaveProperty("loreOverrides");

    setChatMeta(ref, { loreOverrides: [pinned] });
    flushSync();
    writes.mockClear();
    expect(draft.value).toEqual([pinned]);
    selectChat(other.chaId, other.chatId);
    flushSync();
    expect(draft.value).toEqual([]);
    expect(findChat(other)!).not.toHaveProperty("loreOverrides");
    selectChat(ref.chaId, ref.chatId);
    flushSync();
    expect(draft.value).toEqual([pinned]);
    expect(writes).not.toHaveBeenCalled();
});

it("saves override edits and resyncs setChatMeta changes independently of the existing local lore draft", () => {
    install([pinned]);
    const draft = useLoreOverridesDraft();
    const localDraft = useLocalLoreDraft();
    flushSync();
    draft.value[0].entry.content = "Chat copy edited";
    draft.value[0].off = true;
    localDraft.value[0].content = "Local edited";
    flushSync();
    const edited = { entry: { ...original, content: "Chat copy edited" }, off: true };
    expect(stored().loreOverrides).toEqual([edited]);
    expect(stored().localLore).toEqual([{ ...local, content: "Local edited" }]);
    const remote = { entry: { ...original, content: "Another writer's copy" }, off: false };
    setChatMeta(ref, { loreOverrides: [remote] });
    flushSync();
    expect(draft.value).toEqual([remote]);
    expect(localDraft.value).toEqual([{ ...local, content: "Local edited" }]);
    draft.value[0].entry.insertorder = 777;
    flushSync();
    expect(stored().loreOverrides).toEqual([{ ...remote, entry: { ...remote.entry, insertorder: 777 } }]);
    expect(findChat(other)!).not.toHaveProperty("loreOverrides");
    expect(alertError).not.toHaveBeenCalled();
});

it.each(["local send", "followed job"] as const)(
    "refuses and undoes edits during a %s only in that chat, without replaying them",
    (kind) => {
        install([pinned]);
        const draft = useLoreOverridesDraft();
        flushSync();
        const finishOther = fence(kind, other);
        draft.value[0].entry.content = "Allowed while other chat runs";
        flushSync();
        const allowed = { ...pinned, entry: { ...pinned.entry, content: "Allowed while other chat runs" } };
        expect(stored().loreOverrides).toEqual([allowed]);
        finishOther();
        const finish = fence(kind, ref);
        writes.mockClear();
        draft.value[0].entry.content = "Refused edit";
        draft.value[0].off = true;
        flushSync();
        expect(alertError).toHaveBeenCalledExactlyOnceWith(language.chatGenerating);
        expect(draft.value).toEqual([allowed]);
        expect(stored().loreOverrides).toEqual([allowed]);
        expect(writes).not.toHaveBeenCalled();
        draft.value.push({ entry: entry("new", "Refused pin"), off: false });
        flushSync();
        expect(draft.value).toEqual([allowed]);
        expect(alertError).toHaveBeenCalledTimes(2);
        expect(writes).not.toHaveBeenCalled();

        const received = { entry: { ...original, content: "Received during generation" }, off: false };
        setChatMeta(ref, { loreOverrides: [received] });
        flushSync();
        expect(draft.value).toEqual([received]);
        expect(alertError).toHaveBeenCalledTimes(2);
        writes.mockClear();
        finish();
        expect(stored().loreOverrides).toEqual([received]);
        expect(writes).not.toHaveBeenCalled();
        draft.value[0].entry.content = "Allowed after generation";
        flushSync();
        expect(stored().loreOverrides).toEqual([
            { entry: { ...original, content: "Allowed after generation" }, off: false },
        ]);
        expect(stored().localLore).toEqual([local]);
    },
);
