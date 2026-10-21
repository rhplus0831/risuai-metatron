// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";
import { PRESET_DEFAULTS } from "../../../shared/presets.ts";
import {
    createKindRegistry,
    DEFAULT_RESOURCE_KINDS,
    type ResourceKind,
    type ResourceKindRegistry,
} from "../data/kinds.ts";
import {
    createResourceStore,
    ResourceConflictError,
    type ResourceStore,
    ResourceValidationError,
} from "../data/resourceStore.ts";

// The normalization pass the store runs when it opens and inside `replaceAll`, materialization,
// idempotence and stable ids across restarts, and the rollback when the pass fails.

const defaults = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const allDefaults = [...defaults.values()];
const materialized = DEFAULT_RESOURCE_KINDS.filter((kind) => kind.materialize);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const stores: ResourceStore[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) {
        store.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});
function tempDir() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-pass-"));
    dirs.push(dir);
    return dir;
}
function open(file: string, kinds: ResourceKindRegistry = defaults) {
    const store = createResourceStore({ file, kinds });
    stores.push(store);
    return store;
}
/** Runs `sql` against the file with its own connection, the way an older server would have left rows. */
function raw(file: string, sql: string, ...params: (string | number)[]) {
    const db = new DatabaseSync(file);
    try {
        db.prepare(sql).run(...params);
    } finally {
        db.close();
    }
}
type Row = { kind: string; id: string; seq: number; revision: number; schemaVersion: number; data: string };
function rawRows(file: string): Row[] {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        return db
            .prepare("SELECT kind, id, seq, revision, schemaVersion, data FROM resources ORDER BY seq")
            .all() as Row[];
    } finally {
        db.close();
    }
}
/** Everything a client could observe: the epoch and every record of every kind with its token and data. */
const observe = (store: ResourceStore, kinds: readonly ResourceKind[] = allDefaults) => store.readKinds(kinds);
const parseToken = (token: string) => {
    const [epoch, seq, revision] = token.split(":");
    return { epoch, seq: Number(seq), revision: Number(revision) };
};

describe("a fresh store", () => {
    it("holds every materialize singleton at revision 1 as its normalizer's fixed point, and nothing else", () => {
        const store = open(path.join(tempDir(), "resources.sqlite"));
        expect(store.writeCount()).toBe(materialized.length);
        expect(materialized.length).toBe(22);
        const state = observe(store);
        for (const kind of allDefaults) {
            const records = state.kinds[kind.name];
            if (!kind.materialize) {
                expect(records, kind.name).toEqual([]);
                continue;
            }
            expect(records, kind.name).toHaveLength(1);
            const [record] = records;
            expect(record.id, kind.name).toBe("main");
            expect(parseToken(record.revision), kind.name).toMatchObject({ epoch: state.epoch, revision: 1 });
            // Stored as the normalizer's own output: normalizing it again changes nothing.
            expect(JSON.stringify(kind.normalize(record.data, { id: "main" })), kind.name).toBe(
                JSON.stringify(record.data),
            );
        }
        expect(state.kinds.presets[0].data).toEqual([
            expect.objectContaining({
                id: expect.stringMatching(UUID_V4),
                name: PRESET_DEFAULTS.name,
                temperature: PRESET_DEFAULTS.temperature,
            }),
        ]);
        // The sample singletons hold what their normalizer makes from nothing.
        const fresh = (name: string) =>
            allDefaults.find((kind) => kind.name === name)!.normalize(undefined, { id: "main" });
        const [freshPersona] = fresh("personas") as { name: string }[];
        expect(state.kinds.personas[0].data).toEqual([
            expect.objectContaining({ name: freshPersona.name, id: expect.any(String) }),
        ]);
        expect(state.kinds.ui[0].data).toEqual(fresh("ui"));
    });

    it("reopens without rewriting anything: the epoch, every token, every record, and the generated ids stay", () => {
        const file = path.join(tempDir(), "resources.sqlite");
        const first = observe(open(file));
        stores.pop()!.close();
        for (let start = 0; start < 2; start++) {
            const store = open(file);
            expect(store.writeCount(), `start ${start + 2}`).toBe(0);
            expect(observe(store), `start ${start + 2}`).toEqual(first);
            stores.pop()!.close();
        }
        expect(rawRows(file).map((row) => row.revision)).toEqual(materialized.map(() => 1));
    });
});

describe("the pass at startup", () => {
    it("rewrites a record stored before a default existed once, advancing its revision and keeping its seq, then nothing", () => {
        const file = path.join(tempDir(), "resources.sqlite");
        const before = observe(open(file));
        stores.pop()!.close();
        const seqOf = (kind: string) => rawRows(file).find((row) => row.kind === kind)!.seq;
        const seqs = { ui: seqOf("ui"), presets: seqOf("presets"), hotkeys: seqOf("hotkeys") };
        raw(file, "UPDATE resources SET data = ? WHERE kind = 'ui'", '{"zoomsize":150,"unknownKey":1}');
        // A legacy prompt field is migrated; a model field stored in a prompt preset is dropped.
        raw(
            file,
            "UPDATE resources SET data = ? WHERE kind = 'presets'",
            '[{"name":"old","formatingOrder":["main","chats"],"openrouterProvider":"legacy"}]',
        );
        raw(file, "UPDATE resources SET data = ? WHERE kind = 'hotkeys'", "[]");

        const store = open(file);
        expect(store.writeCount()).toBe(3);
        const after = observe(store);
        expect(after.epoch).toBe(before.epoch);
        const ui = after.kinds.ui[0];
        expect(ui.data).toEqual({ ...(before.kinds.ui[0].data as object), zoomsize: 150 });
        expect(parseToken(ui.revision)).toEqual({ epoch: before.epoch, seq: seqs.ui, revision: 2 });
        const presets = after.kinds.presets[0];
        expect(presets.data).toEqual([
            expect.objectContaining({
                id: expect.stringMatching(UUID_V4),
                name: "old",
                formatingOrder: ["personaPrompt", "main", "chats"],
                temperature: 80,
            }),
        ]);
        expect(Object.hasOwn((presets.data as Record<string, unknown>[])[0], "openrouterProvider")).toBe(false);
        expect(parseToken(presets.revision)).toEqual({ epoch: before.epoch, seq: seqs.presets, revision: 2 });
        expect(after.kinds.hotkeys[0].data).toEqual(before.kinds.hotkeys[0].data);
        expect(parseToken(after.kinds.hotkeys[0].revision)).toEqual({
            epoch: before.epoch,
            seq: seqs.hotkeys,
            revision: 2,
        });
        // Every other record is untouched, token included.
        for (const kind of allDefaults) {
            if (!["ui", "presets", "hotkeys"].includes(kind.name)) {
                expect(after.kinds[kind.name], kind.name).toEqual(before.kinds[kind.name]);
            }
        }
        stores.pop()!.close();

        // The second start finds the fixed points, including the backstop id it assigned.
        const again = open(file);
        expect(again.writeCount()).toBe(0);
        expect(observe(again)).toEqual(after);
    });

    it("keeps a token issued before the restart valid for an untouched record and stale for a rewritten one", () => {
        const file = path.join(tempDir(), "resources.sqlite");
        const store = open(file);
        const ui = defaults.get("ui")!;
        const hotkeys = defaults.get("hotkeys")!;
        const uiToken = store.put(ui, "main", { zoomsize: 120 }, store.get(ui, "main")!.revision).revision;
        const hotkeysToken = store.get(hotkeys, "main")!.revision;
        stores.pop()!.close();
        raw(file, "UPDATE resources SET data = ? WHERE kind = 'hotkeys'", "[]");

        const reopened = open(file);
        expect(reopened.put(ui, "main", { zoomsize: 130 }, uiToken).data).toMatchObject({ zoomsize: 130 });
        let error: unknown;
        try {
            reopened.put(hotkeys, "main", [], hotkeysToken);
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ResourceConflictError);
        expect((error as ResourceConflictError).current).toBe(hotkeysToken.replace(/:1$/, ":2"));
    });

    it("creates a materialize singleton that went missing, at revision 1 of a new incarnation, and leaves the rest", () => {
        const file = path.join(tempDir(), "resources.sqlite");
        const before = observe(open(file));
        stores.pop()!.close();
        raw(file, "DELETE FROM resources WHERE kind = 'personas'");
        const maxSeq = Math.max(...rawRows(file).map((row) => row.seq));

        const store = open(file);
        expect(store.writeCount()).toBe(1);
        const after = observe(store);
        const [personas] = after.kinds.personas;
        expect(personas.data).toEqual([expect.objectContaining({ name: "User", id: expect.stringMatching(UUID_V4) })]);
        expect(parseToken(personas.revision)).toMatchObject({ epoch: before.epoch, revision: 1 });
        expect(parseToken(personas.revision).seq).toBeGreaterThan(maxSeq);
        expect({ ...after.kinds, personas: undefined }).toEqual({ ...before.kinds, personas: undefined });
    });

    it("rewrites a record of an older schema version to the kind's version, and refuses to open on a newer one", () => {
        const file = path.join(tempDir(), "resources.sqlite");
        const doc = (schemaVersion: number): ResourceKind => ({
            name: "doc",
            schemaVersion,
            singleton: true,
            materialize: true,
            normalize: (input) => (input === undefined ? { v: 0 } : input),
        });
        const v1 = createKindRegistry([doc(1)]);
        const v2 = createKindRegistry([doc(2)]);
        const first = open(file, v1);
        const token = first.get(v1.get("doc")!, "main")!.revision;
        stores.pop()!.close();
        expect(rawRows(file)).toMatchObject([{ kind: "doc", revision: 1, schemaVersion: 1, data: '{"v":0}' }]);

        const upgraded = open(file, v2);
        expect(upgraded.writeCount()).toBe(1);
        expect(upgraded.get(v2.get("doc")!, "main")).toEqual({ revision: token.replace(/:1$/, ":2"), data: { v: 0 } });
        stores.pop()!.close();
        expect(rawRows(file)).toMatchObject([{ kind: "doc", revision: 2, schemaVersion: 2, data: '{"v":0}' }]);

        // An older server must not downgrade it silently.
        expect(() => open(file, v1)).toThrow(
            "Stored doc record main fails its normalizer: schema version 2 is newer than 1",
        );
        expect(rawRows(file)).toMatchObject([{ kind: "doc", revision: 2, schemaVersion: 2, data: '{"v":0}' }]);
        // The failed open released the file: the right server opens it again without a rewrite.
        expect(open(file, v2).writeCount()).toBe(0);
    });

    it("stops the start on a record its normalizer rejects, rolls back the rewrites before it, and closes the file", () => {
        const file = path.join(tempDir(), "resources.sqlite");
        const plain: ResourceKind = { name: "docs", schemaVersion: 1, normalize: (input) => input };
        // The next version fills a default, and refuses what the old one accepted.
        const filling: ResourceKind = {
            name: "docs",
            schemaVersion: 1,
            normalize: (input) => {
                const record = input as Record<string, unknown>;
                if (record.bad) {
                    throw new ResourceValidationError("bad is not allowed");
                }
                return { ...record, filled: true };
            },
        };
        const seeded = open(file, createKindRegistry([plain]));
        const tokens = [
            seeded.put(plain, "a", { n: 1 }, null).revision,
            seeded.put(plain, "b", { bad: true }, null).revision,
        ];
        stores.pop()!.close();
        const before = rawRows(file);
        expect(before.map((row) => [row.id, row.revision, row.data])).toEqual([
            ["a", 1, '{"n":1}'],
            ["b", 1, '{"bad":true}'],
        ]);

        let error: unknown;
        try {
            open(file, createKindRegistry([filling]));
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Stored docs record b fails its normalizer: bad is not allowed");
        expect((error as Error).cause).toBeInstanceOf(ResourceValidationError);
        // `a` (seq 1) was rewritten before `b` failed; the rollback undid it, revision included.
        expect(rawRows(file)).toEqual(before);

        // Nothing holds the file: the old server opens it again and the tokens are still current.
        const reopened = open(file, createKindRegistry([plain]));
        expect(reopened.writeCount()).toBe(0);
        expect(reopened.get(plain, "a")).toEqual({ revision: tokens[0], data: { n: 1 } });
        expect(reopened.get(plain, "b")).toEqual({ revision: tokens[1], data: { bad: true } });
    });
});

describe("the pass strips preset credentials", () => {
    // `proxyKey` and `openAIKey` left the preset schema: `normalizePreset` keeps only the prompt
    // fields, so a preset stored with either (from before, or by hand) is rewritten without them
    // at the next start, its id kept. The per-model-preset `proxyKey` map `llmSecrets.modelPresets`
    // is retired: the same pass rewrites a stored llmSecrets record without it, keeping every other
    // field.
    it("rewrites a presets record that carries proxyKey and openAIKey once, keeping ids, and drops the retired llmSecrets.modelPresets map", () => {
        const file = path.join(tempDir(), "resources.sqlite");
        const before = observe(open(file));
        stores.pop()!.close();
        const stored = before.kinds.presets[0].data as Record<string, unknown>[];
        const [first] = stored;
        const map = { [first.id as string]: { proxyKey: "pk-in-map" }, "other-id": { proxyKey: "pk-other" } };
        raw(
            file,
            "UPDATE resources SET data = ? WHERE kind = 'presets'",
            JSON.stringify([
                { ...first, proxyKey: "pk-in-preset", openAIKey: "sk-in-preset" },
                { ...first, id: "second", name: "Second", proxyKey: "", openAIKey: "" },
            ]),
        );
        const secrets = before.kinds.llmSecrets[0].data as Record<string, unknown>;
        raw(
            file,
            "UPDATE resources SET data = ? WHERE kind = 'llmSecrets'",
            JSON.stringify({ ...secrets, modelPresets: map }),
        );

        const store = open(file);
        expect(store.writeCount()).toBe(2);
        const after = observe(store);
        const presets = after.kinds.presets[0];
        expect(presets.data).toEqual([first, { ...first, id: "second", name: "Second" }]);
        for (const preset of presets.data as Record<string, unknown>[]) {
            expect(Object.hasOwn(preset, "proxyKey"), String(preset.id)).toBe(false);
            expect(Object.hasOwn(preset, "openAIKey"), String(preset.id)).toBe(false);
        }
        expect(parseToken(presets.revision)).toMatchObject({ epoch: before.epoch, revision: 2 });
        const llmSecrets = after.kinds.llmSecrets[0];
        expect(llmSecrets.data).toEqual(secrets);
        expect(Object.hasOwn(llmSecrets.data as object, "modelPresets")).toBe(false);
        expect(parseToken(llmSecrets.revision)).toMatchObject({ epoch: before.epoch, revision: 2 });
        stores.pop()!.close();

        // The rewritten record is a fixed point: the next start writes nothing.
        const again = open(file);
        expect(again.writeCount()).toBe(0);
        expect(observe(again)).toEqual(after);
    });
});

describe("the pass inside replaceAll", () => {
    // `pluginStorage` stands in for the former `root` record: a plain record singleton the store does
    // not materialize, whose normalizer keeps the input unchanged.
    const pluginStorage = defaults.get("pluginStorage")!;
    const characters = defaults.get("characters")!;
    /** A store from before the materialized kinds: only `pluginStorage` and `characters` exist. */
    const oldKinds = createKindRegistry([pluginStorage, characters]);

    it("materializes the kinds a snapshot lacks, with the new epoch, and does not fill them from another record", async () => {
        const dir = tempDir();
        const old = open(path.join(dir, "old.sqlite"), oldKinds);
        old.put(pluginStorage, "main", { zoomsize: 150, username: "u" }, null);
        old.put(characters, "c", { chaId: "c", name: "C" }, null);
        const snapshotFile = path.join(dir, "old-backup.sqlite");
        await old.backupTo(snapshotFile);

        const store = open(path.join(dir, "resources.sqlite"));
        const before = observe(store);
        const snapshot = store.readSnapshot(snapshotFile);
        expect(snapshot.rows.map((row) => `${row.kind}/${row.id}`)).toEqual(["pluginStorage/main", "characters/c"]);
        const epoch = store.replaceAll(snapshot);
        expect(epoch).not.toBe(before.epoch);

        const after = observe(store);
        expect(after.epoch).toBe(epoch);
        // A restored row keeps its revision counter under a fresh incarnation (`seq`) and the new epoch.
        expect(after.kinds.pluginStorage).toEqual([
            { id: "main", revision: expect.any(String), data: { zoomsize: 150, username: "u" } },
        ]);
        expect(parseToken(after.kinds.pluginStorage[0].revision)).toMatchObject({ epoch, revision: 1 });
        expect(after.kinds.characters).toEqual([
            { id: "c", revision: expect.any(String), data: normalizeCharacter({ chaId: "c", name: "C" }) },
        ]);
        expect(parseToken(after.kinds.characters[0].revision)).toMatchObject({ epoch, revision: 1 });
        for (const kind of materialized) {
            const [record] = after.kinds[kind.name];
            expect(record, kind.name).toBeDefined();
            expect(parseToken(record.revision), kind.name).toMatchObject({ epoch, revision: 1 });
            expect(JSON.stringify(kind.normalize(record.data, { id: "main" })), kind.name).toBe(
                JSON.stringify(record.data),
            );
        }
        // The section starts from the defaults a fresh store materializes (`before`); the value
        // another record holds is not carried over.
        expect(after.kinds.ui[0].data).toEqual(before.kinds.ui[0].data);
        expect(after.kinds.ui[0].data).not.toMatchObject({ zoomsize: 150 });
        const [freshPreset] = before.kinds.presets[0].data as { name: string }[];
        expect(after.kinds.presets[0].data).toEqual([expect.objectContaining({ name: freshPreset.name })]);
        // The ids materialization generated are the ones every later restart sees.
        const ids = after.kinds.personas[0].data;
        stores.pop()!.close();
        const reopened = open(path.join(dir, "resources.sqlite"));
        expect(reopened.writeCount()).toBe(0);
        expect(reopened.get(defaults.get("personas")!, "main")!.data).toEqual(ids);
    });

    it("restores a backup taken after the pass without rewriting: same rows, revisions, and ids", async () => {
        const dir = tempDir();
        const source = open(path.join(dir, "source.sqlite"));
        const ui = defaults.get("ui")!;
        source.put(ui, "main", { zoomsize: 120 }, source.get(ui, "main")!.revision);
        const expected = observe(source);
        const backupFile = path.join(dir, "backup.sqlite");
        await source.backupTo(backupFile);

        const target = open(path.join(dir, "target.sqlite"));
        const snapshot = target.readSnapshot(backupFile);
        expect(snapshot.rows).toHaveLength(materialized.length);
        for (const row of snapshot.rows) {
            const original = rawRows(path.join(dir, "source.sqlite")).find((r) => r.kind === row.kind)!;
            expect(row.text, row.kind).toBe(original.data);
            expect(row.revision, row.kind).toBe(original.revision);
        }
        const epoch = target.replaceAll(snapshot);
        const restored = observe(target);
        // Same data and revision counters (the ids included); the epoch and the incarnations are new.
        const comparable = (state: typeof expected) =>
            Object.fromEntries(
                Object.entries(state.kinds).map(([kind, records]) => [
                    kind,
                    records.map((record) => ({ ...record, revision: parseToken(record.revision).revision })),
                ]),
            );
        expect(comparable(restored)).toEqual(comparable(expected));
        expect(restored.epoch).toBe(epoch);
        expect(restored.epoch).not.toBe(expected.epoch);
        for (const records of Object.values(restored.kinds)) {
            for (const record of records) {
                expect(parseToken(record.revision).epoch).toBe(epoch);
            }
        }
        expect(restored.kinds.ui[0]).toMatchObject({ revision: expect.stringMatching(/:2$/), data: { zoomsize: 120 } });
    });

    it("rolls the whole restore back when the pass fails: data, epoch, and write count stay, and the store keeps working", async () => {
        const dir = tempDir();
        const old = open(path.join(dir, "old.sqlite"), oldKinds);
        old.put(pluginStorage, "main", { zoomsize: 150 }, null);
        const snapshotFile = path.join(dir, "old-backup.sqlite");
        await old.backupTo(snapshotFile);

        // Materializes at the first open; refuses to materialize again (the restore needs it).
        let opened = false;
        const armed: ResourceKind = {
            name: "armed",
            schemaVersion: 1,
            singleton: true,
            materialize: true,
            normalize: (input) => {
                if (input === undefined && opened) {
                    throw new Error("cannot materialize during the restore");
                }
                return input ?? { armed: true };
            },
        };
        const kinds = createKindRegistry([...DEFAULT_RESOURCE_KINDS, armed]);
        const store = open(path.join(dir, "resources.sqlite"), kinds);
        opened = true;
        const all = [...kinds.values()];
        store.put(pluginStorage, "main", { zoomsize: 90 }, null);
        const before = observe(store, all);
        const writes = store.writeCount();

        const snapshot = store.readSnapshot(snapshotFile);
        expect(() => store.replaceAll(snapshot)).toThrow("cannot materialize during the restore");
        expect(store.epoch()).toBe(before.epoch);
        expect(store.writeCount()).toBe(writes);
        expect(observe(store, all)).toEqual(before);
        // No transaction is left open: an ordinary write commits, and the file agrees.
        const written = store.put(pluginStorage, "main", { zoomsize: 95 }, before.kinds.pluginStorage[0].revision);
        expect(written.revision).toBe(before.kinds.pluginStorage[0].revision.replace(/:1$/, ":2"));
        expect(rawRows(path.join(dir, "resources.sqlite")).find((row) => row.kind === "pluginStorage")!.data).toBe(
            '{"zoomsize":95}',
        );
    });
});

describe("non-finite numbers under a normalizer's JSON copy", () => {
    const providers = defaults.get("providers")!;
    const variables = defaults.get("globalChatVariables")!;
    const message = "Resource data contains a non-finite number";

    it("are refused by put and by a batch, and the record is unchanged", () => {
        const store = open(path.join(tempDir(), "resources.sqlite"));
        const providersBefore = store.get(providers, "main")!;
        const variablesBefore = store.get(variables, "main")!;
        expect(() =>
            store.put(providers, "main", JSON.parse('{"additionalParams":[["x",1e400]]}'), providersBefore.revision),
        ).toThrow(new ResourceValidationError(message));
        expect(() => store.put(variables, "main", JSON.parse('{"x":1e400}'), variablesBefore.revision)).toThrow(
            new ResourceValidationError(message),
        );
        expect(() =>
            store.applyChanges({
                ops: [
                    { kind: variables, id: "main", baseRevision: variablesBefore.revision, data: { ok: "1" } },
                    {
                        kind: providers,
                        id: "main",
                        baseRevision: providersBefore.revision,
                        data: JSON.parse('{"additionalParams":[["x",-1e400]]}'),
                    },
                ],
            }),
        ).toThrow(new ResourceValidationError(`ops[1]: ${message}`));
        expect(store.get(providers, "main")).toEqual(providersBefore);
        expect(store.get(variables, "main")).toEqual(variablesBefore);
    });

    it("are refused by readSnapshot, naming the row", async () => {
        const dir = tempDir();
        const store = open(path.join(dir, "resources.sqlite"));
        const file = path.join(dir, "backup.sqlite");
        await store.backupTo(file);
        expect(store.readSnapshot(file).rows).toHaveLength(materialized.length);
        raw(file, "UPDATE resources SET data = ? WHERE kind = 'globalChatVariables'", '{"x":1e400}');
        const row = rawRows(file).findIndex((r) => r.kind === "globalChatVariables") + 1;
        expect(() => store.readSnapshot(file)).toThrow(new ResourceValidationError(`row ${row}: ${message}`));
    });
});
