import type { character, groupChat } from "../../../shared/database.ts";
import type { LuaBindingServices } from "../lua/bindings.ts";
import type { HostContext } from "../scripts/workerPool.ts";
import { randomUUID } from "node:crypto";

/** The job a command line runs in (Phase 5 slice 8b). */
export type CommandHost = {
    services: LuaBindingServices;
    ctx: HostContext;
    /** The job's chat's character as stored now (the client's `ref.chaId` lookup). */
    character(): character | groupChat | undefined;
    /** `/trigger`: a manual trigger on the job's chat as stored now, its result applied after. */
    runManualTrigger(name: string): Promise<void>;
};

/** The client's `/?` text. */
const HELP_TEXT = `
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
            `;

/**
 * `processMultiCommand` of `src/ts/process/command.ts` on the job's chat (Phase 5 slice 8b): the
 * same pipe and quote splitting, argument parsing, and CBS of the arguments, each command reading
 * and writing the job's chat as stored when it runs. Alerts and questions go through the job's
 * channel (`/speak` as a `tts` notice, `/?` as `alertMd`). `/multisend` does not run in a server job
 * (recorded); `/send` and `/sendas` only append, as on the client. A question that is not answered
 * ends the line with its error.
 */
export function createCommandExecutor(host: CommandHost) {
    const { services, ctx } = host;

    async function processMultiCommand(command: string): Promise<string | false | undefined> {
        let pipe: string | undefined = "";
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
        for (let i = 0; i < splited.length; i++) {
            services.fence(ctx);
            // Each command reads the chat as stored when it runs (an earlier one may have waited).
            if (!services.refresh()) {
                // The chat went away while an earlier command waited: the line is consumed, not sent.
                return "";
            }
            const result = await processCommand(splited[i].trim(), pipe as string);
            if (result === false) {
                return false;
            } else {
                pipe = result;
            }
        }
        return pipe;
    }

    async function processCommand(command: string, pipe: string): Promise<false | string | undefined> {
        const currentChar = host.character();
        if (!currentChar) {
            // Its character went away; `false` would mean "not a command" and send the line as text.
            return "";
        }
        const parsed = commandParser(command, pipe);
        const { commandName, namedArg } = parsed;
        let { arg } = parsed;

        if (!arg) {
            arg = pipe;
        }

        const chara = currentChar.type === "character" ? currentChar : null;
        arg = services.parse(arg, chara);

        const namedArgKeys = Object.keys(namedArg);
        for (const key of namedArgKeys) {
            namedArg[key] = services.parse(namedArg[key], chara);
        }

        const answer = async (question: Parameters<LuaBindingServices["ask"]>[0]) => {
            const value = await services.ask(question, ctx);
            services.fence(ctx);
            return typeof value === "string" ? value : String(value ?? "");
        };

        switch (commandName) {
            //STScript compatibility commands
            case "input": {
                pipe = await answer({ kind: "alertInput", payload: { message: arg } });
                return pipe;
            }
            case "echo":
            case "popup": {
                services.notice({ kind: "alertNormal", payload: { message: arg } });
                return pipe;
            }
            case "pass": {
                pipe = arg;
                return pipe;
            }
            case "buttons": {
                if (namedArg.labels) {
                    let labels: unknown = null;
                    try {
                        labels = JSON.parse(namedArg.labels);
                    } catch {}
                    if (Array.isArray(labels)) {
                        pipe = await answer({ kind: "alertSelect", payload: { options: labels.map(String) } });
                    }
                }
                return pipe;
            }
            case "setinput": {
                //NOT IMPLEMENTED
                return false;
            }
            case "speak": {
                if (currentChar.type === "character") {
                    services.notice({ kind: "tts", payload: { chaId: currentChar.chaId, text: arg } });
                    return pipe;
                }
                return pipe;
            }
            case "send": {
                const data = arg;
                services.writeChat(
                    () => [
                        {
                            op: "append",
                            messages: [{ role: "user", data, chatId: randomUUID() }],
                            anchor: { end: true },
                        },
                    ],
                    ctx,
                );
                return pipe;
            }
            case "sendas": {
                //name not implemented
                const data = arg;
                services.writeChat(
                    () => [
                        {
                            op: "append",
                            messages: [{ role: "char", data, chatId: randomUUID() }],
                            anchor: { end: true },
                        },
                    ],
                    ctx,
                );
                return pipe;
            }
            case "comment": {
                //works differently, but its close enough
                const addition = `<Comment>\n${arg}\n</Comment>`;
                services.writeChat((chat) => {
                    const last = chat.message.at(-1);
                    return last?.chatId ? [{ op: "setText", id: last.chatId, text: last.data + addition }] : null;
                }, ctx);
                return pipe;
            }
            case "cut": {
                const cutArg = arg;
                services.writeChat((chat) => {
                    let removed: string[];
                    if (cutArg.includes("-")) {
                        // Keeps the messages of the range (as `Array.slice` does), removes the rest.
                        const [start, end] = cutArg.split("-");
                        const kept = new Set(chat.message.slice(parseInt(start), parseInt(end)));
                        removed = chat.message
                            .filter((message) => !kept.has(message))
                            .map((message) => message.chatId!);
                    } else if (!isNaN(parseInt(cutArg))) {
                        // Removes the one message at the index (a negative one takes the range branch above).
                        const target = chat.message.at(parseInt(cutArg));
                        removed = target?.chatId ? [target.chatId] : [];
                    } else {
                        //For risu, doesn'ts work for STScript
                        removed = [cutArg];
                    }
                    return removed.length > 0 ? [{ op: "remove", ids: removed }] : null;
                }, ctx);
                return pipe;
            }
            case "del": {
                // Keeps the last `size` messages (as `slice(length - size)` does), removes the rest.
                const size = parseInt(arg);
                if (!isNaN(size)) {
                    services.writeChat((chat) => {
                        const kept = new Set(chat.message.slice(chat.message.length - size));
                        const removed = chat.message
                            .filter((message) => !kept.has(message))
                            .map((message) => message.chatId!);
                        return removed.length > 0 ? [{ op: "remove", ids: removed }] : null;
                    }, ctx);
                }
                return pipe;
            }
            case "len": {
                try {
                    const parsedArg = JSON.parse(arg);
                    if (Array.isArray(parsedArg)) {
                        pipe = parsedArg.length.toString();
                    }
                } catch {}
                return pipe;
            }
            case "multisend": {
                // A send from inside a server job is not supported (recorded; the client sends each part).
                services.notice({
                    kind: "alertError",
                    payload: { message: "/multisend does not run in a server job" },
                });
                return "";
            }
            case "setvar": {
                const value = arg;
                // Merged into the variables as stored at the write.
                services.writeChat((chat) => {
                    const scriptstate = { ...(chat.scriptstate ?? {}) };
                    scriptstate["$" + namedArg["key"]] = value;
                    return [{ op: "meta", set: { scriptstate } }];
                }, ctx);
                return "";
            }
            case "addvar": {
                const value = arg;
                services.writeChat((chat) => {
                    const scriptstate = { ...(chat.scriptstate ?? {}) };
                    scriptstate["$" + namedArg["key"]] = (
                        Number(scriptstate["$" + namedArg["key"]]) + Number(value)
                    ).toString();
                    return [{ op: "meta", set: { scriptstate } }];
                }, ctx);
                return "";
            }
            case "getvar": {
                // A read: a missing variable answers "null" and nothing is written.
                const value = services.liveChat().scriptstate?.["$" + namedArg["key"]];
                pipe = value === undefined || value === null ? "null" : value.toString();
                return pipe;
            }
            case "test_lorebook": {
                const p = await services.activateLore(ctx);
                services.fence(ctx);
                console.log(p);
                services.notice({
                    kind: "alertNormal",
                    payload: { message: p.actives.map((e) => e.prompt).join("§") },
                });
                return JSON.stringify(p);
            }
            case "trigger": {
                if (currentChar.type === "group") {
                    return undefined;
                }
                await host.runManualTrigger(arg);
                services.fence(ctx);
                return undefined;
            }
            case "?": {
                services.notice({ kind: "alertMd", payload: { message: HELP_TEXT } });
                return "help";
            }
        }
        return false;
    }

    return { processMultiCommand };
}

function commandParser(command: string, pipe: string) {
    if (command.startsWith("/")) {
        command = command.slice(1);
    }
    const sliced = command.split(" ").filter((e) => e != "");
    const commandName = sliced[0];
    const argArray: string[] = [];
    const namedArg: { [key: string]: string } = {};
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
