// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
    createTranslatorPreset,
    createTranslatorStep,
    defaultTranslatorStepName,
    isTranslatorPreset,
    isTranslatorStep,
    normalizeTranslatorSteps,
    TRANSLATOR_OUTPUT_KEY_PATTERN,
    TRANSLATOR_PRESET_MAX_STEPS,
} from "../translatorPresets.ts";

// `docs/plan/translation.md` slice 1.2: a translator preset holds 1 to 5 steps. `createTranslatorPreset`
// is the server's per-preset normalizer and the tab's creation and import helper, so what it emits
// is a fixed point of itself (what the tab writes is what the server stores), and it migrates the
// `{ prompt, maxResponse }` shape presets had before steps. `isTranslatorPreset` is the tab's read
// guard (`getCurrentTranslatorPresetFromState`).

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const inherited = (overrides: Record<string, unknown> = {}) => ({
    id: expect.stringMatching(UUID_V4),
    name: "Step 1",
    enabled: true,
    prompt: "",
    maxResponse: 1000,
    model: { mode: "inherit" },
    ...overrides,
});

describe("normalizeTranslatorSteps", () => {
    it("turns the shape before steps into one inherited step, and an absent or empty list too", () => {
        expect(normalizeTranslatorSteps({ prompt: "p", maxResponse: 7 })).toEqual([
            inherited({ prompt: "p", maxResponse: 7 }),
        ]);
        expect(normalizeTranslatorSteps({})).toEqual([inherited()]);
        expect(normalizeTranslatorSteps({ steps: [] })).toEqual([inherited()]);
        expect(normalizeTranslatorSteps({ steps: "x", prompt: "p" })).toEqual([inherited({ prompt: "p" })]);
        // The old fields are not read once there are steps.
        expect(normalizeTranslatorSteps({ steps: [{ name: "S" }], prompt: "old", maxResponse: 3 })).toEqual([
            inherited({ name: "S" }),
        ]);
        // No `outputKey` key at all when there is none.
        expect(Object.hasOwn(normalizeTranslatorSteps({})[0], "outputKey")).toBe(false);
    });

    it("keeps the first five steps", () => {
        const steps = Array.from({ length: 7 }, (_, index) => ({ id: `s${index}`, name: `N${index}` }));
        const out = normalizeTranslatorSteps({ steps });
        expect(TRANSLATOR_PRESET_MAX_STEPS).toBe(5);
        expect(out.map((step) => step.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    });

    it("coerces every field: a wrong type gets its default, the name is numbered by position", () => {
        const out = normalizeTranslatorSteps({
            steps: [
                null,
                {
                    id: 3,
                    name: "  ",
                    enabled: "yes",
                    prompt: 5,
                    maxResponse: Number.NaN,
                    model: "profile",
                    outputKey: 1,
                    extra: true,
                },
                {
                    id: "kept",
                    name: "Named",
                    enabled: false,
                    prompt: "<|im_start|>system {{slot}}",
                    maxResponse: 12.5,
                    model: { mode: "profile", profileId: "pr" },
                    outputKey: "draft_1",
                },
            ],
        });
        expect(out).toEqual([
            inherited({ name: "Step 1" }),
            inherited({ name: "Step 2" }),
            {
                id: "kept",
                name: "Named",
                enabled: false,
                prompt: "<|im_start|>system {{slot}}",
                maxResponse: 12.5,
                model: { mode: "profile", profileId: "pr" },
                outputKey: "draft_1",
            },
        ]);
        expect(Object.hasOwn(out[1], "extra")).toBe(false);
    });

    it("reads an unknown model mode, or a profile without an id, as inherit, and keeps nothing else of it", () => {
        const model = (value: unknown) => normalizeTranslatorSteps({ steps: [{ model: value }] })[0].model;
        expect(model({ mode: "profile", profileId: "" })).toEqual({ mode: "inherit" });
        expect(model({ mode: "profile" })).toEqual({ mode: "inherit" });
        expect(model({ mode: "inheritTranslate" })).toEqual({ mode: "inherit" });
        expect(model({ mode: "inherit", profileId: "stray" })).toEqual({ mode: "inherit" });
        expect(model({ mode: "profile", profileId: "pr", extra: 1 })).toEqual({ mode: "profile", profileId: "pr" });
        expect(model(["profile"])).toEqual({ mode: "inherit" });
    });

    it("re-keys a repeated step id and drops a repeated or malformed output key", () => {
        const out = normalizeTranslatorSteps({
            steps: [
                { id: "a", outputKey: "k" },
                { id: "a", outputKey: "k" },
                { id: "b", outputKey: "with space" },
                { id: "c", outputKey: "1starts_with_digit" },
                { id: "d", outputKey: "x".repeat(64) },
            ],
        });
        expect(out[0].id).toBe("a");
        expect(out[1].id).toMatch(UUID_V4);
        expect(new Set(out.map((step) => step.id)).size).toBe(5);
        expect(out.map((step) => step.outputKey)).toEqual(["k", undefined, undefined, undefined, "x".repeat(64)]);
        expect(TRANSLATOR_OUTPUT_KEY_PATTERN.test("x".repeat(65))).toBe(false);
        expect(TRANSLATOR_OUTPUT_KEY_PATTERN.test("_ok9")).toBe(true);
    });

    it("is idempotent: a normalized list, generated ids included, normalizes to itself", () => {
        const once = normalizeTranslatorSteps({
            steps: [{ outputKey: "k" }, { id: "dup" }, { id: "dup", model: { mode: "profile", profileId: "pr" } }, 7],
        });
        const twice = normalizeTranslatorSteps({ steps: JSON.parse(JSON.stringify(once)) });
        expect(twice).toEqual(once);
        expect(normalizeTranslatorSteps({ steps: once })).toEqual(once);
    });
});

describe("createTranslatorPreset", () => {
    it("gives a new preset one inherited step with an empty prompt, and migrates the old shape", () => {
        expect(createTranslatorPreset()).toEqual({
            id: expect.stringMatching(UUID_V4),
            name: "New Preset",
            steps: [inherited()],
        });
        expect(createTranslatorPreset("Old", { id: "o", prompt: "p", maxResponse: 5 })).toEqual({
            id: "o",
            name: "Old",
            steps: [inherited({ prompt: "p", maxResponse: 5 })],
        });
        expect(Object.keys(createTranslatorPreset("Old", { prompt: "p" }))).toEqual(["id", "name", "steps"]);
    });

    it("is a fixed point of itself, so a preset the tab creates is stored as it is", () => {
        const created = createTranslatorPreset("Two", {
            steps: [
                { name: "Draft", prompt: "{{slot::content}}", maxResponse: 300, outputKey: "draft" },
                { name: "Polish", prompt: "{{slot::prev}}", model: { mode: "profile", profileId: "pr" } },
            ],
        });
        const stored = createTranslatorPreset(created.name, JSON.parse(JSON.stringify(created)));
        expect(JSON.stringify(stored)).toBe(JSON.stringify(created));
        expect(isTranslatorPreset(created)).toBe(true);
    });
});

// Translation slice 3.1: the editor's "Add step" appends a step the normalizer keeps as it is.
describe("createTranslatorStep", () => {
    it("is a normalized step named by its position, with a fresh id and no output key", () => {
        const step = createTranslatorStep(2);
        expect(step).toEqual(inherited({ name: "Step 3" }));
        expect(Object.keys(step)).toEqual(["id", "name", "enabled", "prompt", "maxResponse", "model"]);
        expect(createTranslatorStep(0).id).not.toBe(createTranslatorStep(0).id);
        expect(isTranslatorStep(step)).toBe(true);
        // A list holding it normalizes to itself, so the tab's copy stays the server's text.
        const steps = [createTranslatorStep(0), createTranslatorStep(1), createTranslatorStep(2)];
        expect(normalizeTranslatorSteps({ steps: JSON.parse(JSON.stringify(steps)) })).toEqual(steps);
        for (const index of [0, 4, 9]) {
            expect(defaultTranslatorStepName(index)).toBe(`Step ${index + 1}`);
            expect(createTranslatorStep(index).name).toBe(defaultTranslatorStepName(index));
        }
    });
});

describe("isTranslatorStep and isTranslatorPreset", () => {
    const valid = createTranslatorPreset("V", { id: "v" });

    it("accept what the normalizer emits and refuse a missing or malformed field", () => {
        expect(isTranslatorStep(valid.steps[0])).toBe(true);
        expect(isTranslatorStep({ ...valid.steps[0], outputKey: "k" })).toBe(true);
        expect(isTranslatorStep({ ...valid.steps[0], model: { mode: "profile", profileId: "pr" } })).toBe(true);
        for (const broken of [
            null,
            [],
            { ...valid.steps[0], id: "" },
            { ...valid.steps[0], name: 1 },
            { ...valid.steps[0], enabled: "true" },
            { ...valid.steps[0], prompt: null },
            { ...valid.steps[0], maxResponse: Number.POSITIVE_INFINITY },
            { ...valid.steps[0], maxResponse: "5" },
            { ...valid.steps[0], model: { mode: "profile", profileId: "" } },
            { ...valid.steps[0], model: { mode: "other" } },
            { ...valid.steps[0], model: undefined },
            { ...valid.steps[0], outputKey: 1 },
        ]) {
            expect(isTranslatorStep(broken), JSON.stringify(broken)).toBe(false);
        }
    });

    it("require a preset id, a string name, and 1 to 5 valid steps", () => {
        expect(isTranslatorPreset(valid)).toBe(true);
        const steps = (count: number) =>
            Array.from({ length: count }, (_, index) => ({ ...valid.steps[0], id: `s${index}` }));
        expect(isTranslatorPreset({ ...valid, steps: steps(5) })).toBe(true);
        for (const broken of [
            { name: "V", steps: valid.steps },
            { ...valid, id: "" },
            { ...valid, name: undefined },
            { ...valid, steps: [] },
            { ...valid, steps: [null] },
            { ...valid, steps: [valid.steps[0], { ...valid.steps[0], maxResponse: "x" }] },
            { ...valid, steps: steps(6) },
            { ...valid, steps: "x" },
            // The shape before steps.
            { id: "v", name: "V", prompt: "p", maxResponse: 1 },
        ]) {
            expect(isTranslatorPreset(broken), JSON.stringify(broken)).toBe(false);
        }
    });
});

// Translation slice 3.2: Send Text As-Is is stored only as `true`. `createTranslatorPreset` (the
// server's per-preset normalizer) drops any other value, so every preset from before the option
// keeps its text, and `isTranslatorPreset` (the selection's guard) still reads a stray `false` as off.
describe("sendTextAsIs", () => {
    it("is kept by createTranslatorPreset only as true, after the steps, and is absent otherwise", () => {
        const on = createTranslatorPreset("On", { id: "on", prompt: "p", maxResponse: 5, sendTextAsIs: true });
        expect(on).toEqual({
            id: "on",
            name: "On",
            steps: [inherited({ prompt: "p", maxResponse: 5 })],
            sendTextAsIs: true,
        });
        expect(Object.keys(on)).toEqual(["id", "name", "steps", "sendTextAsIs"]);
        for (const off of [false, undefined, null, "true", 1, {}, [true]]) {
            const preset = createTranslatorPreset("Off", { id: "off", sendTextAsIs: off });
            expect(Object.hasOwn(preset, "sendTextAsIs"), JSON.stringify(off)).toBe(false);
            expect(Object.keys(preset), JSON.stringify(off)).toEqual(["id", "name", "steps"]);
        }
        // A fixed point with the option on, so a preset the tab turns on is stored as it is.
        const stored = createTranslatorPreset(on.name, JSON.parse(JSON.stringify(on)));
        expect(JSON.stringify(stored)).toBe(JSON.stringify(on));
    });

    it("passes isTranslatorPreset when absent or a boolean, and fails it for any other value", () => {
        const valid = createTranslatorPreset("V", { id: "v" });
        expect(isTranslatorPreset({ ...valid, sendTextAsIs: true })).toBe(true);
        expect(isTranslatorPreset({ ...valid, sendTextAsIs: false })).toBe(true);
        expect(isTranslatorPreset({ ...valid, sendTextAsIs: undefined })).toBe(true);
        for (const broken of [null, "true", 1, 0, {}, []]) {
            expect(isTranslatorPreset({ ...valid, sendTextAsIs: broken }), JSON.stringify(broken)).toBe(false);
        }
    });
});

// Translation slice 3.4: Exclude Chain-of-Thought is stored only as `true`, after `sendTextAsIs` and
// independent of it; the normalizer drops any other value, and the guard reads a boolean or nothing.
describe("excludeThoughts", () => {
    it("is kept by createTranslatorPreset only as true, after sendTextAsIs and independent of it, and is absent otherwise", () => {
        const on = createTranslatorPreset("On", { id: "on", prompt: "p", maxResponse: 5, excludeThoughts: true });
        expect(on).toEqual({
            id: "on",
            name: "On",
            steps: [inherited({ prompt: "p", maxResponse: 5 })],
            excludeThoughts: true,
        });
        expect(Object.keys(on)).toEqual(["id", "name", "steps", "excludeThoughts"]);
        const both = createTranslatorPreset("Both", { id: "both", sendTextAsIs: true, excludeThoughts: true });
        expect(Object.keys(both)).toEqual(["id", "name", "steps", "sendTextAsIs", "excludeThoughts"]);
        for (const off of [false, undefined, null, "true", 1, {}, [true]]) {
            const preset = createTranslatorPreset("Off", { id: "off", sendTextAsIs: true, excludeThoughts: off });
            expect(Object.hasOwn(preset, "excludeThoughts"), JSON.stringify(off)).toBe(false);
            expect(Object.keys(preset), JSON.stringify(off)).toEqual(["id", "name", "steps", "sendTextAsIs"]);
        }
        // A fixed point with the option on, alone or with Send Text As-Is.
        for (const preset of [on, both]) {
            const stored = createTranslatorPreset(preset.name, JSON.parse(JSON.stringify(preset)));
            expect(JSON.stringify(stored)).toBe(JSON.stringify(preset));
            expect(isTranslatorPreset(preset)).toBe(true);
        }
    });

    it("passes isTranslatorPreset when absent or a boolean, and fails it for any other value", () => {
        const valid = createTranslatorPreset("V", { id: "v" });
        expect(isTranslatorPreset({ ...valid, excludeThoughts: true })).toBe(true);
        expect(isTranslatorPreset({ ...valid, excludeThoughts: false })).toBe(true);
        expect(isTranslatorPreset({ ...valid, excludeThoughts: undefined })).toBe(true);
        for (const broken of [null, "true", 1, 0, {}, []]) {
            expect(isTranslatorPreset({ ...valid, excludeThoughts: broken }), JSON.stringify(broken)).toBe(false);
        }
    });
});
