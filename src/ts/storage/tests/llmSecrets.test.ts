import { beforeEach, describe, expect, it } from "vitest";
import { FLAT_SECRET_FIELDS, maskLlmSecrets, type SecretPath } from "../../../../shared/llmSecrets.ts";
import {
    clearSecret,
    copyPresetSecret,
    deletePresetSecret,
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
// applied over it. The `presets` map is keyed by preset id, and an id is any non-empty string
// (`isRecordId`), so `__proto__` is a valid key: every operation must treat it as an ordinary own
// key (slice 3 Astra point 4, slice 4 Astra point 2).

const presets = (id: string): SecretPath => ({ kind: "entry", field: "presets", id });
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
        setSecret(presets("a"), "k1");
        expect(secretStatus(presets("a"))).toEqual({ set: true, hint: "", pending: true });
        expect(secretStatus(presets("missing"))).toEqual({ set: false, hint: "", pending: false });
        setSecret(presets("a"), "k2");
        expect(isSecretSet(presets("a"))).toBe(true);
        copyPresetSecret("a", "b");
        expect(secretStatus(presets("b"))).toEqual({ set: true, hint: "", pending: true });
        // A copy is a copy, applied where it stands in the queue: a later clear of the source does
        // not reach the target.
        clearSecret(presets("a"));
        expect(secretStatus(presets("a"))).toEqual({ set: false, hint: "", pending: true });
        expect(isSecretSet(presets("b"))).toBe(true);
        // Copying from a preset without an entry removes the target's entry.
        copyPresetSecret("a", "b");
        expect(isSecretSet(presets("b"))).toBe(false);
        expect(queued()).toEqual([
            { kind: "put", path: presets("a"), value: "k1" },
            { kind: "put", path: presets("a"), value: "k2" },
            { kind: "copy", from: "a", to: "b" },
            { kind: "put", path: presets("a"), value: "" },
            { kind: "copy", from: "a", to: "b" },
        ]);
        // The queue is the only place the plaintext lives: the masked record did not change.
        expect(llmSecretState.masked!.presets).toEqual({});
    });

    it("does not read inherited properties as entries", () => {
        setMaskedSecrets(maskLlmSecrets({ presets: {} }));
        for (const id of ["constructor", "toString", "__proto__"]) {
            expect(isSecretSet(presets(id)), id).toBe(false);
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
                presets: { a: { proxyKey: "k" } },
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
        expect(mirror).not.toHaveProperty("presets");
    });
});

describe("the __proto__ id", () => {
    it("is queued, acknowledged as an own key of the masked record, read back, and replaced", () => {
        setMaskedSecrets(maskLlmSecrets({}));
        setSecret(presets("ordinary"), "o");
        setSecret(presets("__proto__"), "p1");
        expect(secretStatus(presets("__proto__"))).toEqual({ set: true, hint: "", pending: true });
        expect(secretStatus(presets("ordinary"))).toEqual({ set: true, hint: "", pending: true });
        // The server acknowledges the writes with the masked record: an own `__proto__` key.
        llmSecretState.queue.splice(0);
        setMaskedSecrets(
            maskLlmSecrets(JSON.parse('{"presets":{"__proto__":{"proxyKey":"p1"},"ordinary":{"proxyKey":"o"}}}')),
        );
        const masked = plain(llmSecretState.masked!.presets);
        expect(Object.hasOwn(masked, "__proto__")).toBe(true);
        expect(Object.keys(masked).sort()).toEqual(["__proto__", "ordinary"]);
        expect(masked.__proto__).toEqual({ proxyKey: { set: true, hint: "" } });
        // The map's prototype is untouched: the entry never became the prototype.
        expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
        expect(secretStatus(presets("__proto__"))).toEqual({ set: true, hint: "", pending: false });
        expect(secretStatus(presets("ordinary"))).toEqual({ set: true, hint: "", pending: false });
        setSecret(presets("__proto__"), "p2");
        expect(secretStatus(presets("__proto__"))).toEqual({ set: true, hint: "", pending: true });
        expect(queued()).toEqual([{ kind: "put", path: presets("__proto__"), value: "p2" }]);
    });

    it("is deleted and copied like any other id", () => {
        setMaskedSecrets(maskLlmSecrets({}));
        setSecret(presets("__proto__"), "p");
        copyPresetSecret("__proto__", "copy");
        expect(isSecretSet(presets("copy"))).toBe(true);
        setSecret(presets("source"), "s");
        copyPresetSecret("source", "__proto__");
        expect(isSecretSet(presets("__proto__"))).toBe(true);
        // A deleted preset's entry is a cleanup (sent once its deletion is saved).
        deletePresetSecret("__proto__");
        expect(secretStatus(presets("__proto__"))).toEqual({ set: false, hint: "", pending: true });
        expect(queued().at(-1)).toEqual({ kind: "cleanup", path: presets("__proto__") });
        expect(isSecretSet(presets("copy"))).toBe(true);
        expect(isSecretSet(presets("source"))).toBe(true);
        // Deleting an absent `__proto__` entry queues the same cleanup; the status stays unset.
        deletePresetSecret("__proto__");
        expect(isSecretSet(presets("__proto__"))).toBe(false);
    });
});

describe("setMaskedSecrets (boot, an acknowledgement, and a conflict reload)", () => {
    it("replaces the whole status with the well-formed leaves of a masked record, own __proto__ key included, and bumps the changed paths", () => {
        // Boot: the first record bumps nothing.
        setMaskedSecrets(maskLlmSecrets({ presets: { stale: { proxyKey: "gone" } } }));
        expect(isSecretSet(presets("stale"))).toBe(true);
        expect(secretVersion(presets("stale"))).toBe(0);
        const record = JSON.parse(
            '{"openAIKey":{"set":true,"hint":"2222"},"presets":{"__proto__":{"proxyKey":{"set":true,"hint":""}},"a":{"proxyKey":{"set":true,"hint":"abcd"}},"b":{"proxyKey":5},"c":"no","d":null,"e":{}}}',
        );
        setMaskedSecrets(record);
        expect(isSecretSet(presets("stale"))).toBe(false);
        expect(secretStatus(presets("__proto__"))).toEqual({ set: true, hint: "", pending: false });
        expect(secretStatus(presets("a"))).toEqual({ set: true, hint: "abcd", pending: false });
        for (const id of ["b", "c", "d", "e"]) {
            expect(secretStatus(presets(id)), id).toEqual({ set: false, hint: "", pending: false });
        }
        expect(secretStatus({ kind: "flat", field: "openAIKey" })).toEqual({ set: true, hint: "2222", pending: false });
        // A changed status bumps its path's version; an unchanged path keeps its version.
        expect(secretVersion(presets("stale"))).toBe(1);
        expect(secretVersion(presets("a"))).toBe(1);
        expect(secretVersion(presets("__proto__"))).toBe(1);
        expect(secretVersion({ kind: "flat", field: "openAIKey" })).toBe(1);
        expect(secretVersion({ kind: "flat", field: "claudeAPIKey" })).toBe(0);
        // The same record again: nothing changed, unless a path is named (an acknowledged write of a
        // key that kept its status), or everything is (a record changed elsewhere).
        setMaskedSecrets(record);
        expect(secretVersion(presets("a"))).toBe(1);
        setMaskedSecrets(record, [presets("a")]);
        expect(secretVersion(presets("a"))).toBe(2);
        expect(secretVersion(presets("__proto__"))).toBe(1);
        setMaskedSecrets(record, "all");
        expect(secretVersion(presets("a"))).toBe(3);
        expect(secretVersion(presets("__proto__"))).toBe(2);
        expect(secretVersion({ kind: "flat", field: "claudeAPIKey" })).toBe(1);
    });

    it("empties the status for a missing or malformed presets value", () => {
        for (const value of [undefined, null, "text", 3, ["x"]]) {
            setMaskedSecrets(maskLlmSecrets({ presets: { a: { proxyKey: "k" } } }));
            expect(isSecretSet(presets("a")), String(value)).toBe(true);
            setMaskedSecrets({ presets: value } as never);
            expect(isSecretSet(presets("a")), String(value)).toBe(false);
        }
    });
});
