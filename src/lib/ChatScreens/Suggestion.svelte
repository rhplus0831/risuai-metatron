<script lang="ts">
    import { getModelInfoForMode } from "src/ts/model/modellist";
    import {
        selectedCharacter,
        type AnyClientCharacter,
        type ClientCharacter,
    } from "src/ts/storage/characterStore.svelte";
    import { settings, activePreset } from "src/ts/storage/settingsViews.svelte";
    import { requestChatData } from "src/ts/process/request/request";
    import { doingChat, sendingChatRef, type OpenAIChat } from "../../ts/process/index.svelte";
    import { type character, type DeepReadonly, type Message, type groupChat } from "../../ts/storage/database.svelte";
    import { translate } from "src/ts/translator/translator";
    import { chatAutoTranslate } from "src/ts/translator/chatTranslation.svelte";
    import { CopyIcon, LanguagesIcon, RefreshCcwIcon } from "@lucide/svelte";
    import { alertConfirm } from "src/ts/alert";
    import { language } from "src/lang";
    import { getUserName, replacePlaceholders } from "../../ts/util";
    import { onDestroy, untrack } from "svelte";
    import { SvelteSet } from "svelte/reactivity";
    import {
        type ChatRef,
        chatEntry,
        currentChatRef,
        findChat,
        selectedChat,
        selectedChatId,
        setChatMeta,
    } from "src/ts/storage/chatStore.svelte";
    import { ParseMarkdown } from "src/ts/parser/parser.svelte";
    import { defaultAutoSuggestPrompt } from "../../ts/storage/defaultPrompts.js";

    const subModel = $derived(getModelInfoForMode("submodel").id);
    const currentCharacter = $derived(selectedCharacter());
    interface Props {
        send: () => any;
        messageInput: (string: string) => any;
    }

    let { send, messageInput }: Props = $props();
    let suggestMessages: readonly string[] = $state(selectedChat()?.suggestMessages);
    let suggestMessagesTranslated: string[] = $state();
    /** Whether the suggestions show translated: the chat's `autoTranslate` until clicked (slice 2.1). */
    let toggleTranslate: boolean = $state(false);
    /** The chat and flag `toggleTranslate` was last started from: a change of either starts it again. */
    let toggleSource: string | null = null;
    let progress: boolean = $state();
    /** The chat a running request is for (by id), or null. */
    let progressChatRef: ChatRef | null = null;
    let abortController: AbortController | undefined;
    let suggestionRequestId = 0;
    let chatId: string | null = $state(null);
    let sendingChat: ChatRef | null = $state(null);
    const chatKeyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;
    const pendingChatKeys = new SvelteSet<string>();

    const isSelectedChat = (ref: ChatRef) => {
        const selected = currentChatRef();
        return selected?.chaId === ref.chaId && selected?.chatId === ref.chatId;
    };
    const sendingSelectedChat = $derived(sendingChat !== null && isSelectedChat(sendingChat));

    const cancelSuggestionRequest = () => {
        suggestionRequestId += 1;
        progress = false;
        progressChatRef = null;
        abortController?.abort();
        abortController = undefined;
    };

    const updateSuggestions = () => {
        if (currentCharacter !== undefined) {
            if (progressChatRef !== null && !isSelectedChat(progressChatRef)) {
                cancelSuggestionRequest();
            }
            suggestMessages = selectedChat()?.suggestMessages;
        }
    };

    const requestSuggestions = () => {
        if (
            sendingSelectedChat ||
            currentCharacter === undefined ||
            (suggestMessages && suggestMessages.length > 0) ||
            progress
        ) {
            return;
        }

        const requestCharId = currentCharacter.chaId;
        const currentChar: AnyClientCharacter = currentCharacter;
        if (!currentChar) {
            return;
        }
        const requestChatId = selectedChatId(currentChar.chaId);
        const currentChat =
            requestChatId === null ? undefined : findChat({ chaId: currentChar.chaId, chatId: requestChatId });
        if (!currentChat) {
            return;
        }
        // The chat the suggestions are for, captured before the request.
        const requestChatRef = { chaId: currentChar.chaId, chatId: currentChat.id };
        let messages: DeepReadonly<Message>[] = [];

        messages = [...messages, ...currentChat.message];
        let lastMessages: DeepReadonly<Message>[] = messages.slice(Math.max(messages.length - 10, 0));
        if (lastMessages.length === 0) return;
        const prompt =
            activePreset.autoSuggestPrompt && activePreset.autoSuggestPrompt.length > 0
                ? activePreset.autoSuggestPrompt
                : defaultAutoSuggestPrompt;
        let promptbody: OpenAIChat[] = [
            {
                role: "system",
                content: replacePlaceholders(prompt, currentChar.name),
            },
            {
                role: "user",
                content: lastMessages
                    .map((b) => (b.role === "char" ? currentChar.name : getUserName()) + ":" + b.data)
                    .reduce((a, b) => a + "," + b),
            },
        ];

        if (subModel === "textgen_webui" || subModel === "mancer" || subModel.startsWith("local_")) {
            promptbody = [
                {
                    role: "system",
                    content: replacePlaceholders(activePreset.autoSuggestPrompt, currentChar.name),
                },
                ...lastMessages.map(({ role, data }) => ({
                    role: role === "user" ? ("user" as const) : ("assistant" as const),
                    content: data,
                })),
            ];
        }

        const requestId = suggestionRequestId + 1;
        const requestController = new AbortController();
        suggestionRequestId = requestId;
        abortController = requestController;
        progress = true;
        progressChatRef = requestChatRef;

        requestChatData(
            {
                formated: promptbody,
                bias: {},
                currentChar: currentChar as ClientCharacter,
            },
            "submodel",
            requestController?.signal ?? null,
        )
            .then((rq2) => {
                const stillCurrentRequest =
                    suggestionRequestId === requestId &&
                    selectedCharacter()?.chaId === requestCharId &&
                    selectedChatId(requestCharId) === requestChatId;
                const currentTargetChat = findChat(requestChatRef);
                if (
                    rq2.type !== "fail" &&
                    rq2.type !== "streaming" &&
                    rq2.type !== "multiline" &&
                    progress &&
                    stillCurrentRequest &&
                    currentTargetChat
                ) {
                    var suggestMessagesNew = rq2.result
                        .split("\n")
                        .filter((msg) => msg.startsWith("-"))
                        .map((msg) => msg.replace("-", "").trim());
                    setChatMeta(requestChatRef, { suggestMessages: suggestMessagesNew });
                    suggestMessages = suggestMessagesNew;
                }
            })
            .catch((error) => {
                if (!requestController?.signal.aborted && suggestionRequestId === requestId) {
                    console.error(error);
                }
            })
            .finally(() => {
                if (suggestionRequestId === requestId) {
                    progress = false;
                    progressChatRef = null;
                    abortController = undefined;
                }
            });
    };

    const unsubSendingChat = sendingChatRef.subscribe((ref) => {
        if (!ref) {
            // sendChat clears this store before doingChat; keep the target until its end below.
            return;
        }
        sendingChat = ref;
        pendingChatKeys.delete(chatKeyOf(ref));
        if (progressChatRef?.chaId === ref.chaId && progressChatRef?.chatId === ref.chatId) {
            cancelSuggestionRequest();
        }
        if (findChat(ref)) {
            setChatMeta(ref, { suggestMessages: [] });
        }
        if (isSelectedChat(ref)) {
            suggestMessages = [];
        }
    });

    const unsub = doingChat.subscribe((v) => {
        if (v) {
            return;
        }
        const finishedChat = sendingChat;
        sendingChat = null;
        if (finishedChat === null || isSelectedChat(finishedChat)) {
            requestSuggestions();
        } else if (chatEntry(finishedChat)) {
            pendingChatKeys.add(chatKeyOf(finishedChat));
        }
    });

    const translateSuggest = async (toggle, messages) => {
        if (toggle && messages && messages.length > 0) {
            suggestMessagesTranslated = [];
            for (let i = 0; i < suggestMessages.length; i++) {
                let msg = suggestMessages[i];
                let translated = await translate(msg, false);
                suggestMessagesTranslated[i] = translated;
            }
        }
    };

    onDestroy(() => {
        cancelSuggestionRequest();
        unsubSendingChat();
        unsub();
    });

    $effect.pre(() => {
        const ref = sendingChat;
        // A background send can publish its target before the job has loaded that chat.
        if (ref && findChat(ref)?.suggestMessages?.length) {
            untrack(() => setChatMeta(ref, { suggestMessages: [] }));
        }
    });
    $effect.pre(() => {
        for (const key of pendingChatKeys) {
            const [chaId, chatId] = key.split("\u0000");
            if (!chatEntry({ chaId, chatId })) {
                pendingChatKeys.delete(key);
            }
        }
    });
    $effect.pre(() => {
        currentCharacter?.chaId;
        chatId = currentCharacter ? selectedChatId(currentCharacter.chaId) : null;
        updateSuggestions();
        const ref = currentChatRef();
        // Wait for the selected chat to load before consuming its deferred request.
        if (ref && selectedChat() && pendingChatKeys.has(chatKeyOf(ref))) {
            pendingChatKeys.delete(chatKeyOf(ref));
            untrack(requestSuggestions);
        }
    });
    $effect.pre(() => {
        const chaId = currentCharacter?.chaId;
        const auto = chaId && chatId !== null ? chatAutoTranslate({ chaId, chatId }) : false;
        const source = `${chaId ?? ""}\n${chatId ?? ""}\n${auto}`;
        if (source !== toggleSource) {
            toggleSource = source;
            toggleTranslate = auto;
        }
    });
    $effect.pre(() => {
        translateSuggest(toggleTranslate, suggestMessages);
    });
</script>

<div class="chat-screen-content-width ml-4 flex flex-wrap">
    {#if progress}
        <div class="flex bg-textcolor2 p-2 rounded-lg items-center">
            <div class="loadmove mx-2"></div>
            <div>{language.creatingSuggestions}</div>
        </div>
    {:else if !sendingSelectedChat}
        {#if settings.memoryTranslateMedia.translator !== ""}
            <div class="flex mr-2 mb-2">
                <button
                    class={"bg-textcolor2 hover:bg-darkbutton font-bold py-2 px-4 rounded-sm " +
                        (toggleTranslate ? "text-green-500" : "text-textcolor")}
                    onclick={() => {
                        toggleTranslate = !toggleTranslate;
                    }}
                >
                    <LanguagesIcon />
                </button>
            </div>
        {/if}

        <div class="flex mr-2 mb-2">
            <button
                class="bg-textcolor2 hover:bg-darkbutton font-bold py-2 px-4 rounded-sm text-textcolor"
                onclick={() => {
                    alertConfirm(language.askReRollAutoSuggestions).then((result) => {
                        if (result) {
                            suggestMessages = [];
                            cancelSuggestionRequest();
                            requestSuggestions();
                        }
                    });
                }}
            >
                <RefreshCcwIcon />
            </button>
        </div>
        {#each suggestMessages ?? [] as suggest, i}
            <div class="flex mr-2 mb-2">
                <button
                    class="bg-textcolor2 hover:bg-darkbutton text-textcolor font-bold py-2 px-4 rounded-sm"
                    onclick={() => {
                        suggestMessages = [];
                        messageInput(suggest);
                        send();
                    }}
                >
                    {#await ParseMarkdown(settings.memoryTranslateMedia.translator !== "" && toggleTranslate && suggestMessagesTranslated && suggestMessagesTranslated.length > 0 ? (suggestMessagesTranslated[i] ?? suggest) : suggest) then md}
                        {@html md}
                    {/await}
                </button>
                <button
                    class="bg-textcolor2 hover:bg-darkbutton text-textcolor font-bold py-2 px-4 rounded-sm ml-1"
                    onclick={() => {
                        messageInput(suggest);
                    }}
                >
                    <CopyIcon />
                </button>
            </div>
        {/each}
    {/if}
</div>

<style>
    .loadmove {
        animation: spin 1s linear infinite;
        border-radius: 50%;
        border: 0.4rem solid rgba(0, 0, 0, 0);
        width: 1rem;
        height: 1rem;
        border-top: 0.4rem solid var(--risu-theme-textcolor);
        border-left: 0.4rem solid var(--risu-theme-textcolor);
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }
</style>
