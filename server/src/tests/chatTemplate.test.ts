// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { OpenAIChat } from "../../../shared/openai.ts";
import type { PromptItem } from "../../../shared/prompt.ts";
import { chatTemplates, renderChatTemplate, templateEffect } from "../../../shared/prompt/chatTemplate.ts";
import { templateCheck } from "../../../shared/prompt/templateCheck.ts";

/**
 * The instruct chat templates and the template check under plain Node: the client's
 * `applyChatTemplate` (`src/ts/process/templates/chatTemplate.ts`) ran these over the selected
 * preset's settings; `renderChatTemplate` takes them as parameters. The rendered strings and the
 * thrown errors are those of the pre-move function, and the input list is never changed.
 */
const names = { characterName: () => "Aria", userName: () => "User" };
const render = (messages: OpenAIChat[], type: string, jinjaTemplate = "") =>
    renderChatTemplate(messages, { type, jinjaTemplate, ...names });

const conversation: OpenAIChat[] = [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
    { role: "user", content: "How are you?" },
];

describe("the built-in templates", () => {
    it("chatml and gpt2 wrap every message in im_start/im_end and end with the assistant header", () => {
        const expected =
            "<|im_start|>system\nBe brief.<|im_end|>\n" +
            "<|im_start|>user\nHello<|im_end|>\n" +
            "<|im_start|>assistant\nHi there<|im_end|>\n" +
            "<|im_start|>user\nHow are you?<|im_end|>\n" +
            "<|im_start|>assistant\n";
        expect(render(conversation, "chatml")).toBe(expected);
        expect(render(conversation, "gpt2")).toBe(expected);
    });

    it("llama3 renders the header ids with the bos token first and trims each content", () => {
        expect(render([{ role: "user", content: "  Hello  " }], "llama3")).toBe(
            "<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\nHello<|eot_id|>" +
                "<|start_header_id|>assistant<|end_header_id|>\n\n",
        );
    });

    it("vicuna and alpaca add their default system line only when no system message is present", () => {
        const withSystem = render(conversation, "vicuna");
        expect(withSystem).toBe("Be brief.\n\nUSER: Hello\nASSISTANT: Hi there</s>\nUSER: How are you?\nASSISTANT:");
        expect(render(conversation.slice(1), "vicuna")).toContain(
            "A chat between a curious user and an artificial intelligence assistant.",
        );
        expect(render(conversation.slice(1), "alpaca")).toBe(
            "Below is an instruction that describes a task. Write a response that appropriately completes the request.\n\n" +
                "### Instruction:\nHello\n\n### Response:\nHi there\n\n### Instruction:\nHow are you?\n\n### Response:\n",
        );
    });

    it("gemma turns a system message into a user turn (no_system_messages) and renders model turns", () => {
        expect(templateEffect.gemma).toEqual(["no_system_messages"]);
        expect(
            render(
                [
                    { role: "system", content: "Be brief." },
                    { role: "assistant", content: "Hi there" },
                    { role: "user", content: "How are you?" },
                ],
                "gemma",
            ),
        ).toBe(
            "<start_of_turn>user\nSystem: Be brief.<end_of_turn>\n" +
                "<start_of_turn>model\nHi there<end_of_turn>\n" +
                "<start_of_turn>user\nHow are you?<end_of_turn>\n" +
                "<start_of_turn>model\n",
        );
        // gemma has no role merging: the converted system message followed by a user message is
        // two user turns, which the template rejects (as before the move).
        expect(() => render(conversation, "gemma")).toThrow("Conversation roles must alternate");
    });

    it("gemma raises on roles that do not alternate (the template's own exception)", () => {
        expect(() =>
            render(
                [
                    { role: "user", content: "a" },
                    { role: "user", content: "b" },
                ],
                "gemma",
            ),
        ).toThrow("Conversation roles must alternate");
    });

    it("mistral merges consecutive same-role turns and opens with an empty user turn before a leading assistant", () => {
        expect(templateEffect.mistral).toEqual(["no_system_messages", "alter_user_assistant_roles"]);
        // system + user merge into one user turn; two assistant turns merge; a leading assistant
        // gets an empty user turn in front so the roles alternate.
        expect(
            render(
                [
                    { role: "system", content: "Be brief." },
                    { role: "user", content: "Hello" },
                    { role: "assistant", content: "Hi" },
                    { role: "assistant", content: "there" },
                ],
                "mistral",
            ),
        ).toBe(" [INST] System: Be brief.\nHello [/INST] Hi\nthere ");
        expect(
            render(
                [
                    { role: "assistant", content: "Opening" },
                    { role: "user", content: "Hello" },
                ],
                "mistral",
            ),
        ).toBe(" [INST]  [/INST] Opening  [INST] Hello [/INST]");
    });

    it("llama2 renders the system message into the first user turn", () => {
        expect(render(conversation, "llama2")).toBe(
            "<|begin_of_text|>[INST] <<SYS>>\nBe brief.\n<</SYS>>\n\nHello [/INST] Hi there <|begin_of_text|>[INST] How are you? [/INST]",
        );
    });

    it("skips messages whose role is not user, assistant, or system", () => {
        expect(
            render(
                [
                    { role: "function", content: "tool output" },
                    { role: "user", content: "Hello" },
                ],
                "chatml",
            ),
        ).toBe("<|im_start|>user\nHello<|im_end|>\n<|im_start|>assistant\n");
    });

    it("renders an empty list to the generation prompt alone", () => {
        expect(render([], "chatml")).toBe("<|im_start|>assistant\n");
        expect(render([], "llama3")).toBe("<|start_header_id|>assistant<|end_header_id|>\n\n");
    });

    it("every template key renders the plain conversation without throwing", () => {
        const plain: OpenAIChat[] = [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi" },
            { role: "user", content: "Again" },
        ];
        for (const type of Object.keys(chatTemplates)) {
            expect(() => render(plain, type), type).not.toThrow();
            expect(render(plain, type)).toContain("Hello");
        }
    });

    it("an unknown template type throws (no template to render)", () => {
        expect(() => render(conversation, "nope")).toThrow();
    });
});

describe("a custom jinja template", () => {
    it("renders with risu_char and risu_user read from the getters at render time", () => {
        let userName = "Before";
        const template =
            "{{ risu_char }}/{{ risu_user }}:{% for m in messages %}[{{ m.role }}={{ m.content }}]{% endfor %}";
        const out = renderChatTemplate(conversation.slice(1, 3), {
            type: "jinja",
            jinjaTemplate: template,
            characterName: () => "Aria",
            userName: () => userName,
        });
        expect(out).toBe("Aria/Before:[user=Hello][assistant=Hi there]");
        userName = "After";
        expect(
            renderChatTemplate([], { type: "jinja", jinjaTemplate: template, ...names, userName: () => userName }),
        ).toBe("Aria/After:");
    });

    it("exposes add_generation_prompt as true and empty bos/eos tokens", () => {
        expect(
            renderChatTemplate([], {
                type: "jinja",
                jinjaTemplate: "{{ add_generation_prompt }}|{{ bos_token }}|{{ eos_token }}|",
                ...names,
            }),
        ).toBe("true|||");
    });

    it("the custom template is used only for the jinja type", () => {
        expect(
            renderChatTemplate([{ role: "user", content: "x" }], {
                type: "chatml",
                jinjaTemplate: "IGNORED",
                ...names,
            }),
        ).toBe("<|im_start|>user\nx<|im_end|>\n<|im_start|>assistant\n");
    });
});

describe("the input list", () => {
    it("is not changed by the effects: roles, contents, and the other fields stay as given", () => {
        const messages: OpenAIChat[] = [
            { role: "system", content: "Be brief.", memo: "sys", thoughts: ["t"] },
            { role: "user", content: "Hello", name: "User", attr: ["a"] },
            { role: "assistant", content: "Hi", multimodals: [{ type: "image", base64: "AAA", width: 1, height: 1 }] },
            { role: "assistant", content: "there", removable: true },
        ];
        const before = JSON.stringify(messages);
        const objects = messages.slice();
        render(messages, "mistral");
        render(messages, "chatml");
        expect(() => render(messages, "gemma")).toThrow();
        expect(JSON.stringify(messages)).toBe(before);
        expect(messages.map((m, i) => m === objects[i])).toEqual([true, true, true, true]);
    });
});

describe("templateCheck", () => {
    const item = (fields: Record<string, unknown>) => fields as unknown as PromptItem;
    const complete: PromptItem[] = [
        item({ type: "plain", type2: "main", text: "" }),
        item({ type: "description" }),
        item({ type: "lorebook" }),
        item({ type: "chat", rangeStart: 0, rangeEnd: "end" }),
        item({ type: "jailbreak", type2: "globalNote", text: "" }),
    ];

    it("answers no warning for a missing template and for a complete one", () => {
        expect(templateCheck({})).toEqual([]);
        expect(templateCheck({ promptTemplate: complete })).toEqual([]);
    });

    it("lists every missing entry of an empty template", () => {
        expect(templateCheck({ promptTemplate: [] })).toEqual([
            "No main prompt entry found",
            "No global notes entry found",
            "No description entry found",
            "No lorebook entry found",
            'No chat entry found with range end set to "Until chat end"',
        ]);
    });

    it("warns on duplicate main and note entries", () => {
        const warnings = templateCheck({
            promptTemplate: [
                ...complete,
                item({ type: "plain", type2: "main" }),
                item({ type: "plain", type2: "globalNote" }),
            ],
        });
        expect(warnings).toEqual([
            "Multiple main prompt entries found, this can result in unexpected behavior",
            "Multiple global notes entries found, this can result in unexpected behavior",
        ]);
    });

    it("reports chat ranges whose start and end do not pair up, ignoring the -1000 sentinel and the 0 start", () => {
        const warnings = templateCheck({
            promptTemplate: [
                ...complete,
                item({ type: "chat", rangeStart: 0, rangeEnd: 3 }),
                item({ type: "chat", rangeStart: 3, rangeEnd: 7 }),
                item({ type: "chat", rangeStart: 9, rangeEnd: "end" }),
                item({ type: "chat", rangeStart: -1000, rangeEnd: 42 }),
            ],
        });
        expect(warnings).toEqual(["Chat are not connected: [9, 7]"]);
    });
});
