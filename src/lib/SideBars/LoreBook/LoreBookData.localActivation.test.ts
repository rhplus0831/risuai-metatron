// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { findChat, selectChat, setChatWorkListener } from "src/ts/storage/chatStore.svelte";
import type { loreBook } from "src/ts/storage/database.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import LoreBookList from "./LoreBookList.svelte";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: vi.fn<typeof import("src/ts/storage/serverAuth").authFetch>(async (_path, init) => {
            const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
            return Response.json({ counts: texts.map(() => 0) });
        }),
    }),
);

const ref = { chaId: "character", chatId: "chat" };
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
let instance: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => {
    vi.useFakeTimers();
    target = document.createElement("div");
    document.body.append(target);
});

afterEach(async () => {
    setChatWorkListener(null);
    if (instance) await unmount(instance);
    instance = undefined;
    target.remove();
    selectCharacter(null);
    vi.useRealTimers();
});

function render(localLore: loreBook[]) {
    installFlatDatabaseWithChats({
        localActivationInGlobalLorebook: true,
        characters: [
            {
                chaId: ref.chaId,
                type: "character",
                name: "Character",
                globalLore: [entry("shared"), entry("other-character-lore")],
                chats: [{ id: ref.chatId, name: "Chat", note: "", message: [], localLore }],
            },
        ],
    });
    selectCharacter(ref.chaId);
    selectChat(ref.chaId, ref.chatId);
    instance = mount(LoreBookList, { target, props: { submenu: 0 } });
    flushSync();
    const row = target.querySelector<HTMLElement>('[data-risu-idgroup][data-risu-idx="0"]')!;
    row.querySelector("button")!.click();
    flushSync();
    return [...row.querySelectorAll("label")]
        .find((label) => label.textContent?.trim() === language.alwaysActiveInChat)!
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function uncheck(box: HTMLInputElement) {
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
}

it("a plain same-id chat entry leaves the box unchecked, and unchecking without a child link writes nothing", () => {
    const localLore = [entry("shared", { content: "Imported chat lore with its original id" })];
    const box = render(localLore);
    expect(box.checked).toBe(false);

    const writes = vi.fn();
    setChatWorkListener(writes);
    uncheck(box);
    expect(findChat(ref)!.localLore).toEqual(localLore);
    expect(writes).not.toHaveBeenCalled();
});

it("a child link checks the box, and unchecking keeps the plain same-id entry and all other chat entries", () => {
    const plain = entry("shared", { content: "Imported chat lore with its original id" });
    const other = entry("chat-only");
    const otherChild = entry("other-character-lore", { mode: "child", alwaysActive: true });
    const child = entry("shared", { mode: "child", alwaysActive: true });
    const box = render([plain, child, other, otherChild]);
    expect(box.checked).toBe(true);

    uncheck(box);
    expect(findChat(ref)!.localLore).toEqual([plain, other, otherChild]);
    expect(box.checked).toBe(false);
});
