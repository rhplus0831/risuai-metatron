// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatLoreOverride, loreBook } from "../../../../shared/database.ts";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: vi.fn(async (path, init) => {
            if (path !== "/api/tokens/count") throw new Error(`Unexpected request: ${path}`);
            const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
            return Response.json({ counts: texts.map(() => 0) });
        }),
    }),
);

import { language } from "src/lang";
import { alertConfirm, alertError } from "src/ts/alert";
import { chatStatusKey } from "src/ts/process/chatStatus.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
import { followedJobs } from "src/ts/process/serverCommands";
import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
import { findChat, selectChat, setChatMeta, setChatWorkListener } from "src/ts/storage/chatStore.svelte";
import { setCharacterWriteListener } from "src/ts/storage/records.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import LoreBookSetting from "./LoreBookSetting.svelte";
import LoreOverrideList from "./LoreOverrideList.svelte";

const ref = { chaId: "owner", chatId: "chat" };
const other = { chaId: "owner", chatId: "other" };
const entry = (comment: string, extra: Partial<loreBook> = {}): loreBook => ({
    comment,
    key: comment,
    content: `${comment} prompt`,
    secondkey: "",
    insertorder: 100,
    mode: "normal",
    alwaysActive: false,
    selective: false,
    ...extra,
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const stored = () => findChat(ref)!;
const originals = () => selectedCharacter()!.globalLore;
const chatWrites = vi.fn();
const characterWrites = vi.fn();
let target: HTMLDivElement;
let instance: ReturnType<typeof mount> | undefined;
const releases: (() => void)[] = [];

function install({
    globalLore,
    overrides,
    localLore = [],
    ownerType = "character",
}: {
    globalLore: loreBook[];
    overrides?: ChatLoreOverride[];
    localLore?: loreBook[];
    ownerType?: "character" | "group";
}) {
    installFlatDatabaseWithChats({
        localActivationInGlobalLorebook: true,
        characters: [
            {
                chaId: ref.chaId,
                name: "Owner",
                type: ownerType,
                globalLore,
                ...(ownerType === "group" ? { characters: ["member"], characterActive: [true] } : {}),
                chats: [ref, other].map(({ chatId }) => ({
                    id: chatId,
                    name: chatId,
                    note: "",
                    message: [],
                    localLore: copy(localLore),
                    ...(overrides === undefined ? {} : { loreOverrides: copy(overrides) }),
                })),
            },
            {
                chaId: "member",
                name: "Member",
                type: "character",
                globalLore: [entry("Member lore", { id: "member-lore" })],
                chats: [],
            },
        ],
    });
    selectCharacter(ref.chaId);
    selectChat(ref.chaId, ref.chatId);
    flushSync();
    chatWrites.mockClear();
    characterWrites.mockClear();
    setChatWorkListener(chatWrites);
    setCharacterWriteListener({ character: characterWrites, membership: characterWrites });
}

function button(name: string, root: ParentNode = target) {
    const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (element) => element.textContent?.trim() === name,
    );
    expect(found, `button ${name}`).toBeDefined();
    return found!;
}
function row(name: string) {
    return button(name).parentElement!.parentElement!;
}
function checkbox(name: string, root: ParentNode = target) {
    const found = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
        (element) => element.alt === name,
    );
    expect(found, `checkbox ${name}`).toBeDefined();
    return found!;
}
const pinBox = (name: string) => checkbox(language.chatLoreOverrides.pin, row(name));
function click(element: HTMLElement) {
    element.click();
    flushSync();
}
function edit(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
}
// The dialog and ensureChatLoaded continuations run with a controlled clock; no real sleep.
async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}
function render(settings = false) {
    instance = settings ? mount(LoreBookSetting, { target }) : mount(LoreOverrideList, { target });
    flushSync();
    if (settings) click(button(language.Chat));
}
function holdConfirmation() {
    let answer!: (confirmed: boolean) => void;
    vi.mocked(alertConfirm).mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
            answer = resolve;
        }),
    );
    return answer;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(alertConfirm).mockReset().mockResolvedValue(true);
    vi.mocked(alertError).mockClear();
    followedJobs.set(new Map());
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    if (instance) await unmount(instance);
    instance = undefined;
    setChatWorkListener(null);
    setCharacterWriteListener(null);
    followedJobs.set(new Map());
    for (const release of releases.splice(0)) release();
    flushSync();
    target.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
});

it.each([
    { ownerType: "character", idState: "missing" },
    { ownerType: "character", idState: "duplicate" },
    { ownerType: "group", idState: "duplicate" },
] as const)("pins an independent full copy of $ownerType lore with a $idState id", ({ ownerType, idState }) => {
    const source = entry("Dragon", {
        ...(idState === "duplicate" ? { id: "shared-id" } : {}),
        mode: "multiple",
        secondkey: "cave",
        selective: true,
        activationPercent: 37,
        insertorder: 412,
        bookVersion: 2,
        useRegex: false,
        extentions: { risu_case_sensitive: true },
        loreCache: { key: "cached", data: ["nested value"] },
    });
    const sibling = entry("Sibling", { id: "shared-id" });
    install({ globalLore: [source, sibling], ownerType });
    render();
    expect(target.textContent).not.toContain("Member lore");
    click(pinBox("Dragon"));

    const id = originals()[0].id;
    expect(id).toEqual(expect.any(String));
    expect(id).toBeTruthy();
    expect(id).not.toBe("shared-id");
    expect(originals()).toEqual([{ ...source, id }, sibling]);
    expect(stored().loreOverrides).toEqual([{ entry: { ...source, id }, off: false }]);
    expect(stored().localLore).toEqual([]);
    expect(findChat(other)!.loreOverrides).toBeUndefined();
    expect(characterWrites).toHaveBeenCalledTimes(1);

    click(button("Dragon"));
    edit(row("Dragon").querySelector("textarea")!, "Only this chat's prompt");
    expect(stored().loreOverrides![0].entry).toEqual({ ...source, id, content: "Only this chat's prompt" });
    expect(originals()[0]).toEqual({ ...source, id });
    expect(characterWrites).toHaveBeenCalledTimes(1);
    click(checkbox(language.chatLoreOverrides.off, row("Dragon")));
    expect(stored().loreOverrides![0].off).toBe(true);

    originals()[0].content = "Changed original";
    originals()[0].extentions!.risu_case_sensitive = false;
    originals()[0].loreCache!.data.push("new source cache");
    flushSync();
    expect(stored().loreOverrides).toEqual([
        { entry: { ...source, id, content: "Only this chat's prompt" }, off: true },
    ]);
    expect(row("Dragon").querySelector("textarea")!.value).toBe("Only this chat's prompt");
});

it("keeps unpinned rows dimmed and read-only without writing either record", () => {
    const source = entry("Read only", { activationPercent: 40, selective: true, secondkey: "second" });
    install({ globalLore: [source] });
    render();
    expect(button("Read only").classList.contains("text-textcolor2")).toBe(true);
    click(button("Read only"));
    const body = row("Read only");
    const inputs = [...body.querySelectorAll<HTMLInputElement>("input")].filter(
        (input) => input !== pinBox("Read only"),
    );
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
        expect(input.disabled).toBe(true);
        if (input.type === "checkbox") {
            input.click();
            input.checked = !input.checked;
            input.dispatchEvent(new Event("change", { bubbles: true }));
        } else edit(input, input.type === "number" ? "91" : "Attempted edit");
    }
    const prompt = body.querySelector("textarea")!;
    expect(prompt.readOnly).toBe(true);
    expect(prompt.closest(".opacity-60")).not.toBeNull();
    edit(prompt, "Attempted prompt edit");
    expect(originals()).toEqual([source]);
    click(button("Read only"));
    click(button("Read only"));
    expect(row("Read only").querySelector("textarea")!.value).toBe(source.content);
    expect(originals()).toEqual([source]);
    expect(stored()).not.toHaveProperty("loreOverrides");
    expect(characterWrites).not.toHaveBeenCalled();
    expect(chatWrites).not.toHaveBeenCalled();
});

it("releases only after confirmation and restores the checkbox when canceled", async () => {
    const source = entry("Dragon", { id: "dragon" });
    const override = { entry: { ...source, content: "Pinned prompt" }, off: false };
    install({ globalLore: [source], overrides: [override] });
    render();
    const cancel = holdConfirmation();
    click(pinBox("Dragon"));
    expect(alertConfirm).toHaveBeenCalledWith(language.chatLoreOverrides.releaseConfirm);
    expect(pinBox("Dragon").checked).toBe(true);
    expect(stored().loreOverrides).toEqual([override]);
    expect(chatWrites).not.toHaveBeenCalled();
    cancel(false);
    await settle();
    expect(pinBox("Dragon").checked).toBe(true);
    expect(chatWrites).not.toHaveBeenCalled();

    const accept = holdConfirmation();
    click(pinBox("Dragon"));
    expect(chatWrites).not.toHaveBeenCalled();
    accept(true);
    await settle();
    expect(stored().loreOverrides).toEqual([]);
    expect(pinBox("Dragon").checked).toBe(false);
    click(button("Dragon"));
    expect(row("Dragon").querySelector("textarea")!.value).toBe(source.content);
    expect(row("Dragon").querySelector("textarea")!.readOnly).toBe(true);
    expect(originals()).toEqual([source]);
    expect(chatWrites).toHaveBeenCalledOnce();
    expect(characterWrites).not.toHaveBeenCalled();
});

it("releases the captured chat's override when selection changes during the dialog", async () => {
    const source = entry("Dragon", { id: "dragon" });
    const override = { entry: source, off: false };
    install({ globalLore: [source], overrides: [override] });
    const otherBefore = copy(findChat(other)!);
    expect(otherBefore.loreOverrides).toEqual([override]);
    render(true);
    click(button(language.chatLoreOverrides.title));
    const accept = holdConfirmation();
    click(pinBox("Dragon"));
    expect(alertConfirm).toHaveBeenCalledOnce();
    selectChat(other.chaId, other.chatId);
    flushSync();
    chatWrites.mockClear();
    accept(true);
    await settle();
    expect(stored().loreOverrides).toEqual([]);
    expect(findChat(other)).toEqual(otherBefore);
    expect(chatWrites).toHaveBeenCalledOnce();
    expect(characterWrites).not.toHaveBeenCalled();
});

it("derives folder all/some/none from nested entries and supports individual and bulk release", async () => {
    const root = entry("Folder", { mode: "folder", key: "root" });
    const inner = entry("Nested", { mode: "folder", key: "inner", folder: "root" });
    const a = entry("A", { id: "a", folder: "root" });
    const b = entry("B", { id: "b", folder: "inner" });
    const c = entry("C", { id: "c", folder: "inner" });
    const savedA = { entry: { ...a, content: "Already customized" }, off: true };
    install({ globalLore: [root, a, inner, b, c], overrides: [savedA] });
    render();
    const state = (name: string) => {
        const input = pinBox(name);
        return [input.checked, input.indeterminate, input.getAttribute("aria-checked")];
    };
    expect(state("Folder")).toEqual([false, true, "mixed"]);
    click(button("Folder"));
    click(button("Nested"));
    expect(row("Folder").contains(row("Nested"))).toBe(true);
    expect(row("Nested").contains(row("B"))).toBe(true);
    expect(state("Nested")).toEqual([false, false, "false"]);
    click(pinBox("Folder"));
    expect(stored().loreOverrides).toEqual([savedA, { entry: b, off: false }, { entry: c, off: false }]);
    expect(state("Folder")).toEqual([true, false, "true"]);
    expect(state("Nested")).toEqual([true, false, "true"]);

    click(pinBox("B"));
    await settle();
    expect(stored().loreOverrides).toEqual([savedA, { entry: c, off: false }]);
    expect(state("Folder")).toEqual([false, true, "mixed"]);
    expect(state("Nested")).toEqual([false, true, "mixed"]);
    click(pinBox("B"));
    expect(state("Folder")).toEqual([true, false, "true"]);
    vi.mocked(alertConfirm).mockClear();
    const accept = holdConfirmation();
    click(pinBox("Folder"));
    expect(alertConfirm).toHaveBeenCalledExactlyOnceWith(language.chatLoreOverrides.releaseConfirm);
    expect(stored().loreOverrides).toHaveLength(3);
    accept(true);
    await settle();
    expect(stored().loreOverrides).toEqual([]);
    expect(state("Folder")).toEqual([false, false, "false"]);
    expect(state("Nested")).toEqual([false, false, "false"]);
    expect(originals()).toEqual([root, a, inner, b, c]);
    expect(characterWrites).not.toHaveBeenCalled();
});

it("moves an on orphan atomically with a fresh id, unchanged mode and no folder; an off orphan can only be deleted", async () => {
    const movable = { entry: entry("Lost on", { id: "lost-on", folder: "gone", mode: "constant" }), off: false };
    const off = { entry: entry("Lost off", { id: "lost-off" }), off: true };
    const survivor = entry("Survivor", { id: "survivor" });
    const local = entry("Existing local", { id: "local" });
    install({ globalLore: [survivor], overrides: [movable, off], localLore: [local] });
    render();
    const orphanRow = (name: string) =>
        [...target.querySelectorAll("p")].find((element) => element.textContent?.trim() === name)!.parentElement!;
    expect(orphanRow("Lost on").textContent).toContain(language.chatLoreOverrides.originalDeleted);
    expect(orphanRow("Lost off").textContent).toContain(language.chatLoreOverrides.originalDeleted);
    expect(
        orphanRow("Lost on").compareDocumentPosition(button("Survivor")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(orphanRow("Lost off").textContent).not.toContain(language.chatLoreOverrides.move);
    const writes: { localLore: unknown; loreOverrides: unknown }[] = [];
    setChatWorkListener(() =>
        writes.push(copy({ localLore: stored().localLore, loreOverrides: stored().loreOverrides })),
    );

    click(button(language.chatLoreOverrides.move, orphanRow("Lost on")));
    await settle();
    expect(alertConfirm).toHaveBeenCalledWith(language.chatLoreOverrides.moveConfirm);
    const moved = stored().localLore[1];
    expect(moved.id).toEqual(expect.any(String));
    expect(moved.id).toBeTruthy();
    expect(["lost-on", "lost-off", "local", "survivor"]).not.toContain(moved.id);
    const { folder: _folder, ...expected } = movable.entry;
    expect(moved).toEqual({ ...expected, id: moved.id });
    expect(moved).not.toHaveProperty("folder");
    expect(writes).toEqual([{ localLore: [local, { ...expected, id: moved.id }], loreOverrides: [off] }]);

    click(button(language.chatLoreOverrides.delete, orphanRow("Lost off")));
    await settle();
    expect(alertConfirm).toHaveBeenCalledWith(language.chatLoreOverrides.deleteConfirm);
    expect(stored().loreOverrides).toEqual([]);
    expect(stored().localLore).toEqual(writes[0].localLore);
    expect(writes).toHaveLength(2);
    expect(originals()).toEqual([survivor]);
    expect(characterWrites).not.toHaveBeenCalled();
});

it("opens the collapsed section for orphans on chat selection and when an original is deleted", () => {
    const source = entry("Dragon", { id: "dragon" });
    const orphan = { entry: entry("Already deleted", { id: "gone" }), off: false };
    install({ globalLore: [source], overrides: [{ entry: source, off: false }] });
    setChatMeta(other, { loreOverrides: [orphan] });
    render(true);
    expect(button(language.chatLoreOverrides.title).getAttribute("aria-expanded")).toBe("false");
    expect(target.textContent).not.toContain(language.chatLoreOverrides.pin);
    selectChat(other.chaId, other.chatId);
    flushSync();
    expect(button(language.chatLoreOverrides.title).getAttribute("aria-expanded")).toBe("true");
    expect(target.textContent).toContain(language.chatLoreOverrides.originalDeleted);
    click(button(language.chatLoreOverrides.title));
    expect(button(language.chatLoreOverrides.title).getAttribute("aria-expanded")).toBe("false");
    selectChat(ref.chaId, ref.chatId);
    flushSync();
    expect(button(language.chatLoreOverrides.title).getAttribute("aria-expanded")).toBe("false");
    selectedCharacter()!.globalLore = [];
    flushSync();
    expect(button(language.chatLoreOverrides.title).getAttribute("aria-expanded")).toBe("true");
    expect(target.textContent).toContain(language.chatLoreOverrides.originalDeleted);
});

it("shows off precedence on the override, the chat child row and the character activation control", () => {
    const source = entry("Dragon", { id: "dragon", useRegex: false });
    const child = entry("", { id: "dragon", mode: "child", alwaysActive: true });
    install({ globalLore: [source], overrides: [{ entry: source, off: false }], localLore: [child] });
    render(true);
    click(button(language.chatLoreOverrides.title));
    expect(target.textContent).not.toContain(language.chatLoreOverrides.offNotice);
    expect(target.textContent).not.toContain(language.chatLoreOverrides.linkOffNotice);
    // There is also a child row named Dragon. The expanded button identifies the override row.
    const header = [...target.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(
        (element) => element.textContent?.trim() === "Dragon",
    )!;
    click(header);
    click(checkbox(language.chatLoreOverrides.off, header.parentElement!.parentElement!));
    expect(stored().loreOverrides![0].off).toBe(true);
    expect(header.parentElement!.parentElement!.textContent).toContain(language.chatLoreOverrides.offNotice);
    const childRow = target.querySelector<HTMLElement>("[data-risu-idx]")!;
    expect(childRow.textContent).toContain(language.chatLoreOverrides.linkOffNotice);
    click(button(language.character));
    click(button("Dragon"));
    expect(checkbox(language.alwaysActiveInChat).checked).toBe(true);
    expect(target.textContent).toContain(language.chatLoreOverrides.linkOffNotice);
    expect(stored().localLore).toEqual([child]);
    expect(originals()).toEqual([source]);
});

it.each(["local send", "followed job"] as const)("refuses pinning before assigning an id during a %s", (kind) => {
    const source = entry("No id");
    install({ globalLore: [source] });
    render();
    if (kind === "local send") releases.push(beginLocalSend(ref)!);
    else followedJobs.set(new Map([["job", chatStatusKey(ref)]]));
    flushSync();
    click(pinBox("No id"));
    expect(alertError).toHaveBeenCalledExactlyOnceWith(language.chatGenerating);
    expect(pinBox("No id").checked).toBe(false);
    expect(originals()).toEqual([source]);
    expect(stored()).not.toHaveProperty("loreOverrides");
    expect(chatWrites).not.toHaveBeenCalled();
    expect(characterWrites).not.toHaveBeenCalled();
});
