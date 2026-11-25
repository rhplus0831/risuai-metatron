// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { OpenAIChat } from "../../openai.ts";
import { applyRequestInterceptions, type RequestInterception } from "../interception.ts";

describe("applyRequestInterceptions", () => {
    it.each(["user", "assistant"] as const)(
        "inserts eligible rules in list order around a prompt ending in %s without changing the inputs",
        (lastRole) => {
            const prompt: OpenAIChat[] = [
                { role: "system", content: "Original instruction" },
                { role: lastRole, content: "Original last message" },
            ];
            const rule = (
                id: string,
                position: RequestInterception["position"],
                role: RequestInterception["prompt"]["role"],
                text: string,
                overrides: Partial<RequestInterception> = {},
            ): RequestInterception => ({
                id,
                enabled: true,
                modes: ["memory"],
                position,
                prompt: { type: "plain", type2: "normal", role, text, name: `Label for ${id}` },
                ...overrides,
            });
            const rules = [
                rule("end-1", "end", "user", "End one"),
                rule("start-1", "start", "system", "  Start one  "),
                rule("disabled", "start", "user", "Disabled", { enabled: false }),
                rule("other-mode", "end", "system", "Translation only", { modes: ["translate"] }),
                rule("blank", "end", "user", " \n\t "),
                rule("start-2", "start", "bot", "Start two"),
                rule("end-2", "end", "system", "End two"),
            ];
            const originalPrompt = structuredClone(prompt);
            const originalRules = structuredClone(rules);
            const end = [
                { role: "user", content: "End one" },
                { role: "system", content: "End two" },
            ];

            const result = applyRequestInterceptions(prompt, rules, "memory");

            expect(result).toEqual({
                formated: [
                    { role: "system", content: "  Start one  " },
                    { role: "assistant", content: "Start two" },
                    { role: "system", content: "Original instruction" },
                    ...(lastRole === "assistant" ? end : []),
                    { role: lastRole, content: "Original last message" },
                    ...(lastRole === "user" ? end : []),
                ],
                applied: 4,
            });
            expect(result.formated).not.toBe(prompt);
            const unlistedMode = applyRequestInterceptions(prompt, rules, "submodel");
            expect(unlistedMode).toEqual({ formated: originalPrompt, applied: 0 });
            expect(unlistedMode.formated).not.toBe(prompt);
            expect(prompt).toEqual(originalPrompt);
            expect(rules).toEqual(originalRules);
        },
    );
});
