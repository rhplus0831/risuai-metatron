// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GenerationContext } from "../../../shared/jobs.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import {
    bindingLookup,
    checkChatBinding,
    chatBindingRefusalMessage,
    readChatBindingState,
    type SentBindingIds,
} from "../jobs/chatBinding.ts";
import { GenerationRunnerError } from "../jobs/generationJobs.ts";
import { ChatBindingError, loadJobScope } from "../jobs/jobScope.ts";

// The server's check of a chat's binding (`server/src/jobs/chatBinding.ts`) and the job scope that
// runs it (`loadJobScope`, `server/src/jobs/jobScope.ts`). Pinned:
// - `checkChatBinding` in its three modes: `send` refuses an unset field, a gone record, and a pending
//   review (every problem, in field order) and compares the three sent ids; `chain` does not compare
//   the prompt preset (a `presetChain` pick); `display` compares only a field bound to a record that
//   exists, takes the sent id for an unset or gone field, and ignores the review;
// - the refusal as a sentence (a job's terminal carries only a message);
// - `readChatBindingState` over a real store (the lists as stored, a missing chat as null);
// - `loadJobScope`: the binding is checked after the chat exists and before the records the ids name
//   (a bound record deleted since the job was created is a 409 `gone`, not a 404), the default mode is
//   `send`, a chain pick re-scopes on the picked preset, a display render accepts the tab's id for an
//   unset or gone field but refuses one bound to an existing record, and a sent id naming no record
//   is the usual 404; the job has one persona: the forwarded `db.username` / `db.personaPrompt` and
//   the selected-persona index are the chat's bound persona, whatever `selectedPersonaId` says.

const lookup = bindingLookup([{ id: "p" }, { id: "p2" }], [{ id: "m" }], [{ id: "u" }, null]);
const bound = { modelPresetId: "m", promptPresetId: "p", bindedPersona: "u" };
const sent = (ids: Partial<SentBindingIds> = {}): SentBindingIds => ({
    presetId: "p",
    modelPresetId: "m",
    personaId: "u",
    ...ids,
});

describe("checkChatBinding", () => {
    it("send: refuses an incomplete binding with every problem in field order, and ids that differ from the binding", () => {
        expect(checkChatBinding(bound, lookup, sent(), "send")).toBeNull();
        expect(checkChatBinding({}, lookup, sent(), "send")).toEqual({
            error: "chatBindingIncomplete",
            problems: [
                { field: "modelPresetId", reason: "unset" },
                { field: "promptPresetId", reason: "unset" },
                { field: "personaId", reason: "unset" },
            ],
        });
        expect(
            checkChatBinding(
                { modelPresetId: "m-gone", promptPresetId: " ", bindedPersona: "u", bindingReview: true },
                lookup,
                sent(),
                "send",
            ),
        ).toEqual({
            error: "chatBindingIncomplete",
            problems: [
                { field: "modelPresetId", reason: "gone" },
                { field: "promptPresetId", reason: "unset" },
                { field: "review" },
            ],
        });
        for (const differing of [{ presetId: "p2" }, { modelPresetId: "other" }, { personaId: null }]) {
            expect(checkChatBinding(bound, lookup, sent(differing), "send"), JSON.stringify(differing)).toEqual({
                error: "chatBindingMismatch",
            });
        }
        // The binding wins over the sent ids even when the sent ids name records that exist.
        expect(checkChatBinding({ ...bound, promptPresetId: "p2" }, lookup, sent(), "send")).toEqual({
            error: "chatBindingMismatch",
        });
    });

    it("chain: the binding must be complete and the model preset and persona must match, but the prompt preset is the pick's", () => {
        expect(checkChatBinding(bound, lookup, sent({ presetId: "p2" }), "chain")).toBeNull();
        expect(checkChatBinding(bound, lookup, sent({ presetId: "nope" }), "chain")).toBeNull();
        expect(checkChatBinding(bound, lookup, sent({ modelPresetId: "other" }), "chain")).toEqual({
            error: "chatBindingMismatch",
        });
        expect(checkChatBinding(bound, lookup, sent({ personaId: "other" }), "chain")).toEqual({
            error: "chatBindingMismatch",
        });
        expect(checkChatBinding({ ...bound, bindedPersona: "" }, lookup, sent({ presetId: "p2" }), "chain")).toEqual({
            error: "chatBindingIncomplete",
            problems: [{ field: "personaId", reason: "unset" }],
        });
    });

    it("display: only a field bound to an existing record is compared; an unset or gone field takes the sent id; the review does not matter", () => {
        expect(checkChatBinding(bound, lookup, sent(), "display")).toBeNull();
        expect(checkChatBinding({ ...bound, bindingReview: true }, lookup, sent(), "display")).toBeNull();
        expect(checkChatBinding({}, lookup, sent({ presetId: "anything", personaId: null }), "display")).toBeNull();
        expect(
            checkChatBinding(
                { modelPresetId: "m-gone", promptPresetId: "p", bindedPersona: " " },
                lookup,
                sent({ modelPresetId: "m", personaId: "u" }),
                "display",
            ),
        ).toBeNull();
        for (const differing of [{ presetId: "p2" }, { modelPresetId: "x" }, { personaId: undefined }]) {
            expect(checkChatBinding(bound, lookup, sent(differing), "display"), JSON.stringify(differing)).toEqual({
                error: "chatBindingMismatch",
            });
        }
    });

    it("says the refusal as one sentence", () => {
        expect(
            chatBindingRefusalMessage({
                error: "chatBindingIncomplete",
                problems: [
                    { field: "modelPresetId", reason: "unset" },
                    { field: "personaId", reason: "gone" },
                    { field: "review" },
                ],
            }),
        ).toBe(
            "This chat cannot be sent: its model preset is not set, its persona is deleted, its imported settings need a confirmation",
        );
        expect(chatBindingRefusalMessage({ error: "chatBindingMismatch" })).toMatch(
            /changed since the request was made/,
        );
    });
});

/**
 * A store with the default records, a second persona `u2` and prompt preset `p2`, the character `a`,
 * and its chats: `bound` (the default ids), `loose` (no binding), `review` (bound, confirmation
 * pending), `gone` (bound to records that do not exist).
 */
function harness() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-chat-binding-"));
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const store = createResourceStore({ file: path.join(dir, "resources.sqlite"), kinds });
    const kind = (name: string) => kinds.get(name)!;
    const list = (name: string) => store.get(kind(name), "main")!;
    const presetId = (list("presets").data as { id: string }[])[0].id;
    const modelPresetId = (list("modelPresets").data as { id: string }[])[0].id;
    const personas = list("personas");
    const personaId = (personas.data as { id: string }[])[0].id;
    store.put(
        kind("personas"),
        "main",
        [
            { ...(personas.data as object[])[0], name: "Default", personaPrompt: "default prompt" },
            { id: "u2", name: "Second", personaPrompt: "second prompt" },
        ],
        personas.revision,
    );
    const presets = list("presets");
    store.put(kind("presets"), "main", [...(presets.data as object[]), { id: "p2", name: "P2" }], presets.revision);
    store.put(
        kind("characters"),
        "a",
        { chaId: "a", type: "character", name: "A", firstMessage: "hi", desc: "", globalLore: [] },
        null,
    );
    const create = (id: string, fields: Record<string, unknown>) => ({
        characterId: "a",
        chatId: id,
        baseRevision: null,
        ops: [{ op: "create" as const, chat: { id, name: id, message: [], ...fields } }],
    });
    const binding = { modelPresetId, promptPresetId: presetId, bindedPersona: personaId };
    store.applyChanges({
        chats: [
            create("bound", binding),
            create("loose", {}),
            create("review", { ...binding, bindingReview: true }),
            create("gone", { modelPresetId: "m-gone", promptPresetId: presetId, bindedPersona: "u-gone" }),
        ],
    });
    const context = (chatId: string, extra: Partial<GenerationContext> = {}): GenerationContext => ({
        characterId: "a",
        chatId,
        presetId,
        modelPresetId,
        personaId,
        mode: "normal",
        input: "",
        chatRevision: store.chatRevision("a", chatId) ?? "",
        ...extra,
    });
    return {
        store,
        kinds,
        ids: { presetId, modelPresetId, personaId },
        context,
        dispose() {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

type Harness = ReturnType<typeof harness>;
let current: Harness | null = null;
const open = () => (current = harness());
afterEach(() => {
    current?.dispose();
    current = null;
});

const refusalOf = (run: () => unknown) => {
    try {
        run();
    } catch (error) {
        if (error instanceof ChatBindingError) {
            return { status: error.status, message: error.message, ...error.refusal };
        }
        if (error instanceof GenerationRunnerError) {
            return { status: error.status, message: error.message };
        }
        throw error;
    }
    return null;
};

describe("readChatBindingState", () => {
    it("reads the chat's summary and the stored lists in one go, and null for a chat that does not exist", () => {
        const h = open();
        const state = readChatBindingState(h.store, h.kinds, { characterId: "a", chatId: "bound" });
        expect(state.chat).toMatchObject({
            modelPresetId: h.ids.modelPresetId,
            promptPresetId: h.ids.presetId,
            bindedPersona: h.ids.personaId,
        });
        expect(state.lookup.promptPreset(h.ids.presetId)).toBe(true);
        expect(state.lookup.promptPreset("p2")).toBe(true);
        expect(state.lookup.modelPreset("m-gone")).toBe(false);
        expect(state.lookup.persona("u2")).toBe(true);
        expect(state.lookup.persona("u-gone")).toBe(false);
        expect(readChatBindingState(h.store, h.kinds, { characterId: "a", chatId: "nope" }).chat).toBeNull();
        expect(readChatBindingState(h.store, h.kinds, { characterId: "zz", chatId: "bound" }).chat).toBeNull();
    });
});

describe("loadJobScope and the binding", () => {
    it("loads a chat job on its complete binding (the default `send` mode) with the bound persona as the job's one persona", () => {
        const h = open();
        const scope = loadJobScope(h.store, h.kinds, h.context("bound", { selectedPersonaId: "u2" }));
        expect(scope.promptPreset.id).toBe(h.ids.presetId);
        expect(scope.modelPreset.id).toBe(h.ids.modelPresetId);
        expect(scope.effectivePersona.id).toBe(h.ids.personaId);
        // The forwarded persona roots (the persona prompt gate of `assemble.ts` and `runSetup.ts`) and the
        // selection index are the bound persona's; `selectedPersonaId` is not read.
        expect(scope.db.username).toBe("Default");
        expect(scope.db.personaPrompt).toBe("default prompt");
        expect(scope.db.selectedPersona).toBe(0);
        expect("selectedPersona" in scope).toBe(false);
    });

    it("refuses (409) an incomplete binding with its problems, a pending review, and ids that are not the binding, before any record is resolved", () => {
        const h = open();
        expect(refusalOf(() => loadJobScope(h.store, h.kinds, h.context("loose")))).toEqual({
            status: 409,
            message:
                "This chat cannot be sent: its model preset is not set, its prompt preset is not set, its persona is not set",
            error: "chatBindingIncomplete",
            problems: [
                { field: "modelPresetId", reason: "unset" },
                { field: "promptPresetId", reason: "unset" },
                { field: "personaId", reason: "unset" },
            ],
        });
        expect(refusalOf(() => loadJobScope(h.store, h.kinds, h.context("review")))).toMatchObject({
            status: 409,
            error: "chatBindingIncomplete",
            problems: [{ field: "review" }],
        });
        expect(refusalOf(() => loadJobScope(h.store, h.kinds, h.context("bound", { personaId: "u2" })))).toEqual({
            status: 409,
            message: expect.stringMatching(/changed since the request was made/),
            error: "chatBindingMismatch",
        });
        // A bound record that is gone is the binding's problem (409), not a missing record (404), also
        // when the job's own ids name it (deleted after the job was created).
        expect(
            refusalOf(() =>
                loadJobScope(h.store, h.kinds, h.context("gone", { modelPresetId: "m-gone", personaId: "u-gone" })),
            ),
        ).toMatchObject({
            status: 409,
            error: "chatBindingIncomplete",
            problems: [
                { field: "modelPresetId", reason: "gone" },
                { field: "personaId", reason: "gone" },
            ],
        });
        // A chat that does not exist is still the 404.
        expect(refusalOf(() => loadJobScope(h.store, h.kinds, h.context("nope")))).toEqual({
            status: 404,
            message: "The job's chat no longer exists",
        });
    });

    it("a `chain` re-scope loads the picked prompt preset while the rest of the binding still holds", () => {
        const h = open();
        const picked = loadJobScope(h.store, h.kinds, h.context("bound", { presetId: "p2" }), { binding: "chain" });
        expect(picked.promptPreset.id).toBe("p2");
        expect(picked.effectivePersona.id).toBe(h.ids.personaId);
        expect(refusalOf(() => loadJobScope(h.store, h.kinds, h.context("bound", { presetId: "p2" })))).toMatchObject({
            error: "chatBindingMismatch",
        });
        expect(
            refusalOf(() =>
                loadJobScope(h.store, h.kinds, h.context("bound", { presetId: "p2", personaId: "u2" }), {
                    binding: "chain",
                }),
            ),
        ).toMatchObject({ error: "chatBindingMismatch" });
        expect(
            refusalOf(() =>
                loadJobScope(h.store, h.kinds, h.context("loose", { presetId: "p2" }), { binding: "chain" }),
            ),
        ).toMatchObject({ error: "chatBindingIncomplete" });
        // The pick itself must exist: the usual 404.
        expect(
            refusalOf(() =>
                loadJobScope(h.store, h.kinds, h.context("bound", { presetId: "nope" }), { binding: "chain" }),
            ),
        ).toEqual({ status: 404, message: "The job's preset no longer exists" });
    });

    it("a `display` render takes the sent id for an unset or gone field and a pending review, refuses a bound field sent differently, and 404s a sent id naming no record", () => {
        const h = open();
        const display = { binding: "display" as const };
        const loose = loadJobScope(h.store, h.kinds, h.context("loose", { presetId: "p2", personaId: "u2" }), display);
        expect(loose.promptPreset.id).toBe("p2");
        expect(loose.effectivePersona.id).toBe("u2");
        expect(loose.db.username).toBe("Second");
        expect(loadJobScope(h.store, h.kinds, h.context("review"), display).promptPreset.id).toBe(h.ids.presetId);
        // `gone` binds its prompt preset to the default one: that field must match; the others are free.
        expect(
            loadJobScope(h.store, h.kinds, h.context("gone", { personaId: "u2" }), display).effectivePersona.id,
        ).toBe("u2");
        expect(refusalOf(() => loadJobScope(h.store, h.kinds, h.context("gone", { presetId: "p2" }), display))).toEqual(
            {
                status: 409,
                message: expect.any(String),
                error: "chatBindingMismatch",
            },
        );
        expect(
            refusalOf(() => loadJobScope(h.store, h.kinds, h.context("bound", { personaId: "u2" }), display)),
        ).toMatchObject({ error: "chatBindingMismatch" });
        expect(
            refusalOf(() => loadJobScope(h.store, h.kinds, h.context("loose", { personaId: "nope" }), display)),
        ).toEqual({ status: 404, message: "The job's persona no longer exists" });
    });
});
