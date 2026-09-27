import { writable } from "svelte/store";
import type { OpenAIChat } from "../process/index.svelte";

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

export type PluginProviderOptions = {
    tokenizer?: string;
    tokenizerFunc?: (content: string) => number[] | Promise<number[]>;
};

export type EditFunction = (content: string) => string | null | undefined | Promise<string | null | undefined>;
export type ReplacerFunction = (content: OpenAIChat[], type: string) => OpenAIChat[] | Promise<OpenAIChat[]>;
type ChatOutputListenerArg = { char: any; chat: any; characterIndex: number; chatIndex: number; messageIndex: number };
export type ChatOutputListener = (arg: ChatOutputListenerArg) => void | Promise<void>;

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

//Resets these registries before plugins are reloaded, since most of them have no per-plugin unload cleanup.
//Replacers, provider options, and the provider lists are not reset.
export function clearPluginHooks() {
    pluginHooks.providers.clear();
    pluginHooks.editdisplay.clear();
    pluginHooks.editoutput.clear();
    pluginHooks.editprocess.clear();
    pluginHooks.editinput.clear();
    pluginHooks.chatOutput.clear();
}
