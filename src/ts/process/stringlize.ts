import { activePreset, activePersona } from "../storage/settingsViews.svelte";
import type { OpenAIChat } from "./index.svelte";
import { getUserName } from "../util";

/**
 * Serializes prompt messages for plain-text and AIN formats and trims generated text at speaker
 * markers. Defaults read the active preset/persona through `src/ts/storage/settingsViews.svelte.ts`
 * and `getUserName` in `src/ts/util.ts`; request-bound callers must pass names where supported.
 */

/** Joins plain-text messages, skipping inlay-image memos and adding the speaker prefix unless continuing. */
export function stringlizeChat(formated: OpenAIChat[], char: string, continued: boolean) {
    let resultString: string[] = [];
    for (const form of formated) {
        if (form.memo?.startsWith("inlayImage")) {
            continue;
        }
        if (form.role === "system") {
            resultString.push("system: " + form.content);
        } else if (form.name) {
            resultString.push(form.name + ": " + form.content);
        } else {
            resultString.push(form.content);
        }
    }
    let res = resultString.join("\n\n");

    if (!continued) {
        res += `\n\n${char}:`;
    }
    return res;
}

const userStrings = ["user", "human", "input", "inst", "instruction"];
function toTitleCase(s: string) {
    return s[0].toUpperCase() + s.slice(1).toLowerCase();
}
/** Builds deduplicated stop markers from the active preset and persona; suggestions add a blank-line stop. */
export function getStopStrings(suggesting: boolean = false) {
    let { userPrefix, seperator } = activePreset.ooba.formating;
    if (!seperator) {
        seperator = "\n";
    }
    const username = activePersona.name;
    const stopStrings = ["GPT4 User", "</s>", "<|end", "<|im_end", userPrefix, `${username}:`];
    if (suggesting) {
        stopStrings.push("\n\n");
    }
    for (const user of userStrings) {
        for (const u of [user.toLowerCase(), user.toUpperCase(), user.replace(/\w\S*/g, toTitleCase)]) {
            stopStrings.push(`${u}:`);
            stopStrings.push(`<<${u}>>`);
            stopStrings.push(`### ${u}`);
        }
    }
    return [...new Set(stopStrings)];
}

/** `userName`: the request's persona name (a caller that captured its chat), else the selected chat's. */
export function unstringlizeChat(text: string, formated: OpenAIChat[], char: string = "", userName?: string) {
    let minIndex = -1;

    const chunks = getUnstringlizerChunks(formated, char, "normal", userName).chunks;

    for (const chunk of chunks) {
        const ind = text.indexOf(chunk);
        if (ind === -1) {
            continue;
        }
        if (minIndex === -1 || minIndex > ind) {
            minIndex = ind;
        }
    }

    if (minIndex !== -1) {
        text = text.substring(0, minIndex).trim();
    }

    return text;
}

/** Builds system and speaker boundary markers for normal or AIN output, plus their bare-name variants. */
export function getUnstringlizerChunks(
    formated: OpenAIChat[],
    char: string,
    mode: "ain" | "normal" = "normal",
    userName: string = getUserName(),
) {
    let chunks: string[] = ["system note:", "system:", "system note：", "system："];
    let charNames: string[] = [];
    if (char) {
        charNames.push(char);
        if (mode === "ain") {
            chunks.push(`${char} `);
            chunks.push(`${char}　`);
        } else {
            chunks.push(`${char}:`);
            chunks.push(`${char}：`);
            chunks.push(`${char}: `);
            chunks.push(`${char}： `);
        }
    }
    if (userName) {
        charNames.push(userName);
        if (mode === "ain") {
            chunks.push(`${userName} `);
            chunks.push(`${userName}　`);
        } else {
            chunks.push(`${userName}:`);
            chunks.push(`${userName}：`);
            chunks.push(`${userName}: `);
            chunks.push(`${userName}： `);
        }
    }

    for (const form of formated) {
        if (form.name) {
            charNames.push(form.name);
            if (mode === "ain") {
                if (!chunks.includes(`${form.name} `)) {
                    chunks.push(`${form.name} `);
                    chunks.push(`${form.name}　`);
                }
            } else {
                if (!chunks.includes(`${form.name}:`)) {
                    chunks.push(`${form.name}:`);
                    chunks.push(`${form.name}：`);
                    chunks.push(`${form.name}: `);
                    chunks.push(`${form.name}： `);
                }
            }
        }
    }
    return { chunks, extChunk: charNames.concat(chunks) };
}

/** Formats AIN dialogue; a non-continued suffix currently appends `NaN` through numeric coercion. */
export function stringlizeAINChat(formated: OpenAIChat[], char: string, continued: boolean) {
    let resultString: string[] = [];

    for (const form of formated) {
        console.log(form);
        if ((form.memo && form.memo.startsWith("newChat")) || form.content === "[Start a new chat]") {
            resultString.push("[新しいチャットの始まり]");
            continue;
        }
        if (form.role === "system") {
            resultString.push(form.content);
        } else if (form.role === "user") {
            resultString.push(...formatToAIN(getUserName(), form.content));
        } else if (form.name || form.role === "assistant") {
            resultString.push(...formatToAIN(form.name ?? char, form.content));
        } else {
            resultString.push(form.content);
        }
    }
    let res = resultString.join("\n\n");
    if (!continued) {
        res += +`\n\n${char} 「`;
    } else {
        res += " 「";
    }
    return res;
}

function extractAINOutputStrings(inputString: string, characters: string[]) {
    let results: {
        content: string;
        character: string;
    }[] = [];

    let remainingString = inputString;

    while (remainingString.length > 0) {
        let characterIndex = -1;
        let character = null;
        for (let i = 0; i < characters.length; i++) {
            const index = remainingString.indexOf(characters[i] + "「");
            if (index >= 0 && (characterIndex == -1 || index < characterIndex)) {
                character = characters[i];
                characterIndex = index;
            }
        }

        if (characterIndex > 0) {
            results.push({ content: remainingString.substring(0, characterIndex).trim(), character: "[narrator]" });
        }

        if (characterIndex == -1) {
            results.push({ content: remainingString.trim(), character: "[narrator]" });
            break;
        } else {
            let endQuoteIndex = remainingString.indexOf("」", characterIndex + character.length);
            if (endQuoteIndex == -1) {
                results.push({
                    character,
                    content: remainingString.substring(characterIndex + character.length + 1).trim(), // plus 1 to exclude 「
                });
                break;
            } else {
                results.push({
                    character,
                    content: remainingString.substring(characterIndex + character.length + 1, endQuoteIndex).trim(), // plus 1 to exclude 「
                });
                remainingString = remainingString.substring(endQuoteIndex + 1);
            }
        }
    }

    return results;
}

/** Parses AIN output into speaker turns, attaching narration to character turns and trimming trailing markers. */
export function unstringlizeAIN(data: string, formated: OpenAIChat[], char: string = "") {
    const chunksResult = getUnstringlizerChunks(formated, char, "ain");
    const chunks = chunksResult.chunks;
    let result: ["char" | "user", string][] = [];
    data = `${char} 「` + data;

    for (const n of chunksResult.extChunk) {
        if (data.endsWith(n)) {
            data = data.substring(0, data.length - n.length);
            console.log("trimed");
        }
    }

    const contents = extractAINOutputStrings(data, chunks);
    for (const cont of contents) {
        if (cont.character === "[narrator]") {
            if (result.length === 0) {
                result[0] = ["char", cont.content];
            } else {
                result[result.length - 1][1] += "\n" + cont.content;
            }
        } else {
            const role = cont.character.trim() === getUserName() ? "user" : "char";
            result.push([role, `「${cont.content}」`]);
        }
    }

    return result;
}

function formatToAIN(name: string, content: string) {
    function extractContent(str: string) {
        let result: {
            type: "outside" | "inside";
            content: string;
        }[] = [];
        let lastEndIndex = 0;
        let regex = /「(.*?)」/g;
        let match: RegExpExecArray | null = null;

        while ((match = regex.exec(str)) !== null) {
            let start = match.index;
            let end = start + match[0].length;
            let inside = match[1];

            if (start != lastEndIndex) {
                let outside = str.slice(lastEndIndex, start);
                result.push({
                    type: "outside",
                    content: outside,
                });
            }

            result.push({
                type: "inside",
                content: inside,
            });

            lastEndIndex = end;
        }

        if (lastEndIndex < str.length) {
            let outside = str.slice(lastEndIndex);
            result.push({
                type: "outside",
                content: outside,
            });
        }

        return result;
    }

    let quoteCounter = 0;
    content = content.replace(/"/g, () => {
        quoteCounter++;
        if (quoteCounter % 2 !== 0) {
            return "「";
        } else {
            return "」";
        }
    });

    const conts = extractContent(content);
    let strs: string[] = [];
    for (const cont of conts) {
        if (cont.type === "inside") {
            strs.push(`${name} 「${cont.content}」`);
        } else {
            strs.push(cont.content);
        }
    }
    return strs;
}
