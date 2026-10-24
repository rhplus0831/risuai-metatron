// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { loreBook } from "src/ts/storage/database.svelte";

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({ alertConfirm: vi.fn(async () => true) }),
);
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);

import { alertConfirm } from "src/ts/alert";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { findChat, selectChat, setChatWorkListener } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import LoreBookList from "./LoreBookList.svelte";

const ref = { chaId: "owner", chatId: "captured" };
const other = { chaId: "owner", chatId: "other" };
const entry = (id: string, extra: Partial<loreBook> = {}): loreBook => ({
    id,
    key: id,
    comment: id,
    content: `${id} content`,
    mode: "normal",
    insertorder: 100,
    alwaysActive: false,
    secondkey: "",
    selective: false,
    ...extra,
});
let instance: ReturnType<typeof mount>;
let target: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(alertConfirm).mockReset().mockResolvedValue(true);
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    setChatWorkListener(null);
    if (instance) await unmount(instance);
    target.remove();
    vi.useRealTimers();
});

it.each([true, false])(
    "deleting a folder removes every member's child links in one write to the captured chat (folder link present: %s)",
    async (folderLinked) => {
        const folder = entry("folder-id", { mode: "folder", key: "folder-key" });
        const memberA = entry("member-a", { folder: "folder-key" });
        const memberB = entry("member-b", { folder: "folder-key" });
        const unrelated = entry("unrelated", { folder: "another-folder" });
        const child = (id: string) => entry(id, { mode: "child", alwaysActive: true });
        const kept = [child("unrelated"), entry("member-a"), entry("folder-id"), entry("local-only")];
        const localLore = [
            ...(folderLinked ? [child("folder-id")] : []),
            child("member-a"),
            child("member-b"),
            child("member-a"),
            ...kept,
        ];
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: ref.chaId,
                    type: "character",
                    name: "Owner",
                    globalLore: [folder, memberA, memberB, unrelated],
                    chats: [ref, other].map(({ chatId }) => ({
                        id: chatId,
                        name: chatId,
                        note: "",
                        message: [],
                        localLore,
                    })),
                },
            ],
        });
        selectCharacter(ref.chaId);
        selectChat(ref.chaId, ref.chatId);
        instance = mount(LoreBookList, { target, props: { submenu: 0 } });
        flushSync();
        let confirm!: (value: boolean) => void;
        vi.mocked(alertConfirm).mockImplementationOnce(
            () =>
                new Promise<boolean>((resolve) => {
                    confirm = resolve;
                }),
        );
        const writes = vi.fn(() => JSON.parse(JSON.stringify(findChat(ref)!.localLore)));
        setChatWorkListener(writes);

        const row = [...target.querySelectorAll<HTMLElement>("[data-risu-idgroup]")].find((element) =>
            element.querySelector("button"),
        )!;
        [...row.querySelector(":scope > div")!.querySelectorAll("button")].at(-1)!.click();
        expect(alertConfirm).toHaveBeenCalledOnce();
        selectChat(other.chaId, other.chatId);
        flushSync();
        confirm(true);
        await vi.advanceTimersByTimeAsync(0);
        flushSync();

        expect(characterList()[0].globalLore).toEqual([unrelated]);
        expect(findChat(ref)!.localLore).toEqual(kept);
        expect(findChat(other)!.localLore).toEqual(localLore);
        expect(writes).toHaveBeenCalledOnce();
        expect(writes.mock.results[0].value).toEqual(kept);
    },
);
