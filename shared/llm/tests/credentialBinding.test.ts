// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveCredentialBinding, type CredentialBindingRecord } from "../credentialBinding.ts";
import { resolveModelInfo } from "../models.ts";

// `docs/plan/shared-api-keys.md`, decision 3: the one binding decision the tab and the server share.
// An absent binding selects the default; any binding that cannot be honored refuses, first failure
// first, and never falls back.

type Record_ = CredentialBindingRecord & { key: string };
const records: Record<string, Record_> = {
    work: { name: "Work", type: "openai", key: "k" },
    blank: { name: "Blank", type: "openai", key: "" },
    claude: { name: "Claude", type: "anthropic", key: "k" },
    sa: { name: "SA", type: "vertex", key: "pem", clientEmail: "sa@x.test" },
    saNoEmail: { name: "SA2", type: "vertex", key: "pem" },
    shared: { name: "Shared", type: "custom", key: "k" },
};
const hasKey = (record: Record_) => record.key !== "";
const decide = (modelId: string, sources: Partial<Parameters<typeof resolveCredentialBinding>[2]>) =>
    resolveCredentialBinding(
        modelId,
        resolveModelInfo(modelId.startsWith("xcustom:::") ? "x" : modelId),
        { customModels: [], ...sources },
        records,
        hasKey,
    );

describe("resolveCredentialBinding", () => {
    it("selects the default without a binding, or with one stored where this model does not read", () => {
        expect(decide("gpt-5.5", {})).toEqual({ kind: "default" });
        expect(decide("gpt-5.5", { modelCredentials: { "gpt-5.4": "work" } })).toEqual({ kind: "default" });
        // A custom model and the reverse proxy ignore the global map.
        expect(decide("xcustom:::a", { modelCredentials: { "xcustom:::a": "work" } })).toEqual({ kind: "default" });
        expect(decide("reverse_proxy", { modelCredentials: { reverse_proxy: "work" } })).toEqual({ kind: "default" });
        // An inherited property is not a binding.
        expect(decide("toString", { modelCredentials: {} })).toEqual({ kind: "default" });
    });

    it("binds through the slot's own source", () => {
        expect(decide("gpt-5.5", { modelCredentials: { "gpt-5.5": "work" } })).toEqual({
            kind: "bound",
            credentialId: "work",
            record: records.work,
        });
        expect(decide("xcustom:::a", { customModels: [{ id: "xcustom:::a", credentialId: "shared" }] })).toMatchObject({
            kind: "bound",
            credentialId: "shared",
        });
        expect(decide("reverse_proxy", { proxyCredentialId: "claude" })).toMatchObject({
            kind: "bound",
            credentialId: "claude",
        });
        expect(
            decide("gemini-2.5-flash-vertex", { modelCredentials: { "gemini-2.5-flash-vertex": "sa" } }),
        ).toMatchObject({ kind: "bound", record: records.sa });
    });

    it("refuses with the first failing reason, in order", () => {
        const reason = (modelId: string, credentialId: string) => {
            const result = decide(modelId, { modelCredentials: { [modelId]: credentialId } });
            return result.kind === "refused" ? [result.reason, result.record?.name] : result.kind;
        };
        // A model without a slot refuses even a binding to a missing key.
        expect(reason("mancer", "gone")).toEqual(["unsupportedModel", undefined]);
        expect(reason("mancer", "work")).toEqual(["unsupportedModel", "Work"]);
        expect(reason("gpt-5.5", "gone")).toEqual(["missing", undefined]);
        expect(reason("gpt-5.5", "")).toEqual(["missing", undefined]);
        // An empty key is reported before a wrong type.
        expect(reason("claude-opus-4-6", "blank")).toEqual(["empty", "Blank"]);
        expect(reason("gpt-5.5", "claude")).toEqual(["typeMismatch", "Claude"]);
        expect(reason("gpt-5.5", "sa")).toEqual(["typeMismatch", "SA"]);
        expect(reason("gemini-2.5-flash-vertex", "saNoEmail")).toEqual(["vertexEmailMissing", "SA2"]);
    });
});
