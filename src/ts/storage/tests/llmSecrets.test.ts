import { beforeEach, describe, expect, it } from "vitest";
import { FLAT_SECRET_FIELDS, maskLlmSecrets, type SecretPath } from "../../../../shared/llmSecrets.ts";
import {
    clearSecret,
    deleteEntrySecret,
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
// applied over it. The `credentials` map is keyed by named credential id (`docs/plan/shared-api-keys.md`;
// the former `modelPresets` and `customModels` maps are gone, `docs/plan/model-profiles.md` O2), and an
// id is any non-empty string (`isRecordId`), so `__proto__` is a valid key: every operation must treat
// it as an ordinary own key (slice 3 Astra point 4, slice 4 Astra point 2).

const credentials = (id: string): SecretPath => ({ kind: "entry", field: "credentials", id });
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
    it("creates, replaces, and deletes entries through the queue, in queue order", () => {
        setMaskedSecrets(maskLlmSecrets({}));
        setSecret(credentials("a"), "k1");
        expect(secretStatus(credentials("a"))).toEqual({ set: true, hint: "", pending: true });
        expect(secretStatus(credentials("missing"))).toEqual({ set: false, hint: "", pending: false });
        setSecret(credentials("a"), "k2");
        expect(isSecretSet(credentials("a"))).toBe(true);
        setSecret(credentials("b"), "kb");
        // Each entry is its own path: a later clear of one does not reach another.
        clearSecret(credentials("a"));
        expect(secretStatus(credentials("a"))).toEqual({ set: false, hint: "", pending: true });
        expect(isSecretSet(credentials("b"))).toBe(true);
        expect(queued()).toEqual([
            { kind: "put", path: credentials("a"), value: "k1" },
            { kind: "put", path: credentials("a"), value: "k2" },
            { kind: "put", path: credentials("b"), value: "kb" },
            { kind: "put", path: credentials("a"), value: "" },
        ]);
        // The queue is the only place the plaintext lives: the masked record did not change.
        expect(llmSecretState.masked!.credentials).toEqual({});
    });

    it("does not read inherited properties as entries", () => {
        setMaskedSecrets(maskLlmSecrets({ credentials: {} }));
        for (const id of ["constructor", "toString", "__proto__"]) {
            expect(isSecretSet(credentials(id)), id).toBe(false);
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
        setSecret(credentials("ordinary"), "o");
        setSecret(credentials("__proto__"), "p1");
        expect(secretStatus(credentials("__proto__"))).toEqual({ set: true, hint: "", pending: true });
        expect(secretStatus(credentials("ordinary"))).toEqual({ set: true, hint: "", pending: true });
        // The server acknowledges the writes with the masked record: an own `__proto__` key.
        llmSecretState.queue.splice(0);
        setMaskedSecrets(
            maskLlmSecrets(JSON.parse('{"credentials":{"__proto__":{"key":"p1"},"ordinary":{"key":"o"}}}')),
        );
        const masked = plain(llmSecretState.masked!.credentials);
        expect(Object.hasOwn(masked, "__proto__")).toBe(true);
        expect(Object.keys(masked).sort()).toEqual(["__proto__", "ordinary"]);
        expect(masked.__proto__).toEqual({ key: { set: true, hint: "" } });
        // The map's prototype is untouched: the entry never became the prototype.
        expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
        expect(secretStatus(credentials("__proto__"))).toEqual({ set: true, hint: "", pending: false });
        expect(secretStatus(credentials("ordinary"))).toEqual({ set: true, hint: "", pending: false });
        setSecret(credentials("__proto__"), "p2");
        expect(secretStatus(credentials("__proto__"))).toEqual({ set: true, hint: "", pending: true });
        expect(queued()).toEqual([{ kind: "put", path: credentials("__proto__"), value: "p2" }]);
    });

    it("is deleted like any other id", () => {
        setMaskedSecrets(maskLlmSecrets({}));
        setSecret(credentials("__proto__"), "p");
        setSecret(credentials("source"), "s");
        expect(isSecretSet(credentials("__proto__"))).toBe(true);
        // A deleted credential's entry is a cleanup (sent once its deletion is saved).
        deleteEntrySecret("credentials", "__proto__");
        expect(secretStatus(credentials("__proto__"))).toEqual({ set: false, hint: "", pending: true });
        expect(queued().at(-1)).toEqual({ kind: "cleanup", path: credentials("__proto__") });
        expect(isSecretSet(credentials("source"))).toBe(true);
        // Deleting an absent `__proto__` entry queues the same cleanup; the status stays unset.
        deleteEntrySecret("credentials", "__proto__");
        expect(isSecretSet(credentials("__proto__"))).toBe(false);
    });
});

describe("setMaskedSecrets (boot, an acknowledgement, and a conflict reload)", () => {
    it("replaces the whole status with the well-formed leaves of a masked record, own __proto__ key included, and bumps the changed paths", () => {
        // Boot: the first record bumps nothing.
        setMaskedSecrets(maskLlmSecrets({ credentials: { stale: { key: "gone" } } }));
        expect(isSecretSet(credentials("stale"))).toBe(true);
        expect(secretVersion(credentials("stale"))).toBe(0);
        const record = JSON.parse(
            '{"openAIKey":{"set":true,"hint":"2222"},"credentials":{"__proto__":{"key":{"set":true,"hint":""}},"a":{"key":{"set":true,"hint":"abcd"}},"b":{"key":5},"c":"no","d":null,"e":{}}}',
        );
        setMaskedSecrets(record);
        expect(isSecretSet(credentials("stale"))).toBe(false);
        expect(secretStatus(credentials("__proto__"))).toEqual({ set: true, hint: "", pending: false });
        expect(secretStatus(credentials("a"))).toEqual({ set: true, hint: "abcd", pending: false });
        for (const id of ["b", "c", "d", "e"]) {
            expect(secretStatus(credentials(id)), id).toEqual({ set: false, hint: "", pending: false });
        }
        expect(secretStatus({ kind: "flat", field: "openAIKey" })).toEqual({ set: true, hint: "2222", pending: false });
        // A changed status bumps its path's version; an unchanged path keeps its version.
        expect(secretVersion(credentials("stale"))).toBe(1);
        expect(secretVersion(credentials("a"))).toBe(1);
        expect(secretVersion(credentials("__proto__"))).toBe(1);
        expect(secretVersion({ kind: "flat", field: "openAIKey" })).toBe(1);
        expect(secretVersion({ kind: "flat", field: "claudeAPIKey" })).toBe(0);
        // The same record again: nothing changed, unless a path is named (an acknowledged write of a
        // key that kept its status), or everything is (a record changed elsewhere).
        setMaskedSecrets(record);
        expect(secretVersion(credentials("a"))).toBe(1);
        setMaskedSecrets(record, [credentials("a")]);
        expect(secretVersion(credentials("a"))).toBe(2);
        expect(secretVersion(credentials("__proto__"))).toBe(1);
        setMaskedSecrets(record, "all");
        expect(secretVersion(credentials("a"))).toBe(3);
        expect(secretVersion(credentials("__proto__"))).toBe(2);
        expect(secretVersion({ kind: "flat", field: "claudeAPIKey" })).toBe(1);
    });

    it("empties the status for a missing or malformed credentials value, and reads no entry of the removed maps", () => {
        for (const value of [undefined, null, "text", 3, ["x"]]) {
            setMaskedSecrets(maskLlmSecrets({ credentials: { a: { key: "k" } } }));
            expect(isSecretSet(credentials("a")), String(value)).toBe(true);
            setMaskedSecrets({ credentials: value } as never);
            expect(isSecretSet(credentials("a")), String(value)).toBe(false);
        }
        // A record stored before Model Profiles O2 held the per-record maps: they carry no entry
        // and are not exposed.
        const masked = maskLlmSecrets({
            modelPresets: { a: { proxyKey: "k" } },
            customModels: { a: { key: "k" } },
        } as never);
        expect(masked).not.toHaveProperty("modelPresets");
        expect(masked).not.toHaveProperty("customModels");
        setMaskedSecrets(masked);
        expect(isSecretSet(credentials("a"))).toBe(false);
        expect(llmSecretState.masked!.credentials).toEqual({});
    });
});
