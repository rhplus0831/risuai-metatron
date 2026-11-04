import { writeInlayImage } from "./files/inlays";
import type { character } from "../storage/database.svelte";
import { generateAIImage } from "./stableDiff";
import { inlayScreenGenData } from "../../../shared/characters.ts";

const imggenRegex = [/<ImgGen="(.+?)">/gi, /{{ImgGen="(.+?)"}}/gi] as const;

/**
 * Unreferenced: a send's view-screen pass is the server's `runInlayScreen`
 * (`server/src/prompt/postProcess.ts`), which asks the tab for each image. With `inlayViewScreen`
 * on, the `emotion` view turns `<Emotion="x">` into `{{emotion::x}}`, and the `imggen` view shows
 * `[Generating...]` for each `<ImgGen="...">` and `{{ImgGen="..."}}` at once, then `promise` gives the
 * text with each command's image as `{{inlay::id}}` (removed when no image was made); a failed inlay
 * write rejects `promise`.
 */
export function runInlayScreen(char: character, data: string): { text: string; promise?: Promise<string> } {
    if (char.inlayViewScreen) {
        if (char.viewScreen === "emotion") {
            return { text: data.replace(/<Emotion="(.+?)">/gi, "{{emotion::$1}}") };
        }
        if (char.viewScreen === "imggen") {
            return {
                text: data.replace(imggenRegex[0], "[Generating...]").replace(imggenRegex[1], "[Generating...]"),
                promise: (async () => {
                    for (const regex of imggenRegex) {
                        const promises: Promise<string | false>[] = [];
                        const neg = char.newGenData.negative;
                        data.replace(regex, (match, p1) => {
                            const prompt = char.newGenData.prompt.replaceAll("{{slot}}", p1);
                            promises.push(
                                (async () => {
                                    const v = await generateAIImage(prompt, char, neg, "inlay");
                                    if (!v) {
                                        return "";
                                    }
                                    const imgHTML = new Image();
                                    imgHTML.src = v;
                                    const inlay = await writeInlayImage(imgHTML);
                                    return `{{inlay::${inlay}}}`;
                                })(),
                            );
                            return match;
                        });
                        const d = await Promise.all(promises);
                        data = data.replace(regex, () => {
                            const result = d.shift();
                            if (result === false) {
                                return "";
                            }
                            return result;
                        });
                    }
                    return data;
                })(),
            };
        }
    }

    return { text: data };
}

export function updateInlayScreen(char: character): character {
    char.newGenData = inlayScreenGenData(char.viewScreen, char.inlayViewScreen);
    return char;
}
