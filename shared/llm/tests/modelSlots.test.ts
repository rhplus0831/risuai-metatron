// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ModelModeExtended } from "../request.ts";
import type { ModelPreset } from "../../database.ts";
import {
    DEFAULT_MODEL_PROFILE_ID,
    normalizeModelPreset,
    normalizeModelProfile,
    normalizeModelProfiles,
} from "../../presets.ts";
import { definitionNeedsProfile, resolveSlotProfile } from "../modelSlots.ts";

// `docs/plan/model-profiles.md`, "Slot resolution" with O3 (slots), O5 (`staticModel`), and O8
// (definitions that need a profile): the one routing decision the tab and the server share.

const profiles = [
    normalizeModelProfile({ id: "main", modelId: "claude-opus-4-6" }),
    normalizeModelProfile({ id: "sub", modelId: "gpt-5.5" }),
    normalizeModelProfile({ id: "memory", modelId: "claude-opus-4-6" }),
    normalizeModelProfile({ id: "proxy", modelId: "reverse_proxy" }),
];

const preset = (fields: Partial<ModelPreset>): ModelPreset =>
    normalizeModelPreset({ mainSlot: { profileId: "main" }, subSlot: { profileId: "sub" }, ...fields });

const summary = (result: ReturnType<typeof resolveSlotProfile>) =>
    result.kind === "profile"
        ? `profile:${result.profile.id}`
        : result.kind === "none"
          ? `none:${result.modelId}`
          : `refused:${result.reason}`;

const AUX_MODES = ["memory", "translate", "emotion", "otherAx"] as const;

describe("resolveSlotProfile", () => {
    it("routes the main mode to the main slot and every other mode to the sub slot while the toggle is off", () => {
        const off = preset({ auxSlots: { memory: { profileId: "memory" } } });
        expect(summary(resolveSlotProfile(off, profiles, "model"))).toBe("profile:main");
        for (const mode of ["submodel", ...AUX_MODES] as const) {
            expect(summary(resolveSlotProfile(off, profiles, mode)), mode).toBe("profile:sub");
        }
    });

    it("routes each auxiliary mode to its own slot when the toggle is on, and an unset one to the sub slot", () => {
        const on = preset({
            seperateModelsForAxModels: true,
            auxSlots: { memory: { profileId: "memory" }, emotion: { profileId: "proxy" } },
        });
        const routed = Object.fromEntries(
            (["model", "submodel", ...AUX_MODES] as ModelModeExtended[]).map((mode) => [
                mode,
                summary(resolveSlotProfile(on, profiles, mode)),
            ]),
        );
        expect(routed).toEqual({
            model: "profile:main",
            // `submodel` never gets an auxiliary slot (O3).
            submodel: "profile:sub",
            memory: "profile:memory",
            emotion: "profile:proxy",
            translate: "profile:sub",
            otherAx: "profile:sub",
        });
        // Two profiles may share one model id; the slot picks the record, not the model.
        const memory = resolveSlotProfile(on, profiles, "memory");
        expect(memory).toMatchObject({ kind: "profile", modelId: "claude-opus-4-6" });
    });

    it("refuses a dangling profile id in any slot instead of falling back", () => {
        const dangling = preset({
            mainSlot: { profileId: "gone" },
            seperateModelsForAxModels: true,
            auxSlots: { translate: { profileId: "gone" } },
        });
        expect(summary(resolveSlotProfile(dangling, profiles, "model"))).toBe("refused:missingProfile");
        expect(summary(resolveSlotProfile(dangling, profiles, "translate"))).toBe("refused:missingProfile");
        expect(summary(resolveSlotProfile(dangling, profiles, "memory"))).toBe("profile:sub");
    });

    it("serves a bare auxiliary slot with no profile, unless its definition needs one", () => {
        const bare = preset({
            seperateModelsForAxModels: true,
            auxSlots: { memory: { modelId: "gemini-2.5-flash" }, otherAx: { modelId: "openrouter" } },
        });
        expect(resolveSlotProfile(bare, profiles, "memory")).toEqual({ kind: "none", modelId: "gemini-2.5-flash" });
        expect(resolveSlotProfile(bare, profiles, "otherAx")).toEqual({
            kind: "refused",
            reason: "needsProfile",
            modelId: "openrouter",
        });
    });

    it("uses the main profile for a static model only when the ids match, and otherwise no profile (O5)", () => {
        const base = preset({});
        expect(summary(resolveSlotProfile(base, profiles, "model", "claude-opus-4-6"))).toBe("profile:main");
        // Even an auxiliary mode reads the main profile, never its own slot.
        expect(summary(resolveSlotProfile(base, profiles, "memory", "claude-opus-4-6"))).toBe("profile:main");
        expect(summary(resolveSlotProfile(base, profiles, "model", "gpt-5.5"))).toBe("none:gpt-5.5");
        expect(summary(resolveSlotProfile(base, profiles, "model", "xcustom:::m1"))).toBe("refused:needsProfile");
        // A missing main profile is no match, not a refusal.
        const dangling = preset({ mainSlot: { profileId: "gone" } });
        expect(summary(resolveSlotProfile(dangling, profiles, "model", "gpt-5.5"))).toBe("none:gpt-5.5");
    });
});

describe("definitionNeedsProfile", () => {
    it("lists exactly the generic definitions, the legacy plugin provider, and custom models", () => {
        const needs = [
            "reverse_proxy",
            "openrouter",
            "nanogpt",
            "ollama-hosted",
            "ollama-cloud",
            "ooba",
            "mancer",
            "kobold",
            "custom",
            "xcustom:::m1",
        ];
        for (const id of needs) {
            expect(definitionNeedsProfile(id), id).toBe(true);
        }
        for (const id of ["gpt-5.5", "claude-opus-4-6", "gemini-2.5-flash", "pluginmodel:::p", "horde:::m", ""]) {
            expect(definitionNeedsProfile(id), id).toBe(false);
        }
    });
});

describe("model slot normalization", () => {
    it("keeps main and sub on a profile, and replaces anything else with the default profile", () => {
        for (const bad of [
            undefined,
            { modelId: "gpt-5.5" },
            { profileId: "" },
            { profileId: "a", extra: 1 },
            "main",
        ]) {
            const record = normalizeModelPreset({ mainSlot: bad, subSlot: bad });
            expect(record.mainSlot, JSON.stringify(bad)).toEqual({ profileId: DEFAULT_MODEL_PROFILE_ID });
            expect(record.subSlot, JSON.stringify(bad)).toEqual({ profileId: DEFAULT_MODEL_PROFILE_ID });
        }
        expect(normalizeModelPreset({ mainSlot: { profileId: "a" } }).mainSlot).toEqual({ profileId: "a" });
    });

    it("keeps only the four auxiliary modes, each a single valid tag", () => {
        const record = normalizeModelPreset({
            auxSlots: {
                memory: { profileId: "p" },
                translate: { modelId: "gpt-5.5" },
                emotion: { profileId: "p", modelId: "gpt-5.5" },
                otherAx: { modelId: "" },
                submodel: { profileId: "p" },
            },
        });
        expect(record.auxSlots).toEqual({ memory: { profileId: "p" }, translate: { modelId: "gpt-5.5" } });
    });

    it("drops the old model ids and the fields that moved to the profile, with no migration (O6)", () => {
        const record = normalizeModelPreset({
            aiModel: "gpt-5.5",
            subModel: "gpt-5.5",
            seperateModels: { memory: "gpt-5.5" },
            forceReplaceUrl: "https://proxy.test",
            maxContext: 1000,
            proxyCredentialId: "k",
            apiType: "x",
        });
        expect(Object.keys(record).sort()).toEqual(
            ["auxSlots", "id", "mainSlot", "name", "seperateModelsForAxModels", "subSlot"].sort(),
        );
    });

    it("materializes one default profile for an empty collection, and keeps a string key binding only", () => {
        const [only, ...rest] = normalizeModelProfiles([]);
        expect(rest).toEqual([]);
        expect(only).toMatchObject({ id: DEFAULT_MODEL_PROFILE_ID, modelId: "gemini-3-flash-preview" });
        expect(only).not.toHaveProperty("credentialId");
        expect(normalizeModelProfile({ credentialId: "k" }).credentialId).toBe("k");
        expect(normalizeModelProfile({ credentialId: 3 })).not.toHaveProperty("credentialId");
        // Profiles hold no secret of their own (O2).
        expect(normalizeModelProfile({ key: "sk", proxyKey: "sk" })).not.toHaveProperty("proxyKey");
        expect(normalizeModelProfile({ key: "sk" })).not.toHaveProperty("key");
    });
});
