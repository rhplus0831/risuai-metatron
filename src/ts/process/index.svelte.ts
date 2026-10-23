import { get } from "svelte/store";
import { type ChatRef, chatEntry, currentChatRef } from "../storage/chatStore.svelte";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { sendChatOnServer, type ServerSendArg } from "./serverGeneration";
import { anyLocalSend, beginLocalSend, localSends } from "./localSends";

export type { OpenAIChat, MultiModal } from "../../../shared/openai.ts";

/**
 * The tab's side of a send: the generation runs as a server job (`sendChatOnServer`;
 * `server/src/prompt/runner.ts` assembles and requests). Each send holds its chat's entry in the
 * local send registry (`localSends.ts`); a preview returns its result to its caller (`previewChat`).
 * `doingChat` is whether this tab runs any send (`anyLocalSend`), for the callers that still refuse
 * tab-wide.
 */
export const doingChat = anyLocalSend;

type SendChatArg = ServerSendArg & {
    /**
     * Called when the send did not run; `ambiguous` when the create request got no answer (the input
     * may have been appended under `userMessageId`).
     */
    onServerRefused?: (ambiguous: boolean) => void;
};

/**
 * Sends in `arg.target` (default: the selected chat) as a server job: refused while this tab runs any
 * send or when the target chat is gone (it may be unloaded: the job loads it); holds the target's
 * local send entry (the tab entry without a chat) from before its first await until the send ends.
 * `chatProcessIndex` is kept for the plugin API's and the slash commands' signature and is not read
 * (a group's speakers are chosen by the server).
 */
export async function sendChat(chatProcessIndex = -1, arg: SendChatArg = {}): Promise<boolean> {
    void chatProcessIndex;
    return (await runSend(arg)).ok;
}

/**
 * The prompt a send in `target` (default: the selected chat) would make, as a server preview job
 * admitted and held like `sendChat`: `preview` gives the formatted messages, `previewPrompt` the
 * request body. Null when the preview did not run or ended without its result (refused, failed, or
 * stopped).
 */
export async function previewChat(kind: "preview", target?: ChatRef): Promise<OpenAIChat[] | null>;
export async function previewChat(kind: "previewPrompt", target?: ChatRef): Promise<string | null>;
export async function previewChat(
    kind: "preview" | "previewPrompt",
    target?: ChatRef,
): Promise<OpenAIChat[] | string | null> {
    const { ok, result } = await runSend(
        kind === "preview" ? { preview: true, target } : { previewPrompt: true, target },
    );
    if (!ok) {
        return null;
    }
    if (kind === "preview") {
        return Array.isArray(result) ? (result as OpenAIChat[]) : null;
    }
    return typeof result === "string" ? result : null;
}

async function runSend(arg: SendChatArg): Promise<{ ok: boolean; result?: unknown }> {
    // The registry itself, not the derived `anyLocalSend`, which a registry subscriber may see late.
    if (get(localSends).size > 0 || (arg.target && !chatEntry(arg.target))) {
        arg.onServerRefused?.(false);
        return { ok: false };
    }
    const target = arg.target ?? currentChatRef();
    const release = beginLocalSend(target);
    if (!release) {
        arg.onServerRefused?.(false);
        return { ok: false };
    }
    try {
        const { ok, result, refusal } = await sendChatOnServer(target ? { ...arg, target } : arg);
        if (refusal) {
            arg.onServerRefused?.(refusal === "ambiguous");
        }
        return { ok, result };
    } finally {
        release();
    }
}
