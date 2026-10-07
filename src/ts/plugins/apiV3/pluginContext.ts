import { settings, activePreset, activeModelPreset, activePersona } from "../../storage/settingsViews.svelte";
import { untrack } from "svelte";
import { chatEntry, chatOwnerToken, type ChatRef } from "../../storage/chatStore.svelte";

/**
 * The call context of a plugin hook (Phase 4, `PLAN.md` Decision 5 for client hooks): the chat a hook
 * runs for, the prompt and model presets selected when its runner started, and the effective persona (the chat's bound
 * persona, else the selected one; carried for Phase 5, no Phase 4 host function reads it). A runner
 * captures it before its first await and hands it to each hook it calls (`invokeHook`); the hook's
 * wrapper (`v3.svelte.ts`) takes it synchronously and keeps it on its plugin instance's stack until
 * the hook settles, so the selection-dependent host functions that plugin calls meanwhile act on the
 * hook's chat and preset instead of the tab's selection (`currentContext`).
 *
 * Attribution is per loaded plugin instance (the stack's owner is the instance's API object, not the
 * plugin's name): another plugin's call during a hook's await never sees the hook's context, and
 * neither does a reloaded instance of the same plugin. Recorded limits: two hooks of one plugin in flight resolve to the innermost; a hook that
 * never settles keeps its context; a plugin's own timers and UI callbacks, and its hooks without a
 * chat, see an ambient context while one of its hooks is in flight. Exact attribution would need a
 * correlation id in the sandbox RPC (a transport change).
 */
export interface PluginCallContext {
    readonly chatRef: ChatRef;
    /** The prompt preset. */
    readonly presetId: string;
    /** The model preset (`docs/plan/split-preset.md`). */
    readonly modelPresetId: string;
    readonly personaId: string;
    /**
     * The chat's owner lifetime when the context was captured (`chatOwnerToken`): a host function
     * refuses the hook's chat once its character's chats were replaced, even under the same ids.
     */
    readonly owner?: string;
}

/** A hook's chat, character, or preset no longer exists; the host call is refused rather than redirected to the tab's selection. */
export class PluginTargetGoneError extends Error {
    constructor(target: string) {
        super(`The ${target} this plugin hook runs for no longer exists`);
        this.name = "PluginTargetGoneError";
    }
}

/** The context of a hook for `chatRef` (none without a chat), from the selection as it is now. */
export function capturePluginContext(chatRef: ChatRef | null | undefined): PluginCallContext | undefined {
    if (!chatRef) {
        return undefined;
    }
    return untrack(() => {
        // The list entry: the bound persona holds also while the chat is not loaded.
        const bound = chatEntry(chatRef)?.bindedPersona;
        const boundPersona = bound ? settings.personas?.find((persona) => persona?.id === bound) : undefined;
        return {
            chatRef: { chaId: chatRef.chaId, chatId: chatRef.chatId },
            presetId: activePreset.id ?? "",
            modelPresetId: activeModelPreset.id ?? "",
            personaId: boundPersona?.id ?? activePersona.id ?? "",
            owner: chatOwnerToken(chatRef.chaId),
        };
    });
}

let handoff: PluginCallContext | undefined;

/**
 * Calls a hook with `context` in the handoff slot, from which the hook's wrapper takes it at its
 * first line (before any await). The slot is restored afterwards, whatever the hook does.
 */
export function invokeHook<A extends unknown[], R>(
    hook: (...args: A) => R,
    context: PluginCallContext | undefined,
    ...args: A
): R {
    const previous = handoff;
    handoff = context;
    try {
        return hook(...args);
    } finally {
        handoff = previous;
    }
}

/** Takes the context `invokeHook` handed over (clearing the slot), or none. */
export function takeHandoff(): PluginCallContext | undefined {
    const context = handoff;
    handoff = undefined;
    return context;
}

type StackEntry = { readonly context: PluginCallContext };

const stacks = new WeakMap<object, StackEntry[]>();

/** Puts `context` on `owner`'s stack; the returned function removes exactly that entry (settle order may differ). */
export function enterContext(owner: object, context: PluginCallContext): () => void {
    const entry: StackEntry = { context };
    const stack = stacks.get(owner) ?? [];
    stack.push(entry);
    stacks.set(owner, stack);
    return () => {
        const current = stacks.get(owner);
        const index = current?.lastIndexOf(entry) ?? -1;
        if (current && index !== -1) {
            current.splice(index, 1);
        }
    };
}

/** The context of `owner`'s innermost hook in flight, or none (the tab's selection applies). */
export function currentContext(owner: object): PluginCallContext | undefined {
    const stack = stacks.get(owner);
    return stack?.[stack.length - 1]?.context;
}
