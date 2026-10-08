import { beforeEach, describe, expect, it, vi } from "vitest";

// `docs/plan/shared-api-keys.md`, "Client": what the tab shows next to a model (the shared binding
// decision over the records and the masked key status), the select options, and the bindings a
// delete confirmation names.

vi.mock("src/ts/plugins/apiV3/v3.svelte", () => ({ customV3ProviderMetaStore: [] }));
vi.mock("src/ts/network/auxFetch", () => ({ auxFetch: vi.fn() }));
vi.mock("src/ts/alert", () => ({ alertError: vi.fn(), alertNormal: vi.fn() }));

import { maskLlmSecrets } from "../../../../shared/llmSecrets";
import { credentialFor, credentialsAccepted, credentialsUsing } from "../credentials";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { setMaskedSecrets, setSecret } from "src/ts/storage/llmSecrets.svelte";
import { selectModelPreset } from "src/ts/storage/selection.svelte";

function boot() {
    installFlatDatabase({
        characters: [],
        botPresets: [
            { id: "a", name: "Preset A", proxyCredentialId: "work" },
            { id: "b", name: "Preset B" },
        ],
        personas: [{ id: "p1", name: "U" }],
        credentials: [
            { id: "work", name: "Work", type: "openai" },
            { id: "home", name: "Home", type: "custom" },
            { id: "claude", name: "Claude", type: "anthropic" },
            { id: "nokey", name: "No key", type: "openai" },
        ],
        modelCredentials: { "gpt-5.5": "work", "gpt-5.4": "nokey", "claude-opus-4-6": "gone", mancer: "home" },
        customModels: [
            { id: "xcustom:::a", internalId: "a", name: "Custom A", credentialId: "home" },
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
        expect(credentialFor("gpt-5.5")).toMatchObject({
            state: "bound",
            credentialId: "work",
            slot: { slot: "openai" },
        });
        expect(credentialFor("gpt-5.4")).toMatchObject({
            state: "refused",
            reason: "empty",
            record: { name: "No key" },
        });
        expect(credentialFor("claude-opus-4-6")).toMatchObject({ state: "refused", reason: "missing" });
        expect(credentialFor("mancer")).toEqual({
            slot: null,
            state: "refused",
            credentialId: "home",
            record: expect.objectContaining({ name: "Home" }),
            reason: "unsupportedModel",
        });
        expect(credentialFor("gemini-2.5-flash")).toMatchObject({ state: "default", slot: { slot: "google" } });
        expect(credentialFor("xcustom:::a")).toMatchObject({ state: "bound", credentialId: "home" });
        expect(credentialFor("xcustom:::b")).toMatchObject({ state: "default", slot: { slot: "customModel" } });
    });

    it("reads a key set in this tab before the server acknowledged it", () => {
        expect(credentialFor("gpt-5.4")).toMatchObject({ state: "refused", reason: "empty" });
        setSecret({ kind: "entry", field: "credentials", id: "nokey" }, "sk-pending");
        expect(credentialFor("gpt-5.4")).toMatchObject({ state: "bound", credentialId: "nokey" });
    });

    it("reads the reverse proxy binding from the active model preset, or the scope's", () => {
        expect(credentialFor("reverse_proxy")).toMatchObject({ state: "bound", credentialId: "work" });
        expect(credentialFor("reverse_proxy", { presetId: "b", modelPresetId: "b" })).toMatchObject({
            state: "default",
        });
        selectModelPreset("b");
        expect(credentialFor("reverse_proxy")).toMatchObject({ state: "default" });
        expect(credentialFor("reverse_proxy", { presetId: "a", modelPresetId: "a" })).toMatchObject({
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

    it("names every binding of a key: global entries, custom models, and every model preset", () => {
        expect(credentialsUsing("home")).toEqual([
            { kind: "model", id: "mancer", name: expect.any(String) },
            { kind: "customModel", id: "xcustom:::a", name: "Custom A" },
        ]);
        expect(credentialsUsing("work")).toEqual([
            { kind: "model", id: "gpt-5.5", name: expect.any(String) },
            { kind: "modelPreset", id: "a", name: "Preset A" },
        ]);
        expect(credentialsUsing("gone")).toEqual([{ kind: "model", id: "claude-opus-4-6", name: expect.any(String) }]);
        expect(credentialsUsing("claude")).toEqual([]);
    });
});
