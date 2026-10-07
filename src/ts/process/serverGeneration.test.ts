import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";

// Phase 5 slice 9: `sendChatOnServer`, the flag branch's adapter over `runServerJob`: the job kind
// from the send (`preview`, `previewPrompt`, `group` for a group chat, `continue`, else `send`), the
// context (the input with its user message id, an explicit continue target; a preview carries no
// input), a plugin call's identity, the two per-send fields written before the job (`statics.messages`
// through `incrementStatic`, the target's `lastInteraction` through `updateCharacter` by its id, which
// queues the save of a character whether or not it is selected, Phase 6 slice 5), and the result
// mapping (`refused` and `followed` are a definite refusal, `unknown` an ambiguous one, an error or
// lost terminal neither; `done` is ok unless `stopped`; a reply's alternatives go to `addRerolls`
// under its generation, none for a continue; a preview's `result` comes back).

const EPOCH = "11111111-2222-4333-8444-555555555555";
const ref = { chaId: "c", chatId: "k" };

const stubs = vi.hoisted(() => ({
    run: vi.fn<(...args: unknown[]) => Promise<{ outcome: string; terminal: unknown }>>(),
    findChat: vi.fn<() => unknown>(),
    /** The membership (`chatEntry`, Phase 6 slice 9b): a chat may be listed without being loaded. */
    members: new Set<string>(),
    currentChatRef: vi.fn<() => unknown>(() => null),
    incrementStatic: vi.fn(),
    updateCharacter: vi.fn<(chaId: string, patch: Record<string, unknown>) => boolean>(),
    addRerolls: vi.fn(),
    db: { characters: [] as Record<string, unknown>[] },
}));

vi.mock("./serverCommands", () => ({ runServerJob: stubs.run }));
vi.mock("../storage/chatStore.svelte", () => ({
    findChat: stubs.findChat,
    currentChatRef: stubs.currentChatRef,
    chatEntry: (ref: { chaId: string; chatId: string }) =>
        stubs.members.has(`${ref.chaId}/${ref.chatId}`) ? { id: ref.chatId, name: "", fmIndex: -1 } : undefined,
    pinChat: () => () => {},
}));
vi.mock("../storage/collectionStore.svelte", () => ({ incrementStatic: stubs.incrementStatic }));
// The character list as the real module serves it (the records' list, here the stub list).
vi.mock("../storage/characterStore.svelte", () => ({
    updateCharacter: stubs.updateCharacter,
    characterList: () => stubs.db.characters,
}));
// `stores.svelte` runs module effects; the module under test reads the records through the stubs above.
vi.mock("../stores.svelte", () => ({}));
vi.mock("./prereroll", () => ({ addRerolls: stubs.addRerolls }));

type Module = typeof import("./serverGeneration");
let send: Module["sendChatOnServer"];

const done = (extra: Partial<Extract<GenerationTerminalEvent, { type: "done" }>> = {}): GenerationTerminalEvent => ({
    type: "done",
    epoch: EPOCH,
    revision: "e:1:2",
    ...extra,
});
const started = (terminal: unknown) => stubs.run.mockResolvedValueOnce({ outcome: "started", terminal });
const lastRequest = () => stubs.run.mock.calls.at(-1)![2] as { kind: string; context: Record<string, unknown> };
const lastOptions = () => stubs.run.mock.calls.at(-1)![3] as Record<string, unknown>;

beforeEach(async () => {
    vi.resetModules();
    stubs.run.mockReset();
    stubs.findChat.mockReset().mockReturnValue({ message: [] });
    // The chats the store lists: `c/k` and the group's `g/k` (`nobody` has none, `other` has no chat `k`).
    stubs.members.clear();
    stubs.members.add("c/k").add("g/k");
    stubs.currentChatRef.mockReset().mockReturnValue(null);
    // The character module's write by id, applied to the stub list as the real one applies it to the record.
    stubs.updateCharacter.mockReset().mockImplementation((chaId, patch) => {
        const char = stubs.db.characters.find((entry) => entry.chaId === chaId);
        if (!char) {
            return false;
        }
        Object.assign(char, patch);
        return true;
    });
    stubs.db.characters = [
        { chaId: "other", type: "character" },
        { chaId: "c", type: "character", lastInteraction: 1 },
        { chaId: "g", type: "group" },
    ];
    send = (await import("./serverGeneration")).sendChatOnServer;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("sendChatOnServer", () => {
    it("posts a send with the input and its user message id after writing the per-send fields of the target", async () => {
        started(done({ messageId: "r1" }));
        const before = Date.now();
        const result = await send({ target: ref, input: "hi", userMessageId: "u1", continueMessageId: "ignored" });
        expect(result).toEqual({ ok: true, outcome: "started", result: undefined });
        const [char, target, request, options] = stubs.run.mock.calls[0];
        expect(char).toBe(stubs.db.characters[1]);
        expect(target).toEqual(ref);
        expect(request).toEqual({ kind: "send", label: "send", context: { input: "hi", userMessageId: "u1" } });
        expect(options).toEqual({ signal: undefined });
        expect(stubs.incrementStatic).toHaveBeenCalledWith("messages");
        expect(stubs.db.characters[1].lastInteraction as number).toBeGreaterThanOrEqual(before);
        expect(stubs.updateCharacter).toHaveBeenCalledTimes(1);
        expect(stubs.updateCharacter).toHaveBeenCalledWith("c", {
            lastInteraction: stubs.db.characters[1].lastInteraction,
        });
        expect(stubs.addRerolls).not.toHaveBeenCalled();
    });

    it("picks the kind: continue with its explicit target, group for a group chat, and the previews without input", async () => {
        started(done());
        await send({ target: ref, continue: true, continueMessageId: "m9", input: "" });
        expect(lastRequest()).toMatchObject({ kind: "continue", context: { input: "", continueMessageId: "m9" } });
        expect("userMessageId" in lastRequest().context).toBe(false);

        started(done());
        await send({ target: ref, continue: true, input: "more", userMessageId: "u2" });
        expect(lastRequest()).toMatchObject({ kind: "continue", context: { input: "more", userMessageId: "u2" } });
        expect("continueMessageId" in lastRequest().context).toBe(false);

        started(done());
        await send({ target: { chaId: "g", chatId: "k" }, input: "all", userMessageId: "u3", continue: true });
        expect(lastRequest()).toMatchObject({ kind: "group", context: { input: "all", userMessageId: "u3" } });
        expect(stubs.updateCharacter).toHaveBeenLastCalledWith("g", { lastInteraction: expect.any(Number) });

        for (const [arg, kind] of [
            [{ preview: true }, "preview"],
            [{ previewPrompt: true }, "previewPrompt"],
        ] as const) {
            started(done({ result: ["x"] }));
            const result = await send({ target: ref, input: "typed", userMessageId: "u4", ...arg });
            expect(lastRequest()).toEqual({ kind, label: "send", context: { input: "" } });
            expect(result).toEqual({ ok: true, outcome: "started", result: ["x"] });
        }
    });

    it("uses the selected chat without a target, and refuses a missing target or chat before writing anything", async () => {
        stubs.currentChatRef.mockReturnValue(ref);
        started(done());
        await send({ input: "" });
        expect(stubs.run.mock.calls[0][1]).toEqual(ref);

        stubs.currentChatRef.mockReturnValue(null);
        expect(await send({})).toEqual({ ok: false, outcome: "refused", refusal: "definite" });
        expect(await send({ target: { chaId: "nobody", chatId: "k" } })).toEqual({
            ok: false,
            outcome: "refused",
            refusal: "definite",
        });
        // The chat left the list meanwhile (Phase 6 slice 9b: the send checks the membership, not a loaded chat).
        stubs.members.delete("c/k");
        expect(await send({ target: ref })).toEqual({ ok: false, outcome: "refused", refusal: "definite" });
        expect(stubs.run).toHaveBeenCalledTimes(1);
        expect(stubs.incrementStatic).toHaveBeenCalledTimes(1);
    });

    it("hands the signal and a plugin call's identity to the runner", async () => {
        const controller = new AbortController();
        started(done());
        await send({
            target: ref,
            signal: controller.signal,
            pluginContext: { chatRef: ref, presetId: "plug", modelPresetId: "plug-model", personaId: "" } as never,
        });
        expect(lastOptions()).toEqual({
            signal: controller.signal,
            identity: { presetId: "plug", modelPresetId: "plug-model", personaId: null },
        });
    });

    it("maps the outcomes: refused and followed are definite, unknown is ambiguous, a failed or lost job is neither", async () => {
        stubs.run.mockResolvedValueOnce({ outcome: "refused", terminal: null });
        expect(await send({ target: ref })).toEqual({ ok: false, outcome: "refused", refusal: "definite" });
        stubs.run.mockResolvedValueOnce({ outcome: "followed", terminal: done() });
        expect(await send({ target: ref })).toEqual({ ok: false, outcome: "followed", refusal: "definite" });
        stubs.run.mockResolvedValueOnce({ outcome: "unknown", terminal: null });
        expect(await send({ target: ref })).toEqual({ ok: false, outcome: "unknown", refusal: "ambiguous" });
        started({ type: "error", epoch: EPOCH, message: "boom", status: 500, reason: "failed" });
        expect(await send({ target: ref })).toEqual({ ok: false, outcome: "started" });
        started("lost");
        expect(await send({ target: ref })).toEqual({ ok: false, outcome: "started" });
        started(done({ stopped: true, messageId: "r1" }));
        expect(await send({ target: ref })).toEqual({ ok: false, outcome: "started", result: undefined });
    });

    it("registers a reply's alternatives under its generation, but not a continue's", async () => {
        stubs.findChat.mockReturnValue({
            message: [{ chatId: "r1", generationInfo: { generationId: "gen-1" } }, { chatId: "r2" }],
        });
        started(done({ messageId: "r1", alternatives: ["a", "b"] }));
        expect((await send({ target: ref })).ok).toBe(true);
        expect(stubs.addRerolls).toHaveBeenCalledWith("gen-1", ["a", "b"]);

        started(done({ messageId: "r2", alternatives: ["a"] }));
        await send({ target: ref });
        started(done({ messageId: "r1", alternatives: ["c"] }));
        await send({ target: ref, continue: true });
        expect(stubs.addRerolls).toHaveBeenCalledTimes(1);
    });
});
