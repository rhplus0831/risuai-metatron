import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain } from "../storage/tests/mutationStoresHarness";

// `importLoreBook("global")` appends the file's entries to the character selected when the dialog
// opened, by the id captured before it, through `updateCharacter`, over the real save adapter and
// the real server store (`storeBackedServer.ts`). With the selection moved meanwhile the entries
// land in the captured character (not selected, so the write reaches the server through its mark)
// and the selected one is untouched; a record replaced with newer lore while the dialog was open
// gets the entries appended to its current list; a character deleted meanwhile gets nothing and is
// not recreated. The local mode (the chat module) is unchanged and not covered here. The imported
// entries are converted as they enter (`upgradeLorebook`: these entries have no old syntax, so only
// `bookVersion: 2` is added), as are the harness characters' entries when they are created
// (`addCharacter`); an entry written later through `updateCharacter` is kept as written.

const { server, alerts, picker } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
    /** What the next `selectSingleFile` answers with; a test's answer runs its "while the dialog is open" step first. */
    picker: { answer: async (): Promise<{ name: string; data: Uint8Array }> => ({ name: "", data: new Uint8Array() }) },
}));

vi.mock("../storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertReloadNotice: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertConfirm: vi.fn(async () => true),
    }),
);
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", chatGenerating: "generating" },
    changeLanguage: vi.fn(),
}));
vi.mock("./modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleTriggers: vi.fn(() => []),
    getModuleMcps: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));
vi.mock("../tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

const lore = (comment: string, content: string) => ({
    key: comment.toLowerCase(),
    comment,
    content,
    mode: "normal",
    insertorder: 100,
    alwaysActive: false,
    secondkey: "",
    selective: false,
});
/** An entry as the lorebook conversion leaves it (no old syntax in these entries to convert). */
const upgraded = (entry: ReturnType<typeof lore>) => ({ ...entry, bookVersion: 2 });
const nativeFile = (entries: unknown[]) => ({
    name: "lore.json",
    data: new TextEncoder().encode(JSON.stringify({ type: "risu", ver: 1, data: entries })),
});

/** Boots the harness with Alpha (one lore entry) selected and Beta (one entry), and loads `lorebook.svelte.ts`. */
async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { characterStore, selectionModule, characterList, sync, fake } = booted;
    const index = (chaId: string) => characterList().findIndex((entry: any) => entry?.chaId === chaId);
    const alpha = characterStore.addCharacter({ type: "character", name: "Alpha", globalLore: [lore("A", "a")] });
    const beta = characterStore.addCharacter({ type: "character", name: "Beta", globalLore: [lore("B", "b")] });
    selectionModule.selectCharacter(alpha);
    await sync.flushResources();
    fake.requests.length = 0;
    // `util` stays real (a `vi.mock` wrapper would outlive `vi.resetModules`); the dialog is spied per graph.
    const util = await import("../util");
    vi.spyOn(util, "selectSingleFile").mockImplementation(() => picker.answer() as any);
    const lorebook = await import("./lorebook.svelte");
    const loreOf = (chaId: string) => plain(booted.character(chaId)?.globalLore);
    const run = async (file: { name: string; data: Uint8Array }, during: () => Promise<void> | void = () => {}) => {
        picker.answer = async () => {
            await during();
            return file;
        };
        await lorebook.importLoreBook("global");
    };
    return { ...booted, lorebook, alpha, beta, index, loreOf, run };
}

// The first boot compiles the module graph; done once here so no test pays for it, in the
// harness's order (the stores before the modules that reach back into them at load).
beforeAll(async () => {
    await import("../stores.svelte");
    await import("../storage/database.svelte");
    await import("./lorebook.svelte");
}, 60_000);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("importLoreBook(global) writes the character captured before the dialog", () => {
    it("appends the entries to that character after the selection moved, and the write is saved", async () => {
        const { run, alpha, beta, index, selectionModule, loreOf, sync, record, fake } = await boot();
        await run(nativeFile([lore("New", "n")]), () => selectionModule.selectCharacter(beta));
        expect(loreOf(alpha)).toEqual([upgraded(lore("A", "a")), upgraded(lore("New", "n"))]);
        expect(loreOf(beta)).toEqual([upgraded(lore("B", "b"))]);
        expect(selectionModule.selectedIndex()).toBe(index(beta));
        expect(alerts.error).not.toHaveBeenCalled();
        await sync.flushResources();
        expect(record("characters", alpha).globalLore).toEqual([upgraded(lore("A", "a")), upgraded(lore("New", "n"))]);
        expect(record("characters", beta).globalLore).toEqual([upgraded(lore("B", "b"))]);
        const sent = fake.batchBodies().flatMap((batch: any) => (batch.ops ?? []).map((op: any) => op.id));
        expect(sent).toContain(alpha);
        expect(sent).not.toContain(beta);
    });

    it("appends to the record's current lore when it was replaced while the dialog was open", async () => {
        const { run, alpha, characterStore, loreOf, sync, record } = await boot();
        await run(nativeFile([lore("New", "n")]), () => {
            characterStore.updateCharacter(alpha, { globalLore: [lore("A", "a"), lore("Newer", "x")] });
        });
        expect(loreOf(alpha)).toEqual([lore("A", "a"), lore("Newer", "x"), upgraded(lore("New", "n"))]);
        await sync.flushResources();
        expect(record("characters", alpha).globalLore).toEqual(loreOf(alpha));
    });

    it("a character deleted while the dialog was open gets nothing and is not recreated", async () => {
        const { run, alpha, beta, characterStore, loreOf, sync, mirrorText, serverText, fake, characterList } =
            await boot();
        let mirror = "";
        let serverBefore = "";
        let batches = 0;
        await run(nativeFile([lore("New", "n")]), async () => {
            expect(characterStore.removeCharacter(alpha)).toBe(true);
            await sync.flushResources();
            mirror = mirrorText();
            serverBefore = serverText();
            batches = fake.batchCount();
        });
        expect(alerts.error).not.toHaveBeenCalled();
        expect(mirrorText()).toBe(mirror);
        await sync.flushResources();
        expect(serverText()).toBe(serverBefore);
        expect(fake.batchCount()).toBe(batches);
        expect(characterList().some((entry: any) => entry.chaId === alpha)).toBe(false);
        expect(fake.record("characters", alpha)).toBeNull();
        expect(loreOf(beta)).toEqual([upgraded(lore("B", "b"))]);
    });
});

// The global import converts the file's old entries (below `bookVersion` 2) as they enter, refuses
// a file the conversion cannot read without changing anything, and leaves the character's own
// entries as written; the local import (the chat's lore) stays unconverted, as the old formatter
// never covered it.
describe("the lorebook conversion of an imported file", () => {
    const old = (comment: string, content: string, extra: Record<string, unknown> = {}) => ({
        ...lore(comment, content),
        ...extra,
    });

    it("converts the file's old entries in the global import and keeps the character's own entries as written", async () => {
        const { run, alpha, characterStore, loreOf, sync, record } = await boot();
        const own = old("Own", "<char> stays", { bookVersion: 1 });
        characterStore.updateCharacter(alpha, { globalLore: [own] });
        await run(
            nativeFile([
                old("Old", "<bot> greets <user>\n@@@end", { activationPercent: 30 }),
                old("Current", "<char> kept", { bookVersion: 2 }),
            ]),
        );
        expect(alerts.error).not.toHaveBeenCalled();
        expect(loreOf(alpha)).toEqual([
            own,
            {
                ...old("Old", "@@probability 30\n{{char}} greets {{user}}\n@@depth 0"),
                activationPercent: null,
                bookVersion: 2,
            },
            old("Current", "<char> kept", { bookVersion: 2 }),
        ]);
        await sync.flushResources();
        expect(record("characters", alpha).globalLore).toEqual(loreOf(alpha));
    });

    it("refuses a file with an entry the conversion cannot read: nothing is imported or sent", async () => {
        const { run, alpha, loreOf, sync, fake, mirrorText } = await boot();
        const before = loreOf(alpha);
        const mirror = mirrorText();
        await run(nativeFile([lore("New", "n"), 5]));
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(loreOf(alpha)).toEqual(before);
        expect(mirrorText()).toBe(mirror);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });

    it("leaves the entries of a local import unconverted", async () => {
        const { alpha, lorebook, chat, character } = await boot();
        const file = nativeFile([old("Old", "<char> local\n@@end")]);
        picker.answer = async () => file;
        await lorebook.importLoreBook("local");
        expect(alerts.error).not.toHaveBeenCalled();
        const selected = character(alpha);
        const ref = { chaId: alpha, chatId: selected.chats[selected.chatPage].id };
        expect(plain(chat.findChat(ref)!.localLore)).toEqual([old("Old", "<char> local\n@@end")]);
    });
});

// The local import sends the chat's whole `localLore`, so while a send of this tab
// (a `localSends` entry) or a job this tab follows (`followedJobs`) runs in the captured chat at the
// write, it is refused with the `chatGenerating` notice and nothing is written, as the lore draft's
// fence does (`localLoreDraft.fence.test.ts`). A job that starts while the dialog is open counts:
// the fence is checked after it.
describe("importLoreBook(local) during a job in the chat", () => {
    async function local() {
        const booted = await boot();
        const { followedJobs } = await import("./serverCommands");
        const { chatStatusKey } = await import("./chatStatus.svelte");
        // The registry of this graph (the fence reads it): imported after the reset, with the wrapper.
        const { beginLocalSend } = await import("./localSends");
        const selected = booted.character(booted.alpha);
        const ref = { chaId: booted.alpha, chatId: selected.chats[selected.chatPage].id };
        const follow = (target: { chaId: string; chatId: string } | null) =>
            followedJobs.set(target ? new Map([["job-1", chatStatusKey(target)]]) : new Map());
        const stored = () => plain(booted.chat.findChat(ref)!.localLore);
        const runLocal = async (file: { name: string; data: Uint8Array }, during: () => void = () => {}) => {
            picker.answer = async () => {
                during();
                return file;
            };
            await booted.lorebook.importLoreBook("local");
        };
        return { ...booted, ref, follow, beginLocalSend, stored, runLocal };
    }

    it("refuses while a job this tab follows runs in the chat, also one started while the dialog was open", async () => {
        const { runLocal, follow, ref, stored, sync, fake } = await local();
        const batches = fake.batchCount();
        follow(ref);
        await runLocal(nativeFile([lore("New", "n")]));
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.error).toHaveBeenCalledWith("generating");
        expect(stored()).toEqual([]);
        follow(null);

        await runLocal(nativeFile([lore("New", "n")]), () => follow(ref));
        expect(alerts.error).toHaveBeenCalledTimes(2);
        expect(stored()).toEqual([]);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(batches);
        follow(null);

        await runLocal(nativeFile([lore("New", "n")]));
        expect(alerts.error).toHaveBeenCalledTimes(2);
        expect(stored()).toEqual([lore("New", "n")]);
    });

    it("is fenced by this tab's own send of the chat only", async () => {
        const { runLocal, beginLocalSend, ref, stored } = await local();
        const releaseOther = beginLocalSend({ chaId: ref.chaId, chatId: "other" })!;
        await runLocal(nativeFile([lore("Other", "o")]));
        expect(alerts.error).not.toHaveBeenCalled();
        expect(stored()).toEqual([lore("Other", "o")]);

        const releaseOwn = beginLocalSend(ref)!;
        await runLocal(nativeFile([lore("Mine", "m")]));
        expect(alerts.error).toHaveBeenCalledWith("generating");
        expect(stored()).toEqual([lore("Other", "o")]);
        releaseOwn();
        releaseOther();
    });
});
