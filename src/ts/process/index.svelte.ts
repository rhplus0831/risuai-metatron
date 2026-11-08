import { type ChatRef, chatEntry, currentChatRef } from "../storage/chatStore.svelte";
import { type ContextReport, parseContextReport } from "../../../shared/contextReport.ts";
import type { GenerationPreviewResult } from "../../../shared/jobs.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { sendChatOnServer, type ServerSendArg, type ServerSendResult } from "./serverGeneration";
import { beginLocalSend } from "./localSends";

/**
 * The tab's side of a send: the generation runs as a server job (`sendChatOnServer`;
 * `server/src/prompt/runner.ts` assembles and requests). Each send holds its chat's entry in the
 * local send registry (`localSends.ts`), so different chats send at the same time and one chat runs
 * one send; a preview returns its result to its caller (`previewChat`).
 * `sendChat` returns success; `previewChat` returns formatted messages or a request body, or null
 * without a usable preview result. This module neither assembles prompts nor calls providers.
 */

/** Re-exports the shared prompt message and media shapes. */
export type { OpenAIChat, MultiModal } from "../../../shared/openai.ts";

type SendChatArg = ServerSendArg & {
    /**
     * Called when the send did not run; `ambiguous` when the create request got no answer (the input
     * may have been appended under `userMessageId`).
     */
    onServerRefused?: (ambiguous: boolean) => void;
    /**
     * Called when the send ended without throwing: `settled` when nothing of it writes to the chat any
     * more (it did not run, or its job ended; not after a create without an answer or a lost follow),
     * with the chats a flush refused for a generation waited on.
     */
    onEnd?: (end: {
        settled: boolean;
        blockedChats: readonly ChatRef[];
        outcome: ServerSendResult["outcome"];
        requestUncertain: boolean;
        reconciled?: boolean;
    }) => void;
};

/**
 * Sends in `arg.target` (default: the selected chat) as a server job: refused while the target chat
 * already has a send of this tab (without a chat: while the tab entry is held) or when the target chat
 * is gone (it may be unloaded: the job loads it); holds the target's local send entry (the tab entry
 * without a chat) from before its first await until the send ends. Sends in other chats run beside it.
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
/** Returns the preview request body, or null when no usable result arrived. */
export async function previewChat(kind: "previewPrompt", target?: ChatRef): Promise<string | null>;
/** Dispatches the requested preview kind through the same send admission and server-job boundary. */
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
        return previewResult(result)?.messages ?? null;
    }
    return typeof result === "string" ? result : null;
}

/**
 * A preview's messages, the context report a send of them would store, and the job's `memoryBlock` as it
 * came (`memoryBlockEntries` reads it).
 */
export type ChatPreviewReport = { messages: OpenAIChat[]; report: ContextReport | null; memoryBlock?: unknown };

/**
 * `previewChat("preview")` with the job's context report, for a caller that reads what the prompt was
 * built from. The report is null when it does not parse (`parseContextReport`).
 */
export async function previewChatReport(target?: ChatRef): Promise<ChatPreviewReport | null> {
    const { ok, result } = await runSend({ preview: true, target });
    const preview = ok ? previewResult(result) : null;
    return (
        preview && {
            messages: preview.messages,
            report: parseContextReport(preview.context),
            memoryBlock: preview.memoryBlock,
        }
    );
}

/** A `preview` job's `done.result`, or null for one of another shape. */
function previewResult(result: unknown): GenerationPreviewResult | null {
    return isPlainObject(result) && Array.isArray(result.messages) ? (result as GenerationPreviewResult) : null;
}

async function runSend(arg: SendChatArg): Promise<{ ok: boolean; result?: unknown }> {
    if (arg.target && !chatEntry(arg.target)) {
        arg.onServerRefused?.(arg.requestUncertain === true);
        arg.onEnd?.({
            settled: !arg.requestUncertain,
            blockedChats: [],
            outcome: "refused",
            requestUncertain: arg.requestUncertain === true,
        });
        return { ok: false };
    }
    const target = arg.target ?? currentChatRef();
    // The registry itself refuses a second send of the chat (read synchronously, never a derived view).
    const release = beginLocalSend(target);
    if (!release) {
        arg.onServerRefused?.(arg.requestUncertain === true);
        arg.onEnd?.({
            settled: !arg.requestUncertain,
            blockedChats: [],
            outcome: "refused",
            requestUncertain: arg.requestUncertain === true,
        });
        return { ok: false };
    }
    try {
        const { ok, result, refusal, settled, blockedChats, outcome, requestUncertain, reconciled } =
            await sendChatOnServer(target ? { ...arg, target } : arg);
        if (refusal) {
            arg.onServerRefused?.(refusal === "ambiguous");
        }
        arg.onEnd?.({
            settled,
            blockedChats: blockedChats ?? [],
            outcome,
            requestUncertain: requestUncertain ?? !settled,
            ...(reconciled !== undefined ? { reconciled } : {}),
        });
        return { ok, result };
    } finally {
        release();
    }
}
