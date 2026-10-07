import { beforeEach, describe, expect, it } from "vitest";
import { FLAT_SECRET_FIELDS, maskLlmSecrets, type SecretPath } from "../../../../shared/llmSecrets.ts";
import {
    clearSecret,
    copyModelPresetSecret,
    deleteModelPresetSecret,
    isSecretSet,
    llmSecretState,
    llmSecretsText,
    mirrorFields,
    secretStatus,
    secretVersion,
    setMaskedSecrets,
    setSecret,
} from "../llmSecrets.svelte";

// Phase 3, slice 4, rewritten for Phase 5 slice 7b (`request-layer-and-llm-secrets.md`, write-only
// `llmSecrets`): the client state of the record is the masked record the server answered, a version
// per credential path, and the queue of credential writes the save adapter sends. The tab never
// holds a key: a write is queued and the status a view shows is the masked record with the queue
// applied over it. The `modelPresets` map is keyed by model preset id (`docs/plan/split-preset.md`), and an id is any non-empty string
// (`isRecordId`), so `__proto__` is a valid key: every operation must treat it as an ordinary own
// key (slice 3 Astra point 4, slice 4 Astra point 2).

const modelPresets = (id: string): SecretPath => ({ kind: "entry", field: "modelPresets", id });
/** The queued requests, in order. */
const queued = () => llmSecretState.queue.map((op) => op.request);
/** A plain copy of a state value, for `Object.hasOwn` checks that a Svelte proxy would answer differently. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

beforeEach(() => {
    llmSecretState.queue.splice(0);
    llmSecretState.masked = null;
    llmSecretState.versions = {};
});

describe("ordinary ids", () => {
    it("creates, replaces, deletes, and copies entries through the queue, in queue order", () => {
        setMaskedSecrets(maskLlmSecrets({}));
        setSecret(modelPresets("a"), "k1");
        expect(secretStatus(modelPresets("a"))).toEqual({ set: true, hint: "", pending: true });
        expect(secretStatus(modelPresets("missing"))).toEqual({ set: false, hint: "", pending: false });
        setSecret(modelPresets("a"), "k2");
        expect(isSecretSet(modelPresets("a"))).toBe(true);
        copyModelPresetSecret("a", "b");
        expect(secretStatus(modelPresets("b"))).toEqual({ set: true, hint: "", pending: true });
        // A copy is a copy, applied where it stands in the queue: a later clear of the source does
        // not reach the target.
        clearSecret(modelPresets("a"));
        expect(secretStatus(modelPresets("a"))).toEqual({ set: false, hint: "", pending: true });
        expect(isSecretSet(modelPresets("b"))).toBe(true);
        // Copying from a model preset without an entry removes the target's entry.
        copyModelPresetSecret("a", "b");
        expect(isSecretSet(modelPresets("b"))).toBe(false);
        expect(queued()).toEqual([
            { kind: "put", path: modelPresets("a"), value: "k1" },
            { kind: "put", path: modelPresets("a"), value: "k2" },
            { kind: "copy", from: "a", to: "b" },
            { kind: "put", path: modelPresets("a"), value: "" },
            { kind: "copy", from: "a", to: "b" },
        ]);
        // The queue is the only place the plaintext lives: the masked record did not change.
        expect(llmSecretState.masked!.modelPresets).toEqual({});
    });

    it("does not read inherited properties as entries", () => {
        setMaskedSecrets(maskLlmSecrets({ modelPresets: {} }));
        for (const id of ["constructor", "toString", "__proto__"]) {
            expect(isSecretSet(modelPresets(id)), id).toBe(false);
        }
    });

    it("sends the readable siblings only: the text the projection writes carries no credential and no map", () => {
        const text = JSON.parse(
            llmSecretsText({
                openAIKey: "sk",
                vertexClientEmail: "e",
                google: { accessToken: "t", projectId: "p" },
                hordeConfig: { apiKey: "h", model: "m" },
                OaiCompAPIKeys: { "https://x": "k" },
                modelPresets: { a: { proxyKey: "k" } },
                customModels: { m: { key: "k" } },
            }),
        );
        expect(text).toEqual({
            google: { projectId: "p" },
            hordeConfig: { model: "m" },
            novelai: {},
            vertexClientEmail: "e",
        });
        // The mirror's view of a masked record: the siblings as they are, every credential field "".
        const mirror = mirrorFields(
            maskLlmSecrets({ openAIKey: "sk", vertexClientEmail: "e", google: { accessToken: "t", projectId: "p" } }),
        );
        expect(mirror).toMatchObject({
            vertexClientEmail: "e",
            google: { accessToken: "", projectId: "p" },
            hordeConfig: { apiKey: "" },
            novelai: { token: "" },
            OaiCompAPIKeys: {},
        });
        for (const field of FLAT_SECRET_FIELDS) {
            expect(mirror[field], field).toBe("");
        }
        expect(mirror).not.toHaveProperty("modelPresets");
    });
});

describe("the __proto__ id", () => {
    it("is queued, acknowledged as an own key of the masked record, read back, and replaced", () => {
        setMaskedSecrets(maskLlmSecrets({}));
        setSecret(modelPresets("ordinary"), "o");
        setSecret(modelPresets("__proto__"), "p1");
        expect(secretStatus(modelPresets("__proto__"))).toEqual({ set: true, hint: "", pending: true });
        expect(secretStatus(modelPresets("ordinary"))).toEqual({ set: true, hint: "", pending: true });
        // The server acknowledges the writes with the masked record: an own `__proto__` key.
        llmSecretState.queue.splice(0);
        setMaskedSecrets(
            maskLlmSecrets(JSON.parse('{"modelPresets":{"__proto__":{"proxyKey":"p1"},"ordinary":{"proxyKey":"o"}}}')),
        );
        const masked = plain(llmSecretState.masked!.modelPresets);
        expect(Object.hasOwn(masked, "__proto__")).toBe(true);
        expect(Object.keys(masked).sort()).toEqual(["__proto__", "ordinary"]);
        expect(masked.__proto__).toEqual({ proxyKey: { set: true, hint: "" } });
        // The map's prototype is untouched: the entry never became the prototype.
        expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
        expect(secretStatus(modelPresets("__proto__"))).toEqual({ set: true, hint: "", pending: false });
        expect(secretStatus(modelPresets("ordinary"))).toEqual({ set: true, hint: "", pending: false });
        setSecret(modelPresets("__proto__"), "p2");
        expect(secretStatus(modelPresets("__proto__"))).toEqual({ set: true, hint: "", pending: true });
        expect(queued()).toEqual([{ kind: "put", path: modelPresets("__proto__"), value: "p2" }]);
    });

    it("is deleted and copied like any other id", () => {
        setMaskedSecrets(maskLlmSecrets({}));
        setSecret(modelPresets("__proto__"), "p");
        copyModelPresetSecret("__proto__", "copy");
        expect(isSecretSet(modelPresets("copy"))).toBe(true);
        setSecret(modelPresets("source"), "s");
        copyModelPresetSecret("source", "__proto__");
        expect(isSecretSet(modelPresets("__proto__"))).toBe(true);
        // A deleted model preset's entry is a cleanup (sent once its deletion is saved).
        deleteModelPresetSecret("__proto__");
        expect(secretStatus(modelPresets("__proto__"))).toEqual({ set: false, hint: "", pending: true });
        expect(queued().at(-1)).toEqual({ kind: "cleanup", path: modelPresets("__proto__") });
        expect(isSecretSet(modelPresets("copy"))).toBe(true);
        expect(isSecretSet(modelPresets("source"))).toBe(true);
        // Deleting an absent `__proto__` entry queues the same cleanup; the status stays unset.
        deleteModelPresetSecret("__proto__");
        expect(isSecretSet(modelPresets("__proto__"))).toBe(false);
    });
});

describe("setMaskedSecrets (boot, an acknowledgement, and a conflict reload)", () => {
    it("replaces the whole status with the well-formed leaves of a masked record, own __proto__ key included, and bumps the changed paths", () => {
        // Boot: the first record bumps nothing.
        setMaskedSecrets(maskLlmSecrets({ modelPresets: { stale: { proxyKey: "gone" } } }));
        expect(isSecretSet(modelPresets("stale"))).toBe(true);
        expect(secretVersion(modelPresets("stale"))).toBe(0);
        const record = JSON.parse(
            '{"openAIKey":{"set":true,"hint":"2222"},"modelPresets":{"__proto__":{"proxyKey":{"set":true,"hint":""}},"a":{"proxyKey":{"set":true,"hint":"abcd"}},"b":{"proxyKey":5},"c":"no","d":null,"e":{}}}',
        );
        setMaskedSecrets(record);
        expect(isSecretSet(modelPresets("stale"))).toBe(false);
        expect(secretStatus(modelPresets("__proto__"))).toEqual({ set: true, hint: "", pending: false });
        expect(secretStatus(modelPresets("a"))).toEqual({ set: true, hint: "abcd", pending: false });
        for (const id of ["b", "c", "d", "e"]) {
            expect(secretStatus(modelPresets(id)), id).toEqual({ set: false, hint: "", pending: false });
        }
        expect(secretStatus({ kind: "flat", field: "openAIKey" })).toEqual({ set: true, hint: "2222", pending: false });
        // A changed status bumps its path's version; an unchanged path keeps its version.
        expect(secretVersion(modelPresets("stale"))).toBe(1);
        expect(secretVersion(modelPresets("a"))).toBe(1);
        expect(secretVersion(modelPresets("__proto__"))).toBe(1);
        expect(secretVersion({ kind: "flat", field: "openAIKey" })).toBe(1);
        expect(secretVersion({ kind: "flat", field: "claudeAPIKey" })).toBe(0);
        // The same record again: nothing changed, unless a path is named (an acknowledged write of a
        // key that kept its status), or everything is (a record changed elsewhere).
        setMaskedSecrets(record);
        expect(secretVersion(modelPresets("a"))).toBe(1);
        setMaskedSecrets(record, [modelPresets("a")]);
        expect(secretVersion(modelPresets("a"))).toBe(2);
        expect(secretVersion(modelPresets("__proto__"))).toBe(1);
        setMaskedSecrets(record, "all");
        expect(secretVersion(modelPresets("a"))).toBe(3);
        expect(secretVersion(modelPresets("__proto__"))).toBe(2);
        expect(secretVersion({ kind: "flat", field: "claudeAPIKey" })).toBe(1);
    });

    it("empties the status for a missing or malformed modelPresets value, and reads no entry of the former presets map", () => {
        for (const value of [undefined, null, "text", 3, ["x"]]) {
            setMaskedSecrets(maskLlmSecrets({ modelPresets: { a: { proxyKey: "k" } } }));
            expect(isSecretSet(modelPresets("a")), String(value)).toBe(true);
            setMaskedSecrets({ modelPresets: value } as never);
            expect(isSecretSet(modelPresets("a")), String(value)).toBe(false);
        }
        // A record stored before the split named the map `presets`: it carries no model preset entry.
        setMaskedSecrets(maskLlmSecrets({ presets: { a: { proxyKey: "k" } } } as never));
        expect(isSecretSet(modelPresets("a"))).toBe(false);
        expect(llmSecretState.masked!.modelPresets).toEqual({});
    });
});
