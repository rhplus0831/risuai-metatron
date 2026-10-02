// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { character } from "../../../shared/database.ts";
import { createVectorCache, type VectorCache } from "../data/vectorCache.ts";
import { createEmbeddings, type EmbeddingEnv } from "../prompt/embeddings.ts";
import { type EmotionHost, runEmotionMode, runInlayScreen } from "../prompt/postProcess.ts";
import type { TransformersService } from "../prompt/transformers.ts";

// Phase 5 slice 11a: `server/src/prompt/postProcess.ts`, the client's `runInlayScreen` and the two
// automatic emotion modes of `sendChatInner` on an `EmotionHost`. The inlay rewrite: the emotion tag,
// the image commands of both forms shown as `[Generating...]` at once and asked one after the other in
// the client's pass order (one form, then the other), the prompt with the command in `{{slot}}` and
// the character's negative, a command without an image removed, the other views untouched. The
// submodel mode: the +10 biases from the main tokenizer, the recent emotions trimmed to four in the
// job's own list before anything is scored (also when nothing is chosen: a failed request, an answer
// without a match), the penalties 5, 10, 15, 20 floored at -100, the four-message prompt with the
// list shuffled by the host's random source, the exact, contained, and `neutral` matches, a failure or
// an unexpected answer shown through `showError` (a stream cancelled) unless aborted. The embedding
// mode: the `emotion:` documents, the reply as the query, the dot-product ranking with the recency
// penalty on the trimmed history, one `show` for the best name.

const EMOTIONS: [string, string][] = [
    ["happy", "happy.png"],
    ["sad", "sad.png"],
    ["angry", "angry.png"],
    ["calm", "calm.png"],
    ["bored", "bored.png"],
    ["neutral", "neutral.png"],
];
const TOKENS: Record<string, number[]> = { happy: [1], sad: [2], angry: [3], calm: [4], bored: [5], neutral: [6, 7] };
const char = (fields: Partial<character> = {}): character =>
    ({ chaId: "c", type: "character", emotionImages: EMOTIONS, ...fields }) as unknown as character;

type Answer = Awaited<ReturnType<EmotionHost["request"]>>;
function host(options: {
    history?: string[];
    answer?: Answer | (() => Answer);
    processer?: "submodel" | "embedding";
    aborted?: boolean;
    embeddings?: () => EmbeddingEnv;
    random?: () => number;
}) {
    const history = options.history ?? [];
    const requests: { formated: { role: string; content: string }[]; bias: Record<number, number> }[] = [];
    const shown: [string, string][] = [];
    const errors: string[] = [];
    const tokenized: string[] = [];
    const fences = { count: 0 };
    const h: EmotionHost = {
        emotionProcesser: options.processer ?? "submodel",
        emotionPrompt2: "",
        history: () => history,
        // The runner's `showEmotion`: the job's list loses its oldest of five and takes the name.
        show: (emotion) => {
            shown.push(emotion);
            if (history.length > 4) {
                history.splice(0, 1);
            }
            history.push(emotion[0]);
        },
        embeddings: options.embeddings ?? (() => ({}) as EmbeddingEnv),
        tokenizeNum: async (text) => {
            tokenized.push(text);
            return TOKENS[text] ?? [99];
        },
        request: async (formated, bias) => {
            requests.push({ formated, bias: { ...bias } });
            const answer = options.answer ?? { type: "success", result: "nothing" };
            return typeof answer === "function" ? answer() : answer;
        },
        random: options.random ?? (() => 0),
        showError: (text) => errors.push(text),
        aborted: () => options.aborted ?? false,
        fence: () => {
            fences.count += 1;
        },
        httpError: "HTTP error: ",
    };
    return { host: h, history, requests, shown, errors, tokenized, fences };
}

describe("runInlayScreen", () => {
    it("rewrites the emotion tag for the emotion inlay view and leaves the other views alone", () => {
        const text = 'Hi <Emotion="joy"> and <emotion="Calm"> there.';
        expect(runInlayScreen(char({ inlayViewScreen: true, viewScreen: "emotion" }), text)).toEqual({
            text: "Hi {{emotion::joy}} and {{emotion::Calm}} there.",
        });
        expect(runInlayScreen(char({ inlayViewScreen: false, viewScreen: "emotion" }), text)).toEqual({ text });
        expect(runInlayScreen(char({ inlayViewScreen: true, viewScreen: "none" }), text)).toEqual({ text });
        expect(runInlayScreen(char({ inlayViewScreen: false, viewScreen: "imggen" }), text)).toEqual({ text });
    });

    it("shows [Generating...] for both image command forms at once, asks one image per command form by form, and removes a command without an image", async () => {
        const c = char({
            inlayViewScreen: true,
            viewScreen: "imggen",
            newGenData: {
                prompt: "best, {{slot}}, fine",
                negative: "worse",
                instructions: "",
                emotionInstructions: "",
            },
        });
        const inlay = runInlayScreen(c, 'A {{ImgGen="dog"}} then <ImgGen="cat"> and <imggen="bird"> end.');
        expect(inlay.text).toBe("A [Generating...] then [Generating...] and [Generating...] end.");
        expect(inlay.images).toBeDefined();
        const asked: [string, string][] = [];
        let pending = 0;
        let overlapped = false;
        const text = await inlay.images!(async (prompt, negative) => {
            asked.push([prompt, negative]);
            pending += 1;
            overlapped ||= pending > 1;
            await new Promise((resolve) => setTimeout(resolve, 5));
            pending -= 1;
            return prompt.includes("cat") ? null : `img-${asked.length}`;
        });
        // The `<ImgGen>` form's commands first, then the `{{ImgGen}}` form's, each one after the other.
        expect(asked).toEqual([
            ["best, cat, fine", "worse"],
            ["best, bird, fine", "worse"],
            ["best, dog, fine", "worse"],
        ]);
        expect(overlapped).toBe(false);
        expect(text).toBe("A {{inlay::img-3}} then  and {{inlay::img-2}} end.");
        // A character without image settings asks with an empty prompt and negative.
        const bare = runInlayScreen(
            char({ inlayViewScreen: true, viewScreen: "imggen", newGenData: undefined }),
            '<ImgGen="x">',
        );
        const bareAsked: [string, string][] = [];
        expect(
            await bare.images!(async (prompt, negative) => {
                bareAsked.push([prompt, negative]);
                return "i";
            }),
        ).toBe("{{inlay::i}}");
        expect(bareAsked).toEqual([["", ""]]);
    });
});

describe("runEmotionMode, the submodel mode", () => {
    it("biases the list +10 with the main tokenizer, penalizes the history trimmed to four in place, sends the four-message prompt, and shows the exact match", async () => {
        const h = host({
            history: ["happy", "sad", "angry", "calm", "bored"],
            answer: { type: "success", result: " Calm\n" },
        });
        await runEmotionMode(h.host, char(), "I am at ease.");
        // The oldest of five is gone before scoring: its tokens keep +10; the rest take 5, 10, 15, 20.
        expect(h.history).toEqual(["sad", "angry", "calm", "bored", "calm"]);
        expect(h.requests).toHaveLength(1);
        expect(h.requests[0].bias).toEqual({ 1: 10, 2: 5, 3: 0, 4: -5, 5: -10, 6: 10, 7: 10 });
        expect(h.tokenized).toEqual([
            "happy",
            "sad",
            "angry",
            "calm",
            "bored",
            "neutral",
            "sad",
            "angry",
            "calm",
            "bored",
        ]);
        const { formated } = h.requests[0];
        expect(formated.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
        // The list is shuffled by the host's random source (0: a rotation), the default prompt kept.
        expect(formated[0].content).toMatch(
            /^From the list below, choose a word .*\n\n list: .* \noutput only one word\.$/s,
        );
        expect(formated[0].content).toContain("list: sad, angry, calm, bored, neutral, happy");
        expect(formated[1].content).toBe(`"Good morning, Master! Is there anything I can do for you today?"`);
        expect(formated[2].content).toBe("happy");
        expect(formated[3].content).toBe("I am at ease.");
        expect(h.shown).toEqual([["calm", "calm.png"]]);
        expect(h.errors).toEqual([]);
    });

    it("sums the penalties of a repeated recent emotion and uses the configured prompt", async () => {
        const h = host({ history: ["calm", "calm", "calm", "calm"], answer: { type: "success", result: "calm" } });
        h.host.emotionPrompt2 = "Pick one.";
        await runEmotionMode(h.host, char(), "r");
        // 10 - (5 + 10 + 15 + 20) = -40 (the -100 floor is out of reach with four entries).
        expect(h.requests[0].bias[4]).toBe(-40);
        expect(h.requests[0].formated[0].content).toMatch(/^Pick one\.\n\n list: /);
        expect(h.history).toEqual(["calm", "calm", "calm", "calm", "calm"]);
    });

    it("shows a contained match, else neutral, else nothing; every outcome trims the history first", async () => {
        const contained = host({
            history: ["a", "b", "c", "d", "e"],
            answer: { type: "success", result: "Rather sad today" },
        });
        await runEmotionMode(contained.host, char(), "r");
        expect(contained.shown).toEqual([["sad", "sad.png"]]);
        expect(contained.history).toEqual(["b", "c", "d", "e", "sad"]);

        const neutral = host({ history: ["a", "b", "c", "d", "e"], answer: { type: "success", result: "unknown" } });
        await runEmotionMode(neutral.host, char(), "r");
        expect(neutral.shown).toEqual([["neutral", "neutral.png"]]);
        expect(neutral.history).toEqual(["b", "c", "d", "e", "neutral"]);

        const nothing = host({ history: ["a", "b", "c", "d", "e"], answer: { type: "success", result: "unknown" } });
        await runEmotionMode(nothing.host, char({ emotionImages: EMOTIONS.slice(0, 5) }), "r");
        expect(nothing.shown).toEqual([]);
        expect(nothing.errors).toEqual([]);
        // The tab's store lost its oldest entry whether or not a choice was made.
        expect(nothing.history).toEqual(["b", "c", "d", "e"]);

        const four = host({ history: ["a", "b", "c", "d"], answer: { type: "success", result: "unknown" } });
        await runEmotionMode(four.host, char({ emotionImages: EMOTIONS.slice(0, 5) }), "r");
        expect(four.history).toEqual(["a", "b", "c", "d"]);
    });

    it("shows a failure and an unexpected answer (a stream cancelled) through showError, nothing after an abort, and trims the history in each case", async () => {
        const failed = host({ history: ["a", "b", "c", "d", "e"], answer: { type: "fail", result: "upstream broke" } });
        await runEmotionMode(failed.host, char(), "r");
        expect(failed.errors).toEqual(["upstream broke"]);
        expect(failed.shown).toEqual([]);
        expect(failed.history).toEqual(["b", "c", "d", "e"]);

        let cancelled = 0;
        const stream = new ReadableStream({
            cancel() {
                cancelled += 1;
            },
        });
        const streaming = host({
            history: ["a", "b", "c", "d", "e"],
            answer: { type: "streaming", result: stream } as unknown as Answer,
        });
        await runEmotionMode(streaming.host, char(), "r");
        expect(cancelled).toBe(1);
        expect(streaming.errors).toEqual(["Unexpected response type"]);
        expect(streaming.history).toEqual(["b", "c", "d", "e"]);

        const multiline = host({ answer: { type: "multiline", result: [["char", "x"]] } as unknown as Answer });
        await runEmotionMode(multiline.host, char(), "r");
        expect(multiline.errors).toEqual(["Unexpected response type"]);

        const aborted = host({ answer: { type: "fail", result: "request aborted" }, aborted: true });
        await runEmotionMode(aborted.host, char(), "r");
        expect(aborted.errors).toEqual([]);
        expect(aborted.shown).toEqual([]);
    });
});

describe("runEmotionMode, the embedding mode", () => {
    const dirs: string[] = [];
    const caches: VectorCache[] = [];
    afterAll(() => {
        for (const cache of caches) {
            cache.close();
        }
        for (const dir of dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    const VECTORS: Record<string, number[]> = {
        "emotion:near": [1, 0, 0],
        "emotion:mid": [0.927, 0, 0],
        "emotion:close": [0.935, 0, 0],
        "emotion:far": [0, 0, 1],
    };
    const embedded: string[][] = [];
    /** A custom embedding env over a fake fetch: the emotion documents get fixed vectors, the query `[1, 0, 0]`. */
    function env(): EmbeddingEnv {
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-post-process-"));
        dirs.push(dir);
        const cache = createVectorCache({ file: path.join(dir, "vectors.sqlite") });
        caches.push(cache);
        const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
            embedded.push(input);
            return new Response(
                JSON.stringify({ data: input.map((text) => ({ embedding: VECTORS[text] ?? [1, 0, 0] })) }),
                { status: 200 },
            );
        }) as typeof fetch;
        return createEmbeddings({ cache, transformers: {} as TransformersService, fetchImpl }).forJob({
            db: {
                hypaModel: "custom",
                hypaCustomSettings: { url: "http://embed.test/v1/", key: "k", model: "emb" },
            } as EmbeddingEnv["db"],
            supaMemoryKey: "",
            signal: new AbortController().signal,
        });
    }
    const emotions: [string, string][] = [
        ["near", "near.png"],
        ["mid", "mid.png"],
        ["far", "far.png"],
    ];

    it("embeds the emotion documents and the reply, ranks by the dot product with the recency penalty on the history trimmed to four, and shows the best name", async () => {
        const fresh = host({ processer: "embedding", embeddings: env });
        await runEmotionMode(fresh.host, char({ emotionImages: emotions }), "The reply.");
        expect(embedded.flat()).toEqual(
            expect.arrayContaining(["emotion:near", "emotion:mid", "emotion:far", "The reply."]),
        );
        expect(fresh.shown).toEqual([["near", "near.png"]]);
        expect(fresh.requests).toEqual([]);
        expect(fresh.history).toEqual(["near"]);
        // Five recent "near": trimmed to four, the penalties (2+3+4+5)/200 = 0.07 leave near at 0.93,
        // above mid's 0.927; all five (0.075) would put mid first.
        const penalized = host({
            processer: "embedding",
            embeddings: env,
            history: ["near", "near", "near", "near", "near"],
        });
        await runEmotionMode(penalized.host, char({ emotionImages: emotions }), "The reply.");
        expect(penalized.shown).toEqual([["near", "near.png"]]);
        expect(penalized.history).toEqual(["near", "near", "near", "near", "near"]);
        // The penalty grows with the slot: three recent "near" cost (3+4+5)/200 = 0.06 and keep near
        // (0.94) above "close" (0.935); four cost 0.07 and put close first.
        const closer: [string, string][] = [
            ["near", "near.png"],
            ["close", "close.png"],
            ["far", "far.png"],
        ];
        const three = host({ processer: "embedding", embeddings: env, history: ["near", "near", "near"] });
        await runEmotionMode(three.host, char({ emotionImages: closer }), "The reply.");
        expect(three.shown).toEqual([["near", "near.png"]]);
        const four = host({ processer: "embedding", embeddings: env, history: ["near", "near", "near", "near"] });
        await runEmotionMode(four.host, char({ emotionImages: closer }), "The reply.");
        expect(four.shown).toEqual([["close", "close.png"]]);
        expect(four.history).toEqual(["near", "near", "near", "near", "close"]);
        // The penalty names: a history of another emotion leaves near untouched.
        const other = host({ processer: "embedding", embeddings: env, history: ["mid", "mid", "mid", "mid", "mid"] });
        await runEmotionMode(other.host, char({ emotionImages: emotions }), "The reply.");
        expect(other.shown).toEqual([["near", "near.png"]]);
        expect(other.history).toEqual(["mid", "mid", "mid", "mid", "near"]);
    });
});
