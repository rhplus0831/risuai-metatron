<script lang="ts">
    import type { AnyClientCharacter, ClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import type { DeepReadonly, Message, StreamingDisplayOptimizationMode } from "src/ts/storage/database.svelte";
    import { mount, onDestroy, unmount } from "svelte";
    import Chat from "./Chat.svelte";
    import { getCharImage } from "src/ts/characters";
    import { createSimpleCharacter, ReloadChatPointer, reloadChatKey } from "src/ts/stores.svelte";
    import { currentChatRef, selectedChatId, streamingState } from "src/ts/storage/chatStore.svelte";
    import { chatFoldedStateMessageIndex } from "src/ts/globalApi.svelte";
    import { get } from "svelte/store";

    const getCurrentChatRoomId = () => currentChatRef()?.chatId ?? null;

    let {
        messages,
        currentCharacter,
        onReroll,
        unReroll,
        currentUsername,
        userIcon,
        loadPages,
        userIconPortrait,
        hasNewUnreadMessage = $bindable(false),
    }: {
        messages: readonly DeepReadonly<Message>[];
        currentCharacter: AnyClientCharacter;
        onReroll: () => void;
        unReroll: () => void;
        currentUsername: string;
        userIcon: string;
        loadPages: number;
        userIconPortrait?: boolean;
        hasNewUnreadMessage?: boolean;
    } = $props();

    let chatBody: HTMLDivElement;
    /** What `Chat.updateRow` changes on a mounted row: its position, and its text while it streams. */
    type RowUpdate = {
        message: string;
        idx: number;
        isOptimizedStreamingMessage: boolean;
        streamingOptimizationMode: StreamingDisplayOptimizationMode;
        rawStreamingText: string;
    };
    /**
     * What mounts the row again when it changes: the text (unless the message streams), compared as is
     * (`data` is always a string), and the rest as JSON, so values the stored data may hold beyond their
     * types (an object `disabled`) compare by content after a clone, as before.
     */
    type MountKey = { text: string | null; rest: string };
    type Row = {
        instance: { updateRow?: (update: Partial<RowUpdate>) => void };
        element: HTMLDivElement;
        mountKey: MountKey;
        sent: RowUpdate;
    };

    /** The text is not copied into a key on every update (every streamed frame). */
    const sameMountKey = (a: MountKey, b: MountKey) => a.text === b.text && a.rest === b.rest;
    /**
     * The mounted rows by key: the chat and the message's id (`Message.chatId`), so a message keeps its
     * row when messages before it are added or removed (its new index goes through `Chat.updateRow`).
     * A row mounts again, resetting its state (an open editor, the translation toggle), when its text
     * changes, its message starts or stops streaming, or its portrait, disabled state, or reload
     * pointer changes. While it streams, its text goes through `Chat.updateRow` in every mode.
     */
    let rows: Map<string, Row> = new Map();

    const updateChatBody = () => {
        if (!chatBody) {
            return;
        }

        const charImage = getCharImage(currentCharacter.image, "css");
        const userImage = getCharImage(userIcon, "css");
        const simpleChar = createSimpleCharacter(currentCharacter);
        let loadStart = messages.length - 1;
        let loadEnd = messages.length - loadPages;
        const currentChatId = selectedChatId(currentCharacter.chaId);
        const configuredPerformanceMode = settings.ui.streamingDisplayOptimizationMode ?? "off";
        const streaming =
            streamingState.messageId !== null &&
            streamingState.chaId === currentCharacter.chaId &&
            streamingState.chatId === currentChatId;
        const performanceMode = streaming ? streamingState.mode : configuredPerformanceMode;
        // The streaming message by id, not by position (another message may follow it).
        const activeStreamingIndex =
            performanceMode !== "off" && streaming
                ? messages.findIndex((message) => message.chatId === streamingState.messageId)
                : -1;

        if (chatFoldedStateMessageIndex.index !== -1) {
            loadStart = chatFoldedStateMessageIndex.index;
            loadEnd = Math.max(0, chatFoldedStateMessageIndex.index - loadPages);
        }

        const reloadPointerMap = get(ReloadChatPointer);
        const chatKey = `${currentCharacter.chaId}\u0000${currentChatId}`;
        /** The rows to show, newest first (the DOM order: the list's flex direction reverses it). */
        const shown: Row[] = [];
        const shownKeys = new Set<string>();

        for (let i = loadStart; i >= loadEnd; i--) {
            if (i < 0) break; // Prevent out of bounds
            const message = messages[i];
            const messageLargePortrait =
                message.role === "user"
                    ? (userIconPortrait ?? false)
                    : ((currentCharacter as ClientCharacter).largePortrait ?? false);
            const reloadPointer = reloadPointerMap[reloadChatKey(message.chatId, i)] ?? 0;
            const streamingMessage =
                streaming && message.role === "char" && message.chatId === streamingState.messageId;
            const activeStreamingMessage = streamingMessage && i === activeStreamingIndex;
            let key = `${chatKey}\u0000${message.chatId ?? `#${i}`}`;
            if (shownKeys.has(key)) {
                // A repeated id (not expected in a saved chat) gets a row of its own.
                key = `${key}\u0000#${i}`;
            }
            shownKeys.add(key);
            const mountKey: MountKey = {
                text: streamingMessage ? null : message.data,
                rest: JSON.stringify([messageLargePortrait, message.disabled ?? false, reloadPointer]),
            };
            const sent: RowUpdate = {
                message: message.data,
                idx: i,
                isOptimizedStreamingMessage: activeStreamingMessage,
                streamingOptimizationMode: performanceMode,
                rawStreamingText: message.data,
            };
            const existing = rows.get(key);
            if (existing && sameMountKey(existing.mountKey, mountKey)) {
                const update: Partial<RowUpdate> = {};
                let changed = false;
                for (const field of Object.keys(sent) as (keyof RowUpdate)[]) {
                    if (existing.sent[field] !== sent[field]) {
                        (update as Record<string, unknown>)[field] = sent[field];
                        changed = true;
                    }
                }
                if (changed) {
                    existing.instance.updateRow?.(update);
                }
                // Equal text read again (a chat reload) may be a new string: comparing against the
                // newest one keeps later frames on the same-string fast path.
                existing.mountKey = mountKey;
                existing.sent = sent;
                shown.push(existing);
                continue;
            }
            if (existing) {
                unmount(existing.instance);
                existing.element.remove();
            }
            const element = document.createElement("div");
            element.classList.add("chat-message-container");
            const instance = mount(Chat, {
                target: element,
                props: {
                    ...sent,
                    isLastMemory: false,
                    messageId: message.chatId,
                    totalLength: messages.length,
                    img: message.role === "user" ? userImage : charImage,
                    onReroll: onReroll,
                    unReroll: unReroll,
                    rerollIcon: "dynamic",
                    character: simpleChar,
                    largePortrait: messageLargePortrait,
                    messageGenerationInfo: message.generationInfo,
                    role: message.role,
                    name: message.role === "user" ? currentUsername : currentCharacter.name,
                    isComment: message.isComment ?? false,
                    disabled: message.disabled ?? false,
                },
            });
            const row: Row = { instance, element, mountKey, sent };
            rows.set(key, row);
            shown.push(row);
        }

        for (const [key, row] of rows) {
            if (!shownKeys.has(key)) {
                unmount(row.instance);
                row.element.remove();
                rows.delete(key);
            }
        }

        // Put the rows in order, moving only the ones out of place.
        let previous: Element | null = null;
        for (const row of shown) {
            const expected: Element | null = previous ? previous.nextElementSibling : chatBody.firstElementChild;
            if (expected !== row.element) {
                chatBody.insertBefore(row.element, expected);
            }
            previous = row.element;
        }
    };

    onDestroy(() => {
        console.log("Unmounting Chats");
        rows.forEach((row) => {
            unmount(row.instance);
        });
        rows.clear();
    });

    function checkIfAtBottom() {
        if (!chatBody || !chatBody.parentElement) return true;
        const sc = chatBody.parentElement;
        const lastEl = chatBody.firstElementChild;
        if (!lastEl) return true;
        const rect = lastEl.getBoundingClientRect();
        const scRect = sc.getBoundingClientRect();
        return rect.top <= scRect.bottom + 100;
    }

    export const scrollToLatestMessage = () => {
        if (!chatBody) return;
        hasNewUnreadMessage = false;
        const element = chatBody.firstElementChild;
        if (element) {
            element.scrollIntoView({ behavior: "instant", block: "start" });
        }
    };

    let previousLength = 0;
    let previousChatRoomId: string | null = null;

    $effect(() => {
        console.log("Updating Chats");
        void $ReloadChatPointer; // Make $effect track ReloadChatPointer changes
        const wasAtBottom = checkIfAtBottom();
        updateChatBody();

        const currentChatRoomId = getCurrentChatRoomId();
        const isSameChat = currentChatRoomId === previousChatRoomId;

        // Only auto-scroll if it's the same chat and new messages were added
        if (isSameChat && messages.length > previousLength) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg && lastMsg.role === "char" && settings.ui.autoScrollToNewMessage) {
                if (wasAtBottom || settings.ui.alwaysScrollToNewMessage) {
                    const element = chatBody.firstElementChild;
                    if (element) {
                        setTimeout(() => {
                            element.scrollIntoView({ behavior: "instant", block: "start" });
                        }, 700);
                    }
                } else {
                    hasNewUnreadMessage = true;
                }
            }
        }
        previousLength = messages.length;
        previousChatRoomId = currentChatRoomId;
    });
</script>

<div class="chat-screen-content-width flex flex-col-reverse" bind:this={chatBody}></div>
