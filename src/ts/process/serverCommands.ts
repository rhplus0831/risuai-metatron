import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";
import { language } from "src/lang";
import { alertError } from "../alert";
import {
    applyGenerationEvent,
    createGenerationJob,
    followGenerationJob,
    type GenerationFollow,
    GenerationBusyError,
    readGenerationJob,
    releaseGenerationJob,
    savedGenerationJobIds,
} from "../network/generationJobs";
import { type ChatRef, findChat, heldChatRevision } from "../storage/chatStore.svelte";
import { getResourceEpoch } from "../storage/resourceClient";
import { getDatabase, type character, type groupChat } from "../storage/database.svelte";
import { selectedPersona, selectedPreset } from "../storage/forwarding.svelte";
import { flushResources } from "../storage/resourceSync.svelte";
import { checkPersonaBinded, sleep } from "../util";

/** How often a follow whose socket closed before the job's end attaches again. */
const MAX_ATTACHES = 5;
const REATTACH_DELAY_MS = 1000;

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The one lifecycle of each job this tab follows to its end, shared by every caller. */
const following = new Map<string, Promise<GenerationTerminalEvent | "lost">>();

/**
 * Follows a job until its end, once per job however many callers ask (a button, a busy job of this
 * tab, the boot resume): the lifecycle is reserved before anything else, so only it discovers the
 * job, retries, reports, and releases. Without `ref` (the boot resume) it reads the job's status
 * first to learn its chat, retrying a failed read; a job the server does not know (or of another
 * epoch) is released. Every event is applied to the chat and the channel (the follow is the
 * channel's transport). A socket that closes before the end attaches again, a bounded number of
 * times, without creating the job again: a status read that fails is retried; a job that ended
 * meanwhile is attached again too (its attach sends its final records and its terminal). The end is
 * reported once (`alertError` for an error or a lost job). Returns the terminal event, or `"lost"`;
 * a lost job is released as its end would release it.
 */
export function followJobToEnd(jobId: string, ref?: ChatRef): Promise<GenerationTerminalEvent | "lost"> {
    let shared = following.get(jobId);
    if (!shared) {
        shared = (async () => {
            try {
                const target = ref ?? (await discover(jobId));
                if (target === "gone") {
                    releaseGenerationJob(jobId);
                    return "lost";
                }
                const end = target === "lost" ? "lost" : await followOnce(jobId, target);
                if (end === "lost") {
                    releaseGenerationJob(jobId);
                }
                reportEnd(end);
                return end;
            } finally {
                following.delete(jobId);
            }
        })();
        following.set(jobId, shared);
    }
    return shared;
}

/** The chat of a saved job from its status: `"gone"` when the server does not know it, `"lost"` after the retries. */
async function discover(jobId: string): Promise<ChatRef | "gone" | "lost"> {
    for (let read = 0; read < MAX_ATTACHES; read++) {
        if (read > 0) {
            await sleep(REATTACH_DELAY_MS);
        }
        let status;
        try {
            status = await readGenerationJob(jobId);
        } catch (error) {
            console.error("[Generation]", error);
            continue;
        }
        if (!status || status.epoch !== getResourceEpoch()) {
            return "gone";
        }
        return { chaId: status.characterId, chatId: status.chatId };
    }
    return "lost";
}

async function followOnce(jobId: string, ref: ChatRef): Promise<GenerationTerminalEvent | "lost"> {
    for (let attach = 0; attach < MAX_ATTACHES; attach++) {
        if (attach > 0) {
            await sleep(REATTACH_DELAY_MS);
        }
        const follow: GenerationFollow = followGenerationJob(jobId, (event) =>
            applyGenerationEvent(jobId, ref, event, follow),
        );
        const { terminal } = await follow.closed;
        if (terminal) {
            return terminal;
        }
        let status;
        try {
            status = await readGenerationJob(jobId);
        } catch {
            // A failed read (the network, the server restarting): attach again.
            continue;
        }
        if (!status || status.epoch !== getResourceEpoch()) {
            break;
        }
    }
    return "lost";
}

/** What the tab shows at a server job's end: its error, or that it was lost. */
function reportEnd(end: GenerationTerminalEvent | "lost") {
    if (end === "lost") {
        alertError("The connection to the server job was lost; reload the chat to see its changes");
    } else if (end.type === "error" && end.reason !== "aborted") {
        alertError(end.message);
    }
}

/** Attaches again to this tab's saved server jobs after a reload (Phase 5 slice 8a), each through its one lifecycle. */
export async function resumeServerJobs(): Promise<void> {
    await Promise.all(savedGenerationJobIds().map((jobId) => followJobToEnd(jobId)));
}

/**
 * A Lua button (`risu-btn`) run by the server (Phase 5 slice 8a, behind `risu.serverGeneration`):
 * the target and the settings ids are taken before the first await (a selection change while the
 * save flushes does not move the button), every pending write is saved first (a refused or a
 * discarding flush runs nothing), then a `command` job runs it and its events are applied until it
 * ends. Its chat and character changes arrive as the server's records; its alerts and questions
 * through the job's channel. An error ends with `alertError`.
 */
export async function runServerButton(char: character | groupChat, data: string, ref: ChatRef | null): Promise<void> {
    if (!ref || char.type === "group") {
        return;
    }
    const db = getDatabase();
    const presetId = selectedPreset(db)?.id ?? null;
    const selectedPersonaId = selectedPersona(db)?.id ?? null;
    // `getUserName(ref)`: the chat's bound persona, else the selected one.
    const personaId = checkPersonaBinded(ref)?.id ?? selectedPersonaId;
    const client = {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        browserLanguage: navigator.language,
    };
    try {
        const { discarded } = await flushResources();
        if (discarded.length > 0) {
            alertError("A conflict discarded local changes; the button did not run");
            return;
        }
    } catch (error) {
        alertError(`Local changes could not be saved: ${errorText(error)}`);
        return;
    }
    if (!findChat(ref)) {
        return;
    }
    const chatRevision = heldChatRevision(ref);
    if (chatRevision === null) {
        alertError("This chat is not saved on the server yet");
        return;
    }
    let jobId: string;
    try {
        jobId = await createGenerationJob({
            kind: "command",
            context: {
                characterId: ref.chaId,
                chatId: ref.chatId,
                presetId,
                personaId,
                selectedPersonaId,
                mode: "button",
                input: "",
                chatRevision,
                client,
            },
            command: { type: "button", data },
        });
    } catch (error) {
        if (error instanceof GenerationBusyError) {
            // This tab's own job (one a reload lost track of): follow it instead; another's is busy.
            const owned = await readGenerationJob(error.jobId).catch(() => null);
            if (owned) {
                await followJobToEnd(error.jobId, ref);
                return;
            }
            alertError(language.chatGenerating);
            return;
        }
        alertError(errorText(error));
        return;
    }
    await followJobToEnd(jobId, ref);
}
