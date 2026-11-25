import { describe, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { isJournalEligible, JOURNAL_EXCLUDED_KINDS } from "../journalEligibility";

// The one boundary of what enters the draft journal (`journalEligibility.ts`): each kind that holds
// credentials as such is refused whatever its text (a delete included), a character is refused only
// with a non-empty `oaiTTSConfig.apiKey`, a `providers` or `customModels` record only when a
// parameter key names `header::`, a text that spells a key with a `\u` escape is parsed and refused
// like a literal one, a text of a checked kind that must be parsed and is not JSON is refused, and
// everything else (other kinds, deletes, chat, order, composer) is eligible.

const SECRET = "sk-live-0123456789abcdef";
const record = (kind: string, text: string | null) => isJournalEligible({ scope: "record", kind, text });
/** A character as `JSON.stringify` writes it, with `oaiTTSConfig` as given. */
const character = (tts: unknown) => JSON.stringify({ name: "Alice", chaId: "c1", oaiTTSConfig: tts });

describe("isJournalEligible", () => {
    it("refuses every excluded kind whatever the text: a credential text, an innocent text, and a delete", () => {
        expect([...JOURNAL_EXCLUDED_KINDS].sort()).toEqual(
            [
                RESOURCE_KIND.llmSecrets,
                RESOURCE_KIND.secrets,
                RESOURCE_KIND.authRefreshes,
                RESOURCE_KIND.pluginStorage,
                RESOURCE_KIND.plugins,
            ].sort(),
        );
        const sentinels: Record<string, string> = {
            [RESOURCE_KIND.llmSecrets]: JSON.stringify({ credentials: { openai: SECRET } }),
            [RESOURCE_KIND.secrets]: JSON.stringify({ googleSearchCredentials: SECRET }),
            [RESOURCE_KIND.authRefreshes]: JSON.stringify([{ refreshToken: SECRET, clientSecret: SECRET }]),
            [RESOURCE_KIND.pluginStorage]: JSON.stringify({ token: SECRET }),
            [RESOURCE_KIND.plugins]: JSON.stringify([{ name: "p", realArg: { key: SECRET } }]),
        };
        for (const kind of JOURNAL_EXCLUDED_KINDS) {
            expect(record(kind, sentinels[kind]), kind).toBe(false);
            expect(record(kind, "{}"), `${kind} innocent`).toBe(false);
            expect(record(kind, null), `${kind} delete`).toBe(false);
        }
    });

    it("refuses a character with a non-empty `oaiTTSConfig.apiKey`, literal or spelled with `\\u` escapes, and accepts one with an empty key, none, or a key elsewhere in free text", () => {
        expect(record(RESOURCE_KIND.characters, character({ apiKey: SECRET, voice: "alloy" }))).toBe(false);
        // JSON may spell the key's letters as escapes: `apiKey` is `apiKey`.
        const escaped = character({ apiKey: SECRET }).replace('"apiKey"', '"\\u0061piKey"');
        expect(escaped).not.toContain("apiKey");
        expect(record(RESOURCE_KIND.characters, escaped)).toBe(false);
        expect(record(RESOURCE_KIND.characters, character({ apiKey: "", voice: "alloy" }))).toBe(true);
        expect(record(RESOURCE_KIND.characters, character({ voice: "alloy" }))).toBe(true);
        expect(
            record(RESOURCE_KIND.characters, JSON.stringify({ name: "Alice", desc: `my apiKey is ${SECRET}` })),
        ).toBe(true);
        expect(record(RESOURCE_KIND.characters, null)).toBe(true);
    });

    it("decides a character without a parse unless it has a non-empty `apiKey` member or a real `\\u` escape", () => {
        const parse = vi.spyOn(JSON, "parse");
        try {
            const regex = { name: "Alice", oaiTTSConfig: { apiKey: "" }, desc: "apiKey", script: "[\\uAC00-\\uD7A3]" };
            expect(JSON.stringify(regex)).toContain("\\\\uAC00");
            expect(record(RESOURCE_KIND.characters, JSON.stringify(regex))).toBe(true);
            expect(record(RESOURCE_KIND.characters, character({ apiKey: "", voice: "alloy" }))).toBe(true);
            expect(parse).not.toHaveBeenCalled();
            // A non-empty key under another object is parsed and accepted.
            expect(record(RESOURCE_KIND.characters, JSON.stringify({ other: { apiKey: SECRET } }))).toBe(true);
            expect(parse).toHaveBeenCalledTimes(1);
            // An escaped backslash right before a real escape (`\\\u0001`) is still parsed.
            const control = JSON.stringify({ desc: "\\\u0001" });
            expect(control).toContain("\\\\\\u0001");
            expect(record(RESOURCE_KIND.characters, control)).toBe(true);
            expect(parse).toHaveBeenCalledTimes(2);
        } finally {
            parse.mockRestore();
        }
    });

    it("refuses a `providers` record whose `additionalParams` has a `header::` key, literal or escaped, and accepts the marker in a value only", () => {
        const providers = (params: unknown) =>
            JSON.stringify({ additionalParams: params, applyAdditionalParamsToAll: true });
        expect(record(RESOURCE_KIND.providers, providers([["header::Authorization", `Bearer ${SECRET}`]]))).toBe(false);
        expect(record(RESOURCE_KIND.providers, providers([["temperature", "0.7"]]))).toBe(true);
        expect(record(RESOURCE_KIND.providers, providers([["note", "set header::X later"]]))).toBe(true);
        const escaped = providers([["header::Authorization", SECRET]]).replace("header::", "\\u0068eader::");
        expect(escaped).not.toContain("header::");
        expect(record(RESOURCE_KIND.providers, escaped)).toBe(false);
        expect(record(RESOURCE_KIND.providers, null)).toBe(true);
    });

    it("refuses a `customModels` record with a model whose `params` line has a `header::` key, and accepts the marker after the `=`", () => {
        const models = (params: string) => JSON.stringify([{ id: "m1", name: "Mine", params }]);
        expect(
            record(RESOURCE_KIND.customModels, models(`temperature=0.7\nheader::Authorization=Bearer ${SECRET}`)),
        ).toBe(false);
        expect(record(RESOURCE_KIND.customModels, models("temperature=0.7"))).toBe(true);
        expect(record(RESOURCE_KIND.customModels, models("note=a header::X value"))).toBe(true);
        expect(record(RESOURCE_KIND.customModels, JSON.stringify([{ id: "m1", params: 7 }]))).toBe(true);
    });

    it("refuses a checked kind's text that names the marker and is not JSON, or parses to the wrong shape, and accepts one without the marker unparsed", () => {
        expect(record(RESOURCE_KIND.characters, `{"oaiTTSConfig":{"apiKey":"${SECRET}"`)).toBe(false);
        expect(record(RESOURCE_KIND.providers, '{"additionalParams":[["header::A","b"]')).toBe(false);
        expect(record(RESOURCE_KIND.customModels, "[{header::A=b")).toBe(false);
        expect(record(RESOURCE_KIND.providers, '["header::A"]')).toBe(false);
        expect(record(RESOURCE_KIND.customModels, '{"params":"header::A=b"}')).toBe(false);
        // Without the marker and without a `\u` escape the text cannot hold the field: not parsed.
        expect(record(RESOURCE_KIND.characters, "{not json")).toBe(true);
        expect(record(RESOURCE_KIND.providers, "{not json")).toBe(true);
    });

    it("accepts every other kind as free text (a module URL with a token included), and every chat, order, and composer subject", () => {
        expect(record(RESOURCE_KIND.modules, JSON.stringify({ url: `https://x.test/?token=${SECRET}` }))).toBe(true);
        expect(record(RESOURCE_KIND.loreBook, `{"content":"${SECRET}"}`)).toBe(true);
        expect(record(RESOURCE_KIND.ui, "{not json")).toBe(true);
        expect(isJournalEligible({ scope: "chat" })).toBe(true);
        expect(isJournalEligible({ scope: "order" })).toBe(true);
        expect(isJournalEligible({ scope: "composer" })).toBe(true);
    });
});
