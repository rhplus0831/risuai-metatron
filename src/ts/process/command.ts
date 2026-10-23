import { characterList, selectedCharacter } from "../storage/characterStore.svelte";
import {
    appendMessage,
    type ChatRef,
    currentChatRef,
    ensureChatLoaded,
    findChat,
    pinChat,
    removeMessages,
    setMessageText,
} from "../storage/chatStore.svelte";
import { setChatVarOf } from "../parser/chatVar.svelte";
import { alertInput, alertMd, alertNormal, alertSelect } from "../alert";
import { sayTTS } from "./tts";
import { risuChatParser } from "../parser/parser.svelte";
import { sendChat } from "./index.svelte";
import { isChatBusy } from "./chatStatus.svelte";
import { loadLoreBookV3Prompt } from "./lorebook.svelte";
import { runServerManualTrigger } from "./serverCommands";

/**
 * `/multisend`: each part appended as a user message and sent, one after the other, in the chat
 * `ref`; with `clearMode` the chat's messages are removed before each part. Before each part, the
 * chat must be there and not busy (`isChatBusy`: a send of this tab, a followed job, or a lock);
 * this check only considers that chat, while `sendChat` still refuses any send while this tab sends.
 * Stops at the first part refused by either check; false then. A server command job's `/multisend`
 * runs it too, after the job (`serverCommands.ts`).
 */
export async function runMultisend(ref: ChatRef, clearMode: boolean, parts: readonly string[]): Promise<boolean> {
    for (const e of parts) {
        const chat = findChat(ref);
        if (!chat || isChatBusy(ref)) {
            return false;
        }
        if (clearMode) {
            removeMessages(
                ref,
                chat.message.map((message) => message.chatId),
            );
        }
        appendMessage(ref, { role: "user", data: e });
        const sent = await sendChat(-1, { target: ref });
        if (!sent) {
            return false;
        }
    }
    return true;
}

/**
 * Runs a command line typed in the chat input. Every command writes to and reads (CBS arguments,
 * lore) `ref`: by default the chat selected when the line started. `/trigger` runs on the server (a
 * server trigger's `v2Command` runs on the server too). The chat is pinned (kept loaded) for the
 * whole line, and loaded first.
 */
export async function processMultiCommand(command: string, ref: ChatRef | null = currentChatRef()) {
    const release = ref ? pinChat(ref) : null;
    try {
        if (ref && !(await ensureChatLoaded(ref))) {
            return "";
        }
        return await processPinnedCommands(command, ref);
    } finally {
        release?.();
    }
}

async function processPinnedCommands(command: string, ref: ChatRef | null) {
    let pipe = "";
    const splited: string[] = [];
    let lastIndex = 0;
    let quoteDepth = false;
    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (char === '"') {
            quoteDepth = !quoteDepth;
        } else if (char === "|" && quoteDepth === false) {
            splited.push(command.slice(lastIndex, i));
            lastIndex = i + 1;
        }
    }
    splited.push(command.slice(lastIndex));
    console.log(splited);
    for (let i = 0; i < splited.length; i++) {
        if (ref && !findChat(ref)) {
            // The chat went away while an earlier command waited: the line is consumed, not sent.
            return "";
        }
        const result = await processCommand(splited[i].trim(), pipe, ref);
        console.log(pipe);
        if (result === false) {
            return false;
        } else {
            pipe = result;
        }
    }
    return pipe;
}

async function processCommand(command: string, pipe: string, ref: ChatRef | null): Promise<false | string> {
    const currentChar = ref ? characterList().find((character) => character?.chaId === ref.chaId) : selectedCharacter();
    if (!currentChar) {
        // Its character went away; `false` would mean "not a command" and send the line as text.
        return "";
    }
    // The chat as it is now; chat writes go through the chat module, addressed by `ref`.
    const currentChat = ref ? findChat(ref) : undefined;
    let { commandName, arg, namedArg } = commandParser(command, pipe);

    if (!arg) {
        arg = pipe;
    }

    arg = risuChatParser(arg, {
        chara: currentChar.type === "character" ? currentChar : null,
        chatRef: ref,
    });

    const namedArgKeys = Object.keys(namedArg);
    for (const key of namedArgKeys) {
        namedArg[key] = risuChatParser(namedArg[key], {
            chara: currentChar.type === "character" ? currentChar : null,
            chatRef: ref,
        });
    }

    switch (commandName) {
        //STScript compatibility commands
        case "input": {
            pipe = await alertInput(arg);
            return pipe;
        }
        case "echo":
        case "popup": {
            alertNormal(arg);
            return pipe;
        }
        case "pass": {
            pipe = arg;
            return pipe;
        }
        case "buttons": {
            if (namedArg.labels) {
                try {
                    const JSONLabels = JSON.parse(namedArg.labels);
                    if (Array.isArray(JSONLabels)) {
                        pipe = await alertSelect(JSONLabels);
                    }
                } catch (error) {}
            }
            return pipe;
        }
        case "setinput": {
            //NOT IMPLEMENTED
            return false;
        }
        case "speak": {
            if (currentChar.type === "character") {
                await sayTTS(currentChar, arg);
                return pipe;
            }
            if (currentChar.type === "group") {
                //NOT IMPLEMENTED
                return pipe;
            }
            return pipe;
        }
        case "send": {
            appendMessage(ref, { role: "user", data: arg });
            return pipe;
        }
        case "sendas": {
            //name not implemented
            appendMessage(ref, { role: "char", data: arg });
            return pipe;
        }
        case "comment": {
            //works differently, but its close enough
            const addition = `<Comment>\n${arg}\n</Comment>`;
            const last = currentChat.message.at(-1);
            if (last) {
                setMessageText(ref, last.chatId, last.data + addition);
            }
            return pipe;
        }
        case "cut": {
            if (arg.includes("-")) {
                // Keeps the messages of the range (as `Array.slice` does), removes the rest.
                const [start, end] = arg.split("-");
                const kept = new Set(currentChat.message.slice(parseInt(start), parseInt(end)));
                removeMessages(
                    ref,
                    currentChat.message.filter((message) => !kept.has(message)).map((message) => message.chatId),
                );
            } else if (!isNaN(parseInt(arg))) {
                // Removes the one message at the index (a negative one takes the range branch above, as upstream).
                const target = currentChat.message.at(parseInt(arg));
                if (target) {
                    removeMessages(ref, [target.chatId]);
                }
            } else {
                //For risu, doesn'ts work for STScript
                removeMessages(ref, [arg]);
            }
            return pipe;
        }
        case "del": {
            // Keeps the last `size` messages (as `slice(length - size)` does), removes the rest.
            const size = parseInt(arg);
            if (!isNaN(size)) {
                const kept = new Set(currentChat.message.slice(currentChat.message.length - size));
                removeMessages(
                    ref,
                    currentChat.message.filter((message) => !kept.has(message)).map((message) => message.chatId),
                );
            }
            return pipe;
        }
        case "len": {
            try {
                const parsed = JSON.parse(arg);
                if (Array.isArray(parsed)) {
                    pipe = parsed.length.toString();
                }
            } catch (error) {}
            return pipe;
        }
        case "multisend": {
            const splited = arg.split("|||");
            let clearMode = false;
            if (splited[0] && splited[0].trim() === "clear") {
                clearMode = true;
                splited.shift();
            }
            await runMultisend(ref, clearMode, splited);
            return "";
        }
        case "setvar": {
            // One variable merged (`setChatVarOf`): the chat's other variables stay as stored.
            setChatVarOf(ref, namedArg["key"], arg);
            return "";
        }
        case "addvar": {
            const current = findChat(ref)?.scriptstate?.["$" + namedArg["key"]];
            setChatVarOf(ref, namedArg["key"], (Number(current) + Number(arg)).toString());
            return "";
        }
        case "getvar": {
            // A read: a missing variable answers "null" and nothing is written.
            const value = findChat(ref)?.scriptstate?.["$" + namedArg["key"]];
            pipe = value === undefined || value === null ? "null" : value.toString();
            return pipe;
        }
        case "test_lorebook": {
            const p = await loadLoreBookV3Prompt(ref);
            console.log(p);
            alertNormal(p.actives.map((e) => e.prompt).join("§"));
            return JSON.stringify(p);
        }
        case "trigger": {
            if (currentChar.type === "group" || !ref) {
                return;
            }
            await runServerManualTrigger(currentChar, arg, ref);
            return;
        }
        case "?": {
            alertMd(`
            # /input [text]
            - Show input dialog
            - Return input text
            - Example: /input Hello World
            # /echo [text]
            - Show alert dialog
            - Return input text
            - Example: /echo Hello World
            # /popup [text]
            - Show alert dialog
            - Return input text
            - Example: /popup Hello World
            # /pass [text]
            - Return input text
            - Example: /pass Hello World
            # /buttons [labels]
            - Show select dialog
            - Return selected label
            - Example: /buttons Yes§No
            # /speak [text]
            - Speak text
            - Example: /speak Hello World
            # /send [text]
            - Send text to chat
            - Example: /send Hello World
            # /sendas [text]
            - Send text to chat as character
            - Example: /sendas Hello World
            # /comment [text]
            - Add comment to chat
            - Example: /comment Hello World
            # /cut [index]
            - Cut chat message
            - Example: /cut 1
            # /del [size]
            - Delete chat message
            - Example: /del 1
            # /len [array]
            - Return length of array
            - Example: /len Hello§World
            # /setvar key=[key] [value]
            - Set variable
            - Example: /setvar key=hello world
            # /addvar key=[key] [value]
            - Add value to variable
            - Example: /addvar key=damage 10
            # /getvar key=[key]
            - Get variable
            - Example: /getvar key=damage
            # /trigger [name]
            - Run trigger
            # /?
            - Show help
            `);
            return "help";
        }
    }
    return false;
}

function commandParser(command: string, pipe: string) {
    if (command.startsWith("/")) {
        command = command.slice(1);
    }
    const sliced = command.split(" ").filter((e) => e != "");
    const commandName = sliced[0];
    let argArray: string[] = [];
    let namedArg: { [key: string]: string } = {};
    for (let i = 1; i < sliced.length; i++) {
        if (sliced[i].includes("=")) {
            const [key, value] = sliced[i].split("=");
            namedArg[key] = value;
        } else {
            argArray.push(sliced[i]);
        }
    }
    const arg = argArray
        .join(" ")
        .replace("{{pipe}}", pipe) //STScript compatibility
        .replace("{{slot}}", pipe); //Risu default
    return { commandName, arg, namedArg };
}
