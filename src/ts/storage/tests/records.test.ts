import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CredentialRefusedError,
    DetachedWrapperError,
    DuplicateIdError,
    applyRaw,
    batchRecordWrites,
    hasRecord,
    initializeRecords,
    isRecordWrapper,
    moveRecordListItem,
    recordData,
    replaceRecord,
    replaceRecordList,
    resetRecords,
    setRecordWriteListener,
    trackedRecord,
    writeRecordField,
    type RecordKind,
} from "../records.svelte";
import { llmSecretState } from "../llmSecrets.svelte";

// Phase 6 slice 4 (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/settings-ownership.md`):
// the production records module (`records.svelte.ts`), checked directly. These are the regressions
// for the reproductions of Astra's challenge and its first re-check (mutator resurrection and stale
// insertion, credential routing on every write shape, descriptor writes, whole `llmSecrets`
// replacements, list replacement displacement, absent-section creation, the reset), and the record
// notification contract (`batchRecordWrites`). A refusal is checked for zero side effects: the record
// text unchanged, no record notification, no credential operation.

let notified: RecordKind[] = [];

const text = (kind: RecordKind) => JSON.stringify(recordData(kind));
const queued = () => llmSecretState.queue.map((op) => op.request);
const entry = (field: "modelPresets" | "customModels", id: string, value: string) => ({
    kind: "put",
    path: { kind: "entry", field, id },
    value,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Runs `write`, which must throw `errorClass`, and checks that nothing changed anywhere. */
function refused(kind: RecordKind, write: () => unknown, errorClass: new (...args: any[]) => Error = Error) {
    const before = text(kind);
    const queue = queued().length;
    const count = notified.length;
    expect(write).toThrow(errorClass);
    expect(text(kind)).toBe(before);
    expect(queued()).toHaveLength(queue);
    expect(notified).toHaveLength(count);
}

beforeEach(() => {
    resetRecords();
    llmSecretState.queue.splice(0);
    notified = [];
    setRecordWriteListener((kind) => notified.push(kind));
});

afterEach(() => {
    resetRecords();
    llmSecretState.queue.splice(0);
});

describe("array mutators (challenge point 1)", () => {
    it("refuses to re-insert a removed element's wrapper once its displacement expired", async () => {
        initializeRecords({
            modules: [
                { id: "a", name: "A" },
                { id: "b", name: "B" },
            ],
        });
        const modules = trackedRecord<any[]>("modules")!;
        const retained = modules[0];
        modules.splice(0, 1);
        expect(JSON.parse(text("modules"))).toEqual([{ id: "b", name: "B" }]);
        await tick();
        notified = [];
        refused("modules", () => modules.splice(0, 0, retained), DetachedWrapperError);
        refused("modules", () => modules.push(retained), DetachedWrapperError);
        expect(() => (retained.name = "back")).toThrow(DetachedWrapperError);
    });

    it("inserts a retained wrapper's current contents after a server copy replaced the record", () => {
        initializeRecords({
            modules: [{ id: "a", name: "old" }],
            presets: [{ id: "p1", name: "old" }],
        });
        const module = trackedRecord<any[]>("modules")![0];
        const preset = trackedRecord<any[]>("presets")![0];
        applyRaw("modules", [{ id: "a", name: "new" }]);
        applyRaw("presets", [{ id: "p1", name: "new" }]);
        trackedRecord<any[]>("modules")!.push(module);
        trackedRecord<any[]>("presets")!.push(preset);
        expect(JSON.parse(text("modules")).map((entry: any) => entry.name)).toEqual(["new", "new"]);
        expect(JSON.parse(text("presets")).map((entry: any) => entry.name)).toEqual(["new", "new"]);
    });

    it("changes nothing when a later inserted value cannot be unwrapped", async () => {
        initializeRecords({ modules: [{ id: "a" }, { id: "b" }] });
        const modules = trackedRecord<any[]>("modules")!;
        const gone = modules[1];
        modules.pop();
        await tick();
        notified = [];
        refused("modules", () => modules.push({ id: "x" }, gone), DetachedWrapperError);
        refused("modules", () => modules.splice(0, 0, { id: "y" }, gone), DetachedWrapperError);
        refused("modules", () => modules.unshift({ id: "z" }, gone), DetachedWrapperError);
    });

    it("lets an element a write displaced in the same task be assigned back (an indexed swap)", () => {
        initializeRecords({ modules: [{ id: "a" }, { id: "b" }] });
        const modules = trackedRecord<any[]>("modules")!;
        const first = modules[0];
        const second = modules[1];
        modules[0] = second;
        modules[1] = first;
        expect(JSON.parse(text("modules"))).toEqual([{ id: "b" }, { id: "a" }]);
        first.name = "still a";
        expect(JSON.parse(text("modules"))[1]).toEqual({ id: "a", name: "still a" });
    });
});

describe("entry credentials (challenge point 2, re-check 1 points 1 and 2)", () => {
    it("routes a credential inserted through push, unshift, and splice, and never stores it", () => {
        initializeRecords({ customModels: [{ id: "a", name: "A" }] });
        const models = trackedRecord<any[]>("customModels")!;
        models.push({ id: "b", name: "B", key: "kb" });
        models.unshift({ id: "c", name: "C", key: "kc" });
        models.splice(1, 0, { id: "d", name: "D", key: "kd" });
        expect(JSON.parse(text("customModels"))).toEqual([
            { id: "c", name: "C" },
            { id: "d", name: "D" },
            { id: "a", name: "A" },
            { id: "b", name: "B" },
        ]);
        expect(text("customModels")).not.toContain("kb");
        expect(queued()).toEqual([
            entry("customModels", "b", "kb"),
            entry("customModels", "c", "kc"),
            entry("customModels", "d", "kd"),
        ]);
        expect(new Set(notified)).toEqual(new Set(["customModels"]));
    });

    it("refuses an insertion whose credential would not have exactly one owner, and a credential-bearing fill", () => {
        initializeRecords({ customModels: [{ id: "a", name: "A" }] });
        const models = trackedRecord<any[]>("customModels")!;
        refused(
            "customModels",
            () => models.push({ id: "same", key: "one" }, { id: "same", key: "two" }),
            CredentialRefusedError,
        );
        // A credentialless element with the same id already in the list.
        refused("customModels", () => models.push({ id: "a", key: "secret" }), CredentialRefusedError);
        // A zero-length fill stores nothing, so its credential has no owner.
        refused("customModels", () => models.fill({ id: "orphan", key: "secret" }, 0, 0), CredentialRefusedError);
        refused("customModels", () => models.fill({ id: "f", key: "secret" }), CredentialRefusedError);
        // A replacement of the only owner is fine: the splice leaves exactly one "a".
        models.splice(0, 1, { id: "a", name: "A2", key: "ka" });
        expect(JSON.parse(text("customModels"))).toEqual([{ id: "a", name: "A2" }]);
        expect(queued()).toEqual([entry("customModels", "a", "ka")]);
    });

    it("refuses object splice indexes before anything changes, and accepts null as native splice does", () => {
        initializeRecords({ customModels: [{ id: "a" }, { id: "b" }] });
        const models = trackedRecord<any[]>("customModels")!;
        let calls = 0;
        const start = { valueOf: () => (calls++ === 0 ? 0 : 1) };
        refused("customModels", () => models.splice(start as any, 1, { id: "a", key: "secret" }), TypeError);
        refused("customModels", () => models.splice(0, { valueOf: () => 1 } as any), TypeError);
        models.splice(null as any, 0, { id: "n", key: "kn" });
        expect(JSON.parse(text("customModels")).map((model: any) => model.id)).toEqual(["n", "a", "b"]);
        expect(queued()).toEqual([entry("customModels", "n", "kn")]);
    });

    it("routes an element replacement's credential, keeps the stored one for a blank or absent one, and refuses a duplicate owner", () => {
        initializeRecords({
            customModels: [
                { id: "a", name: "A" },
                { id: "b", name: "B" },
            ],
        });
        const models = trackedRecord<any[]>("customModels")!;
        models[0] = { id: "a", name: "A2", key: "ka" };
        // An aggregate read-modify-write never clears: blank and absent change nothing.
        models[1] = { ...JSON.parse(JSON.stringify(models[1])), name: "B2", key: "" };
        models[1] = { id: "b", name: "B3" };
        expect(JSON.parse(text("customModels"))).toEqual([
            { id: "a", name: "A2" },
            { id: "b", name: "B3" },
        ]);
        expect(queued()).toEqual([entry("customModels", "a", "ka")]);
        // Replacing "b" by an element named "a" would give "a" two owners.
        refused("customModels", () => (models[1] = { id: "a", key: "again" }), CredentialRefusedError);
        refused("customModels", () => (models[0] = { id: "a", key: 5 }), CredentialRefusedError);
        refused("customModels", () => (models[0] = { name: "no id", key: "k" }), CredentialRefusedError);
    });

    it("routes a direct leaf write (an empty one clears) and refuses a non-string, a missing id, a duplicate owner, and a delete", () => {
        initializeRecords({ customModels: [{ id: "a", name: "A" }, { name: "no id" }] });
        const models = trackedRecord<any[]>("customModels")!;
        models[0].key = "ka";
        models[0].key = "";
        expect(JSON.parse(text("customModels"))[0]).toEqual({ id: "a", name: "A" });
        expect(queued()).toEqual([entry("customModels", "a", "ka"), entry("customModels", "a", "")]);
        refused("customModels", () => (models[0].key = 5), CredentialRefusedError);
        refused("customModels", () => (models[1].key = "k"), CredentialRefusedError);
        refused("customModels", () => delete models[0].key, CredentialRefusedError);
        // Custom model ids are not made unique: a credential on a shared id is refused, set or clear.
        applyRaw("customModels", [{ id: "d" }, { id: "d" }]);
        refused("customModels", () => (models[0].key = "secret"), CredentialRefusedError);
        refused("customModels", () => (models[0].key = ""), CredentialRefusedError);
    });

    it("prepares a whole-list replacement: credentials routed and stripped, ambiguous owners refused", () => {
        initializeRecords({ customModels: [] });
        replaceRecord("customModels", [
            { id: "a", key: "ka" },
            { id: "b", key: "" },
        ]);
        expect(JSON.parse(text("customModels"))).toEqual([{ id: "a" }, { id: "b" }]);
        expect(queued()).toEqual([entry("customModels", "a", "ka")]);
        expect(notified).toEqual(["customModels"]);
        refused("customModels", () => replaceRecord("customModels", [{ id: "x", key: "k" }, { id: "x" }]));
        refused("customModels", () => replaceRecord("customModels", [{ key: "k" }]));
    });

    it("applies the same rules to a model preset's proxyKey, and treats a prompt preset's as plain data", () => {
        initializeRecords({ modelPresets: [{ id: "m1", name: "M1" }], presets: [{ id: "p1", name: "P1" }] });
        const modelPresets = trackedRecord<any[]>("modelPresets")!;
        modelPresets[0].proxyKey = "k1";
        modelPresets.push({ id: "m2", name: "M2", proxyKey: "k2" });
        replaceRecordList(modelPresets, [modelPresets[0], modelPresets[1], { id: "m3", name: "M3", proxyKey: "k3" }]);
        expect(text("modelPresets")).not.toContain("proxyKey");
        expect(queued()).toEqual([
            entry("modelPresets", "m1", "k1"),
            entry("modelPresets", "m2", "k2"),
            entry("modelPresets", "m3", "k3"),
        ]);
        refused("modelPresets", () => delete modelPresets[0].proxyKey, CredentialRefusedError);
        // The prompt preset owns no credential since the split (`docs/plan/split-preset.md`): a
        // `proxyKey` written there is an ordinary field the server normalizer drops, not a routed secret.
        const presets = trackedRecord<any[]>("presets")!;
        presets[0].proxyKey = "plain";
        expect(JSON.parse(text("presets"))[0].proxyKey).toBe("plain");
        expect(queued()).toHaveLength(3);
    });
});

describe("descriptor writes (challenge point 3)", () => {
    it("refuses an unsupported descriptor before routing or storing, and routes a plain data property", () => {
        initializeRecords({ customModels: [{ id: "a" }], ui: { zoomsize: 1 } });
        const model = trackedRecord<any[]>("customModels")![0];
        const ui = trackedRecord<any>("ui")!;
        refused(
            "customModels",
            () => Object.defineProperty(model, "key", { value: "secret", configurable: false }),
            TypeError,
        );
        refused(
            "customModels",
            () => Object.defineProperty(model, "key", { value: "secret", writable: false }),
            TypeError,
        );
        refused("customModels", () => Object.defineProperty(model, "key", { get: () => "secret" }), TypeError);
        refused("ui", () => Object.defineProperty(ui, "zoomsize", { value: 2, enumerable: false }), TypeError);
        Object.defineProperty(model, "key", { value: "ka", writable: true, enumerable: true, configurable: true });
        Object.defineProperty(ui, "zoomsize", { value: 2, writable: true, enumerable: true, configurable: true });
        expect(JSON.parse(text("customModels"))).toEqual([{ id: "a" }]);
        expect(queued()).toEqual([entry("customModels", "a", "ka")]);
        expect(JSON.parse(text("ui"))).toEqual({ zoomsize: 2 });
    });
});

describe("the llmSecrets record (challenge point 4, re-check 1 point 4)", () => {
    const mirror = () => ({
        openAIKey: "",
        google: { projectId: "proj", accessToken: "" },
        OaiCompAPIKeys: {},
        vertexRegion: "r",
    });

    it("routes every credential path written through it and stores only the mirror form", () => {
        initializeRecords({ llmSecrets: mirror() });
        const secrets = trackedRecord<any>("llmSecrets")!;
        secrets.openAIKey = "sk";
        secrets.google.accessToken = "tok";
        // A whole container: the sibling is stored, the credential routed; an absent one changes nothing.
        secrets.google = { projectId: "proj2", accessToken: "tok2" };
        secrets.google = { projectId: "proj3" };
        secrets.OaiCompAPIKeys.m = "mk";
        secrets.OaiCompAPIKeys = { n: "nk" };
        secrets.vertexRegion = "r2";
        expect(JSON.parse(text("llmSecrets"))).toEqual({
            openAIKey: "",
            google: { projectId: "proj3", accessToken: "" },
            OaiCompAPIKeys: {},
            vertexRegion: "r2",
        });
        expect(queued()).toEqual([
            { kind: "put", path: { kind: "flat", field: "openAIKey" }, value: "sk" },
            { kind: "put", path: { kind: "nested", field: "google" }, value: "tok" },
            { kind: "put", path: { kind: "nested", field: "google" }, value: "tok2" },
            { kind: "put", path: { kind: "map", field: "OaiCompAPIKeys", id: "m" }, value: "mk" },
            { kind: "put", path: { kind: "map", field: "OaiCompAPIKeys", id: "n" }, value: "nk" },
        ]);
        refused("llmSecrets", () => (secrets.openAIKey = 5), CredentialRefusedError);
        refused("llmSecrets", () => (secrets.google = "tok"), CredentialRefusedError);
        refused("llmSecrets", () => (secrets.modelPresets = {}), CredentialRefusedError);
        refused("llmSecrets", () => delete secrets.openAIKey, CredentialRefusedError);
        refused("llmSecrets", () => delete secrets.google.accessToken, CredentialRefusedError);
    });

    it("refuses a whole replacement that carries a credential or a malformed container, and takes sibling-only mirror data", () => {
        initializeRecords({ llmSecrets: mirror() });
        for (const value of [
            { ...mirror(), openAIKey: "secret" },
            { ...mirror(), google: { projectId: "p", accessToken: "secret" } },
            { ...mirror(), google: "secret" },
            { ...mirror(), OaiCompAPIKeys: "secret" },
            { ...mirror(), OaiCompAPIKeys: { m: "secret" } },
            { ...mirror(), modelPresets: {} },
            [],
        ]) {
            refused("llmSecrets", () => replaceRecord("llmSecrets", value), CredentialRefusedError);
        }
        replaceRecord("llmSecrets", { ...mirror(), vertexRegion: "r3" });
        expect(JSON.parse(text("llmSecrets")).vertexRegion).toBe("r3");
        expect(queued()).toEqual([]);
        expect(notified).toEqual(["llmSecrets"]);
    });
});

describe("whole-list helpers (challenge point 7)", () => {
    it("replaceRecordList writes once and lets a dropped element be re-inserted in the same task", () => {
        initializeRecords({ loreBook: [{ name: "a" }, { name: "b" }] });
        const list = trackedRecord<any[]>("loreBook")!;
        const retained = list[0];
        replaceRecordList(list, []);
        expect(notified).toEqual(["loreBook"]);
        list.push(retained);
        expect(JSON.parse(text("loreBook"))).toEqual([{ name: "a" }]);
        retained.name = "a2";
        expect(JSON.parse(text("loreBook"))).toEqual([{ name: "a2" }]);
    });

    it("replaceRecordList keeps the identity of the elements it keeps", () => {
        initializeRecords({ loreBook: [{ name: "a" }, { name: "b" }, { name: "c" }] });
        const list = trackedRecord<any[]>("loreBook")!;
        const [a, b, c] = [list[0], list[1], list[2]];
        replaceRecordList(list, [c, a, b]);
        expect(notified).toEqual(["loreBook"]);
        a.name = "a2";
        expect(JSON.parse(text("loreBook"))).toEqual([{ name: "c" }, { name: "a2" }, { name: "b" }]);
    });

    it("an assignment of a plain list of the record's own wrappers (the global lorebook drag) is one write keeping identities", () => {
        initializeRecords({ loreBook: [{ name: "Book", data: [{ key: "a" }, { key: "b" }, { key: "c" }] }] });
        const book = trackedRecord<any[]>("loreBook")![0];
        const [a, b, c] = [book.data[0], book.data[1], book.data[2]];
        // `LoreBookList.svelte`'s global branch: `settings.loreBook[page].data = newArray`.
        book.data = [c, a, b];
        expect(notified).toEqual(["loreBook"]);
        expect(JSON.parse(text("loreBook"))[0].data).toEqual([{ key: "c" }, { key: "a" }, { key: "b" }]);
        a.key = "a2";
        expect(JSON.parse(text("loreBook"))[0].data[1]).toEqual({ key: "a2" });
    });

    it("moveRecordListItem moves an element in one write, retained wrappers following it, and ignores out-of-range moves", () => {
        initializeRecords({ presets: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] });
        const presets = trackedRecord<any[]>("presets")!;
        const first = presets[0];
        moveRecordListItem(presets, 0, 2);
        expect(JSON.parse(text("presets")).map((preset: any) => preset.id)).toEqual(["p2", "p3", "p1"]);
        expect(notified).toEqual(["presets"]);
        first.name = "moved";
        expect(JSON.parse(text("presets"))[2]).toEqual({ id: "p1", name: "moved" });
        notified = [];
        moveRecordListItem(presets, 5, 0);
        moveRecordListItem(presets, 1, 1);
        moveRecordListItem(presets, 0.5, 1);
        expect(notified).toEqual([]);
    });
});

describe("identity", () => {
    it("follows a by-id element (presets, a selectable list's items) through a server reorder, and refuses a write through a duplicated id", () => {
        initializeRecords({
            presets: [
                { id: "p1", name: "A" },
                { id: "p2", name: "B" },
            ],
            translatorPresets: {
                items: [
                    { id: "t1", name: "T1" },
                    { id: "t2", name: "T2" },
                ],
                selectedId: "t1",
            },
        });
        const preset = trackedRecord<any[]>("presets")![1];
        const translator = trackedRecord<any>("translatorPresets")!.items[1];
        applyRaw("presets", [
            { id: "p2", name: "B" },
            { id: "p1", name: "A" },
        ]);
        applyRaw("translatorPresets", {
            items: [
                { id: "t2", name: "T2" },
                { id: "t1", name: "T1" },
            ],
            selectedId: "t1",
        });
        preset.name = "B2";
        translator.name = "T2b";
        expect(JSON.parse(text("presets"))[0]).toEqual({ id: "p2", name: "B2" });
        expect(JSON.parse(text("translatorPresets")).items[0]).toEqual({ id: "t2", name: "T2b" });
        applyRaw("presets", [
            { id: "p2", name: "x" },
            { id: "p2", name: "y" },
        ]);
        notified = [];
        refused("presets", () => (preset.name = "which"), DuplicateIdError);
        refused("presets", () => delete preset.name, DuplicateIdError);
    });

    it("stores another record's wrapper as a detached copy, never the wrapper or a shared object", () => {
        initializeRecords({ ui: { colorScheme: { bgcolor: "#000" } }, modules: [] });
        const scheme = trackedRecord<any>("ui")!.colorScheme;
        const modules = trackedRecord<any[]>("modules")!;
        modules.push({ id: "m", scheme });
        const stored = (recordData<any[]>("modules") as any[])[0].scheme;
        expect(isRecordWrapper(stored)).toBe(false);
        scheme.bgcolor = "#fff";
        expect(JSON.parse(text("modules"))[0].scheme).toEqual({ bgcolor: "#000" });
        modules[0].scheme.bgcolor = "#111";
        expect(JSON.parse(text("ui")).colorScheme).toEqual({ bgcolor: "#fff" });
    });
});

describe("absent records (challenge point 9)", () => {
    it("wraps nothing and creates nothing while a record is absent", () => {
        initializeRecords({});
        expect(hasRecord("pluginStorage")).toBe(false);
        expect(trackedRecord("pluginStorage")).toBeUndefined();
        expect(recordData("pluginStorage")).toBeUndefined();
        expect(hasRecord("pluginStorage")).toBe(false);
        expect(notified).toEqual([]);
    });

    it("checks the first write of an absent section before creating it", () => {
        initializeRecords({});
        expect(() => writeRecordField("llmSecrets", "openAIKey", 5)).toThrow(CredentialRefusedError);
        expect(() => writeRecordField("llmSecrets", "google", "secret")).toThrow(CredentialRefusedError);
        expect(hasRecord("llmSecrets")).toBe(false);
        expect(queued()).toEqual([]);
        expect(notified).toEqual([]);
        writeRecordField("ui", "zoomsize", 3);
        expect(JSON.parse(text("ui"))).toEqual({ zoomsize: 3 });
        expect(notified).toEqual(["ui"]);
    });

    it("initializeRecords replaces the whole set without a notification", () => {
        initializeRecords({ modules: [], pluginStorage: {} });
        initializeRecords({ ui: { zoomsize: 1 } });
        expect(hasRecord("modules")).toBe(false);
        expect(hasRecord("pluginStorage")).toBe(false);
        expect(hasRecord("ui")).toBe(true);
        expect(notified).toEqual([]);
    });
});

describe("notifications", () => {
    it("queues each record once per write outside a batch, and nothing for a server copy", () => {
        initializeRecords({
            ui: { zoomsize: 1, colorScheme: { bgcolor: "#000" } },
            providers: { useStreaming: false },
        });
        const ui = trackedRecord<any>("ui")!;
        ui.zoomsize = 2;
        ui.colorScheme.bgcolor = "#111";
        expect(notified).toEqual(["ui", "ui"]);
        applyRaw("ui", { zoomsize: 9, colorScheme: { bgcolor: "#999" } });
        expect(notified).toEqual(["ui", "ui"]);
        // A retained nested wrapper reaches the replaced record.
        expect(ui.colorScheme.bgcolor).toBe("#999");
    });

    it("batchRecordWrites queues each record once when the outermost scope ends, also when it throws", () => {
        initializeRecords({ ui: { zoomsize: 1 }, providers: { useStreaming: false } });
        const ui = trackedRecord<any>("ui")!;
        const providers = trackedRecord<any>("providers")!;
        batchRecordWrites(() => {
            ui.zoomsize = 2;
            batchRecordWrites(() => {
                ui.zoomsize = 3;
                providers.useStreaming = true;
            });
            expect(notified).toEqual([]);
            ui.zoomsize = 4;
        });
        expect(notified.sort()).toEqual(["providers", "ui"]);
        notified = [];
        expect(() =>
            batchRecordWrites(() => {
                ui.zoomsize = 5;
                ui.zoomsize = 6;
                throw new Error("bulk writer failed");
            }),
        ).toThrow("bulk writer failed");
        expect(notified).toEqual(["ui"]);
        expect(JSON.parse(text("ui")).zoomsize).toBe(6);
        // The scope is closed: the next write queues on its own.
        notified = [];
        ui.zoomsize = 7;
        expect(notified).toEqual(["ui"]);
    });

    it("resetRecords drops the write listener (challenge point 10)", () => {
        const previous = vi.fn();
        setRecordWriteListener(previous);
        resetRecords();
        initializeRecords({ ui: { zoomsize: 1 } });
        trackedRecord<any>("ui")!.zoomsize = 2;
        expect(previous).not.toHaveBeenCalled();
    });
});
