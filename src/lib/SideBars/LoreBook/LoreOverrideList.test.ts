// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Chat, ChatLoreOverride, loreBook } from "../../../../shared/database.ts";

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
import {
    acceptRemoteChat,
    assembleChats,
    findChat,
    selectChat,
    setChatMeta,
    setChatWorkListener,
} from "src/ts/storage/chatStore.svelte";
import { setCharacterWriteListener } from "src/ts/storage/records.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import LoreBookSetting from "./LoreBookSetting.svelte";
import LoreOverrideList from "./LoreOverrideList.svelte";

const strings = language.chatLoreOverrides;
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
                chats: [{ id: "member-chat", name: "member-chat", note: "", message: [], localLore: [] }],
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
/** The row's state control, found by the accessible name that includes the row's own name. */
function group(name: string, root: ParentNode = target) {
    const label = strings.stateFor(name);
    const found = [...root.querySelectorAll<HTMLElement>('[role="group"]')].find(
        (element) => element.getAttribute("aria-label") === label,
    );
    expect(found, `state control ${name}`).toBeDefined();
    return found!;
}
/** The pressed segment's label; exactly one segment is pressed, and it is the highlighted one. */
function pressed(name: string, root: ParentNode = target) {
    const buttons = [...group(name, root).querySelectorAll<HTMLButtonElement>("[data-segment-btn]")];
    const on = buttons.filter((element) => element.getAttribute("aria-pressed") === "true");
    expect(
        on.map((element) => element.textContent?.trim()),
        `pressed segments of ${name}`,
    ).toHaveLength(1);
    expect(buttons.filter((element) => element.classList.contains("segmented-btn-active"))).toEqual(on);
    return on[0].textContent!.trim();
}
const setState = (name: string, label: string, root: ParentNode = target) => click(button(label, group(name, root)));
/** The folder indicator's text, or null while hidden: the one element the control describes itself with, in the row's header. */
function indicator(name: string) {
    const described = group(name).getAttribute("aria-describedby");
    const header = row(name).firstElementChild!;
    if (described === null) {
        expect(header.textContent).not.toMatch(/\d+ changed/);
        return null;
    }
    const elements = document.querySelectorAll(`[id="${described}"]`);
    expect(elements, `indicator ${described}`).toHaveLength(1);
    expect(header.contains(elements[0])).toBe(true);
    return elements[0].textContent!.trim();
}
/** The row's own notices (not its members'). */
const notices = (name: string) =>
    [...row(name).children].filter((element) => element.tagName === "P").map((element) => element.textContent!.trim());
const dimmed = (name: string) => button(name).classList.contains("text-textcolor2");
const releaseAllButtons = () =>
    [...target.querySelectorAll<HTMLButtonElement>("button")].filter(
        (element) => element.textContent?.trim() === strings.releaseAll,
    );
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
/** A server copy of the chat with these overrides replaces the held one (another client wrote it). */
function remoteOverrides(loreOverrides: ChatLoreOverride[]) {
    const data = { ...copy(stored()), loreOverrides } as Chat;
    acceptRemoteChat({ characterId: ref.chaId, id: ref.chatId, revision: "r2", data });
    flushSync();
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
] as const)(
    "Override pins an independent full copy of $ownerType lore with a $idState id; Off keeps its edits",
    ({ ownerType, idState }) => {
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
        expect(target.textContent).toContain(strings.hint);
        expect(pressed("Dragon")).toBe(strings.original);
        setState("Dragon", strings.overridden);

        const id = originals()[0].id;
        expect(id).toEqual(expect.any(String));
        expect(id).toBeTruthy();
        expect(id).not.toBe("shared-id");
        expect(originals()).toEqual([{ ...source, id }, sibling]);
        expect(stored().loreOverrides).toEqual([{ entry: { ...source, id }, off: false }]);
        expect(stored().localLore).toEqual([]);
        expect(findChat(other)!.loreOverrides).toBeUndefined();
        expect(characterWrites).toHaveBeenCalledTimes(1);
        expect(pressed("Dragon")).toBe(strings.overridden);
        expect(pressed("Sibling")).toBe(strings.original);

        click(button("Dragon"));
        edit(row("Dragon").querySelector("textarea")!, "Only this chat's prompt");
        expect(stored().loreOverrides![0].entry).toEqual({ ...source, id, content: "Only this chat's prompt" });
        expect(originals()[0]).toEqual({ ...source, id });
        expect(characterWrites).toHaveBeenCalledTimes(1);

        // Off keeps the copy and its edits; the body stays editable.
        setState("Dragon", strings.off);
        expect(stored().loreOverrides).toEqual([
            { entry: { ...source, id, content: "Only this chat's prompt" }, off: true },
        ]);
        expect(pressed("Dragon")).toBe(strings.off);
        const prompt = row("Dragon").querySelector("textarea")!;
        expect(prompt.readOnly).toBe(false);
        edit(prompt, "Edited while off");
        expect(stored().loreOverrides![0]).toEqual({
            entry: { ...source, id, content: "Edited while off" },
            off: true,
        });
        setState("Dragon", strings.overridden);
        expect(stored().loreOverrides).toEqual([{ entry: { ...source, id, content: "Edited while off" }, off: false }]);
        expect(alertConfirm).not.toHaveBeenCalled();

        originals()[0].content = "Changed original";
        originals()[0].extentions!.risu_case_sensitive = false;
        originals()[0].loreCache!.data.push("new source cache");
        flushSync();
        expect(stored().loreOverrides).toEqual([{ entry: { ...source, id, content: "Edited while off" }, off: false }]);
        expect(row("Dragon").querySelector("textarea")!.value).toBe("Edited while off");
    },
);

it("keeps original rows dimmed and read-only without writing either record", () => {
    const source = entry("Read only", { activationPercent: 40, selective: true, secondkey: "second" });
    install({ globalLore: [source] });
    render();
    expect(pressed("Read only")).toBe(strings.original);
    expect(dimmed("Read only")).toBe(true);
    click(button("Read only"));
    const body = row("Read only");
    const inputs = [...body.querySelectorAll<HTMLInputElement>("input")];
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

it("turns an original off in one write and keeps that copy editable", () => {
    const source = entry("Dragon");
    install({ globalLore: [source] });
    render();
    setState("Dragon", strings.off);
    const id = originals()[0].id;
    expect(id).toBeTruthy();
    expect(stored().loreOverrides).toEqual([{ entry: { ...source, id }, off: true }]);
    expect(chatWrites).toHaveBeenCalledOnce();
    expect(characterWrites).toHaveBeenCalledOnce();
    expect(pressed("Dragon")).toBe(strings.off);
    expect(dimmed("Dragon")).toBe(false);
    click(button("Dragon"));
    expect(row("Dragon").querySelector("textarea")!.readOnly).toBe(false);
    expect(alertConfirm).not.toHaveBeenCalled();
});

it("releases an unedited override without a dialog, deciding after the chat loads", async () => {
    const source = entry("Dragon", { id: "dragon" });
    install({ globalLore: [source], overrides: [{ entry: source, off: false }] });
    render();
    setState("Dragon", strings.original);
    expect(pressed("Dragon")).toBe(strings.overridden);
    await settle();
    expect(alertConfirm).not.toHaveBeenCalled();
    expect(stored().loreOverrides).toEqual([]);
    expect(pressed("Dragon")).toBe(strings.original);
    expect(chatWrites).toHaveBeenCalledOnce();

    // An edit that lands while the chat loads makes the release ask first.
    setState("Dragon", strings.off);
    expect(stored().loreOverrides).toEqual([{ entry: source, off: true }]);
    setState("Dragon", strings.original);
    setChatMeta(ref, { loreOverrides: [{ entry: { ...source, content: "Edited meanwhile" }, off: true }] });
    flushSync();
    await settle();
    expect(alertConfirm).toHaveBeenCalledExactlyOnceWith(strings.releaseConfirm);
    expect(stored().loreOverrides).toEqual([]);
    expect(pressed("Dragon")).toBe(strings.original);
    expect(characterWrites).not.toHaveBeenCalled();
});

it("confirms an edited release, keeps the old segment when cancelled, and removes every override with the id", async () => {
    const source = entry("Dragon", { id: "dragon" });
    const edited = { entry: { ...source, content: "Pinned prompt" }, off: false };
    const duplicate = { entry: source, off: true };
    install({ globalLore: [source], overrides: [edited, duplicate] });
    render();
    expect(pressed("Dragon")).toBe(strings.overridden);
    const cancel = holdConfirmation();
    setState("Dragon", strings.original);
    await settle();
    expect(alertConfirm).toHaveBeenCalledExactlyOnceWith(strings.releaseConfirm);
    expect(pressed("Dragon")).toBe(strings.overridden);
    cancel(false);
    await settle();
    expect(pressed("Dragon")).toBe(strings.overridden);
    expect(stored().loreOverrides).toEqual([edited, duplicate]);
    expect(chatWrites).not.toHaveBeenCalled();

    const accept = holdConfirmation();
    setState("Dragon", strings.original);
    await settle();
    expect(chatWrites).not.toHaveBeenCalled();
    accept(true);
    await settle();
    expect(stored().loreOverrides).toEqual([]);
    expect(pressed("Dragon")).toBe(strings.original);
    click(button("Dragon"));
    expect(row("Dragon").querySelector("textarea")!.value).toBe(source.content);
    expect(row("Dragon").querySelector("textarea")!.readOnly).toBe(true);
    expect(originals()).toEqual([source]);
    expect(chatWrites).toHaveBeenCalledOnce();
    expect(characterWrites).not.toHaveBeenCalled();
});

it("writes nothing when a target changes during the dialog and keeps unrelated changes when it does not", async () => {
    const source = entry("Dragon", { id: "dragon" });
    const knight = entry("Knight", { id: "knight" });
    const edited = { entry: { ...source, content: "Pinned prompt" }, off: false };
    install({ globalLore: [source, knight], overrides: [edited] });
    render();
    // A server copy edits the target while the dialog is open: the user decides again.
    let accept = holdConfirmation();
    setState("Dragon", strings.original);
    await settle();
    const newer = { entry: { ...source, content: "Newer prompt" }, off: false };
    remoteOverrides([newer]);
    chatWrites.mockClear();
    accept(true);
    await settle();
    expect(stored().loreOverrides).toEqual([newer]);
    expect(pressed("Dragon")).toBe(strings.overridden);
    expect(chatWrites).not.toHaveBeenCalled();

    // An unrelated override added meanwhile survives the release.
    accept = holdConfirmation();
    setState("Dragon", strings.original);
    await settle();
    const knightOff = { entry: knight, off: true };
    remoteOverrides([newer, knightOff]);
    chatWrites.mockClear();
    accept(true);
    await settle();
    expect(stored().loreOverrides).toEqual([knightOff]);
    expect(pressed("Dragon")).toBe(strings.original);
    expect(pressed("Knight")).toBe(strings.off);
    expect(chatWrites).toHaveBeenCalledOnce();
    expect(characterWrites).not.toHaveBeenCalled();
});

it.each(["the other chat", "another character"])(
    "releases the captured chat's edited override when %s is selected during the dialog",
    async (selected) => {
        const source = entry("Dragon", { id: "dragon" });
        const override = { entry: { ...source, content: "Pinned prompt" }, off: false };
        install({ globalLore: [source], overrides: [override] });
        const otherBefore = copy(findChat(other)!);
        expect(otherBefore.loreOverrides).toEqual([override]);
        render(true);
        click(button(strings.title));
        const accept = holdConfirmation();
        setState("Dragon", strings.original);
        await settle();
        expect(alertConfirm).toHaveBeenCalledOnce();
        if (selected === "the other chat") selectChat(other.chaId, other.chatId);
        else selectCharacter("member");
        flushSync();
        chatWrites.mockClear();
        accept(true);
        await settle();
        expect(stored().loreOverrides).toEqual([]);
        expect(findChat(other)).toEqual(otherBefore);
        expect(chatWrites).toHaveBeenCalledOnce();
        expect(characterWrites).not.toHaveBeenCalled();
    },
);

it("writes nothing when the chat's owner is replaced during the dialog", async () => {
    const source = entry("Dragon", { id: "dragon" });
    const override = { entry: { ...source, content: "Pinned prompt" }, off: false };
    install({ globalLore: [source], overrides: [override] });
    render();
    const accept = holdConfirmation();
    setState("Dragon", strings.original);
    await settle();
    expect(alertConfirm).toHaveBeenCalledOnce();
    // A boot assembly replaces every held chat (same ids, another lifetime).
    const chats = [ref, other].map((chat) => ({
        characterId: chat.chaId,
        id: chat.chatId,
        revision: "r2",
        data: copy(findChat(chat)!) as Chat,
    }));
    assembleChats([{ chaId: ref.chaId }], chats, [
        { characterId: ref.chaId, revision: "o2", ids: [ref.chatId, other.chatId] },
    ]);
    flushSync();
    chatWrites.mockClear();
    accept(true);
    await settle();
    expect(stored().loreOverrides).toEqual([override]);
    expect(chatWrites).not.toHaveBeenCalled();
});

it("turns a folder off and on without touching member overrides, counting them in the indicator", () => {
    const root = entry("Folder", { mode: "folder", key: "root" });
    const inner = entry("Nested", { mode: "folder", key: "inner", folder: "root" });
    const a = entry("A", { id: "a", folder: "root" });
    const b = entry("B", { id: "b", folder: "inner" });
    const c = entry("C", { id: "c", folder: "inner" });
    const savedA = { entry: { ...a, content: "Already customized" }, off: true };
    const savedB = { entry: b, off: false };
    install({ globalLore: [root, a, inner, b, c], overrides: [savedA, savedB] });
    render();
    const all = ["Folder", "A", "Nested", "B", "C"];
    const states = () => all.map((name) => pressed(name));
    expect(indicator("Folder")).toBe(strings.changed(2));
    click(button("Folder"));
    click(button("Nested"));
    expect(row("Folder").contains(row("Nested"))).toBe(true);
    expect(row("Nested").contains(row("B"))).toBe(true);
    expect(indicator("Nested")).toBe(strings.changed(1));
    expect(group("C").hasAttribute("aria-describedby")).toBe(false);
    expect(states()).toEqual([strings.on, strings.off, strings.on, strings.overridden, strings.original]);
    expect(all.map(dimmed)).toEqual([false, false, false, false, true]);
    expect(all.map(notices)).toEqual([[], [], [], [], []]);

    // Off adds one folder override and leaves the members' own overrides.
    setState("Folder", strings.off);
    const rootId = originals()[0].id;
    expect(rootId).toBeTruthy();
    const rootOff = { entry: { ...root, id: rootId }, off: true };
    expect(stored().loreOverrides).toEqual([savedA, savedB, rootOff]);
    expect(states()).toEqual([strings.off, strings.off, strings.on, strings.overridden, strings.original]);
    expect(indicator("Folder")).toBe(`${strings.changed(2)} · ${strings.notApplied}`);
    expect(indicator("Nested")).toBe(`${strings.changed(1)} · ${strings.notApplied}`);
    expect(all.map(notices)).toEqual([[], ...Array(4).fill([strings.folderOffNotice])]);
    expect(all.map(dimmed)).toEqual([true, true, true, true, true]);

    // A nested folder has its own state, counted by the parent and untouched by it.
    setState("Nested", strings.off);
    const innerId = originals()[2].id;
    expect(innerId).toBeTruthy();
    const innerOff = { entry: { ...inner, id: innerId }, off: true };
    expect(stored().loreOverrides).toEqual([savedA, savedB, rootOff, innerOff]);
    expect(indicator("Folder")).toBe(`${strings.changed(3)} · ${strings.notApplied}`);
    expect(indicator("Nested")).toBe(`${strings.changed(1)} · ${strings.notApplied}`);

    // On removes only the folder's own override; every member returns to its previous state.
    setState("Folder", strings.on);
    expect(stored().loreOverrides).toEqual([savedA, savedB, innerOff]);
    expect(states()).toEqual([strings.on, strings.off, strings.off, strings.overridden, strings.original]);
    expect(indicator("Folder")).toBe(strings.changed(3));
    expect(indicator("Nested")).toBe(`${strings.changed(1)} · ${strings.notApplied}`);
    expect(all.map(notices)).toEqual([[], [], [], [strings.folderOffNotice], [strings.folderOffNotice]]);
    expect(all.map(dimmed)).toEqual([false, false, true, true, true]);
    expect(originals()).toEqual([{ ...root, id: rootId }, a, { ...inner, id: innerId }, b, c]);
    expect(characterWrites).toHaveBeenCalledTimes(2);
    expect(alertConfirm).not.toHaveBeenCalled();
});

it("flips an on folder override to off, turns an empty folder off, and groups nothing under a keyless folder", () => {
    const outer = entry("Outer", { id: "outer", mode: "folder", key: "outer" });
    const root = entry("Folder", { id: "root", mode: "folder", key: "root", folder: "outer" });
    const a = entry("A", { id: "a", folder: "root" });
    const empty = entry("Empty", { id: "empty", mode: "folder", key: "empty" });
    const keyless = entry("", { id: "keyless", mode: "folder", key: "" });
    const loose = entry("Loose", { id: "loose" });
    const blankFolder = entry("Blank folder key", { id: "blank", folder: "" });
    const looseOverride = { entry: loose, off: false };
    install({
        globalLore: [outer, root, a, empty, keyless, loose, blankFolder],
        overrides: [{ entry: root, off: false }, looseOverride],
    });
    render();
    click(button("Outer"));
    click(button("Folder"));
    expect(pressed("Folder")).toBe(strings.on);
    // An on folder override is not a change the enclosing folder counts.
    expect(indicator("Outer")).toBeNull();
    setState("Folder", strings.off);
    expect(stored().loreOverrides).toEqual([{ entry: root, off: true }, looseOverride]);
    expect(pressed("Folder")).toBe(strings.off);
    expect(indicator("Outer")).toBe(strings.changed(1));
    expect(notices("A")).toEqual([strings.folderOffNotice]);
    setState("Folder", strings.on);
    expect(stored().loreOverrides).toEqual([looseOverride]);
    expect(indicator("Outer")).toBeNull();

    expect(indicator("Empty")).toBeNull();
    setState("Empty", strings.off);
    const emptyOff = { entry: empty, off: true };
    expect(stored().loreOverrides).toEqual([looseOverride, emptyOff]);
    expect(indicator("Empty")).toBeNull();
    click(button("Empty"));
    expect(releaseAllButtons()).toHaveLength(0);

    // The unnamed folder is named by the same fallback as its row; it holds no entry.
    const unnamed = strings.unnamedFolder;
    click(button(unnamed));
    expect(row(unnamed).contains(row("Loose"))).toBe(false);
    expect(row(unnamed).contains(row("Blank folder key"))).toBe(false);
    expect(indicator(unnamed)).toBeNull();
    setState(unnamed, strings.off);
    expect(stored().loreOverrides).toEqual([looseOverride, emptyOff, { entry: keyless, off: true }]);
    expect(notices("Loose")).toEqual([]);
    expect(notices("Blank folder key")).toEqual([]);
    expect(pressed("Loose")).toBe(strings.overridden);
    expect(characterWrites).not.toHaveBeenCalled();
    expect(alertConfirm).not.toHaveBeenCalled();
});

it("shows folders in a key cycle once and counts the other folder's off state", () => {
    const x = entry("X", { id: "x", mode: "folder", key: "x", folder: "y" });
    const y = entry("Y", { id: "y", mode: "folder", key: "y", folder: "x" });
    const m = entry("M", { id: "m", folder: "y" });
    install({ globalLore: [x, y, m], overrides: [{ entry: m, off: false }] });
    render();
    const shown = () => [...target.querySelectorAll("button[aria-expanded]")].map((e) => e.textContent?.trim());
    expect(shown()).toEqual(["X"]);
    click(button("X"));
    click(button("Y"));
    expect(shown()).toEqual(["X", "Y", "M"]);
    expect(row("X").contains(row("Y"))).toBe(true);
    expect(row("Y").contains(row("M"))).toBe(true);
    expect(indicator("X")).toBe(strings.changed(1));
    expect(indicator("Y")).toBe(strings.changed(1));
    setState("Y", strings.off);
    expect(stored().loreOverrides).toEqual([
        { entry: m, off: false },
        { entry: y, off: true },
    ]);
    expect(indicator("X")).toBe(`${strings.changed(2)} · ${strings.notApplied}`);
    expect(indicator("Y")).toBe(`${strings.changed(1)} · ${strings.notApplied}`);
    expect(notices("X")).toEqual([strings.folderOffNotice]);
    expect(notices("M")).toEqual([strings.folderOffNotice]);
    setState("X", strings.off);
    expect(indicator("Y")).toBe(`${strings.changed(2)} · ${strings.notApplied}`);
    expect(pressed("M")).toBe(strings.overridden);
});

it("bulk release confirms with the count and releases the overrides inside the folder, not its own state", async () => {
    const root = entry("Folder", { id: "root", mode: "folder", key: "root" });
    const inner = entry("Nested", { id: "inner", mode: "folder", key: "inner", folder: "root" });
    const a = entry("A", { id: "a", folder: "root" });
    const b = entry("B", { id: "b", folder: "inner" });
    const c = entry("C", { id: "c", folder: "inner" });
    const outside = entry("Outside", { id: "outside" });
    const savedA = { entry: { ...a, content: "Already customized" }, off: true };
    const savedB = { entry: b, off: false };
    const innerOff = { entry: inner, off: true };
    const rootOff = { entry: root, off: true };
    const outsideOn = { entry: outside, off: false };
    install({ globalLore: [root, a, inner, b, c, outside], overrides: [savedA, rootOff, savedB, innerOff, outsideOn] });
    render();
    expect(releaseAllButtons()).toHaveLength(0);
    click(button("Folder"));
    click(button("Nested"));
    expect(releaseAllButtons()).toHaveLength(2);
    expect(row("Folder").contains(releaseAllButtons()[0])).toBe(true);
    expect(row("Nested").contains(releaseAllButtons()[1])).toBe(true);

    const cancel = holdConfirmation();
    click(releaseAllButtons()[0]);
    await settle();
    expect(alertConfirm).toHaveBeenCalledExactlyOnceWith(strings.releaseAllConfirm(3));
    cancel(false);
    await settle();
    expect(stored().loreOverrides).toEqual([savedA, rootOff, savedB, innerOff, outsideOn]);
    expect(chatWrites).not.toHaveBeenCalled();

    const accept = holdConfirmation();
    click(releaseAllButtons()[0]);
    await settle();
    expect(stored().loreOverrides).toHaveLength(5);
    accept(true);
    await settle();
    expect(stored().loreOverrides).toEqual([rootOff, outsideOn]);
    expect(pressed("Folder")).toBe(strings.off);
    expect(indicator("Folder")).toBeNull();
    expect(releaseAllButtons()).toHaveLength(0);
    expect(["A", "Nested", "B", "C", "Outside"].map((name) => pressed(name))).toEqual([
        strings.original,
        strings.on,
        strings.original,
        strings.original,
        strings.overridden,
    ]);
    expect(chatWrites).toHaveBeenCalledOnce();
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
    expect(orphanRow("Lost on").textContent).toContain(strings.originalDeleted);
    expect(orphanRow("Lost off").textContent).toContain(strings.originalDeleted);
    expect(
        orphanRow("Lost on").compareDocumentPosition(button("Survivor")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(orphanRow("Lost off").textContent).not.toContain(strings.move);
    const writes: { localLore: unknown; loreOverrides: unknown }[] = [];
    setChatWorkListener(() =>
        writes.push(copy({ localLore: stored().localLore, loreOverrides: stored().loreOverrides })),
    );

    click(button(strings.move, orphanRow("Lost on")));
    await settle();
    expect(alertConfirm).toHaveBeenCalledWith(strings.moveConfirm);
    const moved = stored().localLore[1];
    expect(moved.id).toEqual(expect.any(String));
    expect(moved.id).toBeTruthy();
    expect(["lost-on", "lost-off", "local", "survivor"]).not.toContain(moved.id);
    const { folder: _folder, ...expected } = movable.entry;
    expect(moved).toEqual({ ...expected, id: moved.id });
    expect(moved).not.toHaveProperty("folder");
    expect(writes).toEqual([{ localLore: [local, { ...expected, id: moved.id }], loreOverrides: [off] }]);

    click(button(strings.delete, orphanRow("Lost off")));
    await settle();
    expect(alertConfirm).toHaveBeenCalledWith(strings.deleteConfirm);
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
    expect(button(strings.title).getAttribute("aria-expanded")).toBe("false");
    expect(target.textContent).not.toContain(strings.hint);
    selectChat(other.chaId, other.chatId);
    flushSync();
    expect(button(strings.title).getAttribute("aria-expanded")).toBe("true");
    expect(target.textContent).toContain(strings.originalDeleted);
    click(button(strings.title));
    expect(button(strings.title).getAttribute("aria-expanded")).toBe("false");
    selectChat(ref.chaId, ref.chatId);
    flushSync();
    expect(button(strings.title).getAttribute("aria-expanded")).toBe("false");
    selectedCharacter()!.globalLore = [];
    flushSync();
    expect(button(strings.title).getAttribute("aria-expanded")).toBe("true");
    expect(target.textContent).toContain(strings.originalDeleted);
});

it("shows off precedence on the override, the chat child row and the character activation control", () => {
    const source = entry("Dragon", { id: "dragon", useRegex: false });
    const child = entry("", { id: "dragon", mode: "child", alwaysActive: true });
    install({ globalLore: [source], overrides: [{ entry: source, off: false }], localLore: [child] });
    render(true);
    click(button(strings.title));
    expect(target.textContent).not.toContain(strings.offNotice);
    expect(target.textContent).not.toContain(strings.linkOffNotice);
    // There is also a child row named Dragon. The expanded button identifies the override row.
    const header = [...target.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(
        (element) => element.textContent?.trim() === "Dragon",
    )!;
    const overrideRow = header.parentElement!.parentElement!;
    setState("Dragon", strings.off, overrideRow);
    expect(stored().loreOverrides![0].off).toBe(true);
    expect(pressed("Dragon", overrideRow)).toBe(strings.off);
    expect(overrideRow.textContent).toContain(strings.offNotice);
    const childRow = target.querySelector<HTMLElement>("[data-risu-idx]")!;
    expect(childRow.textContent).toContain(strings.linkOffNotice);
    click(button(language.character));
    click(button("Dragon"));
    const activation = [...target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
        (element) => element.alt === language.alwaysActiveInChat,
    )!;
    expect(activation.checked).toBe(true);
    expect(target.textContent).toContain(strings.linkOffNotice);
    expect(stored().localLore).toEqual([child]);
    expect(originals()).toEqual([source]);
});

it.each(["local send", "followed job"] as const)(
    "refuses every state change during a %s and keeps the old segments",
    (kind) => {
        const source = entry("No id");
        const pinned = entry("Pinned", { id: "pinned" });
        const folder = entry("Folder", { id: "folder", mode: "folder", key: "folder" });
        const override = { entry: pinned, off: false };
        install({ globalLore: [source, pinned, folder], overrides: [override] });
        render();
        if (kind === "local send") releases.push(beginLocalSend(ref)!);
        else followedJobs.set(new Map([["job", chatStatusKey(ref)]]));
        flushSync();
        setState("No id", strings.off);
        setState("Pinned", strings.off);
        setState("Pinned", strings.original);
        setState("Folder", strings.off);
        expect(alertError).toHaveBeenCalledTimes(4);
        expect(vi.mocked(alertError).mock.calls.every(([message]) => message === language.chatGenerating)).toBe(true);
        expect(alertConfirm).not.toHaveBeenCalled();
        expect(pressed("No id")).toBe(strings.original);
        expect(pressed("Pinned")).toBe(strings.overridden);
        expect(pressed("Folder")).toBe(strings.on);
        expect(originals()).toEqual([source, pinned, folder]);
        expect(stored().loreOverrides).toEqual([override]);
        expect(chatWrites).not.toHaveBeenCalled();
        expect(characterWrites).not.toHaveBeenCalled();
    },
);
