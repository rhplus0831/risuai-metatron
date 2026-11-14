import { inputHookHistoryCounts, inputHookMessages, type InputHook } from "../../../shared/inputHooks.ts";
import { buildTranslatorHistory, type TranslatorHistory } from "../../../shared/translation/historySlots.ts";
import { language } from "../../lang";
import { capturePluginContext } from "../plugins/apiV3/pluginContext";
import { chatOwnerToken, findChat, pinChat, type ChatRef } from "../storage/chatStore.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { countTokensInScope, tabTokenScope } from "../tokenizer";
import { requestChatData } from "./request/request";

/**
 * Input hooks are tab requests on the chat's bound presets: the otherAx slot, or the hook's model
 * profile. `tools: []` keeps tool records out of the chat; plugins' request replacers still run.
 * The chat stays pinned through history preparation, the request, and cancellation of a returned stream.
 */

/**
 * Builds any requested history with a tokenizer scope captured from the chat's presets before
 * yielding, then requests one buffered reply. Returns its trimmed text (an empty string included).
 * Missing history chats, request failures, streams, and multiline replies throw; aborts propagate.
 */
export async function runInputHook(
    hook: InputHook,
    { ref, content, draft, signal }: { ref: ChatRef; content: string; draft: string; signal: AbortSignal },
): Promise<string> {
    const owner = chatOwnerToken(ref.chaId);
    const release = pinChat(ref);
    try {
        const { presetId, modelPresetId } = capturePluginContext(ref)!;
        const captured = tabTokenScope({ presetId, modelPresetId });
        if (signal.aborted) {
            throw signal.reason;
        }

        let history: TranslatorHistory | undefined;
        const counts = inputHookHistoryCounts(hook.prompt);
        if (counts.length > 0) {
            const messages = findChat(ref)?.message;
            if (messages === undefined) {
                throw new Error(language.error);
            }
            history = await buildTranslatorHistory({
                messages,
                messageIndex: messages.length,
                counts,
                maxTokens: settings.memoryTranslateMedia.translatorHistoryMaxTokens,
                countTokens: (text) => countTokensInScope(text, captured, signal),
            });
        }

        const response = await requestChatData(
            {
                formated: inputHookMessages(hook, { content, draft }, history),
                bias: {},
                chatRef: ref,
                chatOwner: owner,
                tools: [],
                useStreaming: false,
                noMultiGen: true,
                ...(hook.model.mode === "profile" ? { profileId: hook.model.profileId } : {}),
            },
            "otherAx",
            signal,
        );
        if (response.type === "streaming") {
            try {
                await response.result.cancel();
            } catch {
                // Cancellation still releases the transport's pin when it rejects.
            }
        }
        if (signal.aborted) {
            throw signal.reason;
        }
        if (response.type === "fail") {
            throw new Error(response.result);
        }
        if (response.type !== "success") {
            throw new Error(language.error);
        }
        return response.result.trim();
    } finally {
        release();
    }
}
