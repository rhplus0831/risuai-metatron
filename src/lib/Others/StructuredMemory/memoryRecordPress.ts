import { language } from "src/lang";
import { alertToast } from "src/ts/alert";
import { runServerJob } from "src/ts/process/serverCommands";
import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
import type { ChatRef } from "src/ts/storage/chatStore.svelte";

/**
 * A press of "record now" or "resume", wherever the button sits: the `memoryRecord` command through
 * `messageId`, or, with none, resuming on everything open, and the toast that says how the press went.
 */
export async function pressMemoryRecord(owner: AnyClientCharacter, chatRef: ChatRef, messageId?: string) {
    const { outcome, terminal } = await runServerJob(owner, chatRef, {
        kind: "command",
        command: { type: "memoryRecord", ...(messageId === undefined ? {} : { messageId }) },
        label: "memoryRecord",
        context: { mode: "manual" },
    });
    if (outcome === "followed") {
        alertToast(language.structuredMemory.receipt.busy);
    } else if (terminal !== null && terminal !== "lost" && terminal.type === "done") {
        alertToast(language.structuredMemory.receipt.requested);
    }
}
