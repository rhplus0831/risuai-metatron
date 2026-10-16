import { beforeEach, describe, expect, it, vi } from "vitest";

// `docs/plan/shared-api-keys.md`, "Client": what the tab shows next to a model (the shared binding
// decision over the records and the masked key status), the select options, and the bindings a
// delete confirmation names.

vi.mock("src/ts/plugins/apiV3/v3.svelte", () => ({ customV3ProviderMetaStore: [] }));
vi.mock("src/ts/network/auxFetch", () => ({ auxFetch: vi.fn() }));
vi.mock("src/ts/alert", () => ({ alertError: vi.fn(), alertNormal: vi.fn() }));

import { maskLlmSecrets } from "../../../../shared/llmSecrets";
import { credentialFor, credentialStatusFor, credentialsAccepted, credentialsUsing } from "../credentials";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { setMaskedSecrets, setSecret, secretVersion } from "src/ts/storage/llmSecrets.svelte";
import { selectModelPreset } from "src/ts/storage/selection.svelte";
import { resolveModelSlot, settings } from "src/ts/storage/settingsViews.svelte";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets";

// Model Profiles: a profile owns the key binding, so each model's binding sits on one profile.
const profiles = [
    { id: "gpt55", name: "GPT 5.5", modelId: "gpt-5.5", credentialId: "work" },
    { id: "gpt54", name: "GPT 5.4", modelId: "gpt-5.4", credentialId: "nokey" },
    { id: "opus", name: "Opus", modelId: "claude-opus-4-6", credentialId: "gone" },
    { id: "mancer", name: "Mancer", modelId: "mancer", credentialId: "home" },
    { id: "gemini", name: "Gemini", modelId: "gemini-2.5-flash" },
    { id: "custom-a", name: "Custom A profile", modelId: "xcustom:::a", credentialId: "home" },
    { id: "custom-b", name: "Custom B profile", modelId: "xcustom:::b" },
    { id: "proxy-a", name: "Proxy A", modelId: "reverse_proxy", credentialId: "work" },
    { id: "proxy-b", name: "Proxy B", modelId: "reverse_proxy" },
];

function profile(id: string) {
    return settings.modelProfiles.find((entry) => entry.id === id)!;
}

function boot() {
    installFlatDatabase({
        characters: [],
        botPresets: [
            { id: "a", name: "Preset A" },
            { id: "b", name: "Preset B" },
        ],
        modelPresets: [
            normalizeModelPreset({ name: "Preset A", mainSlot: { profileId: "proxy-a" } }, { id: "a" }),
            normalizeModelPreset({ name: "Preset B", mainSlot: { profileId: "proxy-b" } }, { id: "b" }),
        ],
        modelProfiles: profiles.map((entry) => normalizeModelProfile(entry)),
        personas: [{ id: "p1", name: "U" }],
        credentials: [
            { id: "work", name: "Work", type: "openai" },
            { id: "home", name: "Home", type: "custom" },
            { id: "claude", name: "Claude", type: "anthropic" },
            { id: "nokey", name: "No key", type: "openai" },
        ],
        customModels: [
            { id: "xcustom:::a", internalId: "a", name: "Custom A" },
            { id: "xcustom:::b", internalId: "b", name: "Custom B" },
        ],
    });
    setMaskedSecrets(
        maskLlmSecrets({ credentials: { work: { key: "k1" }, home: { key: "k2" }, claude: { key: "k3" } } }),
        "all",
    );
    selectModelPreset("a");
}

beforeEach(() => {
    boot();
});

describe("credentialFor", () => {
    it("shows each model's binding state as the server decides it", () => {
        expect(credentialFor(profile("gpt55"))).toMatchObject({
            state: "bound",
            credentialId: "work",
            slot: { slot: "openai" },
        });
        expect(credentialFor(profile("gpt54"))).toMatchObject({
            state: "refused",
            reason: "empty",
            record: { name: "No key" },
        });
        expect(credentialFor(profile("opus"))).toMatchObject({ state: "refused", reason: "missing" });
        expect(credentialFor(profile("mancer"))).toEqual({
            slot: null,
            state: "refused",
            credentialId: "home",
            record: expect.objectContaining({ name: "Home" }),
            reason: "unsupportedModel",
        });
        expect(credentialFor(profile("gemini"))).toMatchObject({ state: "default", slot: { slot: "google" } });
        expect(credentialFor(profile("custom-a"))).toMatchObject({ state: "bound", credentialId: "home" });
        expect(credentialFor(profile("custom-b"))).toMatchObject({ state: "default", slot: { slot: "customModel" } });
    });

    it("reads a key set in this tab before the server acknowledged it", () => {
        expect(credentialFor(profile("gpt54"))).toMatchObject({ state: "refused", reason: "empty" });
        setSecret({ kind: "entry", field: "credentials", id: "nokey" }, "sk-pending");
        expect(credentialFor(profile("gpt54"))).toMatchObject({ state: "bound", credentialId: "nokey" });
    });

    it("reads the reverse proxy binding from the main slot's profile of the active model preset, or the scope's", () => {
        const main = (scope?: { presetId: string; modelPresetId: string }) => {
            const resolved = resolveModelSlot("model", scope);
            return resolved.kind === "profile" ? resolved.profile : undefined;
        };
        expect(credentialFor(main())).toMatchObject({ state: "bound", credentialId: "work" });
        expect(credentialFor(main({ presetId: "b", modelPresetId: "b" }))).toMatchObject({
            state: "default",
        });
        selectModelPreset("b");
        expect(credentialFor(main())).toMatchObject({ state: "default" });
        expect(credentialFor(main({ presetId: "a", modelPresetId: "a" }))).toMatchObject({
            state: "bound",
            credentialId: "work",
        });
    });
});

describe("credentialsAccepted and credentialsUsing", () => {
    it("offers the keys a model's slot accepts, in list order, and none for a model without a slot", () => {
        expect(credentialsAccepted("gpt-5.5").map((record) => record.id)).toEqual(["work", "home", "nokey"]);
        expect(credentialsAccepted("claude-opus-4-6").map((record) => record.id)).toEqual(["home", "claude"]);
        expect(credentialsAccepted("xcustom:::a").map((record) => record.id)).toEqual([
            "work",
            "home",
            "claude",
            "nokey",
        ]);
        expect(credentialsAccepted("mancer")).toEqual([]);
    });

    it("names every profile that binds a key", () => {
        expect(credentialsUsing("home")).toEqual([
            { kind: "modelProfile", id: "mancer", name: "Mancer" },
            { kind: "modelProfile", id: "custom-a", name: "Custom A profile" },
        ]);
        expect(credentialsUsing("work")).toEqual([
            { kind: "modelProfile", id: "gpt55", name: "GPT 5.5" },
            { kind: "modelProfile", id: "proxy-a", name: "Proxy A" },
        ]);
        expect(credentialsUsing("gone")).toEqual([{ kind: "modelProfile", id: "opus", name: "Opus" }]);
        expect(credentialsUsing("claude")).toEqual([]);
    });
});

describe("discovery credential status", () => {
    const flat = { kind: "flat", field: "nanogptKey" } as const;
    it("uses the named key's masked status without a flat key", () => {
        const nano = normalizeModelProfile({ id: "nano", modelId: "nanogpt", credentialId: "home" });
        expect(credentialStatusFor(nano, flat)).toMatchObject({ state: "bound", keySet: true });
        expect(credentialStatusFor(undefined, flat)).toMatchObject({ state: "default", keySet: false });
    });
    it.each(["gone", "nokey", "work"])(
        "treats refused binding %s as no key even when the flat key is set",
        (credentialId) => {
            setMaskedSecrets(
                maskLlmSecrets({ nanogptKey: "flat", credentials: { work: { key: "openai-key" } } }),
                "all",
            );
            const nano = normalizeModelProfile({ id: "nano", modelId: "nanogpt", credentialId });
            expect(credentialStatusFor(nano, flat)).toMatchObject({ state: "refused", keySet: false });
        },
    );
    it("changes refresh identity for A to B and default to bound at equal secret versions", () => {
        setMaskedSecrets(
            maskLlmSecrets({ nanogptKey: "flat", credentials: { home: { key: "A" }, claude: { key: "B" } } }),
            "all",
        );
        settings.credentials.find((key) => key.id === "claude")!.type = "custom";
        const nano = normalizeModelProfile({ id: "nano", modelId: "nanogpt" });
        const paths = [
            flat,
            { kind: "entry", field: "credentials", id: "home" },
            { kind: "entry", field: "credentials", id: "claude" },
        ] as const;
        expect(new Set(paths.map((path) => secretVersion(path))).size).toBe(1);
        const identities = [undefined, "home", "claude"].map(
            (credentialId) => credentialStatusFor({ ...nano, credentialId }, flat).keyVersion,
        );
        expect(new Set(identities).size).toBe(3);
    });
});
