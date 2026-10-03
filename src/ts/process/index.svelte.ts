import { get, writable } from "svelte/store";
import { findChat } from "../storage/chatStore.svelte";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { sendChatOnServer, type ServerSendArg } from "./serverGeneration";

export type { OpenAIChat, MultiModal } from "../../../shared/openai.ts";

/**
 * The tab's side of a send (Phase 5 cutover): the generation runs as a server job
 * (`sendChatOnServer`; `server/src/prompt/runner.ts` assembles and requests). `doingChat` is the
 * tab's busy flag; a preview's result lands in `previewFormated`/`previewBody` (DevTool, hotkeys).
 */
export const doingChat = writable(false);
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
 * or when the target chat is gone; sets `doingChat` (its callers clear it). `chatProcessIndex` is
 * kept for the plugin API's and the slash commands' signature and is not read (a group's speakers
 * are chosen by the server).
 */
export async function sendChat(chatProcessIndex = -1, arg: SendChatArg = {}): Promise<boolean> {
    void chatProcessIndex;
    if (get(doingChat) || (arg.target && !findChat(arg.target))) {
        arg.onServerRefused?.(false);
        return false;
    }
    doingChat.set(true);
    const { ok, result, refusal } = await sendChatOnServer(arg);
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
}
