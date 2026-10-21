import type { GenerationKind } from "../../../shared/jobs.ts";
import type { PluginCallContext } from "../plugins/apiV3/pluginContext";
import { type ChatRef, chatEntry, currentChatRef, findChat, pinChat } from "../storage/chatStore.svelte";
import { incrementStatic } from "../storage/collectionStore.svelte";
import { characterList } from "../storage/characterStore.svelte";
import { addRerolls } from "./prereroll";
import { runServerJob, type ServerCommandOutcome } from "./serverCommands";

/** What a send asks of the server (`sendChat`'s argument as the flag branch reads it). */
export type ServerSendArg = {
    target?: ChatRef;
    signal?: AbortSignal;
    continue?: boolean;
    continueMessageId?: string;
    preview?: boolean;
    previewPrompt?: boolean;
    /** The chat input the job's input stage appends (`sendMain` behind the flag), with its message id. */
    input?: string;
    userMessageId?: string;
    /** A plugin call's context: the job takes its preset and effective persona, not the tab's selection now. */
    pluginContext?: PluginCallContext;
};

/**
 * Why a send did not run: `definite` (nothing reached the server, or this tab's other job was followed
 * instead: the input was not appended), or `ambiguous` (the create request got no answer: the input
 * may have been appended under its id).
 */
export type ServerSendRefusal = "definite" | "ambiguous";

/**
 * `sendChat` as a server job (the only send path): the tab counts the send (`statics.messages`),
 * then `runServerJob` flushes, creates the job (`preview`, `previewPrompt`, `continue`, `group` for
 * a group chat, else `send`) with the input and the message ids, and follows it to its end. The
 * target's `lastInteraction` is the job's to stamp (a field patch on the server, so the character
 * record is not uploaded before every send). A preview's `done.result` is returned for
 * `previewFormated`/`previewBody`; a reply's reroll alternatives go to `addRerolls` under the
 * reply's generation (a continue keeps none, as its alternatives are never looked up on the client
 * either). `ok` is the browser path's result: the job ended with `done` and counted as sent (not
 * `stopped`). `refusal` says why a send did not run. The target chat needs to be listed, not
 * loaded: `runServerJob` loads it, and it stays pinned until the reply's alternatives are read
 * here.
 */
export async function sendChatOnServer(
    arg: ServerSendArg,
): Promise<{ ok: boolean; outcome: ServerCommandOutcome; result?: unknown; refusal?: ServerSendRefusal }> {
    const ref = arg.target ?? currentChatRef();
    const char = ref ? characterList().find((entry) => entry?.chaId === ref.chaId) : undefined;
    if (!ref || !char || !chatEntry(ref)) {
        return { ok: false, outcome: "refused", refusal: "definite" };
    }
    const release = pinChat(ref);
    try {
        return await sendPinned(arg, ref, char);
    } finally {
        release();
    }
}

async function sendPinned(
    arg: ServerSendArg,
    ref: ChatRef,
    char: NonNullable<ReturnType<typeof characterList>[number]>,
): Promise<{ ok: boolean; outcome: ServerCommandOutcome; result?: unknown; refusal?: ServerSendRefusal }> {
    incrementStatic("messages");

    const kind: GenerationKind = arg.preview
        ? "preview"
        : arg.previewPrompt
          ? "previewPrompt"
          : char.type === "group"
            ? "group"
            : arg.continue
              ? "continue"
              : "send";
    const input = kind === "preview" || kind === "previewPrompt" ? "" : (arg.input ?? "");
    const { outcome, terminal } = await runServerJob(
        char,
        ref,
        {
            kind,
            label: "send",
            context: {
                input,
                ...(input !== "" && arg.userMessageId ? { userMessageId: arg.userMessageId } : {}),
                ...(kind === "continue" && arg.continueMessageId ? { continueMessageId: arg.continueMessageId } : {}),
            },
        },
        {
            signal: arg.signal,
            ...(arg.pluginContext
                ? {
                      identity: {
                          presetId: arg.pluginContext.presetId || null,
                          modelPresetId: arg.pluginContext.modelPresetId || null,
                          personaId: arg.pluginContext.personaId || null,
                      },
                  }
                : {}),
        },
    );
    if (outcome === "refused" || outcome === "followed") {
        // A followed job is this tab's other action: this send's input did not reach it.
        return { ok: false, outcome, refusal: "definite" };
    }
    if (outcome === "unknown") {
        return { ok: false, outcome, refusal: "ambiguous" };
    }
    if (!terminal || terminal === "lost" || terminal.type !== "done") {
        return { ok: false, outcome };
    }
    if (terminal.alternatives && terminal.messageId && kind !== "continue") {
        const reply = findChat(ref)?.message.find((message) => message.chatId === terminal.messageId);
        const generationId = reply?.generationInfo?.generationId;
        if (generationId) {
            addRerolls(generationId, terminal.alternatives, ref, terminal.messageId);
        }
    }
    return { ok: !terminal.stopped, outcome, result: terminal.result };
}
