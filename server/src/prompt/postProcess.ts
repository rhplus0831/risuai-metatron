import type { character } from "../../../shared/database.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import type { requestDataResponse } from "../llm/request.ts";
import { type EmbeddingEnv, HypaProcesser } from "./embeddings.ts";

/**
 * The parts of a send's tail that are the client's own code after the reply (the former
 * `src/ts/process/index.svelte.ts`, `src/ts/process/inlayScreen.ts`): the inlay screen's rewrite of a
 * reply and the two automatic emotion modes. The runner (`runner.ts`) orders them with the rest of
 * the tail.
 */

const imggenRegex = [/<ImgGen="(.+?)">/gi, /{{ImgGen="(.+?)"}}/gi] as const;

/**
 * `runInlayScreen` (`inlayScreen.ts`): the reply's text at once, and for the image view the work
 * that replaces each image command by its inlay.
 *
 * - `emotion` view: `<Emotion="x">` becomes `{{emotion::x}}`.
 * - `imggen` view: every `<ImgGen="…">` and `{{ImgGen="…"}}` shows `[Generating...]` at once;
 *   `images(generate)` then asks for one image per command (the prompt is the character's
 *   `newGenData.prompt` with the command in `{{slot}}`), one regex form after the other, and gives
 *   the text with `{{inlay::id}}` in place of each command. A command whose image was not made
 *   (`generate` answered null) is removed.
 *
 * The client starts a form's images together; here they are asked one after the other (the job
 * channel runs one callback at a time for a tab anyway).
 */
export function runInlayScreen(
    char: character,
    data: string,
): {
    text: string;
    images?: (generate: (prompt: string, negative: string) => Promise<string | null>) => Promise<string>;
} {
    if (char.inlayViewScreen) {
        if (char.viewScreen === "emotion") {
            return { text: data.replace(/<Emotion="(.+?)">/gi, "{{emotion::$1}}") };
        }
        if (char.viewScreen === "imggen") {
            return {
                text: data.replace(imggenRegex[0], "[Generating...]").replace(imggenRegex[1], "[Generating...]"),
                images: async (generate) => {
                    let text = data;
                    for (const regex of imggenRegex) {
                        const prompts: string[] = [];
                        const neg = char.newGenData?.negative ?? "";
                        text.replace(regex, (match, p1: string) => {
                            prompts.push((char.newGenData?.prompt ?? "").replaceAll("{{slot}}", p1));
                            return match;
                        });
                        const results: string[] = [];
                        for (const prompt of prompts) {
                            const inlay = await generate(prompt, neg);
                            results.push(inlay ? `{{inlay::${inlay}}}` : "");
                        }
                        text = text.replace(regex, () => results.shift() ?? "");
                    }
                    return text;
                },
            };
        }
    }

    return { text: data };
}

/** `[name, image]` of `currentChar.emotionImages`. */
type EmotionImage = [string, string];

/** What the emotion modes read and call outside their arguments. */
export type EmotionHost = {
    /** `db.emotionProcesser` and `db.emotionPrompt2`. */
    emotionProcesser: string;
    emotionPrompt2: string;
    /**
     * The emotions the tab showed last for the speaker (`CharEmotion[chaId]`: its copy when the job
     * was created, plus what the job showed since), oldest first. The job's own list: the mode drops
     * its oldest entry in place when there are five, as the tab's store loses it.
     */
    history(): string[];
    /** `CharEmotion.set` with a new entry: an `emotion` notice, recorded in the job's history. */
    show(emotion: EmotionImage): void;
    /** The job's embeddings (the embedding mode's `new HypaProcesser()`). */
    embeddings(): EmbeddingEnv;
    /** `tokenizeNum` with the main model's tokenizer. */
    tokenizeNum(text: string): Promise<ArrayLike<number>>;
    /** `requestChatData({ formated, bias, currentChar, maxTokens: 30 }, "emotion")`. */
    request(formated: OpenAIChat[], bias: { [key: number]: number }): Promise<requestDataResponse>;
    /** `Math.random` of the list shuffle: the runner's random source. */
    random(): number;
    /** `throwError(text)` where the client goes on afterwards: the error is shown, the send is not stopped. */
    showError(text: string): void;
    aborted(): boolean;
    /** Raises after an abort or a latched failure. */
    fence(): void;
    /** `language.errors.httpError`. */
    httpError: string;
};

const DEFAULT_EMOTION_PROMPT =
    "From the list below, choose a word that best represents a character's outfit description, action, or emotion in their dialogue. Prioritize selecting words related to outfit first, then action, and lastly emotion. Print out the chosen word.";

/**
 * The automatic emotion of a reply (`viewScreen === "emotion"` without `inlayViewScreen`, no emotion
 * shown by the reply yet): the embedding mode or the submodel mode, statement for statement. Both end
 * the client's `sendChat` right after (they return before the last generation-info write), so the
 * caller does too.
 *
 * `tempEmotion` is the client's: the tab's recent emotions with the oldest dropped when there are
 * five, before anything is scored.
 */
export async function runEmotionMode(host: EmotionHost, currentChar: character, result: string): Promise<void> {
    const currentEmotion = currentChar.emotionImages as EmotionImage[];
    let emotionList = currentEmotion.map((a) => {
        return a[0];
    });

    const tempEmotion = host.history();
    if (tempEmotion.length > 4) {
        tempEmotion.splice(0, 1);
    }

    if (host.emotionProcesser === "embedding") {
        const hypaProcesser = new HypaProcesser(host.embeddings());
        await hypaProcesser.addText(emotionList.map((v) => "emotion:" + v));
        host.fence();
        const searched = (await hypaProcesser.similaritySearchScored(result)).map((v) => {
            v[0] = v[0].replace("emotion:", "");
            return v;
        });
        host.fence();

        //give panaltys
        for (let i = 0; i < tempEmotion.length; i++) {
            const emo = tempEmotion[i];
            //give panalty index
            const index = searched.findIndex((v) => {
                return v[0] === emo;
            });

            const modifier = (5 - (tempEmotion.length - (i + 1))) / 200;

            if (index !== -1) {
                searched[index][1] -= modifier;
            }
        }

        //make a sorted array by score
        const emoresult = searched
            .sort((a, b) => {
                return b[1] - a[1];
            })
            .map((v) => {
                return v[0];
            });

        for (const emo of currentEmotion) {
            if (emo[0] === emoresult[0]) {
                host.show(emo);
                break;
            }
        }

        return;
    }

    function shuffleArray(array: string[]) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(host.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    const emobias: { [key: number]: number } = {};

    for (const emo of emotionList) {
        const tokens = await host.tokenizeNum(emo);
        host.fence();
        for (const token of Array.from(tokens)) {
            emobias[token] = 10;
        }
    }

    for (let i = 0; i < tempEmotion.length; i++) {
        const emo = tempEmotion[i];

        const tokens = await host.tokenizeNum(emo);
        host.fence();
        const modifier = 20 - (tempEmotion.length - (i + 1)) * (20 / 4);

        for (const token of Array.from(tokens)) {
            emobias[token] -= modifier;
            if (emobias[token] < -100) {
                emobias[token] = -100;
            }
        }
    }

    const promptbody: OpenAIChat[] = [
        {
            role: "system",
            content: `${host.emotionPrompt2 || DEFAULT_EMOTION_PROMPT}\n\n list: ${shuffleArray(emotionList).join(", ")} \noutput only one word.`,
        },
        {
            role: "user",
            content: `"Good morning, Master! Is there anything I can do for you today?"`,
        },
        {
            role: "assistant",
            content: "happy",
        },
        {
            role: "user",
            content: result,
        },
    ];

    const rq = await host.request(promptbody, emobias);

    if (rq.type === "fail") {
        if (host.aborted()) {
            return;
        }
        host.showError(rq.result);
        return;
    }
    if (rq.type === "streaming" || rq.type === "multiline") {
        if (rq.type === "streaming") {
            // Never read: the request is released.
            void rq.result.cancel().catch(() => {});
        }
        if (host.aborted()) {
            return;
        }
        host.showError("Unexpected response type");
        return;
    } else {
        emotionList = currentEmotion.map((a) => {
            return a[0];
        });
        try {
            const emotion: string = rq.result.replace(/ |\n/g, "").trim().toLocaleLowerCase();
            let emotionSelected = false;
            for (const emo of currentEmotion) {
                if (emo[0] === emotion) {
                    host.show(emo);
                    emotionSelected = true;
                    break;
                }
            }
            if (!emotionSelected) {
                for (const emo of currentEmotion) {
                    if (emotion.includes(emo[0])) {
                        host.show(emo);
                        emotionSelected = true;
                        break;
                    }
                }
            }
            if (!emotionSelected && emotionList.includes("neutral")) {
                const emo = currentEmotion[emotionList.indexOf("neutral")];
                host.show(emo);
                emotionSelected = true;
            }
        } catch (error) {
            host.showError(host.httpError + `${error}`);
            return;
        }
    }
}
