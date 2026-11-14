import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../../shared/database.ts";
import type { InputHook } from "../../../shared/inputHooks.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { warmModules } from "../storage/tests/mutationStoresHarness";
import type { requestDataResponse, StreamResponseChunk } from "./request/request";

const io = vi.hoisted(() => ({
    request: vi.fn<typeof import("./request/request").requestChatData>(),
    count: vi.fn<typeof import("../tokenizer").countTokensInScope>(),
}));
vi.mock("./request/request", async () =>
    (await import("./request/tests/requestMock")).createRequestMock({ requestChatData: io.request }),
);

const ref = { chaId: "character", chatId: "story" };
const other = { chaId: "character", chatId: "other" };
const messages: Message[] = [
    { chatId: "first", role: "user", data: "The door opens." },
    {
        chatId: "last",
        role: "char",
        data: "Someone enters.",
        translation: {
            text: "Quelqu'un entre.",
            sourceHash: translationSourceHash("Someone enters."),
            targetLanguage: "French",
            translatedAt: 1,
        },
    },
];
const hook: InputHook = {
    id: "rewrite",
    name: "Rewrite",
    type: "draft",
    prompt: "Rewrite the message.",
    model: { mode: "inherit" },
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

async function load() {
    return {
        runner: await import("./inputHooks"),
        chat: await import("../storage/chatStore.svelte"),
        selection: await import("../storage/selection.svelte"),
        fixtures: await import("../storage/tests/installFlatDatabase"),
        history: await import("../../../shared/translation/historySlots.ts"),
        tokenizer: await import("../tokenizer"),
    };
}
let m: Awaited<ReturnType<typeof load>>;
beforeAll(() => warmModules(load));
beforeEach(async () => {
    vi.resetModules();
    io.request.mockReset().mockResolvedValue({ type: "success", result: "Rewritten text" });
    io.count.mockReset().mockResolvedValue(1);
    m = await load();
    vi.spyOn(m.tokenizer, "countTokensInScope").mockImplementation(io.count);
    seed();
});
afterEach(() => vi.restoreAllMocks());

function seed() {
    const chats = [ref.chatId, other.chatId].map((id) => ({
        id,
        name: id,
        note: "",
        localLore: [],
        message: id === ref.chatId ? structuredClone(messages) : [],
        promptPresetId: id === ref.chatId ? "chat-preset" : "selected-preset",
        modelPresetId: id === ref.chatId ? "chat-preset" : "selected-preset",
        bindedPersona: "persona",
    }));
    m.fixtures.installFlatDatabaseWithChats({
        translatorHistoryMaxTokens: 4,
        botPresets: [
            { id: "chat-preset", name: "Chat preset", aiModel: "gpt-4o" },
            { id: "selected-preset", name: "Selected preset", aiModel: "gpt-4.1" },
        ],
        personas: [{ id: "persona", name: "Persona", personaPrompt: "", icon: "", note: "" }],
        characters: [{ chaId: ref.chaId, name: "Character", type: "character", globalLore: [], chats }],
    });
    m.chat.seedChats(
        chats.map(({ id }) => ({ characterId: ref.chaId, id, revision: "epoch:1:1" })),
        [{ characterId: ref.chaId, ids: chats.map(({ id }) => id), revision: "epoch:1:1" }],
    );
    // The runner must use ref's binding even when the tab has another chat open.
    m.selection.selectCharacter(ref.chaId);
    m.chat.selectChat(other.chaId, other.chatId);
}

function input() {
    return { ref, content: "Original text", draft: "Current draft", signal: new AbortController().signal };
}

/** Observe the real per-chat pin and wrap its public release; isChatPinned reads character pins only. */
function observePin() {
    const release = vi.fn<() => void>();
    const pinChat = m.chat.pinChat;
    const pin = vi.spyOn(m.chat, "pinChat").mockImplementation((target) => {
        release.mockImplementation(pinChat(target));
        return release;
    });
    return { pin, release };
}

describe("runInputHook", () => {
    it("requests plain prompts on otherAx with the captured chat and a pin until the trimmed reply", async () => {
        const pending = deferred<requestDataResponse>();
        io.request.mockReturnValueOnce(pending.promise);
        const history = vi.spyOn(m.history, "buildTranslatorHistory");
        const { pin, release } = observePin();
        const values = input();
        const owner = m.chat.chatOwnerToken(ref.chaId);
        const run = m.runner.runInputHook(hook, values);

        expect(pin).toHaveBeenCalledExactlyOnceWith(ref);
        expect(release).not.toHaveBeenCalled();
        expect(io.request).toHaveBeenCalledExactlyOnceWith(
            {
                formated: [
                    { role: "system", content: "Rewrite the message." },
                    { role: "user", content: "Original text" },
                ],
                bias: {},
                chatRef: ref,
                chatOwner: owner,
                tools: [],
                useStreaming: false,
                noMultiGen: true,
            },
            "otherAx",
            values.signal,
        );
        expect(io.request.mock.calls[0][0]).not.toHaveProperty("profileId");
        expect(history).not.toHaveBeenCalled();
        expect(io.count).not.toHaveBeenCalled();

        pending.resolve({ type: "success", result: "  Rewritten text\n" });
        expect(await run).toBe("Rewritten text");
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("fills content and draft slots, passes the hook profile, and returns an empty success", async () => {
        io.request.mockResolvedValueOnce({ type: "success", result: "" });
        const history = vi.spyOn(m.history, "buildTranslatorHistory");
        const values = input();
        expect(
            await m.runner.runInputHook(
                {
                    ...hook,
                    prompt: "Rewrite {{slot::content}}\nDraft: {{slot::draft}}",
                    model: { mode: "profile", profileId: "hook-profile" },
                },
                values,
            ),
        ).toBe("");
        expect(io.request).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                formated: [{ role: "user", content: "Rewrite Original text\nDraft: Current draft" }],
                profileId: "hook-profile",
            }),
            "otherAx",
            values.signal,
        );
        expect(history).not.toHaveBeenCalled();
        expect(io.count).not.toHaveBeenCalled();
    });

    it("builds budgeted history through the last message with the chat's captured owner and token scope", async () => {
        const firstCount = deferred<number>();
        io.count.mockReturnValueOnce(firstCount.promise);
        const history = vi.spyOn(m.history, "buildTranslatorHistory");
        const scope = vi.spyOn(m.tokenizer, "tabTokenScope");
        const { pin, release } = observePin();
        const values = input();
        const owner = m.chat.chatOwnerToken(ref.chaId);
        const run = m.runner.runInputHook(
            {
                ...hook,
                prompt: "{{slot::history::2}}Translated: {{slot::historytrans::1}}Input: {{slot::content}}",
            },
            values,
        );

        expect(pin).toHaveBeenCalledExactlyOnceWith(ref);
        expect(release).not.toHaveBeenCalled();
        expect(io.request).not.toHaveBeenCalled();
        expect(scope).toHaveBeenCalledExactlyOnceWith({ presetId: "chat-preset", modelPresetId: "chat-preset" });
        expect(history).toHaveBeenCalledExactlyOnceWith({
            messages,
            messageIndex: 2,
            counts: expect.toSatisfy((counts: number[]) => [...counts].sort().join() === "1,2"),
            maxTokens: 4,
            countTokens: expect.any(Function),
        });

        // A new installation changes the owner while history awaits its token count.
        seed();
        expect(m.chat.chatOwnerToken(ref.chaId)).not.toBe(owner);
        firstCount.resolve(1);
        expect(await run).toBe("Rewritten text");
        expect(io.count.mock.calls).toEqual(
            [
                "user: The door opens.\n\n---\n\n",
                "user: \n\n---\n\n",
                "char: Someone enters.\n\n---\n\n",
                "char: Quelqu'un entre.\n\n---\n\n",
            ].map((text) => [text, expect.objectContaining({ aiModel: "gpt-4o" }), values.signal]),
        );
        expect(io.request).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                formated: [
                    {
                        role: "user",
                        content:
                            "user: The door opens.\n\n---\n\nchar: Someone enters.\n\n---\n\n" +
                            "Translated: char: Quelqu'un entre.\n\n---\n\nInput: Original text",
                    },
                ],
                chatRef: ref,
                chatOwner: owner,
            }),
            "otherAx",
            values.signal,
        );
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("rejects a history request when the chat is not loaded", async () => {
        // Install only a list entry, as a chat whose messages have not been loaded.
        const unloaded = { chaId: ref.chaId, chatId: "unloaded" };
        m.chat.assembleChats(
            [{ chaId: ref.chaId }],
            [
                {
                    characterId: ref.chaId,
                    id: unloaded.chatId,
                    revision: "epoch:1:1",
                    name: "Unloaded chat",
                    fmIndex: 0,
                    promptPresetId: "chat-preset",
                    modelPresetId: "chat-preset",
                    bindedPersona: "persona",
                },
            ],
            [{ characterId: ref.chaId, ids: [unloaded.chatId], revision: "epoch:1:1" }],
        );
        expect(m.chat.findChat(unloaded)).toBeUndefined();
        await expect(
            m.runner.runInputHook({ ...hook, prompt: "{{slot::history::1}}" }, { ...input(), ref: unloaded }),
        ).rejects.toThrow();
        expect(io.request).not.toHaveBeenCalled();
        expect(io.count).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: "a failure with its text",
            response: { type: "fail", result: "Provider refused the hook" },
            error: new Error("Provider refused the hook"),
        },
        {
            name: "a multiline result",
            response: {
                type: "multiline",
                result: [
                    ["char", "First"],
                    ["char", "Second"],
                ],
            },
            error: undefined,
        },
    ] satisfies { name: string; response: requestDataResponse; error: Error | undefined }[])(
        "rejects $name and releases the request's pin",
        async ({ response, error }) => {
            const pending = deferred<requestDataResponse>();
            io.request.mockReturnValueOnce(pending.promise);
            const { pin, release } = observePin();
            const run = m.runner.runInputHook(hook, input());
            expect(pin).toHaveBeenCalledExactlyOnceWith(ref);
            expect(release).not.toHaveBeenCalled();
            const rejected = expect(run).rejects.toThrow(error);
            pending.resolve(response);
            await rejected;
            expect(release).toHaveBeenCalledTimes(1);
        },
    );

    it("cancels a returned stream before rejecting and releasing its pin", async () => {
        const cancelled = deferred<void>();
        const cancel = vi.fn(() => cancelled.promise);
        io.request.mockResolvedValueOnce({
            type: "streaming",
            result: new ReadableStream<StreamResponseChunk>({ cancel }),
        });
        const { release } = observePin();
        const rejected = expect(m.runner.runInputHook(hook, input())).rejects.toThrow();
        try {
            // The already-resolved request resumes before this microtask; cancellation stays pending.
            await Promise.resolve();
            expect(cancel).toHaveBeenCalledTimes(1);
            expect(release).not.toHaveBeenCalled();
        } finally {
            cancelled.resolve();
            await rejected;
        }
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("passes the signal and surfaces an abort even if the request returns success, releasing its pin", async () => {
        const pending = deferred<requestDataResponse>();
        io.request.mockReturnValueOnce(pending.promise);
        const controller = new AbortController();
        const { pin, release } = observePin();
        const run = m.runner.runInputHook(hook, { ...input(), signal: controller.signal });
        expect(pin).toHaveBeenCalledExactlyOnceWith(ref);
        expect(io.request.mock.calls[0][2]).toBe(controller.signal);
        expect(release).not.toHaveBeenCalled();

        const rejected = expect(run).rejects.toThrow();
        controller.abort(new DOMException("Stopped the input hook", "AbortError"));
        expect(release).not.toHaveBeenCalled();
        pending.resolve({ type: "success", result: "Late reply" });
        await rejected;
        expect(controller.signal.aborted).toBe(true);
        expect(release).toHaveBeenCalledTimes(1);
    });
});
