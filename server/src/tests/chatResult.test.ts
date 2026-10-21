// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import { NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { RESOURCE_KIND } from "../../../shared/resources.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    createResourceStore,
    isValidResourceId,
    ResourceBatchConflictError,
    type ResourceStore,
} from "../data/resourceStore.ts";
import { applyTriggerChat, type ChatBaseline } from "../jobs/chatResult.ts";
import { GenerationRunnerError, JobWriteConflictError, type RunningJob } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { type JobScope, loadJobScope, refreshChat, scopeChat } from "../jobs/jobScope.ts";

// `applyTriggerChat` (`server/src/jobs/chatResult.ts`), the port of the client's `applyChatResult`,
// over a real in-memory resource store guarded by the real generation lock and a fake job whose
// `write` is the store's `applyChanges` with the job's token (the registry's `writeAsJob`
// translation of a conflict). Expected outcomes follow the client's rules: changed message fields
// merged into the message as stored now (edits made meanwhile kept), removals in one op, new
// messages anchored after their predecessor (counting the ones inserted before them), missing,
// duplicate, or colliding ids re-keyed, chat fields set or unset, a reorder as a whole replacement
// only while the chat is unchanged since the baseline and no job owns a message of it (else dropped
// with a warning while the rest applies), a change to a message another job owns failing the whole
// group (409, nothing written), a gone chat applying nothing, and the recorded replay of the copy's
// `scriptstate` over a concurrent variable write.

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const kind = (name: string) => kinds.get(name)!;
const m = (id: string, data: string, role: "user" | "char" = "user", extra: Record<string, unknown> = {}): Message =>
    ({ role, data, chatId: id, ...extra }) as Message;

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        cleanup();
    }
    vi.restoreAllMocks();
});

function setup() {
    const lock = createGenerationLock();
    const store: ResourceStore = createResourceStore({ file: ":memory:", kinds, guard: lock });
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
                data: { chaId: "c", type: "character", name: "C", firstMessage: "hello" },
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
                            note: "n0",
                            scriptstate: { $a: "1" },
                            // The chat's binding: the job scope checks the context's ids against it.
                            modelPresetId: "m",
                            promptPresetId: "p",
                            bindedPersona: "u",

                            message: [m("m1", "greeting", "char"), m("m2", "hi there"), m("m3", "and more", "char")],
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
    const scope: JobScope = loadJobScope(store, kinds, context);
    const token = "job-token";
    lock.addToken(token);
    const emitted: unknown[] = [];
    const job: RunningJob = {
        id: "job",
        kind: "command",
        context,
        command: { type: "manual", name: "go" },
        hooks: NO_GENERATION_HOOKS,
        channel: {
            notice() {},
            ask: async () => ({ outcome: "aborted" }),
            callback: async () => ({ outcome: "refused", refusal: "unregistered", error: "none" }),
        },
        ownerAttached: () => true,
        epoch: store.epoch(),
        signal: new AbortController().signal,
        emit() {},
        emitRecords: (records) => {
            emitted.push(records);
            return [];
        },
        write: (build) => {
            try {
                return store.applyChanges(build() as never, { epoch: store.epoch(), jobToken: token });
            } catch (error) {
                if (error instanceof ResourceBatchConflictError) {
                    throw new JobWriteConflictError(error.conflicts);
                }
                throw error;
            }
        },
        onClientMessage: () => () => {},
    };
    const read = () => store.readRefs([], { chats: [{ characterId: "c", id: "k" }] }).chats[0];
    const stored = () => read().data as Chat;
    const texts = () => stored().message.map((message) => `${message.role}:${message.data}`);
    const ids = () => stored().message.map((message) => message.chatId!);
    /** The trigger's starting point: the chat as stored now, with its revision. */
    const baseline = (): ChatBaseline => {
        refreshChat(store, scope);
        return { chat: structuredClone(scopeChat(scope)!), revision: scope.chatRevision };
    };
    /** Another client's write meanwhile. */
    const external = (ops: ChatOp[]) =>
        store.applyChanges({
            chats: [{ characterId: "c", chatId: "k", baseRevision: store.chatRevision("c", "k"), ops }],
        });
    const apply = (base: ChatBaseline, result: Chat) => applyTriggerChat({ job, store, scope, lock }, base, result);
    /** Another job owning `messageId`. */
    const lockMessage = (messageId: string) => {
        lock.addToken("other");
        lock.acquire(
            { characterId: "c", chatId: "k", messageId },
            { jobId: "other", generationId: "g", token: "other" },
        );
    };
    return { store, scope, lock, job, emitted, read, stored, texts, ids, baseline, external, apply, lockMessage };
}

describe("applyTriggerChat", () => {
    it("writes nothing when the result equals the baseline", () => {
        const s = setup();
        const base = s.baseline();
        const revision = s.read().revision;
        s.apply(base, structuredClone(base.chat));
        expect(s.read().revision).toBe(revision);
        expect(s.emitted).toEqual([]);
    });

    it("merges only the changed fields into the message as stored now, keeping edits and additions made meanwhile", () => {
        const s = setup();
        const base = s.baseline();
        const result = structuredClone(base.chat);
        result.message[0] = { ...result.message[0], data: "edited by trigger" };
        // Meanwhile: another field of m1, the text of m2, a new m4.
        s.external([
            { op: "setMessage", message: m("m1", "greeting", "char", { name: "ext" }) },
            { op: "setText", id: "m2", text: "external" },
            { op: "append", messages: [m("m4", "late")], anchor: { end: true } },
        ]);
        s.apply(base, result);
        expect(s.texts()).toEqual(["char:edited by trigger", "user:external", "char:and more", "user:late"]);
        expect(s.stored().message[0]).toMatchObject({ chatId: "m1", data: "edited by trigger", name: "ext" });
        expect(s.emitted).toEqual([{ chats: [{ characterId: "c", id: "k" }] }]);
        // The scope follows the write.
        expect(s.scope.chatRevision).toBe(s.read().revision);
    });

    it("removes the messages the trigger dropped in one op, skipping one already gone", () => {
        const s = setup();
        const base = s.baseline();
        const result = structuredClone(base.chat);
        result.message = [result.message[0]];
        s.external([{ op: "remove", ids: ["m3"] }]);
        s.apply(base, result);
        expect(s.ids()).toEqual(["m1"]);
    });

    it("inserts new messages after their predecessor (counting earlier inserts), at the start, or after a message stored meanwhile", () => {
        const s = setup();
        const base = s.baseline();
        const [m1, m2, m3] = base.chat.message;
        const result: Chat = {
            ...structuredClone(base.chat),
            message: [
                { role: "user", data: "X" },
                m1,
                { role: "char", data: "Y1" },
                { role: "char", data: "Y2" },
                m2,
                { role: "user", data: "Z" },
                m3,
            ],
        };
        s.apply(base, result);
        expect(s.texts()).toEqual([
            "user:X",
            "char:greeting",
            "char:Y1",
            "char:Y2",
            "user:hi there",
            "user:Z",
            "char:and more",
        ]);
        const stored = s.ids();
        expect(stored.every((id) => isValidResourceId(id))).toBe(true);
        expect(new Set(stored).size).toBe(7);
    });

    it("re-keys a new message whose id collides with a stored one, a duplicate, or an invalid id", () => {
        const s = setup();
        const base = s.baseline();
        s.external([{ op: "append", messages: [m("m4", "stored meanwhile")], anchor: { end: true } }]);
        const result: Chat = {
            ...structuredClone(base.chat),
            message: [
                ...base.chat.message,
                m("m4", "collides"),
                m("dup", "first dup"),
                m("dup", "second dup"),
                { role: "user", data: "no id", chatId: "" } as Message,
            ],
        };
        s.apply(base, result);
        // The new messages follow their predecessor in the result (m3), before the one appended meanwhile.
        expect(s.texts()).toEqual([
            "char:greeting",
            "user:hi there",
            "char:and more",
            "user:collides",
            "user:first dup",
            "user:second dup",
            "user:no id",
            "user:stored meanwhile",
        ]);
        const ids = s.ids();
        expect(ids[7]).toBe("m4");
        expect(ids[3]).not.toBe("m4");
        expect(ids[4]).toBe("dup");
        expect(ids[5]).not.toBe("dup");
        expect(new Set(ids).size).toBe(8);
        expect(ids.every((id) => isValidResourceId(id))).toBe(true);
    });

    it("sets the changed chat fields and unsets the removed ones, never `message` or `id`", () => {
        const s = setup();
        const base = s.baseline();
        const result = structuredClone(base.chat);
        result.note = "n1";
        result.fmIndex = 2;
        delete result.scriptstate;
        s.apply(base, result);
        expect(s.stored()).toMatchObject({ id: "k", name: "K", note: "n1", fmIndex: 2 });
        expect(s.stored().scriptstate).toBeUndefined();
        expect(s.texts()).toHaveLength(3);
    });

    it("replaces the whole chat for a reorder while the chat is unchanged and no job owns a message of it", () => {
        const s = setup();
        const base = s.baseline();
        const [m1, m2, m3] = structuredClone(base.chat.message);
        const result: Chat = { ...structuredClone(base.chat), message: [m2, { ...m1, data: "edited" }, m3] };
        s.apply(base, result);
        expect(s.texts()).toEqual(["user:hi there", "char:edited", "char:and more"]);
        expect(s.ids()).toEqual(["m2", "m1", "m3"]);
        expect(s.stored()).toMatchObject({ note: "n0", scriptstate: { $a: "1" } });
    });

    it("drops the order change with a warning when the chat changed since the baseline, and applies the rest", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const s = setup();
        const base = s.baseline();
        const [m1, m2, m3] = structuredClone(base.chat.message);
        const result: Chat = {
            ...structuredClone(base.chat),
            message: [m2, m1, { ...m3, data: "edited" }],
            note: "n1",
        };
        s.external([{ op: "setText", id: "m2", text: "external" }]);
        s.apply(base, result);
        expect(s.ids()).toEqual(["m1", "m2", "m3"]);
        expect(s.texts()).toEqual(["char:greeting", "user:external", "char:edited"]);
        expect(s.stored().note).toBe("n1");
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reordered messages .* order change is dropped/));
    });

    it("drops the order change when another job owns a message of the chat, writing nothing when nothing else changed", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const s = setup();
        const base = s.baseline();
        const [m1, m2, m3] = structuredClone(base.chat.message);
        s.lockMessage("m3");
        const revision = s.read().revision;
        s.apply(base, { ...structuredClone(base.chat), message: [m2, m1, m3] });
        expect(s.ids()).toEqual(["m1", "m2", "m3"]);
        expect(s.read().revision).toBe(revision);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("fails the whole group with 409 when the trigger changed a message another job owns: the unrelated append is not written", () => {
        const s = setup();
        const base = s.baseline();
        s.lockMessage("m2");
        const result = structuredClone(base.chat);
        result.message[1] = { ...result.message[1], data: "touching a locked message" };
        result.message.push({ role: "user", data: "unrelated" });
        const revision = s.read().revision;
        let error: unknown;
        try {
            s.apply(base, result);
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(GenerationRunnerError);
        expect((error as GenerationRunnerError).status).toBe(409);
        expect(s.texts()).toEqual(["char:greeting", "user:hi there", "char:and more"]);
        expect(s.read().revision).toBe(revision);
        expect(s.emitted).toEqual([]);
    });

    it("fails with 409 when the trigger removed a message another job owns", () => {
        const s = setup();
        const base = s.baseline();
        s.lockMessage("m2");
        const result = structuredClone(base.chat);
        result.message.splice(1, 1);
        expect(() => s.apply(base, result)).toThrow(GenerationRunnerError);
        expect(s.ids()).toEqual(["m1", "m2", "m3"]);
    });

    it("lets the owning job itself change its message", () => {
        const s = setup();
        const base = s.baseline();
        s.lock.acquire(
            { characterId: "c", chatId: "k", messageId: "m2" },
            { jobId: "job", generationId: "g", token: "job-token" },
        );
        const result = structuredClone(base.chat);
        result.message[1] = { ...result.message[1], data: "my own" };
        s.apply(base, result);
        expect(s.texts()[1]).toBe("user:my own");
    });

    it("applies nothing when the chat is gone", () => {
        const s = setup();
        const base = s.baseline();
        s.external([{ op: "delete" }]);
        const result = structuredClone(base.chat);
        result.message.push({ role: "user", data: "late" });
        expect(() => s.apply(base, result)).not.toThrow();
        expect(s.read().revision).toBeNull();
        expect(s.emitted).toEqual([]);
    });

    it("re-sets the copy's `scriptstate` over a variable written meanwhile (inherited from the tab, recorded)", () => {
        const s = setup();
        const base = s.baseline();
        const result = structuredClone(base.chat);
        result.scriptstate = { $a: "2" };
        s.external([{ op: "meta", set: { scriptstate: { $a: "1", $b: "ext" } } }]);
        s.apply(base, result);
        expect(s.stored().scriptstate).toEqual({ $a: "2" });
    });
});
