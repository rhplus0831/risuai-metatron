import { beforeEach, describe, expect, it } from "vitest";
import {
    copyPresetSecret,
    deletePresetSecret,
    getPresetSecret,
    llmSecretPresets,
    replacePresetSecrets,
    setPresetSecret,
} from "../llmSecrets.svelte";

// Phase 3, slice 4: the client state of the `llmSecrets` record's `presets` map. The map is keyed
// by preset id, and an id is any non-empty string (`isRecordId`), so `__proto__` is a valid key:
// every operation must treat it as an ordinary own key, and the text the save adapter sends
// (`JSON.stringify` of the live value) must carry it (slice 3 Astra point 4, slice 4 Astra point 2).

/** The text the `llmSecrets` projection sends for the map, parsed back into plain data. */
const sent = () => JSON.parse(JSON.stringify(llmSecretPresets.value)) as Record<string, unknown>;

beforeEach(() => {
    replacePresetSecrets({});
});

describe("ordinary ids", () => {
    it("creates, reads, replaces, deletes, and copies entries, keeping only proxyKey", () => {
        setPresetSecret("a", { proxyKey: "k1", extra: "dropped" } as any);
        expect(getPresetSecret("a")).toEqual({ proxyKey: "k1" });
        expect(getPresetSecret("missing")).toBeUndefined();
        setPresetSecret("a", { proxyKey: "k2" });
        expect(getPresetSecret("a")).toEqual({ proxyKey: "k2" });
        copyPresetSecret("a", "b");
        expect(getPresetSecret("b")).toEqual({ proxyKey: "k2" });
        // A copy is a copy: a later change of the source does not reach the target.
        setPresetSecret("a", { proxyKey: "k3" });
        expect(getPresetSecret("b")).toEqual({ proxyKey: "k2" });
        deletePresetSecret("a");
        expect(getPresetSecret("a")).toBeUndefined();
        expect(sent()).toEqual({ b: { proxyKey: "k2" } });
        // Copying from a preset without an entry removes the target's entry.
        copyPresetSecret("a", "b");
        expect(getPresetSecret("b")).toBeUndefined();
        expect(sent()).toEqual({});
    });

    it("does not read inherited properties as entries", () => {
        expect(getPresetSecret("constructor")).toBeUndefined();
        expect(getPresetSecret("toString")).toBeUndefined();
        expect(getPresetSecret("__proto__")).toBeUndefined();
    });
});

describe("the __proto__ id", () => {
    it("is created as an own key, read back, replaced, and sent in the text", () => {
        setPresetSecret("ordinary", { proxyKey: "o" });
        setPresetSecret("__proto__", { proxyKey: "p1" });
        expect(getPresetSecret("__proto__")).toEqual({ proxyKey: "p1" });
        expect(getPresetSecret("ordinary")).toEqual({ proxyKey: "o" });
        let text = sent();
        expect(Object.hasOwn(text, "__proto__")).toBe(true);
        expect(text.__proto__).toEqual({ proxyKey: "p1" });
        expect(text.ordinary).toEqual({ proxyKey: "o" });
        setPresetSecret("__proto__", { proxyKey: "p2" });
        expect(getPresetSecret("__proto__")).toEqual({ proxyKey: "p2" });
        text = sent();
        expect(Object.keys(text).sort()).toEqual(["__proto__", "ordinary"]);
        expect(text.__proto__).toEqual({ proxyKey: "p2" });
        // The map's prototype is untouched: the entry never became the prototype.
        expect(Object.getPrototypeOf(JSON.parse(JSON.stringify(llmSecretPresets.value)))).toBe(Object.prototype);
    });

    it("is deleted and copied like any other id", () => {
        setPresetSecret("__proto__", { proxyKey: "p" });
        copyPresetSecret("__proto__", "copy");
        expect(getPresetSecret("copy")).toEqual({ proxyKey: "p" });
        setPresetSecret("source", { proxyKey: "s" });
        copyPresetSecret("source", "__proto__");
        expect(getPresetSecret("__proto__")).toEqual({ proxyKey: "s" });
        deletePresetSecret("__proto__");
        expect(getPresetSecret("__proto__")).toBeUndefined();
        const text = sent();
        expect(Object.hasOwn(text, "__proto__")).toBe(false);
        expect(text).toEqual({ copy: { proxyKey: "p" }, source: { proxyKey: "s" } });
        // Deleting an absent `__proto__` entry is a no-op.
        deletePresetSecret("__proto__");
        expect(sent()).toEqual({ copy: { proxyKey: "p" }, source: { proxyKey: "s" } });
    });
});

describe("replacePresetSecrets (boot and conflict reload)", () => {
    it("replaces the whole map with the well-formed entries of a record, own __proto__ key included", () => {
        setPresetSecret("stale", { proxyKey: "gone" });
        replacePresetSecrets(
            JSON.parse(
                '{"__proto__":{"proxyKey":"proto"},"a":{"proxyKey":"ka","extra":1},"b":{"proxyKey":5},"c":"no","d":null,"e":{}}',
            ),
        );
        expect(getPresetSecret("stale")).toBeUndefined();
        expect(getPresetSecret("__proto__")).toEqual({ proxyKey: "proto" });
        expect(getPresetSecret("a")).toEqual({ proxyKey: "ka" });
        for (const id of ["b", "c", "d", "e"]) {
            expect(getPresetSecret(id), id).toBeUndefined();
        }
        expect(sent()).toEqual(JSON.parse('{"__proto__":{"proxyKey":"proto"},"a":{"proxyKey":"ka"}}'));
    });

    it("empties the map for a missing or malformed presets value", () => {
        for (const value of [undefined, null, "text", 3, ["x"]]) {
            setPresetSecret("a", { proxyKey: "k" });
            replacePresetSecrets(value);
            expect(sent(), String(value)).toEqual({});
        }
    });
});
