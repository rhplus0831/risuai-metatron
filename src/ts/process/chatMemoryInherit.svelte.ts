import { language } from "src/lang";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import {
    MEMORY_RESTORE_BODY_BYTES,
    STRUCTURED_MEMORY_ALGORITHM,
    type StructuredMemoryFileRecords,
} from "../../../shared/structuredMemory.ts";
import { alertError } from "../alert";
import { chatHasUnackedWork, createChat, type ChatRef } from "../storage/chatStore.svelte";
import type { Chat, MessageGenerationInfo } from "../storage/database.svelte";
import {
    beginMutationScope,
    flushResources,
    GenerationBlockedError,
    type MutationScope,
} from "../storage/resourceSync.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { inheritStructuredMemory, restoreStructuredMemory } from "./structuredMemory.svelte";

/**
 * A new chat's memory. A copied or branched chat: the tab makes the chat, and the server builds its
 * records from the chat it came from (`server/src/prompt/memory/structured/inherit.ts`). An imported
 * chat: the tab makes the chat, and sends the records its file held
 * (`server/src/prompt/memory/structured/restore.ts`). Its own module, because the wait reads the chat
 * store and the save loop, and `structuredMemory.svelte.ts` stays free of both.
 *
 * `createChat` only queues the write, so the route is asked once the create can have reached the server.
 * A failure leaves a notice, never a wrong record. There is one attempt: the copy, the branch, or the
 * import is already done, and nothing waits for this.
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

/** Keeps a message or candidate's other generation metadata without its source chat's receipt. */
function withoutMemoryReceipt<T extends { generationInfo?: DeepReadonly<MessageGenerationInfo> }>(entry: T): T {
    if (!entry.generationInfo) {
        return entry;
    }
    const generationInfo = { ...entry.generationInfo };
    delete generationInfo.memory;
    return { ...entry, generationInfo };
}

/**
 * `createChat` for a copy or a branch of the chat `source`, which answers as `createChat` does, with the
 * inherit under way behind it. The id comes from `createChat`'s answer, because it may replace the one in
 * `input`. Copied message and candidate receipts are stripped because their runs stay behind in the source
 * chat. Every copy asks, because a chat can hold records under another algorithm, and one with none answers
 * at once; only a user of this algorithm reads about it when that fails.
 */
export function createInheritingChat(
    source: ChatRef,
    input: DeepReadonly<Chat>,
    options: { index?: number; select?: boolean },
): DeepReadonly<Chat> {
    const scope = beginMutationScope();
    const created = createChat(
        source.chaId,
        {
            ...input,
            message: input.message.map((message) => ({
                ...withoutMemoryReceipt(message),
                ...(message.candidates ? { candidates: message.candidates.map(withoutMemoryReceipt) } : {}),
            })),
        },
        options,
    );
    const { id, name } = created;
    void inheritMemory({ chaId: source.chaId, chatId: id }, source.chatId, scope).then((inherited) => {
        if (!inherited && settings.ui.memoryAlgorithmType === STRUCTURED_MEMORY_ALGORITHM) {
            alertError(language.structuredMemory.inherit.failed(name));
        }
    });
    return created;
}

/** One imported chat and what its file held: `chatId` is `createChat`'s answer, which may not be the id sent. */
export type ChatMemoryRestore = { chatId: string; name: string; records: StructuredMemoryFileRecords };

/** How a restore ended. `tooLarge` is a failure with its own notice: the records are over the route's cap. */
type RestoreEnd = "done" | "failed" | "tooLarge";

/**
 * How the restore of `records` to `ref`, created inside `scope`, ended: an `epoch` refusal is no failure,
 * because it halts the tab with its own notice. `restored: false` is one, since the chat is left without
 * what its file held.
 */
async function restoreMemory(
    ref: ChatRef,
    records: StructuredMemoryFileRecords,
    scope: MutationScope,
): Promise<RestoreEnd> {
    try {
        if (!(await createSettled(ref, scope))) {
            return "failed";
        }
        const result = await restoreStructuredMemory(ref, records);
        if (result.outcome === "ok") {
            return result.value.restored ? "done" : "failed";
        }
        if (result.outcome === "refused" && result.reason === "tooLarge") {
            return "tooLarge";
        }
        return result.outcome === "refused" && result.reason === "epoch" ? "done" : "failed";
    } catch {
        return "failed";
    }
}

/**
 * Restores `restores`, the chats of `chaId` an import just made inside `scope`, one after another behind
 * the action, each failure leaving the others to go on, and shows one notice naming the chats that failed.
 * It shows it whatever the selected algorithm: a file that holds records was meant to restore them, unlike
 * a copy, which asks for every chat. The notice says what the tab knows: the answer can be lost after the
 * commit, so it cannot say that nothing was restored.
 */
export function restoreChatMemory(chaId: string, restores: readonly ChatMemoryRestore[], scope: MutationScope): void {
    if (restores.length === 0) {
        return;
    }
    void (async () => {
        const failed: string[] = [];
        const tooLarge: string[] = [];
        for (const { chatId, name, records } of restores) {
            const end = await restoreMemory({ chaId, chatId }, records, scope);
            if (end === "failed") {
                failed.push(name);
            } else if (end === "tooLarge") {
                tooLarge.push(name);
            }
        }
        const { restoreFailed, restoreTooLarge } = language.structuredMemory.memoryFile;
        const notices = [
            ...(failed.length > 0 ? [restoreFailed(failed.join(", "))] : []),
            ...(tooLarge.length > 0
                ? [restoreTooLarge(tooLarge.join(", "), MEMORY_RESTORE_BODY_BYTES / (1024 * 1024))]
                : []),
        ];
        if (notices.length > 0) {
            alertError(notices.join("\n\n"));
        }
    })();
}
