// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat, character, groupChat } from "../../../shared/database.ts";
import { type GenerationQuestion, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore } from "../data/resourceStore.ts";
import type { RunningJob } from "../jobs/generationJobs.ts";
import { loadJobScope } from "../jobs/jobScope.ts";
import { createLuaBindings } from "../lua/bindings.ts";
import { createCommandExecutor } from "../prompt/commands.ts";
import type { HostContext } from "../scripts/workerPool.ts";
import { deleteChatThroughTrash } from "./chatDeletion.ts";

// The server command executor (`server/src/prompt/commands.ts`), the port of the
// client's `processMultiCommand`, over the production bindings' services on a real in-memory store
// and a fake job whose questions the test answers (and may use to edit or delete the chat
// meanwhile). The client's rules: pipes split outside quotes, `{{pipe}}`/`{{slot}}` and an empty
// argument taking the pipe, the argument and named arguments through CBS, each command reading the
// chat as stored when it runs (a key added during a question survives `/setvar`; a deleted chat
// consumes the rest of the line), the append-only `/send` and `/sendas`, `/comment` on the last
// message, the `/cut` and `/del` index rules, the alerts and questions as notices and questions
// (`/speak` a `tts` notice, `/?` an `alertMd`), `/trigger` handed to the job's manual run (refused
// for a group), the retired `/multisend` consuming the rest of its line without effect,
// an unknown command `false`, and a question not answered ending the line with its error.

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const kind = (name: string) => kinds.get(name)!;

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        cleanup();
    }
    vi.restoreAllMocks();
});

function setup(options: { type?: "character" | "group" } = {}) {
    const store: ResourceStore = createResourceStore({ file: ":memory:", kinds });
    cleanups.push(() => store.close());
    const singleton = (name: string, data: unknown) => {
        const row = store.get(kind(name), "main");
        store.applyChanges({ ops: [{ kind: kind(name), id: "main", baseRevision: row?.revision ?? null, data }] });
    };
    singleton(RESOURCE_KIND.presets, [{ id: "p", name: "p" }]);
    singleton(RESOURCE_KIND.modelPresets, [{ id: "m", name: "m", aiModel: "gpt-4o" }]);
    singleton("personas", [{ id: "u", name: "Uma" }]);
    store.applyChanges({
        ops: [
            {
                kind: kind(RESOURCE_KIND.characters),
                id: "c",
                baseRevision: null,
                data: {
                    chaId: "c",
                    type: options.type ?? "character",
                    name: "Cora",
                    firstMessage: "hello",
                    globalLore: [],
                    ...(options.type === "group" ? { characters: [] } : {}),
                },
            },
        ],
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "k",
                            name: "K",
                            scriptstate: { $old: "old" },
                            // The chat's binding: the job scope checks the context's ids against it.
                            modelPresetId: "m",
                            promptPresetId: "p",
                            bindedPersona: "u",
                            message: [
                                { role: "char", data: "greeting", chatId: "m1" },
                                { role: "user", data: "hi there", chatId: "m2" },
                                { role: "char", data: "third", chatId: "m3" },
                            ],
                        },
                    },
                ],
            },
        ],
    });
    const context = {
        characterId: "c",
        chatId: "k",
        presetId: "p",
        modelPresetId: "m",
        personaId: "u",
        mode: "manual",
        input: "",
        chatRevision: store.chatRevision("c", "k")!,
    };
    const scope = loadJobScope(store, kinds, context);
    const notices: { kind: string; payload: Record<string, unknown> }[] = [];
    const questions: GenerationQuestion[] = [];
    const state = {
        /** Answers a question; it may edit the store meanwhile. Default: "typed". */
        answer: async (_question: GenerationQuestion): Promise<unknown> => "typed",
        notAnswered: null as null | "cancelled" | "aborted",
    };
    const job: RunningJob = {
        id: "job",
        kind: "command",
        context,
        command: { type: "manual", name: "go" },
        hooks: NO_GENERATION_HOOKS,
        channel: {
            notice: (notice) => notices.push(notice as { kind: string; payload: Record<string, unknown> }),
            ask: async (question) => {
                questions.push(question);
                if (state.notAnswered) {
                    return { outcome: state.notAnswered } as never;
                }
                return { outcome: "answered", value: await state.answer(question) };
            },
            callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "none" }),
        },
        ownerAttached: () => true,
        epoch: store.epoch(),
        signal: new AbortController().signal,
        emit() {},
        emitRecords: () => [],
        write: (build) => store.applyChanges(build() as never, { epoch: store.epoch() }),
        onClientMessage: () => () => {},
    };
    const bindings = createLuaBindings({
        job,
        scope,
        store,
        kinds,
        rootDir: "/nonexistent",
        savePath: "/nonexistent/save",
        llm: {} as never,
        tokens: { count: async (text: string) => text.length, encode: async () => [] } as never,
        runCharacterId: "c",
        engineCharacterId: "c",
    });
    const ctx: HostContext = {
        identity: { characterId: "c", chatId: "k", presetId: "p", personaId: "u" },
        access: "lowLevel",
        signal: job.signal,
        regex: async () => ({ value: false }),
    };
    const manualRuns: string[] = [];
    const storedCharacter = () =>
        store.get(kind(RESOURCE_KIND.characters), "c")?.data as character | groupChat | undefined;
    const executor = createCommandExecutor({
        services: bindings.services,
        ctx,
        character: storedCharacter,
        runManualTrigger: async (name) => {
            manualRuns.push(name);
        },
    });
    const read = () => store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0];
    const chat = () => read().data as Chat | undefined;
    const texts = () => chat()?.message.map((message) => `${message.role}:${message.data}`);
    const external = (ops: unknown[]) =>
        store.applyChanges({
            chats: [{ characterId: "c", chatId: "k", baseRevision: store.chatRevision("c", "k"), ops }],
        });
    const run = (line: string) => executor.processMultiCommand(line);
    return { store, run, notices, questions, state, manualRuns, read, chat, texts, external };
}

describe("the command executor", () => {
    it("keeps inner quotes and unmatched surrounding quotes in arguments", async () => {
        const s = setup();
        expect(await s.run('/pass say "hi" now')).toBe('say "hi" now');
        expect(await s.run('/pass "starts here')).toBe('"starts here');
        expect(await s.run('/pass ends here"')).toBe('ends here"');
    });

    it("preserves surrounding quotes in piped values substituted into {{pipe}} and {{slot}}", async () => {
        const s = setup();
        s.state.answer = async () => '"quoted value"';
        expect(await s.run("/input Value? | /pass {{pipe}}")).toBe('"quoted value"');
        expect(await s.run("/input Value? | /pass {{slot}}")).toBe('"quoted value"');
    });

    it("splits pipes outside quotes, feeds the pipe to an empty argument and to `{{pipe}}`/`{{slot}}`, and runs CBS on the arguments", async () => {
        const s = setup();
        // The quotes guard the split, and their surrounding pair leaves the argument, as in the tab.
        expect(await s.run('/pass "a|b" | /pass [{{slot}}] | /pass')).toBe("[a|b]");
        expect(await s.run("/pass {{char}} | /pass {{pipe}}!")).toBe("Cora!");
        expect(await s.run('/len ["x","y","z"]')).toBe("3");
        expect(await s.run("/pass seed | /len not-json")).toBe("seed");
    });

    it('shows `/echo` and `/popup` as alertNormal notices and keeps the pipe; `/?` is an alertMd notice answering "help"', async () => {
        const s = setup();
        expect(await s.run("/pass kept | /echo hello {{char}} | /popup again")).toBe("kept");
        expect(s.notices).toEqual([
            { kind: "alertNormal", payload: { message: "hello Cora" } },
            { kind: "alertNormal", payload: { message: "again" } },
        ]);
        expect(await s.run("/?")).toBe("help");
        expect(s.notices.at(-1)?.kind).toBe("alertMd");
        expect(String(s.notices.at(-1)?.payload.message)).toContain("# /trigger [name]");
    });

    it("asks `/input` and `/buttons` as questions and pipes the answer; invalid labels ask nothing", async () => {
        const s = setup();
        s.state.answer = async (question) => (question.kind === "alertInput" ? "Ada" : "b");
        expect(await s.run('/input Your name? | /buttons labels=["a","b"] | /pass {{pipe}}')).toBe("b");
        expect(s.questions).toEqual([
            { kind: "alertInput", payload: { message: "Your name?" } },
            { kind: "alertSelect", payload: { options: ["a", "b"] } },
        ]);
        expect(await s.run("/pass kept | /buttons labels=nope")).toBe("kept");
        expect(await s.run("/pass kept | /buttons")).toBe("kept");
        expect(s.questions).toHaveLength(2);
    });

    it("ends the line with an error when a question is not answered", async () => {
        const s = setup();
        s.state.notAnswered = "cancelled";
        await expect(s.run("/input q | /echo never")).rejects.toThrow(/alertInput question ended: cancelled/);
        expect(s.notices).toEqual([]);
    });

    it("speaks through a `tts` notice for the chat's character", async () => {
        const s = setup();
        expect(await s.run("/speak read {{char}}")).toBe("");
        expect(s.notices).toEqual([{ kind: "tts", payload: { chaId: "c", text: "read Cora" } }]);
    });

    it("appends `/send` as the user and `/sendas` as the character at the end, and never sends", async () => {
        const s = setup();
        expect(await s.run("/send hello | /sendas world")).toBe("");
        expect(s.texts()).toEqual(["char:greeting", "user:hi there", "char:third", "user:hello", "char:world"]);
        expect(s.chat()?.message.every((message) => typeof message.chatId === "string" && message.chatId)).toBe(true);
    });

    it("adds a `/comment` to the last message", async () => {
        const s = setup();
        await s.run("/comment noted");
        expect(s.texts()?.at(-1)).toBe("char:third<Comment>\nnoted\n</Comment>");
    });

    it.each([
        ["/cut 1", ["char:greeting", "char:third"]],
        ["/cut 0-2", ["char:greeting", "user:hi there"]],
        // A negative index removes from the end of the history view.
        ["/cut -1", ["char:greeting", "user:hi there"]],
        ["/cut abc-def", ["char:greeting", "user:hi there", "char:third"]],
        ["/cut 3f1c2b6e-1234-4abc-9def-0123456789ab", ["char:greeting", "user:hi there", "char:third"]],
        ["/cut 1-", ["char:greeting", "user:hi there", "char:third"]],
        ["/cut m2", ["char:greeting", "char:third"]],
        ["/del 2", ["user:hi there", "char:third"]],
        ["/del nope", ["char:greeting", "user:hi there", "char:third"]],
    ])("%s leaves %j, as the client's index rules", async (line, expected) => {
        const s = setup();
        await s.run(line);
        expect(s.texts()).toEqual(expected);
    });

    it("merges `/setvar` and `/addvar` into the variables as stored at the write, keeping a key added during a question, and `/getvar` reads it", async () => {
        const s = setup();
        s.state.answer = async () => {
            s.external([{ op: "meta", set: { scriptstate: { $old: "old", $concurrent: "preserve" } } }]);
            return "ok";
        };
        expect(
            await s.run(
                "/input wait | /setvar key=new value | /setvar key=n 2 | /addvar key=n 3 | /getvar key=concurrent",
            ),
        ).toBe("preserve");
        expect(s.chat()?.scriptstate).toEqual({ $old: "old", $concurrent: "preserve", $new: "value", $n: "5" });
        expect(await s.run("/getvar key=missing")).toBe("null");
        // `/addvar` on a missing variable is `Number(undefined) + n`: "NaN", as in the tab.
        await s.run("/addvar key=fresh 1");
        expect(s.chat()?.scriptstate?.$fresh).toBe("NaN");
    });

    it("consumes the rest of the line when the chat is deleted during a question, running nothing more", async () => {
        const s = setup();
        // A spare active chat lets `k` go to the trash and be deleted.
        s.store.applyChanges({
            chats: [
                { characterId: "c", chatId: "spare", baseRevision: null, ops: [{ op: "create", chat: {} as never }] },
            ],
        });
        s.state.answer = async () => {
            deleteChatThroughTrash(s.store, "c", "k");
            return "ok";
        };
        expect(await s.run("/input wait | /echo should-not-run | /send nor this")).toBe("");
        expect(s.notices).toEqual([]);
        expect(s.read().revision).toBeNull();
    });

    it('answers "" when the chat\'s character is gone, so the line is not sent as text', async () => {
        const s = setup();
        const row = s.store.get(kind(RESOURCE_KIND.characters), "c")!;
        s.store.applyChanges({
            ops: [{ kind: kind(RESOURCE_KIND.characters), id: "c", baseRevision: row.revision, delete: true }],
        });
        expect(await s.run("/echo gone")).toBe("");
        expect(s.notices).toEqual([]);
    });

    it("hands `/trigger` to the job's manual run with the CBS'd name and answers undefined; a group refuses it", async () => {
        const s = setup();
        expect(await s.run("/trigger {{char}} thing")).toBeUndefined();
        expect(s.manualRuns).toEqual(["Cora thing"]);
        const group = setup({ type: "group" });
        expect(await group.run("/trigger x")).toBeUndefined();
        expect(group.manualRuns).toEqual([]);
    });

    it("consumes a retired `/multisend` and the rest of its line without effect, and refuses `setinput`/unknown commands with false", async () => {
        const s = setup();
        const revision = s.store.chatRevision("c", "k");
        // The retired segment takes everything after it, pipes and CBS included: nothing later runs,
        // nothing reaches the host or the channel, and the chat is not written.
        for (const line of [
            '/multisend "one|||two"',
            "/multisend clear ||| first ||| second",
            "multisend one | /send leaked",
            "  /multisend",
            "/pass ok | /multisend {{setvar::leaked::1}} | /trigger later | /nosuchcommand",
        ]) {
            expect(await s.run(line), line).toBe("");
        }
        expect(s.manualRuns).toEqual([]);
        expect(s.notices).toEqual([]);
        expect(s.questions).toEqual([]);
        expect(s.texts()).toHaveLength(3);
        expect(s.store.chatRevision("c", "k")).toBe(revision);
        expect(s.chat()?.scriptstate).toEqual({ $old: "old" });
        expect(await s.run("/setinput x")).toBe(false);
        expect(await s.run("/nosuchcommand x")).toBe(false);
        expect(await s.run("/pass ok | /nosuchcommand")).toBe(false);
    });
});
