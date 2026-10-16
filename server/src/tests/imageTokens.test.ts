// @vitest-environment node
import { describe, expect, it } from "vitest";
import { LLMFormat, type LLMModel } from "../../../shared/llm.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import type { MultiModal } from "../../../shared/openai.ts";
import { ChatTokenCounter, type ChatTokenHost } from "../../../shared/prompt/chatTokens.ts";

describe("ChatTokenCounter image rules", () => {
    const image = (width?: number, height?: number): MultiModal => ({ type: "image", base64: "", width, height });
    const counter = (model: LLMModel | undefined, quality?: string, host: Partial<ChatTokenHost> = {}) =>
        new ChatTokenCounter(3, "noName", {
            encode: async (text) => Array.from(text, (_, i) => i),
            supportsInlayImage: () => true,
            ...(model ? { mainModel: () => model } : {}),
            gptVisionQuality: () => quality,
            ...host,
        });

    it("uses the documented tile rates, downscaling, and detail", () => {
        // 1024 square -> 768 square -> four tiles. Low detail charges only the base.
        for (const [id, low, high] of [
            ["gpt4o", 85, 765],
            ["gpt41", 85, 765],
            ["gpt4om", 2833, 25501],
            ["gpt-5", 70, 630],
            ["gpt-5.1", 70, 630],
            ["o1", 75, 675],
            ["o3", 75, 675],
        ] as const) {
            const model = resolveModelInfo(id);
            expect(counter(model, "low").tokenizeMultiModal(image(1024, 1024)), id).toBe(low);
            for (const detail of ["high", "auto", undefined]) {
                expect(counter(model, detail).tokenizeMultiModal(image(1024, 1024)), `${id}/${detail}`).toBe(high);
            }
        }
        const gpt4o = counter(resolveModelInfo("gpt4o"), "high");
        for (const [width, height, expected] of [
            [1000, 2000, 1105], // 768 x 1536: six tiles.
            [2000, 1000, 1105],
            [2049, 4098, 1105], // Fit within 2048 first, then scale the shorter side to 768.
            [4096, 512, 765], // 2048 x 256: four tiles; no upscaling of the short side.
            [500, 2000, 765],
            [769, 1026, 765], // Floor 1024.655... to 1024 after scaling: four, not six tiles.
        ]) {
            expect(gpt4o.tokenizeMultiModal(image(width, height)), `${width}x${height}`).toBe(expected);
        }
    });

    it("fits patch images to the detail limits and rounds the multiplied patch count up", () => {
        for (const [id, detail, width, height, expected] of [
            ["gpt-6-astra", "high", 1024, 1024, 1229], // 1024 patches x 1.2, rounded up.
            ["gpt-6-astra", "high", 2048, 2048, 3000], // Shrink to 50 x 50 patches.
            ["gpt-6-astra", "high", 4096, 512, 2458], // 128 x 16 patches; no 2048 dimension cap.
            ["gpt41-mini", "high", 1024, 1024, 1659], // ceil(1024 x 1.62) = ceil(1658.88).
            ["gpt-5.5", "high", 2048, 2048, 3000],
            ["gpt-5.5", "low", 2048, 2048, 308], // Fit to 512 square: 256 patches x 1.2.
            ["gpt-5.5", "low", 4096, 512, 39], // Fit to 512 x 64: 32 patches x 1.2.
        ] as const) {
            expect(
                counter(resolveModelInfo(id), detail).tokenizeMultiModal(image(width, height)),
                `${id}/${detail}/${width}x${height}`,
            ).toBe(expected);
        }
    });

    it("resolves wire ids through request models, internal ids, and ids with an explicit GPT-4o fallback", () => {
        for (const id of ["openrouter", "nanogpt"]) {
            expect(
                counter(resolveModelInfo(id), "low", { requestModel: () => "openai/gpt-4o-mini" }).tokenizeMultiModal(
                    image(1024, 1024),
                ),
                id,
            ).toBe(2833);
        }
        // The internal wire id wins over the local id; an absent internal id uses the id itself.
        expect(
            counter({ ...resolveModelInfo("gpt4o"), internalID: "gpt-4o-mini" }, "low").tokenizeMultiModal(
                image(1024, 1024),
            ),
        ).toBe(2833);
        expect(
            counter(
                { ...resolveModelInfo("gpt4o"), id: "gpt-4o-mini", internalID: undefined },
                "low",
            ).tokenizeMultiModal(image(1024, 1024)),
        ).toBe(2833);
        for (const id of ["claude-opus-4-8", "gemini-3-flash-preview", "my-custom-model"]) {
            expect(counter(resolveModelInfo(id), "high").tokenizeMultiModal(image(1000, 2000)), id).toBe(1105);
        }
        expect(counter(undefined, "high").tokenizeMultiModal(image(1024, 1024))).toBe(765);
        expect(
            counter(resolveModelInfo("openrouter"), "high", { requestModel: () => "vendor/custom" }).tokenizeMultiModal(
                image(1024, 1024),
            ),
        ).toBe(765);
    });

    it("honors low detail only for request formats that send image detail", () => {
        const withDetail: LLMFormat[] = [
            LLMFormat.OpenAICompatible,
            LLMFormat.OpenAIResponseAPI,
            LLMFormat.Mistral,
            LLMFormat.NanoGPT,
            LLMFormat.NanoGPTResponses,
        ];
        // A numeric enum's entries include the reverse mappings; keep the members only.
        const formats = Object.entries(LLMFormat).filter(
            (entry): entry is [string, LLMFormat] => typeof entry[1] === "number",
        );
        for (const [name, format] of formats) {
            const model = { ...resolveModelInfo("gpt4o"), format };
            expect(counter(model, "low").tokenizeMultiModal(image(1024, 1024)), name).toBe(
                withDetail.includes(format) ? 85 : 765,
            );
        }
    });

    it("counts image defaults and non-image media without charging message overhead per supported entry", async () => {
        const media: MultiModal[] = [
            image(),
            image(1024),
            image(undefined, 1024),
            image(1024, 1024),
            ...(["video", "audio", "signature"] as const).map((type) => ({
                type,
                base64: "",
                width: 4096,
                height: 4096,
            })),
        ];
        const message = { role: "user" as const, content: "abc", multimodals: media };
        const supported = counter(resolveModelInfo("gpt4o"), "high");
        expect(media.map((entry) => supported.tokenizeMultiModal(entry))).toEqual([255, 255, 255, 765, 85, 85, 85]);
        expect(await supported.tokenizeChat(message)).toBe(3 + 3 + 255 * 3 + 765 + 85 * 3);
        expect(await supported.tokenizeChats([message, { role: "assistant", content: "ok" }])).toBe(1791 + 2 + 3);
        const unsupported = counter(resolveModelInfo("gpt4"), "high", { supportsInlayImage: () => false });
        expect(media.map((entry) => unsupported.tokenizeMultiModal(entry))).toEqual([3, 3, 3, 3, 3, 3, 3]);
        expect(await unsupported.tokenizeChat(message)).toBe(3 + 3 + 7 * 3);
    });
});
