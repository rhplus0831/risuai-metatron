import {
    readChatBindingIds,
    resolveChatBinding,
    type ChatBindingField,
    type ChatBindingFields,
    type ChatBindingLookup,
    type ChatBindingProblem,
} from "../../../shared/chatBinding.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../../shared/resources.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";

/**
 * The server's check of a chat's binding: a chat job or chat request names the chat's own model
 * preset, prompt preset, and persona, or it is refused (409). Pure over what the caller read, so
 * the job scope checks the same synchronous read it loads from. Imports nothing of the job
 * registry (`jobScope.ts` and `generationJobs.ts` import this module).
 */

/** The ids a job, request, or transform names (`GenerationContext`, `LlmRequestBody.context`, `TransformContext`). */
export type SentBindingIds = {
    presetId: string | null | undefined;
    modelPresetId: string | null | undefined;
    personaId: string | null | undefined;
};

/**
 * - `send`: the binding is complete (every id set, every record there, no review pending) and the
 *   three sent ids are the bound ones.
 * - `chain`: as `send`, but the prompt preset is not compared: a `presetChain` pick re-scopes its own
 *   job.
 * - `display`: a read-only render. A field bound to a record that exists must be sent as bound; an
 *   unset or gone field takes the sent id; a pending review does not matter.
 */
export type ChatBindingMode = "send" | "chain" | "display";

export type ChatBindingRefusal =
    { error: "chatBindingIncomplete"; problems: ChatBindingProblem[] } | { error: "chatBindingMismatch" };

function hasId(list: unknown, id: string): boolean {
    return Array.isArray(list) && list.some((record) => (record as { id?: unknown } | null)?.id === id);
}

/** Which records exist, over the three settings lists as stored (arrays of records with an `id`). */
export function bindingLookup(presets: unknown, modelPresets: unknown, personas: unknown): ChatBindingLookup {
    return {
        modelPreset: (id) => hasId(modelPresets, id),
        promptPreset: (id) => hasId(presets, id),
        persona: (id) => hasId(personas, id),
    };
}

/** Whether `sent` may run for a chat with `chat`'s binding in `mode`: null, or the refusal (409 body). */
export function checkChatBinding(
    chat: ChatBindingFields,
    lookup: ChatBindingLookup,
    sent: SentBindingIds,
    mode: ChatBindingMode,
): ChatBindingRefusal | null {
    if (mode === "display") {
        const bound = readChatBindingIds(chat);
        const pairs: [string | null, unknown, (id: string) => boolean][] = [
            [bound.modelPresetId, sent.modelPresetId, lookup.modelPreset],
            [bound.promptPresetId, sent.presetId, lookup.promptPreset],
            [bound.personaId, sent.personaId, lookup.persona],
        ];
        const differs = pairs.some(([id, value, exists]) => id !== null && exists(id) && value !== id);
        return differs ? { error: "chatBindingMismatch" } : null;
    }
    const resolved = resolveChatBinding(chat, lookup);
    if (!resolved.ok) {
        return { error: "chatBindingIncomplete", problems: resolved.problems };
    }
    const { ids } = resolved;
    if (
        sent.modelPresetId !== ids.modelPresetId ||
        sent.personaId !== ids.personaId ||
        (mode === "send" && sent.presetId !== ids.promptPresetId)
    ) {
        return { error: "chatBindingMismatch" };
    }
    return null;
}

/**
 * The chat's binding fields (its summary; no message is read) and the lookup over the stored lists,
 * in one synchronous read. `chat` is null when the chat does not exist.
 */
export function readChatBindingState(
    store: ResourceStore,
    kinds: ResourceKindRegistry,
    ref: { characterId: string; chatId: string },
): { chat: ChatBindingFields | null; lookup: ChatBindingLookup } {
    const kind = (name: string) => {
        const found = kinds.get(name);
        if (!found) {
            throw new Error(`Unknown resource kind ${name}`);
        }
        return found;
    };
    const read = store.readRefs([
        { kind: kind(RESOURCE_KIND.presets), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.modelPresets), id: SINGLETON_RESOURCE_ID },
        { kind: kind(RESOURCE_KIND.personas), id: SINGLETON_RESOURCE_ID },
    ]);
    const [presets, modelPresets, personas] = read.items.map((item) => item.data);
    return {
        chat: store.chatSummary(ref.characterId, ref.chatId),
        lookup: bindingLookup(presets, modelPresets, personas),
    };
}

const FIELD_NAMES: Record<ChatBindingField, string> = {
    modelPresetId: "model preset",
    promptPresetId: "prompt preset",
    personaId: "persona",
};

/** The refusal as a sentence (a job's terminal error, which carries only a message). */
export function chatBindingRefusalMessage(refusal: ChatBindingRefusal): string {
    if (refusal.error === "chatBindingMismatch") {
        return "This chat's model preset, prompt preset, or persona changed since the request was made; send again";
    }
    const parts = refusal.problems.map((problem) =>
        problem.field === "review"
            ? "its imported settings need a confirmation"
            : `its ${FIELD_NAMES[problem.field]} is ${problem.reason === "unset" ? "not set" : "deleted"}`,
    );
    return `This chat cannot be sent: ${parts.join(", ")}`;
}
