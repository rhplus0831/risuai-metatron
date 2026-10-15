// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationContext } from "../../../shared/jobs.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { loadJobScope, refreshChat } from "../jobs/jobScope.ts";

// `loadJobScope` (`server/src/jobs/jobScope.ts`) reads the chat's characters, not every one: the
// owner, a group's members, the speaker the job names, every message's speaker, and a caller's
// extras; `refreshChat` reads the speakers a chat gained since. Invalid and missing ids are skipped.

function harness() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-job-scope-characters-"));
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const store = createResourceStore({ file: path.join(dir, "resources.sqlite"), kinds });
    const characters = kinds.get("characters")!;
    const first = (name: string) => (store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
    const presetId = first("presets");
    const modelPresetId = first("modelPresets");
    const personaId = first("personas");
    for (const id of ["member", "named", "earlier", "extra", "late", "outsider"]) {
        store.put(
            characters,
            id,
            { chaId: id, type: "character", name: id.toUpperCase(), firstMessage: "", desc: "", globalLore: [] },
            null,
        );
    }
    // A member that is not a resource id and one whose record is gone.
    store.put(
        characters,
        "g",
        { chaId: "g", type: "group", name: "G", firstMessage: "", desc: "", characters: ["member", "", "deleted"] },
        null,
    );
    store.applyChanges({
        chats: [
            {
                characterId: "g",
                chatId: "gk",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "gk",
                            name: "GK",
                            message: [{ role: "char", data: "before", saying: "earlier", chatId: "m1" }],
                            modelPresetId,
                            promptPresetId: presetId,
                            bindedPersona: personaId,
                        },
                    },
                ],
            },
        ],
    });
    const context: GenerationContext = {
        characterId: "g",
        chatId: "gk",
        presetId,
        modelPresetId,
        personaId,
        speakerChaId: "named",
        mode: "normal",
        input: "",
        chatRevision: "",
    };
    return {
        store,
        kinds,
        context,
        dispose() {
            store.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

let current: ReturnType<typeof harness> | null = null;
afterEach(() => {
    vi.restoreAllMocks();
    current?.dispose();
    current = null;
});

const ids = (scope: ReturnType<typeof loadJobScope>) => scope.db.characters.map((entry) => entry.chaId).sort();

describe("the characters of a job's scope", () => {
    it("reads the owner, the members, the named speaker, the chat's speakers, and the extras, and no other", () => {
        const h = (current = harness());
        const readKinds = vi.spyOn(h.store, "readKinds");
        const scope = loadJobScope(h.store, h.kinds, h.context, { characters: () => ["extra", "not an id!"] });

        expect(ids(scope)).toEqual(["earlier", "extra", "g", "member", "named"]);
        for (const [kindList] of readKinds.mock.calls) {
            expect(kindList.map((kind) => kind.name)).not.toContain("characters");
        }
        const characterRevisions = [...scope.revisions!.keys()].filter((key) => key.startsWith("characters/")).sort();
        expect(characterRevisions).toEqual([
            "characters/earlier",
            "characters/extra",
            "characters/g",
            "characters/member",
            "characters/named",
        ]);
    });

    it("reads a speaker the chat gained when the chat is read again", () => {
        const h = (current = harness());
        const scope = loadJobScope(h.store, h.kinds, h.context);
        expect(ids(scope)).not.toContain("late");

        h.store.applyChanges({
            chats: [
                {
                    characterId: "g",
                    chatId: "gk",
                    baseRevision: h.store.chatRevision("g", "gk"),
                    ops: [
                        {
                            op: "append",
                            messages: [
                                { role: "char", data: "after", saying: "late", chatId: "m2" },
                                { role: "char", data: "stray", saying: "", chatId: "m3" },
                            ],
                            anchor: { end: true },
                        },
                    ],
                },
            ],
        });
        expect(refreshChat(h.store, scope)).toBe(true);
        expect(ids(scope)).toEqual(["earlier", "g", "late", "member", "named"]);
        expect(scope.db.characters.find((entry) => entry.chaId === "late")).toMatchObject({ name: "LATE", chats: [] });
    });
});
