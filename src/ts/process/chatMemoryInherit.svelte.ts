import { language } from "src/lang";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { STRUCTURED_MEMORY_ALGORITHM } from "../../../shared/structuredMemory.ts";
import { alertError } from "../alert";
import { chatHasUnackedWork, createChat, type ChatRef } from "../storage/chatStore.svelte";
import type { Chat } from "../storage/database.svelte";
import {
    beginMutationScope,
    flushResources,
    GenerationBlockedError,
    type MutationScope,
} from "../storage/resourceSync.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { inheritStructuredMemory } from "./structuredMemory.svelte";

/**
 * A copied or branched chat's memory: the tab makes the chat, and the server builds its records from the
 * chat it came from (`server/src/prompt/memory/structured/inherit.ts`). Its own module, because the wait
 * reads the chat store and the save loop, and `structuredMemory.svelte.ts` stays free of both.
 *
 * `createChat` only queues the write, so the route is asked once the create can have reached the server.
 * A failure leaves the chat with no records and a notice, never a wrong record. There is one attempt:
 * the copy or the branch is already done, and nothing waits for this.
 */

/** How often a blocked create is looked at, and how long it is waited for in all. */
const SAVE_POLL_MS = 250;
const SAVE_WAIT_MS = 30_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Whether it is worth asking the server for `ref`, created inside `scope`: false when saving failed, or a
 * conflict or a refusal took the create. A flush refuses for any chat that waits for a generation, also
 * when this one could save, so that is no failure: the save loop goes on, and this waits for it, bounded.
 * The wait proves nothing: what shows whether the chat landed is the route's `chatGone`.
 */
async function createSettled(ref: ChatRef, scope: MutationScope): Promise<boolean> {
    const key = `chats/${ref.chaId}/${ref.chatId}`;
    try {
        const { discarded, refused } = await flushResources({ scope });
        return !discarded.includes(key) && !refused.includes(key);
    } catch (error) {
        if (!(error instanceof GenerationBlockedError)) {
            return false;
        }
    }
    for (let waited = 0; waited < SAVE_WAIT_MS && chatHasUnackedWork(ref); waited += SAVE_POLL_MS) {
        await pause(SAVE_POLL_MS);
    }
    return true;
}

/** Whether `ref` got what it could: an `epoch` refusal counts, because it halts the tab with its own notice. */
async function inheritMemory(ref: ChatRef, sourceChatId: string, scope: MutationScope): Promise<boolean> {
    if (!(await createSettled(ref, scope))) {
        return false;
    }
    const result = await inheritStructuredMemory(ref, sourceChatId);
    return result.outcome === "ok" || (result.outcome === "refused" && result.reason === "epoch");
}

/**
 * `createChat` for a copy or a branch of the chat `source`, which answers as `createChat` does, with the
 * inherit under way behind it. The id comes from `createChat`'s answer, because it may replace the one in
 * `input`. Every copy asks, because a chat can hold records under another algorithm, and one with none
 * answers at once; only a user of this algorithm reads about it when that fails.
 */
export function createInheritingChat(
    source: ChatRef,
    input: DeepReadonly<Chat>,
    options: { index?: number; select?: boolean },
): DeepReadonly<Chat> {
    const scope = beginMutationScope();
    const created = createChat(source.chaId, input, options);
    const { id, name } = created;
    void inheritMemory({ chaId: source.chaId, chatId: id }, source.chatId, scope).then((inherited) => {
        if (!inherited && settings.ui.memoryAlgorithmType === STRUCTURED_MEMORY_ALGORITHM) {
            alertError(language.structuredMemory.inherit.failed(name));
        }
    });
    return created;
}
