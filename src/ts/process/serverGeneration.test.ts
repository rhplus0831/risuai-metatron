import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";

// `sendChatOnServer`, the flag branch's adapter over `runServerJob`: the job kind from the send
// (`preview`, `previewPrompt`, `group` for a group chat, `continue`, else `send`), the context (the
// input with its user message id, an explicit continue target; a preview carries no input), a
// plugin call's identity, the one per-send field written before the job (`statics.messages` through
// `incrementStatic`; the target's `lastInteraction` is the server job's to stamp, so the tab
// touches no character record and uploads none before the job), and the result mapping (`refused`
// and `followed` are a definite refusal, `unknown` an ambiguous one, an error or lost terminal
// neither; `settled` unless the create got no answer or the follow was lost; `requestUncertain`
// while this send's own request has no known end; a `replayed` job is this send's own, its chat
// read's success passed on as `reconciled`; `done` is ok unless `stopped`; a reply's alternatives go to `addRerolls` under its
// generation, none for a continue; a preview's `result` comes back).

const EPOCH = "11111111-2222-4333-8444-555555555555";
const ref = { chaId: "c", chatId: "k" };

const stubs = vi.hoisted(() => ({
    run: vi.fn<
        (...args: unknown[]) => Promise<{
            outcome: string;
            terminal: unknown;
            blockedChats?: unknown;
            requestUncertain?: boolean;
            reconciled?: boolean;
        }>
    >(),
    findChat: vi.fn<() => unknown>(),
    /** The membership (`chatEntry`): a chat may be listed without being loaded. */
    members: new Set<string>(),
    currentChatRef: vi.fn<() => unknown>(() => null),
    incrementStatic: vi.fn(),
    addRerolls: vi.fn(),
    db: { characters: [] as Record<string, unknown>[] },
}));

vi.mock("./serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock({
        // The stub answers loosely typed outcomes the mapping cases need.
        runServerJob: stubs.run as unknown as typeof import("./serverCommands").runServerJob,
    }),
);
vi.mock("../storage/chatStore.svelte", () => ({
    findChat: stubs.findChat,
    currentChatRef: stubs.currentChatRef,
    chatEntry: (ref: { chaId: string; chatId: string }) =>
        stubs.members.has(`${ref.chaId}/${ref.chatId}`) ? { id: ref.chatId, name: "", fmIndex: -1 } : undefined,
    pinChat: () => () => {},
}));
vi.mock("../storage/collectionStore.svelte", () => ({ incrementStatic: stubs.incrementStatic }));
// The character list as the real module serves it (the records' list, here the stub list). No
// write of the module is stubbed: the send is not expected to call one.
vi.mock("../storage/characterStore.svelte", () => ({
    characterList: () => stubs.db.characters,
}));
// `stores.svelte` runs module effects; the module under test reads the records through the stubs above.
vi.mock("../stores.svelte", async () => (await import("src/ts/tests/storesMock")).createStoresMock({}));
vi.mock("./prereroll", () => ({ addRerolls: stubs.addRerolls }));

type Module = typeof import("./serverGeneration");
let send: Module["sendChatOnServer"];

const done = (extra: Partial<Extract<GenerationTerminalEvent, { type: "done" }>> = {}): GenerationTerminalEvent => ({
    type: "done",
    epoch: EPOCH,
    revision: "e:1:2",
    ...extra,
});
const started = (terminal: unknown) =>
    stubs.run.mockResolvedValueOnce({ outcome: "started", terminal, requestUncertain: terminal === "lost" });
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

/** The character records as the test seeded them: a send changes none of them (the server stamps). */
const seededCharacters = () => [
    { chaId: "other", type: "character" },
    { chaId: "c", type: "character", lastInteraction: 1 },
    { chaId: "g", type: "group" },
];

describe("sendChatOnServer", () => {
    it("returns the result of this send's owned ended replay", async () => {
        const result = ["the preview already completed"];
        stubs.run.mockResolvedValueOnce({ outcome: "replayed", terminal: done({ result }), requestUncertain: false });
        expect(await send({ target: ref, preview: true, requestId: "preview-request" })).toEqual({
            ok: true,
            outcome: "replayed",
            settled: true,
            result,
        });
    });

    it("posts a send with the input and its user message id after counting the send, without touching the target record", async () => {
        started(done({ messageId: "r1" }));
        const result = await send({ target: ref, input: "hi", userMessageId: "u1", continueMessageId: "ignored" });
        expect(result).toEqual({ ok: true, outcome: "started", settled: true, result: undefined });
        const [char, target, request, options] = stubs.run.mock.calls[0];
        expect(char).toBe(stubs.db.characters[1]);
        expect(target).toEqual(ref);
        expect(request).toEqual({ kind: "send", label: "send", context: { input: "hi", userMessageId: "u1" } });
        expect(options).toEqual({ signal: undefined });
        expect(stubs.incrementStatic).toHaveBeenCalledTimes(1);
        expect(stubs.incrementStatic).toHaveBeenCalledWith("messages");
        // The stamp is the job's (a server field patch), so no character record becomes dirty and
        // none is uploaded before the job: the target keeps its seeded stamp, the others are untouched.
        expect(stubs.db.characters).toEqual(seededCharacters());
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
        // The group record is not stamped by the tab either.
        expect(stubs.db.characters).toEqual(seededCharacters());

        for (const [arg, kind] of [
            [{ preview: true }, "preview"],
            [{ previewPrompt: true }, "previewPrompt"],
        ] as const) {
            started(done({ result: ["x"] }));
            const result = await send({ target: ref, input: "typed", userMessageId: "u4", ...arg });
            expect(lastRequest()).toEqual({ kind, label: "send", context: { input: "" } });
            expect(result).toEqual({ ok: true, outcome: "started", settled: true, result: ["x"] });
        }
        expect(stubs.incrementStatic).toHaveBeenCalledTimes(5);
        expect(stubs.db.characters).toEqual(seededCharacters());
    });

    it("uses the selected chat without a target, and refuses a missing target or chat before writing anything", async () => {
        stubs.currentChatRef.mockReturnValue(ref);
        started(done());
        await send({ input: "" });
        expect(stubs.run.mock.calls[0][1]).toEqual(ref);

        stubs.currentChatRef.mockReturnValue(null);
        const definite = { ok: false, outcome: "refused", settled: true, refusal: "definite", requestUncertain: false };
        expect(await send({})).toEqual(definite);
        expect(await send({ target: { chaId: "nobody", chatId: "k" } })).toEqual(definite);
        // The chat left the list meanwhile (the send checks the membership, not a loaded chat).
        stubs.members.delete("c/k");
        expect(await send({ target: ref })).toEqual(definite);
        // A request whose earlier attempt has no known end stays uncertain: the refusal ran nothing new.
        expect(await send({ target: ref, requestId: "r1", requestUncertain: true })).toEqual({
            ok: false,
            outcome: "refused",
            settled: false,
            refusal: "ambiguous",
            requestUncertain: true,
        });
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
        // The send's request id, and whether an earlier attempt under it is uncertain, go to the runner.
        started(done());
        await send({ target: ref, requestId: "r1", requestUncertain: true });
        expect(lastRequest()).toMatchObject({ requestId: "r1", requestUncertain: true });
    });

    it("maps the outcomes: refused and followed are definite, unknown is ambiguous, a failed or lost job is neither; an unanswered create, a lost follow, or a replay whose chat read failed is unsettled", async () => {
        const blockedChats = [{ chaId: "c2", chatId: "k2" }];
        stubs.run.mockResolvedValueOnce({ outcome: "refused", terminal: null, blockedChats, requestUncertain: false });
        expect(await send({ target: ref })).toEqual({
            ok: false,
            outcome: "refused",
            settled: true,
            refusal: "definite",
            requestUncertain: false,
            blockedChats,
        });
        stubs.run.mockResolvedValueOnce({ outcome: "followed", terminal: done(), requestUncertain: false });
        expect(await send({ target: ref })).toEqual({
            ok: false,
            outcome: "followed",
            settled: true,
            refusal: "definite",
            requestUncertain: false,
        });
        // A lost follow of this tab's other action leaves that action open, not this send's request.
        stubs.run.mockResolvedValueOnce({ outcome: "followed", terminal: "lost", requestUncertain: false });
        expect(await send({ target: ref })).toEqual({
            ok: false,
            outcome: "followed",
            settled: false,
            refusal: "definite",
            requestUncertain: false,
        });
        stubs.run.mockResolvedValueOnce({ outcome: "unknown", terminal: null, requestUncertain: true });
        expect(await send({ target: ref })).toEqual({
            ok: false,
            outcome: "unknown",
            settled: false,
            refusal: "ambiguous",
            requestUncertain: true,
        });
        started({ type: "error", epoch: EPOCH, message: "boom", status: 500, reason: "failed" });
        expect(await send({ target: ref })).toEqual({
            ok: false,
            outcome: "started",
            settled: true,
            requestUncertain: false,
        });
        started("lost");
        expect(await send({ target: ref })).toEqual({
            ok: false,
            outcome: "started",
            settled: false,
            requestUncertain: true,
        });
        // A replay is this send's own job: its terminal maps as a started one's does, and a replay settled
        // from a chat read passes on whether that read succeeded.
        stubs.run.mockResolvedValueOnce({ outcome: "replayed", terminal: done(), requestUncertain: false });
        expect(await send({ target: ref })).toEqual({
            ok: true,
            outcome: "replayed",
            settled: true,
            result: undefined,
        });
        stubs.run.mockResolvedValueOnce({
            outcome: "replayed",
            terminal: null,
            reconciled: true,
            requestUncertain: false,
        });
        expect(await send({ target: ref })).toEqual({
            ok: false,
            outcome: "replayed",
            settled: true,
            requestUncertain: false,
            reconciled: true,
        });
        stubs.run.mockResolvedValueOnce({
            outcome: "replayed",
            terminal: null,
            reconciled: false,
            requestUncertain: true,
        });
        expect(await send({ target: ref })).toEqual({
            ok: false,
            outcome: "replayed",
            settled: false,
            requestUncertain: true,
            reconciled: false,
        });
        started(done({ stopped: true, messageId: "r1" }));
        expect(await send({ target: ref })).toEqual({
            ok: false,
            outcome: "started",
            settled: true,
            result: undefined,
        });
    });

    it("registers a reply's alternatives under its generation, but not a continue's", async () => {
        stubs.findChat.mockReturnValue({
            message: [{ chatId: "r1", generationInfo: { generationId: "gen-1" } }, { chatId: "r2" }],
        });
        started(done({ messageId: "r1", alternatives: ["a", "b"] }));
        expect((await send({ target: ref })).ok).toBe(true);
        expect(stubs.addRerolls).toHaveBeenCalledWith("gen-1", ["a", "b"], ref, "r1");

        started(done({ messageId: "r2", alternatives: ["a"] }));
        await send({ target: ref });
        started(done({ messageId: "r1", alternatives: ["c"] }));
        await send({ target: ref, continue: true });
        expect(stubs.addRerolls).toHaveBeenCalledTimes(1);
    });
});
