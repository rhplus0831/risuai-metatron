import { CCardLib } from "@risuai/ccardlib";
import type { Chat, Message, character, groupChat, loreBook } from "../database.ts";
import type { DeepReadonly } from "../readonly.ts";
import { mergeOwnerLore, offOverrideIds } from "./overrides.ts";

/**
 * Lorebook activation, shared by the client and the server: the key, regex, and decorator matching
 * over the chat, recursion, the token budget, and `@@inject_lore`. The application state comes
 * through `input` and `host`; the module also uses `Math.random` (`@@probability`) and `console`.
 */
export type LoreActivationInput = {
    /** The chat's owner (a group's own lore and settings for a group chat), before chat overrides. */
    character: DeepReadonly<Pick<character | groupChat, "name" | "globalLore" | "loreSettings">>;
    /** The chat, including its local lore and overrides of the owner's lore. */
    chat: DeepReadonly<Chat>;
    /** The enabled modules' lore for this chat: global, chat, character, the bound persona's. */
    moduleLorebooks: loreBook[];
    /** `memoryTranslateMedia.loreBookDepth`, unless the character sets `loreSettings.scanDepth`. */
    loreBookDepth: number;
    /** `providers.loreBookToken`, unless the character sets `loreSettings.tokenBudget`. */
    loreBookToken: number;
    /** The user's name in the scanned text: the effective persona's (a bound persona wins). */
    userName: string;
};

export type LoreHost = {
    /** A deep copy of the lore; activation rewrites `child` entries in place. */
    clone: <T>(value: T) => T;
    /** A group member's name by `chaId`, for a message without a `name`. */
    findCharacterName: (id: string) => string | undefined;
    /** The chat's variables (the keep and don't-activate-after-match flags). */
    getChatVar: (key: string) => string;
    setChatVar: (key: string, value: string) => void;
    pickHashRand: (cid: number, word: string) => number;
    /** CBS over an entry's content for its token count (no side effects). */
    parseCBS: (text: string) => string;
    tokenize: (text: string) => Promise<number>;
    /** A regex key's test; it throws (or rejects) for an invalid pattern, which matches nothing. */
    testRegex: (pattern: string, flags: string, text: string) => boolean | Promise<boolean>;
};

export type LoreActive = {
    depth: number;
    pos: string;
    prompt: string;
    role: "system" | "user" | "assistant";
    order: number;
    tokens: number;
    priority: number;
    source: string;
    inject: {
        operation: "append" | "prepend" | "replace";
        location: string;
        param: string;
        lore: boolean;
    } | null;
};

export type LoreMatch = { prompt: string; source: string; activated: string };

/**
 * The token budget pass: `used` is the kept entries' total before `@@inject_lore` edits (accepted
 * injectors included), `limit` the budget, and the rejected entries are the ones the pass dropped.
 */
export type LoreBudget = { used: number; limit: number; rejectedCount: number; rejectedTokens: number };

export type LoreActivation = { actives: LoreActive[]; matchLog: LoreMatch[]; budget: LoreBudget };

/**
 * Runs `steps` synchronously while every yielded value is a boolean; at the first promise it
 * continues asynchronously (a rejection is thrown into the generator).
 */
function runSteps(
    steps: Generator<boolean | Promise<boolean>, boolean, boolean>,
    next: { value: boolean } | { error: unknown } = { value: false },
): boolean | Promise<boolean> {
    let step = "error" in next ? steps.throw(next.error) : steps.next(next.value);
    while (!step.done) {
        const value = step.value;
        if (typeof value !== "boolean") {
            return Promise.resolve(value).then(
                (resolved) => runSteps(steps, { value: resolved }),
                (error: unknown) => runSteps(steps, { error }),
            );
        }
        step = steps.next(value);
    }
    return step.value;
}

/**
 * The lore of `input.chat` that activates, and why: `loadLoreBookV3Prompt` on the client.
 * Applies chat overrides to owner lore, silently drops orphans, and keeps off child links inactive.
 */
export async function activateLore(input: LoreActivationInput, host: LoreHost): Promise<LoreActivation> {
    const char = input.character;
    const lorechat = input.chat;
    const overrides = lorechat.loreOverrides ?? [];
    const characterLore = mergeOwnerLore(char.globalLore ?? [], overrides).lore;
    const offIds = offOverrideIds(overrides);
    const chatLore = lorechat.localLore ?? [];
    const moduleLorebook = input.moduleLorebooks;
    const fullLore = host.clone([...characterLore, ...chatLore, ...moduleLorebook]) as loreBook[];
    const currentChat = lorechat.message;
    const loreDepth = char.loreSettings?.scanDepth ?? input.loreBookDepth;
    const loreToken = char.loreSettings?.tokenBudget ?? input.loreBookToken;
    const fullWordMatchingSetting = char.loreSettings?.fullWordMatching ?? false;
    const chatLength = currentChat.length + 1; //includes first message
    const recursiveScanning = char.loreSettings?.recursiveScanning ?? true;
    let recursivePrompt: {
        prompt: string;
        source: string;
        data: string;
    }[] = [];
    let matchLog: LoreMatch[] = [];

    const searchMatch = (
        messages: readonly DeepReadonly<Message>[],
        arg: {
            keys: string[];
            searchDepth: number;
            regex?: boolean;
            fullWordMatching: boolean;
            all?: boolean;
            dontSearchWhenRecursive: boolean;
        },
    ) => {
        const sliced = messages.slice(messages.length - arg.searchDepth, messages.length);
        const newKeys = [];
        for (const key of arg.keys) {
            const trimmed = key.trim();
            if (trimmed.length > 0) {
                newKeys.push(trimmed);
            }
        }
        arg.keys = newKeys;
        let mList: {
            source: string;
            prompt: string;
            data: string;
        }[] = sliced
            .map((msg, i) => {
                if (msg.role === "user") {
                    return {
                        source: `message ${i} by user`,
                        prompt: `\x01{{${input.userName}}}:` + msg.data + "\x01",
                        data: msg.data,
                    };
                } else {
                    return {
                        source: `message ${i} by char`,
                        prompt:
                            `\x01{{${msg.name ?? (msg.saying ? host.findCharacterName(msg.saying) : null) ?? char.name}}}:` +
                            msg.data +
                            "\x01",
                        data: msg.data,
                    };
                }
            })
            .concat(
                arg.dontSearchWhenRecursive
                    ? []
                    : recursivePrompt.map((msg) => {
                          return {
                              source: "lorebook " + msg.source,
                              prompt: msg.prompt,
                              data: msg.data,
                          };
                      }),
            );

        if (arg.regex) {
            const keys = arg.keys;
            // A generator, so the search stays synchronous while `testRegex` answers synchronously
            // (the client) and suspends only on a promise (the server's worker).
            return runSteps(
                (function* (): Generator<boolean | Promise<boolean>, boolean, boolean> {
                    for (const mText of mList) {
                        for (const regexString of keys) {
                            if (!regexString.startsWith("/")) {
                                return false;
                            }
                            // `/pattern/flags`: the last `/` ends the pattern, and the flags may be
                            // empty. (In the browser-only version the key's first entry was
                            // overwritten with the pattern, the leading `/` stayed in it, and empty
                            // flags never matched.)
                            const lastSlash = regexString.lastIndexOf("/");
                            if (lastSlash === 0) {
                                return false;
                            }
                            const pattern = regexString.substring(1, lastSlash);
                            const flags = regexString.substring(lastSlash + 1);
                            try {
                                const d: boolean = yield host.testRegex(pattern, flags, mText.data);
                                if (d) {
                                    matchLog.push({
                                        prompt: mText.prompt,
                                        source: mText.source,
                                        activated: regexString,
                                    });
                                    return true;
                                }
                            } catch (error) {
                                return false;
                            }
                        }
                    }
                    return false;
                })(),
            );
        }

        mList = mList.map((m) => {
            return {
                source: m.source,
                prompt: m.prompt
                    .toLocaleLowerCase()
                    .replace(/\{\{\/\/(.+?)\}\}/g, "")
                    .replace(/\{\{comment:(.+?)\}\}/g, ""),
                data: m.data
                    .toLocaleLowerCase()
                    .replace(/\{\{\/\/(.+?)\}\}/g, "")
                    .replace(/\{\{comment:(.+?)\}\}/g, ""),
            };
        });

        let allMode = arg.all ?? false;
        let allModeMatched = true;

        for (const m of mList) {
            let mText = m.data;
            if (arg.fullWordMatching) {
                const splited = mText.split(" ");
                for (const key of arg.keys) {
                    if (splited.includes(key.toLocaleLowerCase())) {
                        matchLog.push({
                            prompt: m.prompt,
                            source: m.source,
                            activated: key,
                        });
                        if (!allMode) {
                            return true;
                        }
                    } else if (allMode) {
                        allModeMatched = false;
                    }
                }
            } else {
                mText = mText.replace(/ /g, "");
                for (const key of arg.keys) {
                    const realKey = key.toLocaleLowerCase().replace(/ /g, "");
                    if (mText.includes(realKey)) {
                        matchLog.push({
                            prompt: m.prompt,
                            source: m.source,
                            activated: key,
                        });
                        if (!allMode) {
                            return true;
                        }
                    } else if (allMode) {
                        allModeMatched = false;
                    }
                }
            }
        }
        if (allMode && allModeMatched) {
            return true;
        }
        return false;
    };

    let matching = true;
    let actives: LoreActive[] = [];
    const pendingCounts: { active: LoreActive; count: Promise<number> }[] = [];
    const pendingFlags = new Map<string, string>();
    let activatedIndexes: number[] = [];
    let disabledUIPrompts: string[] = [];
    let matchTimes = 0;
    while (matching) {
        matching = false;
        for (let i = 0; i < fullLore.length; i++) {
            if (activatedIndexes.includes(i)) {
                continue;
            }
            // A child link to an entry this chat turns off never activates, even when another entry
            // shares its id or the child's content has `@@activate`.
            if (fullLore[i].mode === "child" && offIds.has(fullLore[i].id ?? "")) {
                continue;
            }
            if (!fullLore[i].alwaysActive && !fullLore[i].key) {
                continue;
            }
            let activated = true;
            let pos = "";
            let inject: {
                operation: "append" | "prepend" | "replace";
                location: string;
                param: string;
                lore: boolean;
            } | null = null;
            let depth = 0;
            let scanDepth = loreDepth;
            let order = fullLore[i].insertorder;
            let priority = fullLore[i].insertorder;
            let forceState: string = "none";
            let role: "system" | "user" | "assistant" = "system";
            let searchQueries: {
                keys: string[];
                negative: boolean;
                all?: boolean;
            }[] = [];
            let fullWordMatching = fullWordMatchingSetting;
            let dontSearchWhenRecursive = false;
            let keepActivateAfterMatch = false;
            let dontActivateAfterMatch = false;

            if (fullLore[i].mode === "child") {
                activated = false;
                for (let j = 0; j < i; j++) {
                    if (fullLore[j].id === fullLore[i].id) {
                        if (!activatedIndexes.includes(j)) {
                            fullLore[i].comment = fullLore[j].comment;
                            fullLore[i].content = fullLore[j].content;
                            fullLore[i].alwaysActive = true;
                            order = fullLore[j].insertorder;
                            priority = fullLore[j].insertorder;
                            activated = true;
                        }
                        break;
                    }
                }
            }
            let itemRecursive: "global" | true | false = "global";
            const content = CCardLib.decorator.parse(fullLore[i].content, (name, arg) => {
                switch (name) {
                    case "end": {
                        pos = "depth";
                        depth = 0;
                        return;
                    }
                    case "activate_only_after": {
                        const int = parseInt(arg[0]);
                        if (Number.isNaN(int)) {
                            return false;
                        }
                        if (chatLength < int) {
                            activated = false;
                        }
                        return;
                    }
                    case "activate_only_every": {
                        const int = parseInt(arg[0]);
                        if (Number.isNaN(int)) {
                            return false;
                        }
                        if (chatLength % int !== 0) {
                            activated = false;
                        }
                        return;
                    }
                    case "keep_activate_after_match": {
                        const key =
                            "__internal_ka_" +
                            (fullLore[i].id ?? host.pickHashRand(5555, fullLore[i].content).toString());
                        const vara = pendingFlags.get(key) ?? host.getChatVar(key);
                        if (vara === "true") {
                            forceState = "activate";
                        } else {
                            keepActivateAfterMatch = true;
                        }
                        return false;
                    }
                    case "dont_activate_after_match": {
                        const key =
                            "__internal_da_" +
                            (fullLore[i].id ?? host.pickHashRand(5555, fullLore[i].content).toString());
                        const vara = pendingFlags.get(key) ?? host.getChatVar(key);
                        if (vara === "true") {
                            forceState = "deactivate";
                        } else {
                            dontActivateAfterMatch = true;
                        }
                        return false;
                    }
                    case "depth":
                    case "reverse_depth": {
                        const int = parseInt(arg[0]);
                        if (Number.isNaN(int)) {
                            return false;
                        }
                        depth = int;
                        pos = name === "depth" ? "depth" : "reverse_depth";
                        return;
                    }
                    case "instruct_depth":
                    case "reverse_instruct_depth":
                    case "instruct_scan_depth": {
                        //the instruct mode does not exists in risu
                        return false;
                    }
                    case "role": {
                        if (arg[0] === "user" || arg[0] === "assistant" || arg[0] === "system") {
                            role = arg[0];
                            return;
                        }
                        return false;
                    }
                    case "scan_depth": {
                        scanDepth = parseInt(arg[0]);
                        return;
                    }
                    case "is_greeting": {
                        const int = parseInt(arg[0]);
                        if (Number.isNaN(int)) {
                            return false;
                        }
                        if ((lorechat.fmIndex ?? -1) + 1 !== int) {
                            activated = false;
                        }
                        return;
                    }
                    case "position": {
                        if (
                            arg[0].startsWith("pt_") ||
                            ["after_desc", "before_desc", "personality", "scenario"].includes(arg[0])
                        ) {
                            pos = arg[0];
                            return;
                        }
                        return false;
                    }
                    case "inject_lore": {
                        inject ??= {
                            operation: "append",
                            location: "",
                            param: "",
                            lore: true,
                        };
                        inject.location = arg.join(" ");
                        inject.lore = true;
                        return;
                    }
                    case "inject_at": {
                        inject ??= {
                            operation: "append",
                            location: "",
                            param: "",
                            lore: false,
                        };
                        inject.location = arg.join(" ");
                        inject.lore = false;
                        return;
                    }
                    case "inject_replace": {
                        inject ??= {
                            operation: "replace",
                            location: "",
                            param: "",
                            lore: false,
                        };
                        inject.operation = "replace";
                        inject.param = arg.join(" ");
                        return;
                    }
                    case "inject_prepend": {
                        inject ??= {
                            operation: "prepend",
                            location: "",
                            param: "",
                            lore: false,
                        };
                        inject.operation = "prepend";
                        inject.param = arg.join(" ");
                        return;
                    }
                    case "ignore_on_max_context": {
                        priority = -1000;
                        return;
                    }
                    case "additional_keys": {
                        searchQueries.push({
                            keys: arg,
                            negative: false,
                        });
                        return;
                    }
                    case "exclude_keys": {
                        searchQueries.push({
                            keys: arg,
                            negative: true,
                        });
                        return;
                    }
                    case "exclude_keys_all": {
                        searchQueries.push({
                            keys: arg,
                            negative: true,
                            all: true,
                        });
                        return;
                    }
                    case "match_full_word": {
                        fullWordMatching = true;
                        return;
                    }
                    case "match_partial_word": {
                        fullWordMatching = false;
                        return;
                    }
                    case "is_user_icon": {
                        //TODO
                        return false;
                    }
                    case "activate": {
                        forceState = "activate";
                        return;
                    }
                    case "dont_activate": {
                        forceState = "deactivate";
                        return;
                    }
                    case "disable_ui_prompt": {
                        if (["post_history_instructions", "system_prompt"].includes(arg[0])) {
                            disabledUIPrompts.push(arg[0]);
                            return;
                        }
                        return false;
                    }
                    case "probability": {
                        if (Math.random() * 100 > parseInt(arg[0])) {
                            activated = false;
                        }
                        return;
                    }
                    case "priority": {
                        priority = parseInt(arg[0]);
                        return;
                    }
                    //We can already do it with search depth, but its more readable and performant this way
                    case "unrecursive": {
                        itemRecursive = false;
                        return;
                    }
                    case "recursive": {
                        itemRecursive = true;
                        return;
                    }
                    case "no_recursive_search": {
                        dontSearchWhenRecursive = true;
                        return;
                    }
                    default: {
                        return false;
                    }
                }
            });

            if (!activated || forceState !== "none" || fullLore[i].alwaysActive) {
                //if the lore is not activated or force activated, skip the search
            } else {
                searchQueries.push({
                    keys: fullLore[i].key.split(","),
                    negative: false,
                });

                if (fullLore[i].secondkey && fullLore[i].selective) {
                    searchQueries.push({
                        keys: fullLore[i].secondkey.split(","),
                        negative: false,
                    });
                }

                for (const query of searchQueries) {
                    const searched = searchMatch(currentChat, {
                        keys: query.keys,
                        searchDepth: scanDepth,
                        regex: fullLore[i].useRegex,
                        fullWordMatching: fullWordMatching,
                        all: query.all,
                        dontSearchWhenRecursive: dontSearchWhenRecursive,
                    });
                    // Awaited only when a regex test is asynchronous: a synchronous search does not
                    // yield, so nothing can change the chat between two entries' searches.
                    const result = typeof searched === "boolean" ? searched : await searched;
                    if (query.negative) {
                        if (result) {
                            activated = false;
                            break;
                        }
                    } else {
                        if (!result) {
                            activated = false;
                            break;
                        }
                    }
                }
            }

            if (forceState === "activate") {
                activated = true;
            } else if (forceState === "deactivate") {
                activated = false;
            }

            if (activated) {
                const active: LoreActive = {
                    depth: depth,
                    pos: pos,
                    prompt: content,
                    role: role,
                    order: order,
                    tokens: 0,
                    priority: priority,
                    source: fullLore[i].comment || `lorebook ${i}`,
                    inject: inject ?? null,
                };
                // Parse CBS in entry order, with runVar left false as in the output path.
                // Start each count now and await them together before the budget pass, so cutoff
                // uses evaluated text without yielding at each entry's count.
                const count = host.tokenize(host.parseCBS(content));
                // A later regex test can yield or throw before the counts are awaited.
                void count.catch(() => {});
                pendingCounts.push({ active, count });
                actives.push(active);
                activatedIndexes.push(i);

                if (keepActivateAfterMatch) {
                    pendingFlags.set(
                        "__internal_ka_" + (fullLore[i].id ?? host.pickHashRand(5555, fullLore[i].content).toString()),
                        "true",
                    );
                }
                if (dontActivateAfterMatch) {
                    pendingFlags.set(
                        "__internal_da_" + (fullLore[i].id ?? host.pickHashRand(5555, fullLore[i].content).toString()),
                        "true",
                    );
                }

                let recursive = recursiveScanning;
                if (itemRecursive !== "global") {
                    recursive = itemRecursive;
                }

                if (recursive) {
                    matching = true;
                    recursivePrompt.push({
                        prompt: content,
                        data: content,
                        source: fullLore[i].comment || `lorebook ${i}`,
                    });
                }
            }
        }
    }

    const counts = await Promise.all(pendingCounts.map(({ count }) => count));
    pendingCounts.forEach(({ active }, index) => {
        active.tokens = counts[index];
    });
    // Writes wait for the counts so an aborted or failed activation leaves no flag. Decorator
    // reads use pendingFlags during the loop so entries sharing a key still see earlier writes.
    for (const [key, value] of pendingFlags) {
        host.setChatVar(key, value);
    }

    const activesSorted = actives.sort((a, b) => {
        return b.priority - a.priority;
    });

    let usedTokens = 0;
    let rejectedCount = 0;
    let rejectedTokens = 0;

    const activesFiltered = activesSorted.filter((act) => {
        if (usedTokens + act.tokens <= loreToken) {
            usedTokens += act.tokens;
            return true;
        }
        rejectedCount++;
        rejectedTokens += act.tokens;
        return false;
    });

    let activesResorted = activesFiltered.sort((a, b) => {
        return b.order - a.order;
    });

    const loreinjectionLores = activesResorted.filter((act) => {
        return act?.inject?.lore;
    });

    activesResorted = activesResorted.filter((act) => {
        return !act?.inject?.lore;
    });

    //I know this will make token count wrong, but performance is more important here

    for (const lore of loreinjectionLores) {
        const foundLoreIndex = activesResorted.findIndex((l) => {
            return l.source === lore.inject!.location;
        });
        if (foundLoreIndex !== -1) {
            const foundLore = activesResorted[foundLoreIndex];
            switch (lore.inject!.operation) {
                case "append": {
                    foundLore.prompt += " " + lore.prompt;
                    break;
                }
                case "prepend": {
                    foundLore.prompt = lore.prompt + " " + foundLore.prompt;
                    break;
                }
                case "replace": {
                    foundLore.prompt = foundLore.prompt.replace(lore.inject!.param, lore.prompt);
                    break;
                }
            }
        }
    }

    return {
        actives: activesResorted.reverse(),
        matchLog: matchLog,
        budget: { used: usedTokens, limit: loreToken, rejectedCount, rejectedTokens },
    };
}
