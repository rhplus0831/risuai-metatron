import type { customscript } from "../database.ts";

/**
 * The regex script engine, shared by the client and the server (PLAN.md Decision 2): flags and
 * `<order n>`, the `@@` directives, and the script loop. It writes nothing itself: `@@emo` and
 * `@@inject` go to `applyEffect` at the point they match, so a later script's CBS reads what the
 * effect wrote, and come back as the ordered `effects` of the run. Lua edit hooks, the display
 * trigger, plugin handlers, and dynamic assets stay with the caller.
 */
export type RegexScriptMode = "editinput" | "editoutput" | "editprocess" | "editdisplay";

export type RegexScriptEffect =
    /** An `@@emo <name>` script matched. */
    | { kind: "emotion"; name: string }
    /** An `@@inject` script matched: the message at `chatID` becomes `text`. */
    | { kind: "inject"; text: string };

export type RegexScriptRun = {
    mode: RegexScriptMode;
    /** The message index the text belongs to, or -1 (no `@@inject`, no `@@repeat_back`). */
    chatID: number;
    /** CBS for this run's chat: the client's `risuChatParser(text, { chatID, cbsConditions, chatRef })`. */
    parse: (text: string) => string;
    /**
     * `@@repeat_back`: the text of the previous message with the role of the one at `chatID`, or
     * the chat's first message. It may throw, as the client's lookup does; the script is skipped.
     */
    repeatBackSource: () => string;
    /**
     * Applies an effect where its script matched, inside the script's `try` (a throw skips the
     * rest of that script, as an inline write did). The client writes `CharEmotion` and the
     * message here; a caller that only collects `effects` leaves it out.
     */
    applyEffect?: (effect: RegexScriptEffect) => void;
};

const dreg = /{{data}}/g;

type ParsedScript = {
    script: customscript;
    order: number;
    actions: string[];
};

function parseScripts(scripts: customscript[]): ParsedScript[] {
    const parsed: ParsedScript[] = [];
    let orderChanged = false;
    for (const script of scripts) {
        if (script.ableFlag && script.flag?.includes("<")) {
            const rregex = /<(.+?)>/g;
            const scriptData = { ...script };
            let order = 0;
            const actions: string[] = [];
            scriptData.flag = scriptData.flag?.replace(rregex, (v: string, p1: string) => {
                const meta = p1.split(",").map((v) => v.trim());
                for (const m of meta) {
                    if (m.startsWith("order ")) {
                        order = parseInt(m.substring(6));
                        orderChanged = true;
                    } else {
                        actions.push(m);
                    }
                }

                return "";
            });
            parsed.push({
                script: scriptData,
                order,
                actions,
            });
            continue;
        }
        parsed.push({
            script,
            order: 0,
            actions: [],
        });
    }

    if (orderChanged) {
        parsed.sort((a, b) => b.order - a.order); //sort by order
    }
    return parsed;
}

/** Runs `scripts` of `run.mode` over `data`, in their order; a script that throws is skipped. */
export function runRegexScripts(
    data: string,
    scripts: customscript[],
    run: RegexScriptRun,
): { data: string; effects: RegexScriptEffect[] } {
    const { mode, chatID, parse } = run;
    const effects: RegexScriptEffect[] = [];
    const emit = (effect: RegexScriptEffect) => {
        effects.push(effect);
        run.applyEffect?.(effect);
    };

    function executeScript(pscript: ParsedScript) {
        const script = pscript.script;

        if (script.in === "") {
            return;
        }

        if (script.type === mode) {
            let outScript2 = script.out.replaceAll("$n", "\n");
            let outScript = outScript2.replace(dreg, "$&");
            let flag = "g";
            if (script.ableFlag) {
                flag = script.flag || "g";
            }
            if (
                outScript.startsWith("@@move_top") ||
                outScript.startsWith("@@move_bottom") ||
                pscript.actions.includes("move_top") ||
                pscript.actions.includes("move_bottom")
            ) {
                flag = flag.replace("g", ""); //temperary fix
            }
            if (outScript.endsWith(">") && !pscript.actions.includes("no_end_nl")) {
                outScript += "\n";
            }
            //remove unsupported flag
            flag = flag.trim().replace(/[^dgimsuvy]/g, "");

            //remove repeated flags
            flag = flag
                .split("")
                .filter((v, i, a) => a.indexOf(v) === i)
                .join("");

            if (flag.length === 0) {
                flag = "u";
            }

            let input = script.in;
            if (pscript.actions.includes("cbs")) {
                input = parse(input);
            }

            const reg = new RegExp(input, flag);
            if (outScript.startsWith("@@") || pscript.actions.length > 0) {
                if (reg.test(data)) {
                    if (outScript.startsWith("@@emo ")) {
                        emit({ kind: "emotion", name: script.out.substring(6).trim() });
                    } else if (
                        (outScript.startsWith("@@inject") || pscript.actions.includes("inject")) &&
                        chatID !== -1
                    ) {
                        emit({ kind: "inject", text: data });
                        data = data.replace(reg, "");
                    } else if (
                        outScript.startsWith("@@move_top") ||
                        outScript.startsWith("@@move_bottom") ||
                        pscript.actions.includes("move_top") ||
                        pscript.actions.includes("move_bottom")
                    ) {
                        const isGlobal = flag.includes("g");
                        const matchAll = isGlobal ? data.matchAll(reg) : [data.match(reg)];
                        data = data.replace(reg, "");
                        for (const matched of matchAll) {
                            if (matched) {
                                const inData = matched[0];
                                let out = outScript
                                    .replace("@@move_top ", "")
                                    .replace("@@move_bottom ", "")
                                    .replace(/(?<!\$)\$[0-9]+/g, (v) => {
                                        const index = parseInt(v.substring(1));
                                        if (index < matched.length) {
                                            return matched[index];
                                        }
                                        return v;
                                    })
                                    .replace(/\$\&/g, inData)
                                    .replace(/(?<!\$)\$<([^>]+)>/g, (v) => {
                                        // The client indexes the groups by a number here.
                                        const groupName = parseInt(v.substring(2, v.length - 1)) as unknown as string;
                                        if (matched.groups && matched.groups[groupName]) {
                                            return matched.groups[groupName];
                                        }
                                        return v;
                                    });
                                if (outScript.startsWith("@@move_top") || pscript.actions.includes("move_top")) {
                                    data = out + "\n" + data;
                                } else {
                                    data = data + "\n" + out;
                                }
                            }
                        }
                        // The moved text goes through the CBS parser like any other replacement.
                        data = parse(data);
                    } else {
                        data = parse(data.replace(reg, outScript));
                    }
                } else {
                    if (
                        (outScript.startsWith("@@repeat_back") || pscript.actions.includes("repeat_back")) &&
                        chatID !== -1
                    ) {
                        const v = outScript.split(" ", 2)[1];
                        const lastChat = run.repeatBackSource();

                        // `match` answers null when the previous message does not match; reading
                        // `r[0]` then throws and skips the script, as on the client.
                        const r = lastChat.match(reg)!;
                        if (!v) {
                            data = data + r[0];
                        } else if (r[0]) {
                            switch (v) {
                                case "end":
                                    data = data + r[0];
                                    break;
                                case "start":
                                    data = r[0] + data;
                                    break;
                                case "end_nl":
                                    data = data + "\n" + r[0];
                                    break;
                                case "start_nl":
                                    data = r[0] + "\n" + data;
                                    break;
                            }
                        }
                    }
                }
            } else {
                data = parse(data.replace(reg, outScript));
            }
        }
    }

    for (const script of parseScripts(scripts)) {
        try {
            executeScript(script);
        } catch (error) {
            console.error(error);
        }
    }
    return { data, effects };
}

/**
 * The cache key of a run: the text, the mode, the chat (`chatKey`), and every script of the mode
 * (a `<cbs>` input expanded through `parse`, for the same chat the scripts then run for).
 */
export function regexScriptCacheKey(
    scripts: customscript[],
    data: string,
    mode: RegexScriptMode,
    chatID: number,
    chatKey: string,
    parse: (text: string) => string,
): string {
    let hash = data + "|||" + mode + "|||" + chatKey + "|||";
    for (const script of scripts) {
        if (script.type !== mode) {
            continue;
        }
        hash += `${script.flag?.includes("<cbs>") ? parse(script.in) : script.in}|||${script.out}${chatID}|||${script.flag ?? ""}|||${script.ableFlag ? 1 : 0}`;
    }
    return hash;
}

/** A run's final output by its key: the most recent 1,000. */
export function createScriptCache(limit = 1000) {
    let entries = new Map<string, string>();
    return {
        get: (key: string) => entries.get(key),
        set: (key: string, value: string) => {
            entries.set(key, value);
            if (entries.size > limit) {
                entries.delete(entries.keys().next().value!);
            }
        },
        reset: () => {
            entries = new Map();
        },
    };
}
