// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_NEW_CHAT_BINDING } from "../../../shared/chatBinding.ts";
import { defaultColorScheme } from "../../../shared/colorScheme.ts";
import { normalizeModelProfile } from "../../../shared/presets.ts";
import { DROPPED_FIELDS, SECTION_FIELDS, type SectionKind } from "../../../shared/sections.ts";
import { valueKindOf } from "../../../shared/valueKinds.ts";
import { normalizeLlmSecrets } from "../data/normalize/llmSecrets.ts";
import { normalizeMemoryTranslateMedia } from "../data/normalize/memoryTranslateMedia.ts";
import { normalizeProviders } from "../data/normalize/providers.ts";
import { normalizeSecrets } from "../data/normalize/secrets.ts";
import { normalizeUi } from "../data/normalize/ui.ts";
import { ResourceValidationError, serialize } from "../data/resourceStore.ts";

// The five section normalizers. Their specs and the hand-maintained
// `src/ts/storage/tests/fixtures/boot/boot-snapshot.json` together define the fresh-boot defaults.

const fixtureDir = path.resolve(import.meta.dirname, "../../../src/ts/storage/tests/fixtures/boot");
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
        // The named keys by credential id; the per-model-preset and per-custom-model maps are
        // retired.
        record.credentials = {};
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
                // An enum field keeps only its own values: its valid alternate stands in for the
                // generated string (`ui.newChatBinding`, `memoryTranslateMedia.llmTranslationTarget`;
                // the invalid strings are covered under their sections).
                const replacement =
                    valueKindOf(value) === "string"
                        ? field === "newChatBinding"
                            ? "empty"
                            : field === "llmTranslationTarget"
                              ? "rendered"
                              : `changed-${field}`
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
 * tolerates them: the hypaCustomSettings rebuild, the NAI v4 fields, the quote colors, and the
 * chat load pages.
 */
function mutationTolerant(section: SectionKind, kept: Record<string, unknown>): Record<string, unknown> {
    const out = { ...kept };
    if (section === "secrets") {
        out.hypaCustomSettings = { url: "", key: "", model: "" };
    }
    if (section === "memoryTranslateMedia") {
        out.NAIImgConfig = expect.objectContaining({ marker: "NAIImgConfig", autoSmea: false });
    }
    if (section === "ui") {
        out.customTextTheme = { marker: "customTextTheme", FontColorQuote1: "#8BE9FD", FontColorQuote2: "#FFB86C" };
        // An entry without an id is not a blocked creator.
        out.blockedRealmCreators = [];
    }
    return out;
}

describe("providers", () => {
    it("drops the former keep-on-switch copies and their three toggles: they are preset fields now", () => {
        const out = normalizeProviders({
            seperateModels: { memory: "m", emotion: "", translate: "", otherAx: "" },
            seperateModelsForAxModels: true,
            fallbackModels: { model: ["a", "", "b"], memory: [], emotion: [], translate: [], otherAx: [] },
            fallbackWhenBlankResponse: true,
            seperateParameters: { memory: { temperature: 1 }, emotion: {}, translate: {}, otherAx: {} },
            doNotChangeSeperateModels: true,
            doNotChangeFallbackModels: true,
            disableSeperateParameterChangeOnPresetChange: true,
        });
        for (const field of [
            "seperateModels",
            "seperateModelsForAxModels",
            "fallbackModels",
            "fallbackWhenBlankResponse",
            "seperateParameters",
            "doNotChangeSeperateModels",
            "doNotChangeFallbackModels",
            "disableSeperateParameterChangeOnPresetChange",
        ]) {
            expect(Object.hasOwn(out, field), field).toBe(false);
            expect(SECTION_FIELDS.providers as readonly string[], field).not.toContain(field);
        }
        expectIdempotent(normalizeProviders, { seperateParameters: { memory: {} }, fallbackModels: { model: ["a"] } });
    });

    it("drops a stored model-to-credential map and the profile fields, of any kind", () => {
        // The profile owns the key and the upstream model and URL of a generic definition.
        const profileFields = [
            "nanogptRequestModel",
            "nanogptRequestModelName",
            "nanogptProvider",
            "ollamaURL",
            "ollamaModel",
            "ollamaModelName",
            "ollamaModelSource",
            "ollamaInputMode",
            "ollamaRequestFormat",
            "ollamaCloudModel",
            "ollamaCloudModelName",
            "customTokenizer",
        ];
        const fresh = normalizeProviders(undefined);
        for (const modelCredentials of [{ "gpt-4o": "c1" }, { "gpt-4o": 1 }, [], null]) {
            const stored = {
                ...Object.fromEntries(profileFields.map((field) => [field, "stored"])),
                modelCredentials,
            };
            const out = normalizeProviders(stored);
            expect(out, JSON.stringify(modelCredentials)).toEqual(fresh);
            expect(serialize(out).text).not.toContain("c1");
        }
        for (const field of ["modelCredentials", ...profileFields]) {
            expect(Object.hasOwn(fresh, field), field).toBe(false);
            expect(SECTION_FIELDS.providers as readonly string[], field).not.toContain(field);
        }
    });

    it("keeps the fresh-boot constants that setDatabase derived from other fields", () => {
        expect(normalizeProviders(undefined)).toMatchObject({ loreBookToken: 8000 });
        // The two Ollama constants moved with the other profile fields to the profile's defaults.
        expect(normalizeModelProfile({})).toMatchObject({ ollamaModelSource: "local", ollamaCloudModel: "" });
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

    it("drops the retired per-model-preset and per-custom-model key maps and the former `presets` map, well-formed or not", () => {
        // The named keys are the one place that stores LLM keys.
        expect(Object.hasOwn(normalizeLlmSecrets(undefined), "modelPresets")).toBe(false);
        expect(Object.hasOwn(normalizeLlmSecrets(undefined), "customModels")).toBe(false);
        const input = JSON.parse(
            '{"modelPresets":{"a":{"proxyKey":"k-preset"},"__proto__":{"proxyKey":"p-preset"}},"customModels":{"xcustom:::a":{"key":"k-custom"}},"presets":{"old":{"proxyKey":"gone"}},"credentials":{"c1":{"key":"k-named"}}}',
        );
        const out = normalizeLlmSecrets(input);
        for (const field of ["modelPresets", "customModels", "presets"]) {
            expect(Object.hasOwn(out, field), field).toBe(false);
        }
        expect(out.credentials).toEqual({ c1: { key: "k-named" } });
        for (const value of ["k-preset", "p-preset", "k-custom", "gone"]) {
            expect(serialize(out).text, value).not.toContain(value);
        }
        expectIdempotent(normalizeLlmSecrets as Normalizer, input);
        // A malformed retired map is dropped too, never refused: it no longer has a shape to check.
        for (const legacy of [[], null, "k", { "": { proxyKey: "k" } }, { a: { proxyKey: 1 } }, { a: null }]) {
            const dropped = normalizeLlmSecrets({ modelPresets: legacy, customModels: legacy });
            expect(dropped, JSON.stringify(legacy)).toEqual(normalizeLlmSecrets(undefined));
        }
    });

    it("keeps the named credential map with only `key` per entry, as own keys, `{}` when absent, and rejects any other shape", () => {
        expect(normalizeLlmSecrets(undefined).credentials).toEqual({});
        const input = JSON.parse('{"credentials":{"c1":{"key":"k","extra":1},"__proto__":{"key":"p"}}}');
        const out = normalizeLlmSecrets(input);
        expect(Object.keys(out.credentials)).toEqual(["c1", "__proto__"]);
        expect(out.credentials.c1).toEqual({ key: "k" });
        expect(Object.getOwnPropertyDescriptor(out.credentials, "__proto__")?.value).toEqual({ key: "p" });
        expectIdempotent(normalizeLlmSecrets as Normalizer, input);
        expect(() => normalizeLlmSecrets({ credentials: [] })).toThrow(
            new ResourceValidationError("llmSecrets.credentials must be an object"),
        );
        for (const credentials of [{ "": { key: "k" } }, { c1: { key: 1 } }, { c1: "k" }, { c1: null }]) {
            expect(() => normalizeLlmSecrets({ credentials }), JSON.stringify(credentials)).toThrow(
                new ResourceValidationError("llmSecrets.credentials must map credential ids to { key: string }"),
            );
        }
    });
});

describe("ui", () => {
    it("repairs blocked Realm creators and keeps only the first entry for each id", () => {
        const out = normalizeUi({
            blockedRealmCreators: [
                { id: "creator-a", name: "Creator A", extra: "discard" },
                null,
                "creator-b",
                {},
                { id: 7, name: "Invalid id" },
                { id: "", name: "Missing id" },
                { id: "creator-b" },
                { id: "creator-c", name: 42 },
                { id: "creator-a", name: "Duplicate" },
            ],
        });
        expect(out.blockedRealmCreators).toEqual([
            { id: "creator-a", name: "Creator A" },
            { id: "creator-b", name: "creator-b" },
            { id: "creator-c", name: "creator-c" },
        ]);
    });

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

    it("keeps newChatBinding when it is one of its two values and replaces any other string, or another kind, with the default `inherit`", () => {
        expect(normalizeUi(undefined).newChatBinding).toBe(DEFAULT_NEW_CHAT_BINDING);
        expect(normalizeUi({ newChatBinding: "inherit" }).newChatBinding).toBe("inherit");
        expect(normalizeUi({ newChatBinding: "empty" }).newChatBinding).toBe("empty");
        for (const value of ["", "changed-newChatBinding", "Inherit", "tab", 1, true, null, {}, ["empty"]]) {
            expect(normalizeUi({ newChatBinding: value }).newChatBinding, JSON.stringify(value)).toBe("inherit");
        }
        expectIdempotent(normalizeUi, { newChatBinding: "tab" });
        expectIdempotent(normalizeUi, { newChatBinding: "empty" });
    });
});

describe("memoryTranslateMedia", () => {
    it("defaults llmTranslationTarget to `message`, keeps `rendered`, and replaces any other string, or another kind, with `message`", () => {
        expect(normalizeMemoryTranslateMedia(undefined).llmTranslationTarget).toBe("message");
        expect(normalizeMemoryTranslateMedia({}).llmTranslationTarget).toBe("message");
        expect(normalizeMemoryTranslateMedia({ llmTranslationTarget: "message" }).llmTranslationTarget).toBe("message");
        expect(normalizeMemoryTranslateMedia({ llmTranslationTarget: "rendered" }).llmTranslationTarget).toBe(
            "rendered",
        );
        for (const value of [
            "",
            "Message",
            "RENDERED",
            "changed-llmTranslationTarget",
            1,
            true,
            null,
            {},
            ["rendered"],
        ]) {
            expect(
                normalizeMemoryTranslateMedia({ llmTranslationTarget: value }).llmTranslationTarget,
                JSON.stringify(value),
            ).toBe("message");
        }
        expectIdempotent(normalizeMemoryTranslateMedia, { llmTranslationTarget: "bogus" });
        expectIdempotent(normalizeMemoryTranslateMedia, { llmTranslationTarget: "rendered" });
    });

    it("defaults translatorHistoryMaxTokens to 2048 for a missing, wrong-kind, nonfinite, zero, or negative value and keeps a positive number, fractions included, exactly", () => {
        const budget = (input: unknown) =>
            normalizeMemoryTranslateMedia(input === undefined ? undefined : { translatorHistoryMaxTokens: input })
                .translatorHistoryMaxTokens;
        expect(bootSnapshot.translatorHistoryMaxTokens).toBe(2048);
        expect(budget(undefined)).toBe(2048);
        expect(normalizeMemoryTranslateMedia({}).translatorHistoryMaxTokens).toBe(2048);
        for (const value of [null, "2048", "", true, [], {}, Number.NaN, Infinity, -Infinity, 0, -0, -1, -0.5, -1e9]) {
            expect(budget(value), JSON.stringify(value) ?? String(value)).toBe(2048);
        }
        for (const value of [1, 0.5, 0.0001, 3000.25, 2048, 1e9]) {
            expect(budget(value), String(value)).toBe(value);
        }
        expectIdempotent(normalizeMemoryTranslateMedia, { translatorHistoryMaxTokens: 0 });
        expectIdempotent(normalizeMemoryTranslateMedia, { translatorHistoryMaxTokens: 0.5 });
        expectIdempotent(normalizeMemoryTranslateMedia, { translatorHistoryMaxTokens: "x" });
    });

    it("turns a stored `bergamot` translator into Google with translation and input translation off, keeps the rest, and drops `htmlTranslation`; the legacy global `autoTranslate` is dropped from every record", () => {
        const bergamot = {
            translatorType: "bergamot",
            translator: "ko",
            autoTranslate: true,
            useAutoTranslateInput: true,
            htmlTranslation: true,
            // Unrelated settings of the same record.
            translatorInputLanguage: "ja",
            legacyTranslation: true,
            combineTranslation: true,
            llmTranslationTarget: "rendered",
            noWaitForTranslate: true,
            loreBookDepth: 9,
        };
        const migrated = normalizeMemoryTranslateMedia(deepFreeze(structuredClone(bergamot)));
        expect(migrated).toMatchObject({
            translatorType: "google",
            translator: "",
            useAutoTranslateInput: false,
            translatorInputLanguage: "ja",
            legacyTranslation: true,
            combineTranslation: true,
            llmTranslationTarget: "rendered",
            noWaitForTranslate: true,
            loreBookDepth: 9,
        });
        expect(Object.hasOwn(migrated, "htmlTranslation")).toBe(false);
        // Auto-translate is a chat setting now: the global field is dropped, never set to `false`.
        expect(Object.hasOwn(migrated, "autoTranslate")).toBe(false);
        expect(DROPPED_FIELDS).toContain("autoTranslate");
        expect(SECTION_FIELDS.memoryTranslateMedia).not.toContain("autoTranslate");
        for (const key of Object.keys(migrated)) {
            expect(SECTION_FIELDS.memoryTranslateMedia, key).toContain(key);
        }
        // The migrated record reads as a Google record from then on: the mapping does not run again.
        expectIdempotent(normalizeMemoryTranslateMedia, bergamot);
        expect(serialize(normalizeMemoryTranslateMedia(migrated)).text).toBe(serialize(migrated).text);
        // Bergamot without a target or the input translation is mapped the same way.
        const bare = normalizeMemoryTranslateMedia({ translatorType: "bergamot" });
        expect(bare).toMatchObject({ translatorType: "google", translator: "", useAutoTranslateInput: false });
        expect(Object.hasOwn(bare, "autoTranslate")).toBe(false);

        // Every other provider keeps its target and its input translation, `none` and an unknown
        // string included (the spec checks the kind, not the value); the global `autoTranslate` of
        // its input is dropped all the same.
        for (const translatorType of ["google", "deepl", "deeplX", "llm", "none", "Bergamot", "bergamot "]) {
            const kept = normalizeMemoryTranslateMedia({
                ...bergamot,
                translatorType,
            });
            expect(kept, translatorType).toMatchObject({
                translatorType,
                translator: "ko",
                useAutoTranslateInput: true,
            });
            expect(Object.hasOwn(kept, "htmlTranslation"), translatorType).toBe(false);
            expect(Object.hasOwn(kept, "autoTranslate"), translatorType).toBe(false);
        }
        // A missing or wrong-kind provider reads as the default without touching the flag.
        for (const translatorType of [undefined, null, 3, ["bergamot"]]) {
            const kept = normalizeMemoryTranslateMedia({ ...bergamot, translatorType });
            expect(kept, JSON.stringify(translatorType)).toMatchObject({
                translatorType: "google",
                translator: "ko",
                useAutoTranslateInput: true,
            });
            expect(Object.hasOwn(kept, "autoTranslate"), JSON.stringify(translatorType)).toBe(false);
        }
        // A record without a translator type carrying only the legacy flag loses it too (`false` included).
        for (const autoTranslate of [true, false]) {
            expect(Object.hasOwn(normalizeMemoryTranslateMedia({ autoTranslate }), "autoTranslate")).toBe(false);
        }
    });

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
