import { get, writable, type Writable } from "svelte/store";
import { type ChatRef, chatEntry, currentChatRef } from "../storage/chatStore.svelte";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { sendChatOnServer, type ServerSendArg } from "./serverGeneration";

export type { OpenAIChat, MultiModal } from "../../../shared/openai.ts";

/**
 * The tab's side of a send (Phase 5 cutover): the generation runs as a server job
 * (`sendChatOnServer`; `server/src/prompt/runner.ts` assembles and requests). `doingChat` is the
 * tab's busy flag and `sendingChatRef` its target; a preview's result lands in
 * `previewFormated`/`previewBody` (DevTool, hotkeys).
 */
export const doingChat = writable(false);
export const sendingChatRef: Writable<ChatRef | null> = writable(null);
export let previewFormated: OpenAIChat[] = [];
export let previewBody: string = "";

type SendChatArg = ServerSendArg & {
    /**
     * Called when the send did not run; `ambiguous` when the create request got no answer (the input
     * may have been appended under `userMessageId`).
     */
    onServerRefused?: (ambiguous: boolean) => void;
};

/**
 * Sends in `arg.target` (default: the selected chat) as a server job: refused while this tab is busy
 * or when the target chat is gone (it may be unloaded: the job loads it); owns `doingChat` until the send ends. `chatProcessIndex` is
 * kept for the plugin API's and the slash commands' signature and is not read (a group's speakers
 * are chosen by the server).
 */
export async function sendChat(chatProcessIndex = -1, arg: SendChatArg = {}): Promise<boolean> {
    void chatProcessIndex;
    if (get(doingChat) || (arg.target && !chatEntry(arg.target))) {
        arg.onServerRefused?.(false);
        return false;
    }
    try {
        doingChat.set(true);
        const target = arg.target ?? currentChatRef();
        sendingChatRef.set(target);
        const { ok, result, refusal } = await sendChatOnServer(target ? { ...arg, target } : arg);
        if (refusal) {
            arg.onServerRefused?.(refusal === "ambiguous");
        }
        if (ok && arg.preview && Array.isArray(result)) {
            previewFormated = result as OpenAIChat[];
        }
        if (ok && arg.previewPrompt && typeof result === "string") {
            previewBody = result;
        }
        return ok;
    } finally {
        sendingChatRef.set(null);
        doingChat.set(false);
    }
}
