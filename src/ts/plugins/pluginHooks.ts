import { writable } from "svelte/store";
import type { OpenAIChat } from "../process/index.svelte";

/**
 * Live tab-side hook registries. `src/ts/network/jobChannel.ts` lists hook names at job creation
 * (`registeredHooks`) and reads the current registry when a server callback runs; a job does not
 * retain the original functions. `src/ts/plugins/plugins.svelte.ts` must wait for plugin work to
 * become idle before a remote change replaces these registrations.
 */

/** Provider names for UI consumers; `apiV3/v3.svelte.ts` maintains one entry per registered name. */
export const customProviderStore = writable([] as string[]);

export type PluginProviderArgument = {
    prompt_chat: OpenAIChat[];
    frequency_penalty: number;
    min_p: number;
    presence_penalty: number;
    repetition_penalty: number;
    top_k: number;
    top_p: number;
    temperature: number;
    mode: string;
    max_tokens: number;
};

/**
 * `tokenizerFunc` is retained for compatibility but never called: token counting runs on the server,
 * which uses `cl100k_base` for a provider's `custom` tokenizer (`server/src/prompt/tokens.ts`).
 */
export type PluginProviderOptions = {
    tokenizer?: string;
    tokenizerFunc?: (content: string) => number[] | Promise<number[]>;
};

export type EditFunction = (content: string) => string | null | undefined | Promise<string | null | undefined>;
export type ReplacerFunction = (content: OpenAIChat[], type: string) => OpenAIChat[] | Promise<OpenAIChat[]>;
type ChatOutputListenerArg = { char: any; chat: any; characterIndex: number; chatIndex: number; messageIndex: number };
export type ChatOutputListener = (arg: ChatOutputListenerArg) => void | Promise<void>;

/** Registrations are live until removed or reloaded; context-aware callers use `apiV3/pluginContext.ts:invokeHook`. */
export const pluginHooks = {
    providers: new Map<
        string,
        (
            arg: PluginProviderArgument,
            abortSignal?: AbortSignal,
        ) => Promise<{ success: boolean; content: string | ReadableStream<string> }>
    >(),
    providerOptions: new Map<string, PluginProviderOptions>(),
    editdisplay: new Set<EditFunction>(),
    editoutput: new Set<EditFunction>(),
    editprocess: new Set<EditFunction>(),
    editinput: new Set<EditFunction>(),
    replacerbeforeRequest: new Set<ReplacerFunction>(),
    replacerafterRequest: new Set<(content: string, type: string) => string | Promise<string>>(),
    chatOutput: new Set<ChatOutputListener>(),
};

/** Clears provider callbacks, options, and UI names together; `apiV3/v3.svelte.ts` resets model metadata separately. */
export function clearPluginProviders() {
    pluginHooks.providers.clear();
    pluginHooks.providerOptions.clear();
    customProviderStore.set([]);
}

/**
 * Resets provider, script-handler, and chat-output registries before unload starts. Replacers rely
 * on per-plugin unload cleanup. `apiV3/v3.svelte.ts:loadV3Plugins` clears providers and model metadata
 * again after termination as a backstop; each unloading instance refuses new registrations.
 */
export function clearPluginHooks() {
    clearPluginProviders();
    pluginHooks.editdisplay.clear();
    pluginHooks.editoutput.clear();
    pluginHooks.editprocess.clear();
    pluginHooks.editinput.clear();
    pluginHooks.chatOutput.clear();
}
