import type { GenerationKind } from "../../../shared/jobs.ts";
import type { PluginCallContext } from "../plugins/apiV3/pluginContext";
import { type ChatRef, currentChatRef, findChat } from "../storage/chatStore.svelte";
import { incrementStatic } from "../storage/collectionStore.svelte";
import { markCharacterDirtyAt } from "../storage/resourceSync.svelte";
import { DBState } from "../stores.svelte";
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
 * `sendChat` as a server job (Phase 5 slice 9, behind `risu.serverGeneration`): the tab writes the
 * two per-send fields (`statics.messages`, the target's `lastInteraction`), then `runServerJob`
 * flushes, creates the job (`preview`, `previewPrompt`, `continue`, `group` for a group chat, else
 * `send`) with the input and the message ids, and follows it to its end. A preview's `done.result` is
 * returned for `previewFormated`/`previewBody`; a reply's reroll alternatives go to `addRerolls`
 * under the reply's generation (a continue keeps none, as its alternatives are never looked up on the
 * client either). `ok` is the browser path's result: the job ended with `done` and counted as sent
 * (not `stopped`). `refusal` says why a send did not run.
 */
export async function sendChatOnServer(
    arg: ServerSendArg,
): Promise<{ ok: boolean; outcome: ServerCommandOutcome; result?: unknown; refusal?: ServerSendRefusal }> {
    const ref = arg.target ?? currentChatRef();
    const characterIndex = ref ? DBState.db.characters.findIndex((entry) => entry?.chaId === ref.chaId) : -1;
    const char = DBState.db.characters[characterIndex];
    if (!ref || !char || !findChat(ref)) {
        return { ok: false, outcome: "refused", refusal: "definite" };
    }
    incrementStatic("messages");
    char.lastInteraction = Date.now();
    // The target is not necessarily the selected character (whose changes the save loop sees).
    markCharacterDirtyAt(characterIndex);

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
            addRerolls(generationId, terminal.alternatives);
        }
    }
    return { ok: !terminal.stopped, outcome, result: terminal.result };
}
