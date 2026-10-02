// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultColorScheme } from "../../../shared/colorScheme.ts";
import { SECTION_FIELDS, type SectionKind } from "../../../shared/sections.ts";
import { valueKindOf } from "../../../shared/valueKinds.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeMemoryTranslateMedia } from "../data/normalize/memoryTranslateMedia.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import { normalizeSecrets } from "../data/normalize/secrets.ts";
import { normalizeUi } from "../data/normalize/ui.ts";
import { ResourceValidationError, serialize } from "../data/resourceStore.ts";

// Phase 3, slice 3 (`docs/plan/phases/slices/phase-3-settings-sections/server-section-normalizers.md`,
// "Validation"): the five section normalizers. Their defaults are the values a pre-phase fresh
// boot showed, captured in `src/ts/storage/tests/fixtures/phase3/boot-snapshot.json`.

const fixtureDir = path.resolve(import.meta.dirname, "../../../src/ts/storage/tests/fixtures/phase3");
const bootSnapshot = JSON.parse(readFileSync(path.join(fixtureDir, "boot-snapshot.json"), "utf-8")) as Record<
    string,
    unknown
>;

type Normalizer = (input: unknown) => Record<string, unknown>;
const normalizers: Record<SectionKind, Normalizer> = {
    providers: normalizeProviders,
    secrets: normalizeSecrets,
    llmSecrets: normalizeLlmSecrets as Normalizer,
    ui: normalizeUi,
    memoryTranslateMedia: normalizeMemoryTranslateMedia,
};
const sections = Object.keys(normalizers) as SectionKind[];

/** The section's fields that the fresh boot set, with the boot values, in `SECTION_FIELDS` order. */
function bootDefaults(section: SectionKind): Record<string, unknown> {
    const record: Record<string, unknown> = {};
    for (const field of SECTION_FIELDS[section]) {
        if (Object.hasOwn(bootSnapshot, field)) {
            record[field] = bootSnapshot[field];
        }
    }
    if (section === "llmSecrets") {
        record.presets = {};
        // Phase 5 slice 7b: each custom model's key, by model id.
        record.customModels = {};
    }
    return record;
}

/** A value of another JSON kind than `value` (an array for everything but arrays, an object for those). */
const otherKind = (value: unknown) => (Array.isArray(value) ? { not: "an array" } : ["not", "the kind"]);

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
        for (const inner of Object.values(value as object)) {
            deepFreeze(inner);
        }
        Object.freeze(value);
    }
    return value;
}

/** Normalizing the stored form of the output must give the same text (the startup pass rewrites otherwise). */
function expectIdempotent(normalize: Normalizer, input: unknown) {
    const once = serialize(normalize(input));
    expect(serialize(normalize(once.stored)).text).toBe(once.text);
}

describe("every section normalizer", () => {
    it("materializes `undefined`, and fills `{}`, as the fresh-boot values of its fields, in SECTION_FIELDS order, and nothing else", () => {
        for (const section of sections) {
            const expected = bootDefaults(section);
            const materialized = normalizers[section](undefined);
            expect(materialized, section).toEqual(expected);
            expect(Object.keys(materialized), section).toEqual(Object.keys(expected));
            expect(normalizers[section]({}), section).toEqual(expected);
            // The fields a fresh boot left unset stay absent (they have no default).
            const unset = SECTION_FIELDS[section].filter((field) => !Object.hasOwn(bootSnapshot, field));
            expect(unset.length, section).toBeGreaterThan(0);
            for (const field of unset) {
                expect(Object.hasOwn(materialized, field), `${section}.${field}`).toBe(false);
            }
        }
    });

    it("replaces a null or wrong-kind value with the default, and leaves a field without one absent", () => {
        for (const section of sections) {
            const defaults = bootDefaults(section);
            const nulls = Object.fromEntries(SECTION_FIELDS[section].map((field) => [field, null]));
            expect(normalizers[section](nulls), `${section} nulls`).toEqual(defaults);
            const wrong = Object.fromEntries(
                SECTION_FIELDS[section].map((field) => [
                    field,
                    Object.hasOwn(defaults, field) ? otherKind(defaults[field]) : null,
                ]),
            );
            expect(normalizers[section](wrong), `${section} wrong kinds`).toEqual(defaults);
        }
    });

    it("keeps a value of the right kind, drops unknown keys, and neither mutates nor aliases its input", () => {
        for (const section of sections) {
            const defaults = bootDefaults(section);
            const input: Record<string, unknown> = { unknownKey: 1, another: { nested: true } };
            const kept: Record<string, unknown> = {};
            for (const field of SECTION_FIELDS[section]) {
                if (!Object.hasOwn(defaults, field)) {
                    continue;
                }
                const value = defaults[field];
                const replacement =
                    valueKindOf(value) === "string"
                        ? `changed-${field}`
                        : valueKindOf(value) === "number"
                          ? 7
                          : valueKindOf(value) === "boolean"
                            ? !value
                            : Array.isArray(value)
                              ? [{ marker: field }]
                              : { marker: field };
                input[field] = replacement;
                kept[field] = replacement;
            }
            const output = normalizers[section](deepFreeze(structuredClone(input)));
            expect(Object.hasOwn(output, "unknownKey"), section).toBe(false);
            expect(Object.hasOwn(output, "another"), section).toBe(false);
            expect(output, section).toMatchObject(mutationTolerant(section, kept));
            // A copy: changing the output leaves the input alone.
            const source = structuredClone(input);
            const copy = normalizers[section](source);
            for (const [field, value] of Object.entries(copy)) {
                if (value && typeof value === "object") {
                    expect(value, `${section}.${field}`).not.toBe(source[field]);
                }
            }
        }
    });

    it("rejects a record that is not an object", () => {
        for (const section of sections) {
            for (const input of [null, [], "x", 1, true]) {
                expect(() => normalizers[section](input), `${section}: ${JSON.stringify(input)}`).toThrow(
                    new ResourceValidationError(`${section} must be an object`),
                );
            }
        }
    });

    it("is idempotent after serialization on the defaults and on a messy input", () => {
        for (const section of sections) {
            expectIdempotent(normalizers[section], undefined);
            const messy = Object.fromEntries(
                SECTION_FIELDS[section].map((field, index) => [
                    field,
                    index % 3 === 0 ? null : index % 3 === 1 ? "s" : 1,
                ]),
            );
            expectIdempotent(normalizers[section], messy);
        }
    });
});

/**
 * The section-specific migrations rewrite a few kept containers, so the "kept as sent" expectation
 * tolerates them: the hypaCustomSettings rebuild, the keep-on-switch containers, the NAI v4 fields,
 * the quote colors, and the chat load pages.
 */
function mutationTolerant(section: SectionKind, kept: Record<string, unknown>): Record<string, unknown> {
    const out = { ...kept };
    if (section === "secrets") {
        out.hypaCustomSettings = { url: "", key: "", model: "" };
    }
    if (section === "providers") {
        out.seperateParameters = { marker: "seperateParameters", overrides: {} };
        out.fallbackModels = {
            marker: "fallbackModels",
            model: [],
            memory: [],
            emotion: [],
            translate: [],
            otherAx: [],
        };
    }
    if (section === "memoryTranslateMedia") {
        out.NAIImgConfig = expect.objectContaining({ marker: "NAIImgConfig", autoSmea: false });
    }
    if (section === "ui") {
        out.customTextTheme = { marker: "customTextTheme", FontColorQuote1: "#8BE9FD", FontColorQuote2: "#FFB86C" };
    }
    return out;
}

describe("providers", () => {
    it("applies the keep-on-switch migrations: `overrides` on seperateParameters and clean fallbackModels lists", () => {
        const out = normalizeProviders({
            seperateParameters: { memory: { temperature: 1 }, emotion: {}, translate: {}, otherAx: {} },
            fallbackModels: { model: ["a", "", "b"], memory: "not a list", extra: 1 },
        });
        expect(out.seperateParameters).toEqual({
            memory: { temperature: 1 },
            emotion: {},
            translate: {},
            otherAx: {},
            overrides: {},
        });
        expect(out.fallbackModels).toEqual({
            model: ["a", "b"],
            memory: [],
            emotion: [],
            translate: [],
            otherAx: [],
            extra: 1,
        });
        expectIdempotent(normalizeProviders, {
            seperateParameters: { memory: {}, emotion: {}, translate: {}, otherAx: {} },
            fallbackModels: { model: ["a", ""] },
        });
    });

    it("keeps the fresh-boot constants that setDatabase derived from other fields", () => {
        const out = normalizeProviders(undefined);
        expect(out).toMatchObject({ ollamaModelSource: "local", ollamaCloudModel: "", loreBookToken: 8000 });
    });
});

describe("secrets", () => {
    it("rebuilds hypaCustomSettings as exactly three strings", () => {
        expect(normalizeSecrets({ hypaCustomSettings: { url: "u", key: 1, extra: true } }).hypaCustomSettings).toEqual({
            url: "u",
            key: "",
            model: "",
        });
        expect(normalizeSecrets({ hypaCustomSettings: "nope" }).hypaCustomSettings).toEqual({
            url: "",
            key: "",
            model: "",
        });
    });
});

describe("llmSecrets", () => {
    it("fills the google container and requires a finite number for the vertex expiry", () => {
        const out = normalizeLlmSecrets({ google: { projectId: "p" }, vertexAccessTokenExpires: "soon" });
        expect(out.google).toEqual({ accessToken: "", projectId: "p" });
        expect(out.vertexAccessTokenExpires).toBe(0);
        expect(normalizeLlmSecrets({ vertexAccessTokenExpires: 42 }).vertexAccessTokenExpires).toBe(42);
    });

    it("keeps the per-preset proxyKey map with only `proxyKey` per entry, as own keys, and `{}` when absent", () => {
        expect(normalizeLlmSecrets(undefined).presets).toEqual({});
        expect(normalizeLlmSecrets({}).presets).toEqual({});
        const input = JSON.parse(
            '{"presets":{"a":{"proxyKey":"k","extra":1},"__proto__":{"proxyKey":"p"},"constructor":{"proxyKey":"c"}}}',
        );
        const out = normalizeLlmSecrets(input);
        expect(Object.getPrototypeOf(out.presets)).toBe(Object.prototype);
        expect(Object.keys(out.presets)).toEqual(["a", "__proto__", "constructor"]);
        expect(out.presets.a).toEqual({ proxyKey: "k" });
        expect(Object.getOwnPropertyDescriptor(out.presets, "__proto__")?.value).toEqual({ proxyKey: "p" });
        expect(Object.getOwnPropertyDescriptor(out.presets, "constructor")?.value).toEqual({ proxyKey: "c" });
        // The stored text carries the entries, and the second normalization is the same text.
        expect(serialize(out).text).toContain('"__proto__":{"proxyKey":"p"}');
        expectIdempotent(normalizeLlmSecrets as Normalizer, input);
    });

    it("rejects a presets map that is not an object of `{ proxyKey: string }` by non-empty ids", () => {
        const rejects = (presets: unknown, message: string) =>
            expect(() => normalizeLlmSecrets({ presets }), JSON.stringify(presets)).toThrow(
                new ResourceValidationError(message),
            );
        rejects([], "llmSecrets.presets must be an object");
        rejects(null, "llmSecrets.presets must be an object");
        rejects("k", "llmSecrets.presets must be an object");
        const entries = "llmSecrets.presets must map preset ids to { proxyKey: string }";
        rejects({ "": { proxyKey: "k" } }, entries);
        rejects({ a: { proxyKey: 1 } }, entries);
        rejects({ a: {} }, entries);
        rejects({ a: "k" }, entries);
        rejects({ a: null }, entries);
    });
});

describe("ui", () => {
    it("takes a custom color scheme saved before customColorScheme existed from colorScheme", () => {
        const custom = { ...defaultColorScheme, bgcolor: "#123456" };
        const migrated = normalizeUi({ colorSchemeName: "custom", colorScheme: custom });
        expect(migrated.customColorScheme).toEqual(custom);
        expect(migrated.customColorScheme).not.toBe(migrated.colorScheme);
        // Not when the name is another scheme, and not over an existing custom scheme.
        expect(normalizeUi({ colorSchemeName: "default", colorScheme: custom }).customColorScheme).toEqual(
            defaultColorScheme,
        );
        const existing = { ...defaultColorScheme, bgcolor: "#654321" };
        expect(
            normalizeUi({ colorSchemeName: "custom", colorScheme: custom, customColorScheme: existing })
                .customColorScheme,
        ).toEqual(existing);
    });

    it("adds the two quote colors to a custom text theme that predates them", () => {
        const out = normalizeUi({ customTextTheme: { FontColorStandard: "#fff", FontColorQuote1: "#000" } });
        expect(out.customTextTheme).toEqual({
            FontColorStandard: "#fff",
            FontColorQuote1: "#000",
            FontColorQuote2: "#FFB86C",
        });
    });

    it("floors the chat load pages and replaces a value below 1 or of another kind with the default", () => {
        const pages = (initial: unknown, additional: unknown) => {
            const out = normalizeUi({ chatLoadInitialPages: initial, chatLoadAdditionalPages: additional });
            return [out.chatLoadInitialPages, out.chatLoadAdditionalPages];
        };
        expect(pages(2.7, 9.1)).toEqual([2, 9]);
        expect(pages(0, -1)).toEqual([30, 15]);
        // A numeric string is another kind now (the record says so): the default, not the parsed number.
        expect(pages("12", "3")).toEqual([30, 15]);
        expect(pages(undefined, null)).toEqual([30, 15]);
        expectIdempotent(normalizeUi, { chatLoadInitialPages: 2.7, chatLoadAdditionalPages: 0.5 });
    });
});

describe("memoryTranslateMedia", () => {
    it("adds the NAI v4 fields to a config saved before them, and leaves a v4 config alone", () => {
        const legacy: unknown = normalizeMemoryTranslateMedia({
            NAIImgConfig: { width: 1, autoSmea: true },
        }).NAIImgConfig;
        expect(legacy).toEqual({
            width: 1,
            autoSmea: false,
            use_coords: false,
            legacy_uc: false,
            v4_prompt: { caption: { base_caption: "", char_captions: [] }, use_coords: false, use_order: true },
            v4_negative_prompt: { caption: { base_caption: "", char_captions: [] }, legacy_uc: false },
        });
        const v4 = { width: 2, autoSmea: true, v4_prompt: { caption: { base_caption: "x", char_captions: [] } } };
        expect(normalizeMemoryTranslateMedia({ NAIImgConfig: v4 }).NAIImgConfig).toEqual(v4);
        expectIdempotent(normalizeMemoryTranslateMedia, { NAIImgConfig: { width: 1 } });
    });
});
