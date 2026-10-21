// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveCredentialBinding, type CredentialBindingRecord } from "../credentialBinding.ts";
import { resolveModelInfo } from "../models.ts";

// The credential binding on the model profile: the one binding decision the tab and the server
// share. An absent binding selects the default; any binding that cannot be honored refuses, first
// failure first, and never falls back.

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
const decide = (modelId: string, profile?: Parameters<typeof resolveCredentialBinding>[2]) =>
    resolveCredentialBinding(
        modelId,
        resolveModelInfo(modelId.startsWith("xcustom:::") ? "x" : modelId),
        profile,
        records,
        hasKey,
    );

describe("resolveCredentialBinding", () => {
    it("selects the default with no profile or a profile without a binding", () => {
        expect(decide("gpt-5.5")).toEqual({ kind: "default" });
        expect(decide("gpt-5.5", {})).toEqual({ kind: "default" });
        expect(decide("xcustom:::a", {})).toEqual({ kind: "default" });
        // An inherited property is not a binding.
        expect(decide("gpt-5.5", Object.create({ credentialId: "work" }))).toEqual({ kind: "default" });
    });

    it("binds the profile's credential for every slot, the custom model and reverse proxy included", () => {
        expect(decide("gpt-5.5", { credentialId: "work" })).toEqual({
            kind: "bound",
            credentialId: "work",
            record: records.work,
        });
        expect(decide("xcustom:::a", { credentialId: "shared" })).toMatchObject({
            kind: "bound",
            credentialId: "shared",
        });
        expect(decide("reverse_proxy", { credentialId: "claude" })).toMatchObject({
            kind: "bound",
            credentialId: "claude",
        });
        expect(decide("gemini-2.5-flash-vertex", { credentialId: "sa" })).toMatchObject({
            kind: "bound",
            record: records.sa,
        });
    });

    it("refuses with the first failing reason, in order", () => {
        const reason = (modelId: string, credentialId: string) => {
            const result = decide(modelId, { credentialId });
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
