// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LLMFlags, LLMFormat, type LLMModel, LLMProvider, LLMTokenizer } from "../../../shared/llm.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import { admitProviderModels, type JobScope } from "../jobs/jobScope.ts";

// Phase 5 slice 11b: a job's plugin provider models (`jobScope.ts` `admitProviderModels`) and how
// the shared resolver reads them (`resolveModelInfo`'s `pluginModels`): the descriptors the tab
// registered when it created the job, each under its own `pluginmodel:::<name>` id, as plugin
// models whatever format they claim, returned as registered (custom flags apply to the extra
// models, not to these: the tab's `pluginModels` branch).

const descriptor = (name: string, extra: Partial<LLMModel> = {}): LLMModel => ({
    id: `pluginmodel:::${name}`,
    name,
    shortName: name,
    fullName: name,
    internalID: `pluginmodel:::${name}`,
    provider: LLMProvider.AsIs,
    format: LLMFormat.Plugin,
    flags: [LLMFlags.hasFullSystemPrompt],
    parameters: ["temperature"],
    tokenizer: LLMTokenizer.Unknown,
    ...extra,
});

describe("admitProviderModels", () => {
    it("admits the descriptors whose id is their provider's `pluginmodel:::<name>`, cloned and as plugin models, on a new request projection that keeps the other fields", () => {
        const db = { enableCustomFlags: true, customFlags: [LLMFlags.hasStreaming], aiModel: "pluginmodel:::prov" };
        const scope = { request: { db, userName: "u" }, chatId: "k" } as unknown as JobScope;
        const before = scope.request;
        // A descriptor that claims another format is admitted as a plugin model all the same: the
        // server never sends a provider request for it.
        const registered = descriptor("prov", { format: LLMFormat.OpenAICompatible });
        admitProviderModels(scope, [
            { name: "prov", model: registered },
            { name: "mismatch", model: descriptor("other") },
            { name: "legacy", model: descriptor("legacy", { id: "custom" }) },
        ]);
        expect(scope.request).not.toBe(before);
        expect(scope.chatId).toBe("k");
        expect((scope.request as unknown as { userName: string }).userName).toBe("u");
        expect(scope.request.db).toMatchObject({
            enableCustomFlags: true,
            customFlags: [LLMFlags.hasStreaming],
            aiModel: "pluginmodel:::prov",
        });
        expect(scope.request.db.pluginModels).toEqual([{ ...registered, format: LLMFormat.Plugin }]);
        // A copy: the hook list's descriptor is not shared with the projection.
        registered.flags.push(LLMFlags.hasImageInput);
        expect(scope.request.db.pluginModels![0].flags).toEqual([LLMFlags.hasFullSystemPrompt]);
        admitProviderModels(scope, []);
        expect(scope.request.db.pluginModels).toEqual([]);
    });
});

describe("resolveModelInfo with plugin models", () => {
    it("returns an admitted descriptor as registered (custom flags do not apply, as in the tab), applies them to an extra model, and falls back for an unadmitted plugin id", () => {
        const pluginModels = [descriptor("prov")];
        const flags = { enableCustomFlags: true, customFlags: [] as LLMFlags[] };
        expect(resolveModelInfo("pluginmodel:::prov", { ...flags, pluginModels })).toEqual(descriptor("prov"));
        // The same descriptor given as an extra model takes the custom flags: that was the defect.
        expect(resolveModelInfo("pluginmodel:::prov", { ...flags, extraModels: pluginModels }).flags).toEqual([]);
        // Without custom flags the two branches agree.
        expect(resolveModelInfo("pluginmodel:::prov", { extraModels: pluginModels })).toEqual(descriptor("prov"));
        // An id no descriptor was admitted for: the catalogue's fallback (the request layer forces
        // it to the plugin format for a job, so it reaches the hook list and is refused there).
        expect(resolveModelInfo("pluginmodel:::other", { ...flags, pluginModels })).toMatchObject({
            id: "pluginmodel:::other",
            format: LLMFormat.OpenAICompatible,
        });
    });
});
