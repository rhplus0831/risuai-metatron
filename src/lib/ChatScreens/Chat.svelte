<script module lang="ts">
    import { characterList, selectedCharacter } from "src/ts/storage/characterStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";

    const currentCharacter = $derived(selectedCharacter());
    const currentChat = $derived(selectedChat());
    /**
     * The server manual trigger whose id `CurrentTriggerIdStore` holds: only the invocation that set
     * it clears it, so a refused click or an older timer leaves a newer one alone.
     */
    let serverTriggerIdOwner: object | null = null;
</script>

<script lang="ts">
    import { tick } from "svelte";
    import {
        ArrowLeft,
        ArrowLeftRightIcon,
        ArrowRight,
        BookmarkIcon,
        BotIcon,
        CopyIcon,
        PowerOff,
        GitBranch,
        HamburgerIcon,
        LanguagesIcon,
        MenuIcon,
        PencilIcon,
        RefreshCcwIcon,
        RotateCwIcon,
        SplitIcon,
        TrashIcon,
        UserIcon,
        Volume2Icon,
        Scissors,
        XIcon,
    } from "@lucide/svelte";
    import { rerenderMessage } from "src/ts/parser/transformClient";
    import {
        aiLawApplies,
        changeChatTo,
        foldChatToMessage,
        getFileSrc,
        createChatCopyName,
    } from "src/ts/globalApi.svelte";
    import { ColorSchemeTypeStore } from "src/ts/gui/colorscheme";
    import { longpress } from "src/ts/gui/longtouch";
    import { getModelInfo } from "src/ts/model/modellist";
    import { runServerButton, runServerManualTrigger } from "src/ts/process/serverCommands";
    import { sayTTS } from "src/ts/process/tts";
    import { ReloadChatPointer, CurrentTriggerIdStore, popupStore, reloadChatKey } from "src/ts/stores.svelte";
    import { capitalize, getUserIcon, getUserName, sleep } from "src/ts/util";
    import { onDestroy, onMount, untrack } from "svelte";
    import { type Unsubscriber } from "svelte/store";
    import { v4 as uuidv4, v4 } from "uuid";
    import { language } from "../../lang";
    import {
        alertClear,
        alertConfirm,
        alertError,
        alertInput,
        alertNormal,
        alertRequestData,
        alertWait,
    } from "../../ts/alert";
    import {
        ParseMarkdown,
        risuChatParser,
        risuChatParserForDisplay,
        type CbsConditions,
        type simpleCharacterArgument,
    } from "../../ts/parser/parser.svelte";
    import {
        type Message,
        type MessageGenerationInfo,
        type StreamingDisplayOptimizationMode,
    } from "../../ts/storage/database.svelte";
    import {
        type ChatRef,
        chatSaveVersion,
        createChat,
        chatOwnerToken,
        chatSelectionVersion,
        currentChatRef,
        ensureChatLoaded,
        findChat,
        isMessageLocked,
        patchMessage,
        removeMessages,
        setChatMeta,
        setMessageText,
        selectedChat,
        selectedChatId,
    } from "../../ts/storage/chatStore.svelte";
    import { HideIconStore, ReloadGUIPointer, SafeModeStore } from "../../ts/stores.svelte";
    import AutoresizeArea from "../UI/GUI/TextAreaResizable.svelte";
    import ChatBody from "./ChatBody.svelte";
    import PopupButton from "../UI/PopupButton.svelte";
    import PartialEditController from "./PartialEditController.svelte";
    import { chatFolderOf } from "../SideBars/chatFolders";
    import { llmTranslationCacheKey, readLLMCacheEntry, writeLLMCacheEntry } from "../../ts/translator/translator";
    import {
        beginStoredTranslationEdit,
        freshTranslation,
        heldMessage,
        isStoredTranslationPending,
        requestStoredTranslation,
        saveStoredTranslationEdit,
        setStoredTranslationChoice,
        storedTranslationChoice,
        type StoredTranslationEdit,
        usesStoredTranslation,
    } from "../../ts/translator/storedTranslation.svelte";
    import { chatAutoTranslate, chatTranslationSettings } from "../../ts/translator/chatTranslation.svelte";
    import type { BilingualInterleaveOptions } from "../../ts/translator/bilingualInterleave";

    let translating = $state(false);
    let editMode = $state(false);
    // A cancelled long press keeps the draft available, without changing the rendered/stored message.
    let draft: string | null = $state(null);
    export function isEditing() {
        return editMode || editTranslationMode || loadingTranslationEdit;
    }
    let statusMessage: string = $state("");
    let retranslate = $state(false);
    let editTranslationMode = $state(false);
    let loadingTranslationEdit = $state(false);
    let editTranslationText = $state("");
    /** What the open translation editor writes back to: a rendered translation's cache key, or a stored translation. */
    let editTranslationTarget: { kind: "cache"; key: string } | { kind: "stored"; edit: StoredTranslationEdit } | null =
        null;
    let chatBodyRevision = $state(0);
    /** Whether this message was locked when last seen (the server transform skips a locked message). */
    let wasLocked = false;
    let bodyRoot: HTMLElement | null = $state(null);
    let parsedBody: { whenRendered: () => Promise<void> } | undefined = $state();
    export async function whenRendered() {
        await tick();
        while (true) {
            const body = parsedBody;
            await body?.whenRendered();
            await tick();
            // The reload key (including ReloadGUIPointer) can replace ChatBody mid-parse.
            if (body === parsedBody) return;
        }
    }
    interface Props {
        message?: string;
        name?: string;
        largePortrait?: boolean;
        isLastMemory: boolean;
        img?: string | Promise<string>;
        idx?: number;
        /** The message's id (`Message.chatId`); handlers address the message by it, not by `idx`. */
        messageId?: string;
        messageGenerationInfo?: MessageGenerationInfo | null;
        rerollIcon?: boolean | "dynamic";
        role?: string;
        onReroll?: () => void;
        unReroll?: () => void;
        character?: simpleCharacterArgument | string | null;
        firstMessage?: boolean;
        altGreeting?: boolean;
        currentPage?: number;
        totalPages?: number;
        isComment?: boolean;
        disabled?: boolean | "allBefore";
        isOptimizedStreamingMessage?: boolean;
        streamingOptimizationMode?: StreamingDisplayOptimizationMode;
        rawStreamingText?: string;
        pendingReveal?: boolean;
    }

    let {
        message = $bindable(""),
        name = "",
        largePortrait = false,
        isLastMemory,
        img = "",
        idx = -1,
        messageId = undefined,
        rerollIcon = false,
        messageGenerationInfo = null,
        role = null,
        onReroll = () => {},
        unReroll = () => {},
        character = null,
        firstMessage = false,
        altGreeting = false,
        currentPage = 1,
        totalPages = 1,
        isComment = false,
        disabled = false,
        isOptimizedStreamingMessage = false,
        streamingOptimizationMode = "off",
        rawStreamingText = message,
        pendingReveal = false,
    }: Props = $props();

    let msgDisplay = $state("");
    let translated = $state(false);
    let partialEditEnabled = $state(true);
    let translationViewControlsDisabled = $derived(editMode || editTranslationMode || loadingTranslationEdit);
    /** The chat this message is shown in (a branched or copied chat shares its source's message ids). */
    let displayedChat = $derived.by((): ChatRef | null => {
        const character = currentCharacter;
        const chatId = character ? selectedChatId(character.chaId) : null;
        return character && chatId !== null ? { chaId: character.chaId, chatId } : null;
    });
    /**
     * Whether this message is locked by a server generation job (its edit, delete, and regenerate are
     * off): while it streams and until the job releases it, and also a previous group speaker's reply.
     */
    let locked = $derived(isMessageLocked(displayedChat, messageId));
    let originalEditControlDisabled = $derived(editTranslationMode || loadingTranslationEdit || locked);

    // The stored translation: the LLM translator on `llmTranslationTarget: "message"`, for a row of a
    // stored message. Rows without a message id (the greeting, bookmark previews) keep the rendered
    // path. Every read below is tracked: the held chats are deep state, so a refresh that brings a
    // translation re-derives it without remounting the row.
    let storedPath = $derived(usesStoredTranslation() && !!messageId && displayedChat !== null);
    let storedMessage = $derived(
        storedPath && displayedChat && messageId ? heldMessage(displayedChat, messageId) : undefined,
    );
    let storedFresh = $derived(storedMessage ? freshTranslation(storedMessage) : null);
    /** The chat's `autoTranslate` (off for a row outside a chat): its translations show without a click. */
    let chatAutoShow = $derived(chatAutoTranslate(displayedChat));
    /** The row asks for the translation: its choice (kept across a remount), else the chat's `autoTranslate`. */
    let storedWanted = $derived(
        storedPath && displayedChat && messageId
            ? (storedTranslationChoice(displayedChat, messageId) ?? chatAutoShow)
            : false,
    );
    let storedPending = $derived(
        storedPath && displayedChat && messageId ? isStoredTranslationPending(displayedChat, messageId) : false,
    );
    /** The stored translation is what the row shows. */
    let storedShown = $derived(storedWanted && storedFresh !== null);
    /**
     * The chat's bilingual display: with the stored translation shown, the row renders it
     * interleaved with the message's text, by line or every `bilingualSentences` sentences, with the
     * chat's emphasis. Null: off, or nothing shown.
     */
    let storedBilingual = $derived.by(() => {
        if (!storedShown || !storedMessage || !displayedChat) {
            return null;
        }
        const chatSettings = chatTranslationSettings(displayedChat);
        if (!chatSettings.bilingualDisplay) {
            return null;
        }
        return {
            source: storedMessage.data,
            options: {
                emphasize: chatSettings.bilingualEmphasis,
                ...(chatSettings.bilingualSentences > 0
                    ? { sentenceBreaks: { sentencesPerParagraph: chatSettings.bilingualSentences } }
                    : {}),
            },
        };
    });
    /** `storedBilingual` with its source after the display CBS pre-pass (`displaya`), as `ChatBody` takes it. */
    let bilingualDisplay = $state<{ source: string; options: BilingualInterleaveOptions } | null>(null);
    /** The translation view is on: shown, or asked for and being requested (the toggle's highlight). */
    let translationViewOn = $derived(storedPath ? storedShown || (storedWanted && storedPending) : translated);
    let translationEditControlDisabled = $derived(
        editMode ||
            loadingTranslationEdit ||
            (storedPath && !editTranslationMode && (storedFresh === null || storedPending)),
    );

    /**
     * `Chats` keys a row by its message id and passes these here instead of mounting the row again: a
     * new position (a message before it was added or removed), the text while it streams, and
     * display-only name/image changes. Only the fields given change; name/image never reset ChatBody.
     */
    export function updateRow(update: {
        message?: string;
        idx?: number;
        isOptimizedStreamingMessage?: boolean;
        streamingOptimizationMode?: StreamingDisplayOptimizationMode;
        rawStreamingText?: string;
        name?: string;
        img?: string | Promise<string>;
    }) {
        if ("message" in update) message = update.message;
        if ("idx" in update) idx = update.idx;
        if ("isOptimizedStreamingMessage" in update) isOptimizedStreamingMessage = update.isOptimizedStreamingMessage;
        if ("streamingOptimizationMode" in update) streamingOptimizationMode = update.streamingOptimizationMode;
        if ("rawStreamingText" in update) rawStreamingText = update.rawStreamingText;
        if ("name" in update) name = update.name;
        if ("img" in update) img = update.img;
    }

    // A row rendered before its chat's first save had no transform context (the script stage was
    // skipped): it renders again once the save lands.
    let seenSave: { chat: string; version: number } | null = null;
    $effect(() => {
        const chat = displayedChat;
        const key = chat ? JSON.stringify([chat.chaId, chat.chatId]) : "";
        const version = chat ? chatSaveVersion(chat) : 0;
        if (seenSave && seenSave.chat === key && seenSave.version !== version) {
            untrack(() => {
                chatBodyRevision += 1;
            });
        }
        seenSave = { chat: key, version };
    });

    // The server transform shows a locked (streaming) message raw: it renders again once the lock ends.
    $effect(() => {
        const now = locked;
        if (wasLocked && !now) {
            untrack(() => {
                chatBodyRevision += 1;
            });
        }
        wasLocked = now;
    });

    /** The chat this message belongs to, captured before any await (a later chat switch cannot redirect a write). */
    function messageTarget(): { ref: ChatRef; id: string } | null {
        const ref = currentChatRef();
        return ref && messageId ? { ref, id: messageId } : null;
    }

    /**
     * Alerts and returns true when a generation locks any of `ids` (checked when the write is made:
     * a continue may have started while a dialog was open, and the button state alone is stale).
     */
    function refuseLocked(ref: ChatRef, ids: readonly string[]): boolean {
        if (ids.some((id) => isMessageLocked(ref, id))) {
            alertError(language.chatGenerating);
            return true;
        }
        return false;
    }

    /** Removes the message and every message after it (by id, where they are now). */
    function removeFromMessage(target: { ref: ChatRef; id: string }) {
        const messages = findChat(target.ref)?.message ?? [];
        const index = messages.findIndex((entry) => entry.chatId === target.id);
        if (index !== -1) {
            const ids = messages.slice(index).map((entry) => entry.chatId);
            if (!refuseLocked(target.ref, ids)) {
                removeMessages(target.ref, ids);
            }
        }
    }

    async function rm(e: MouseEvent, rec?: boolean) {
        const target = messageTarget();
        if (!target || locked) {
            return;
        }
        if (e.shiftKey) {
            removeFromMessage(target);
            return;
        }

        const rm = settings.ui.askRemoval ? await alertConfirm(language.removeChat) : true;
        if (rm) {
            if (settings.ui.instantRemove || rec) {
                const r = await alertConfirm(language.instantRemoveConfirm);
                if (!r) {
                    removeFromMessage(target);
                } else if (!refuseLocked(target.ref, [target.id])) {
                    removeMessages(target.ref, [target.id]);
                }
            } else if (!refuseLocked(target.ref, [target.id])) {
                removeMessages(target.ref, [target.id]);
            }
        }
    }

    /** Saves the edited text; false (the editor stays open) when a generation locked the message meanwhile. */
    function edit(): boolean {
        const target = messageTarget();
        if (target && refuseLocked(target.ref, [target.id])) {
            return false;
        }
        if (target) {
            setMessageText(target.ref, target.id, draft ?? message);
        }
        message = draft ?? message;
        draft = null;
        return true;
    }

    function startOriginalEdit() {
        if (originalEditControlDisabled) return;
        draft ??= message;
        editMode = true;
    }

    function toggleOriginalEdit() {
        if (originalEditControlDisabled) return;

        if (editMode) {
            if (edit()) {
                editMode = false;
            }
        } else {
            startOriginalEdit();
        }
    }

    function toggleTranslation() {
        if (translationViewControlsDisabled) return;
        if (storedPath) {
            toggleStoredTranslation();
            return;
        }
        translated = !translated;
    }

    /**
     * The stored path's toggle: hides the translation when it is on; otherwise shows it, and asks the
     * server for one when the message has no fresh translation and none is being requested.
     */
    function toggleStoredTranslation() {
        const ref = displayedChat;
        const id = messageId;
        if (!ref || !id) return;
        if (translationViewOn) {
            setStoredTranslationChoice(ref, id, false);
            return;
        }
        setStoredTranslationChoice(ref, id, true);
        if (storedFresh === null && !storedPending) {
            if (isMessageLocked(ref, id)) {
                alertError(language.chatGenerating);
                return;
            }
            void requestStoredTranslation(ref, id, { force: false });
        }
    }

    async function requestRetranslation() {
        if (translationViewControlsDisabled) return;
        if (!storedPath) {
            retranslate = true;
            return;
        }
        // The message as the click found it (the selected chat can change during the dialog).
        const ref = displayedChat ? { ...displayedChat } : null;
        const id = messageId;
        if (!ref || !id || isStoredTranslationPending(ref, id)) return;
        if (!(await alertConfirm(language.retranslateConfirm))) return;
        if (!heldMessage(ref, id)) return;
        if (isMessageLocked(ref, id)) {
            alertError(language.chatGenerating);
            return;
        }
        setStoredTranslationChoice(ref, id, true);
        void requestStoredTranslation(ref, id, { force: true });
    }

    /** The partial editor's open stored-translation edits, by the key its context handed out. */
    const storedPartialEdits = new Map<string, StoredTranslationEdit>();
    let storedPartialEditSeq = 0;

    /**
     * Writes the partial editor's translation edit: a stored edit through its captured session, a
     * rendered one to its cache key. False (the editor keeps the draft) when it was not taken.
     */
    async function savePartialTranslation(newData: string, key: string): Promise<boolean> {
        const edit = storedPartialEdits.get(key);
        if (edit) {
            if (!saveStoredTranslationEdit(edit, newData)) {
                return false;
            }
            storedPartialEdits.delete(key);
            return true;
        }
        if (key.startsWith("stored:")) {
            alertError(language.translationEditStale);
            return false;
        }
        await updateTranslationCache(key, newData);
        return true;
    }

    async function handlePartialEditSave(
        e: CustomEvent<{ newData: string; target: "original" | "translation"; translationKey?: string }>,
    ) {
        if (idx < 0) return;

        if (e.detail.target === "translation") {
            if (!e.detail.translationKey) return;

            await savePartialTranslation(e.detail.newData, e.detail.translationKey);
            return;
        }

        const target = messageTarget();
        if (target && refuseLocked(target.ref, [target.id])) {
            return;
        }
        message = e.detail.newData;
        if (target) {
            setMessageText(target.ref, target.id, e.detail.newData);
        }
        displaya(e.detail.newData);
    }

    async function updateTranslationCache(key: string, data: string) {
        await writeLLMCacheEntry(key, data);
        editTranslationText = data;
        chatBodyRevision += 1;
    }

    async function getTranslationPartialEditContext() {
        if (storedPath) {
            // The stored translation as shown; its edit session is captured now (the chat, the
            // message, the source hash, and the translation), so the save lands on what was edited.
            const edit =
                storedShown && !storedPending && displayedChat && messageId
                    ? beginStoredTranslationEdit(displayedChat, messageId)
                    : null;
            if (!edit) {
                return null;
            }
            const key = `stored:${++storedPartialEditSeq}`;
            storedPartialEdits.clear();
            storedPartialEdits.set(key, edit);
            return { key, data: edit.base.text };
        }
        if (!translated || settings.memoryTranslateMedia.translatorType !== "llm") {
            return null;
        }

        const key = await getTranslationCacheKey();
        if (!key) {
            return null;
        }
        const data = await readLLMCacheEntry(key);
        if (data === null) {
            return null;
        }

        return { key, data };
    }

    function getCbsCondition() {
        try {
            const cbsConditions: CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: currentChat?.message?.[idx]?.role ?? null,
            };
            return cbsConditions;
        } catch (e) {
            return {
                firstmsg: firstMessage ?? false,
                chatRole: null,
            };
        }
    }

    /**
     * The full `LLMTranslateCache` key of this message's translation as it is translated now. The
     * editors keep it and write back to it, so an edit lands on the entry it was read from.
     */
    async function getTranslationCacheKey(): Promise<string> {
        if (settings.memoryTranslateMedia.translateBeforeHTMLFormatting) {
            return llmTranslationCacheKey(msgDisplay);
        }
        const source = !settings.memoryTranslateMedia.legacyTranslation
            ? await ParseMarkdown(msgDisplay, character, "pretranslate", idx, getCbsCondition())
            : await ParseMarkdown(msgDisplay, character, "notrim", idx, getCbsCondition());
        return llmTranslationCacheKey(source);
    }

    async function loadTranslationForEdit() {
        if (translationViewControlsDisabled) return;

        if (storedPath) {
            // Only a fresh stored translation is edited (the button is off without one).
            const edit = displayedChat && messageId ? beginStoredTranslationEdit(displayedChat, messageId) : null;
            if (!edit) return;
            editTranslationTarget = { kind: "stored", edit };
            editTranslationText = edit.base.text;
            editTranslationMode = true;
            return;
        }

        loadingTranslationEdit = true;
        try {
            const key = await getTranslationCacheKey();
            const cached = await readLLMCacheEntry(key);
            editTranslationTarget = { kind: "cache", key };
            editTranslationText = cached ?? "";
            editTranslationMode = true;
        } catch (error) {
            editTranslationTarget = null;
            throw error;
        } finally {
            loadingTranslationEdit = false;
        }
    }

    /** Closes the translation editor without writing. */
    function cancelTranslationEdit() {
        editTranslationTarget = null;
        editTranslationMode = false;
    }

    async function saveTranslationEdit() {
        const target = editTranslationTarget;
        if (target === null) return;

        if (target.kind === "stored") {
            // A refused write keeps the editor open with the draft.
            if (!saveStoredTranslationEdit(target.edit, editTranslationText)) return;
        } else {
            await updateTranslationCache(target.key, editTranslationText);
        }
        editTranslationTarget = null;
        editTranslationMode = false;
    }

    /** The display CBS pre-pass of the row (`displaya`). */
    function displayPrePass(text: string): string {
        return risuChatParserForDisplay(text, {
            // Display-only name updates do not restart the pre-pass; the next text/render
            // change still uses the current name.
            chara: untrack(() => name),
            chatID: idx,
            rmVar: true,
            visualize: true,
            cbsConditions: getCbsCondition(),
        });
    }

    /** The bilingual pairs' source side takes the same pre-pass as the translation. */
    function updateBilingualDisplay() {
        bilingualDisplay = storedBilingual
            ? { source: displayPrePass(storedBilingual.source), options: storedBilingual.options }
            : null;
    }

    function displaya(message: string) {
        msgDisplay = displayPrePass(message);
        updateBilingualDisplay();
    }

    const setStatusMessage = (message: string, timeout: number = 0) => {
        statusMessage = message;
        if (timeout === 0) return;
        setTimeout(() => {
            statusMessage = "";
        }, timeout);
    };

    let blankMessage = $derived(
        ((message === "{{none}}" || message === "{{blank}}" || message === "") && idx === -1) || isComment,
    );
    // On the stored path the stored translation goes through the normal display path in place of the text.
    let displayMessage = $derived(
        isOptimizedStreamingMessage ? rawStreamingText : storedShown && storedFresh ? storedFresh.text : message,
    );
    let renderRawStreaming = $derived(isOptimizedStreamingMessage && streamingOptimizationMode === "strong");

    function updateDisplayedMessage() {
        if (renderRawStreaming) {
            // A shown stored translation still renders while the text streams (a Continue): its
            // bilingual settings stay current.
            updateBilingualDisplay();
            return;
        }
        displaya(displayMessage);
    }

    $effect.pre(() => {
        updateDisplayedMessage();
    });

    const unsubscribers: Unsubscriber[] = [];

    onMount(() => {
        unsubscribers.push(
            ReloadGUIPointer.subscribe((v) => {
                updateDisplayedMessage();
            }),
        );
    });

    onDestroy(() => {
        unsubscribers.forEach((u) => u());
    });

    function RenderGUIHtml(html: string) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(
                risuChatParser(html ?? "", { cbsConditions: getCbsCondition() }),
                "text/html",
            );
            return doc.body;
        } catch (error) {
            const placeholder = document.createElement("div");
            return placeholder;
        }
    }

    async function handleButtonTriggerWithin(event: UIEvent) {
        const currentChar = selectedCharacter();
        if (!currentChar || currentChar.type === "group") {
            return;
        }

        const target = event.target as HTMLElement;
        const origin = target.closest("[risu-trigger], [risu-btn]");
        if (!origin) {
            return;
        }

        const triggerName = origin.getAttribute("risu-trigger");
        const triggerId = origin.getAttribute("risu-id");
        const btnEvent = origin.getAttribute("risu-btn");

        // The server runs manual triggers and Lua buttons; their changes arrive as the server's
        // records.
        const ref = currentChatRef();
        if (triggerName) {
            // `{{trigger_id}}` reads the id as the browser path left it: set once the job exists,
            // cleared 100 ms after it ends.
            const owner = {};
            try {
                const outcome = await runServerManualTrigger(currentChar, triggerName, ref, {
                    triggerId: triggerId || undefined,
                    onStart: () => {
                        serverTriggerIdOwner = owner;
                        CurrentTriggerIdStore.set(triggerId || null);
                    },
                });
                if (outcome === "started") {
                    ReloadChatPointer.update((v) => {
                        v[reloadChatKey(messageId, idx)] = (v[reloadChatKey(messageId, idx)] ?? 0) + 1;
                        return v;
                    });
                }
            } finally {
                if (triggerId && serverTriggerIdOwner === owner) {
                    setTimeout(() => {
                        if (serverTriggerIdOwner === owner) {
                            serverTriggerIdOwner = null;
                            CurrentTriggerIdStore.set(null);
                        }
                    }, 100); // Small delay to allow display mode to complete
                }
            }
            return;
        }
        if (btnEvent) {
            await runServerButton(currentChar, btnEvent, ref);
            ReloadChatPointer.update((v) => {
                v[reloadChatKey(messageId, idx)] = (v[reloadChatKey(messageId, idx)] ?? 0) + 1;
                return v;
            });
        }
    }

    let isBookmarked = $derived(messageId !== undefined && (currentChat?.bookmarks?.includes(messageId) ?? false));

    async function toggleBookmark() {
        const target = messageTarget();
        const chat = target ? findChat(target.ref) : undefined;
        const current = chat?.message.find((entry) => entry.chatId === target?.id);
        if (!target || !chat || !current) return;

        const bookmarkedId = target.id;
        const messageContent = current.data;
        const bookmarks = [...(chat.bookmarks ?? [])];
        const bookmarkNames = { ...(chat.bookmarkNames ?? {}) };

        const bookmarkIndex = bookmarks.indexOf(bookmarkedId);

        if (bookmarkIndex > -1) {
            bookmarks.splice(bookmarkIndex, 1);
            delete bookmarkNames[bookmarkedId];
        } else {
            bookmarks.push(bookmarkedId);

            const msgSender = current.role === "user" ? getUserName() : name;
            const newName = await alertInput(language.bookmarkAskNameOrDefault, [], bookmarkNames[bookmarkedId] || "");

            if (newName && newName.trim() !== "") {
                bookmarkNames[bookmarkedId] = newName;
            } else {
                let defaultName;

                const blacklist = [
                    "!",
                    "@",
                    "#",
                    "$",
                    "%",
                    "^",
                    "&",
                    "*",
                    "(",
                    ")",
                    "_",
                    "+",
                    "-",
                    "=",
                    "[",
                    "]",
                    "{",
                    "}",
                    "|",
                    ";",
                    ":",
                    '"',
                    "'",
                    ",",
                    ".",
                    "<",
                    ">",
                    "/",
                    "?",
                ];
                let lines = messageContent.split("\n");
                lines = lines.splice(Math.floor(lines.length * 0.5));
                for (const line of lines) {
                    if (line && !blacklist.some((char) => line.startsWith(char))) {
                        defaultName = line.trim().slice(0, 50) + "...";
                        break;
                    }
                }
                if (!defaultName) {
                    defaultName = messageContent.slice(0, 50) + "...";
                }
                bookmarkNames[bookmarkedId] = msgSender + "| " + defaultName;
            }
        }

        setChatMeta(target.ref, { bookmarks, bookmarkNames });
    }
</script>

{#snippet genInfo()}
    <div class="flex flex-col items-end">
        {#if messageGenerationInfo && (settings.ui.requestInfoInsideChat || aiLawApplies())}
            <button
                class="text-sm p-1 text-textcolor2 border-darkborderc float-end mr-2 my-1
                    hover:ring-darkbutton hover:ring-3 rounded-md hover:text-textcolor transition-all flex justify-center items-center"
                onclick={() => {
                    const currentGenerationInfo =
                        idx >= 0 ? currentChat?.message[idx]?.generationInfo : messageGenerationInfo;

                    // The dialog keeps its own copy of the message: it may wait behind another dialog.
                    const message = idx >= 0 ? currentChat?.message[idx] : undefined;
                    alertRequestData({
                        genInfo: currentGenerationInfo,
                        idx: idx,
                        message: message ? $state.snapshot(message) : undefined,
                    });
                }}
            >
                <BotIcon size={20} />
                <span class="ml-1">
                    {capitalize(getModelInfo(messageGenerationInfo.model).shortName)}
                </span>
            </button>
        {/if}
        <!-- An open translation editor keeps its Save and Cancel whatever the settings do meanwhile (it writes to its captured target). -->
        {#if editTranslationMode || (settings.memoryTranslateMedia.translatorType === "llm" && (storedPath ? storedWanted : translated))}
            {#if editTranslationMode}
                <button
                    class="text-sm p-1 text-textcolor2 border-darkborderc float-end mr-2 my-1 rounded-md transition-all flex justify-center items-center hover:ring-darkbutton hover:ring-3 hover:text-textcolor"
                    onclick={cancelTranslationEdit}
                >
                    <XIcon size={20} />
                    <span class="ml-1">
                        {language.cancel}
                    </span>
                </button>
            {/if}
            <button
                class={"text-sm p-1 text-textcolor2 border-darkborderc float-end mr-2 my-1 rounded-md transition-all flex justify-center items-center " +
                    (translationViewControlsDisabled || (storedPath && storedPending)
                        ? "opacity-50 cursor-not-allowed"
                        : "hover:ring-darkbutton hover:ring-3 hover:text-textcolor")}
                disabled={translationViewControlsDisabled || (storedPath && storedPending)}
                onclick={requestRetranslation}
            >
                <RefreshCcwIcon size={20} />
                <span class="ml-1">
                    {language.retranslate}
                </span>
            </button>
            <button
                class={"text-sm p-1 border-darkborderc float-end mr-2 my-1 rounded-md transition-all flex justify-center items-center " +
                    (editTranslationMode
                        ? "text-blue-400 hover:ring-darkbutton hover:ring-3 hover:text-textcolor"
                        : translationEditControlDisabled
                          ? "text-textcolor2 opacity-50 cursor-not-allowed"
                          : "text-textcolor2 hover:ring-darkbutton hover:ring-3 hover:text-textcolor")}
                disabled={translationEditControlDisabled}
                onclick={() => {
                    if (editTranslationMode) {
                        saveTranslationEdit();
                    } else {
                        loadTranslationForEdit();
                    }
                }}
            >
                <PencilIcon size={20} />
                <span class="ml-1">
                    {editTranslationMode ? language.editTranslationSave : language.editTranslation}
                </span>
            </button>
        {/if}
    </div>
{/snippet}

{#snippet textBox()}
    {#if editTranslationMode}
        <AutoresizeArea
            bind:value={editTranslationText}
            handleLongPress={() => {
                saveTranslationEdit();
            }}
        />
    {/if}
    {#if editMode}
        <AutoresizeArea
            bind:value={draft}
            handleLongPress={() => {
                editMode = false;
            }}
        />
    {:else if isComment}
        <div class="w-full flex justify-center text-textcolor2 italic mb-12">
            {#if msgDisplay.startsWith("{{specialcomment")}
                {@const parts = msgDisplay.split("::")}
                {@const type = parts[1]}

                {#if type === "branchedfrom"}
                    <button
                        class="text-blue-500 hover:underline"
                        onclick={() => {
                            console.log(parts);
                            changeChatTo(parts[2] ?? "");
                            foldChatToMessage(parts[4]);
                        }}
                    >
                        <GitBranch size={20} class="inline-block mr-1" />
                        {language.branchedText.replace("{}", parts[3] ?? "")}
                    </button>
                {/if}
            {:else}
                {msgDisplay}
            {/if}
        </div>
    {:else if blankMessage}
        <div class="w-full flex justify-center text-textcolor2 italic mb-12">
            {language.noMessage}
        </div>
    {:else}
        {@const chatReloadPointer = $ReloadGUIPointer + ($ReloadChatPointer[reloadChatKey(messageId, idx)] ?? 0)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span
            class="text chat-width chattext prose minw-0"
            class:hidden={editTranslationMode}
            class:prose-invert={$ColorSchemeTypeStore}
            bind:this={bodyRoot}
            onclick={() => {
                if (settings.ui.clickToEdit && idx > -1 && !isOptimizedStreamingMessage) {
                    startOriginalEdit();
                }
            }}
            style:font-size="{0.875 * (settings.ui.zoomsize / 100)}rem"
            style:line-height="{(settings.ui.lineHeight ?? 1.25) * (settings.ui.zoomsize / 100)}rem"
        >
            {#key chatReloadPointer}
                <ChatBody
                    bind:this={parsedBody}
                    {character}
                    {firstMessage}
                    {idx}
                    {msgDisplay}
                    {name}
                    {bodyRoot}
                    renderRevision={chatBodyRevision}
                    modelShortName={messageGenerationInfo ? getModelInfo(messageGenerationInfo?.model).shortName : ""}
                    role={role ?? null}
                    bind:translated
                    bind:translating
                    bind:retranslate
                    {renderRawStreaming}
                    {rawStreamingText}
                    {storedPath}
                    autoTranslate={chatAutoShow}
                    storedTranslationShown={storedShown}
                    storedPending={storedPending && storedWanted}
                    bilingual={bilingualDisplay}
                />
            {/key}
        </span>
        {#if idx >= 0 && !editMode && !editTranslationMode && !isOptimizedStreamingMessage && !locked && partialEditEnabled && storedBilingual === null && (settings.ui.enableBlockPartialEdit || settings.ui.enableDragPartialEdit)}
            <PartialEditController
                messageData={message}
                chatIndex={idx}
                {bodyRoot}
                blockEditEnabled={settings.ui.enableBlockPartialEdit}
                dragEditEnabled={settings.ui.enableDragPartialEdit}
                translatedView={storedPath ? storedShown : translated}
                getTranslationEditContext={getTranslationPartialEditContext}
                saveTranslation={savePartialTranslation}
                on:save={handlePartialEditSave}
            />
        {/if}
    {/if}
{/snippet}

{#snippet iconButtons(options: { applyTextColors?: boolean } = {})}
    <div class="grow flex items-center justify-end" class:text-textcolor2={options?.applyTextColors !== false}>
        {#if isComment}
            <button
                class="flex items-center hover:text-blue-500 transition-colors button-icon-remove"
                onclick={async (e) => {
                    await rm(e, true);
                }}
            >
                <TrashIcon size={20} />
            </button>
        {:else}
            <span class="text-xs">{statusMessage}</span>
            <div class="flex items-center ml-2 gap-2">
                {@render translationButton()}
                {#if window.innerWidth >= 640}
                    {@render majorIconButtonsBody(false)}
                    {#if currentCharacter}
                        <PopupButton>
                            {@render minorIconButtonsBody(true)}
                        </PopupButton>
                    {/if}
                {:else}
                    {#if currentCharacter}
                        <PopupButton>
                            {@render majorIconButtonsBody(true)}
                            {@render minorIconButtonsBody(true)}
                        </PopupButton>
                    {:else}
                        {@render majorIconButtonsBody(false)}
                    {/if}
                {/if}
                {@render rerolls()}
            </div>
        {/if}
    </div>
{/snippet}

{#snippet majorIconButtonsBody(showNames: boolean)}
    {#if settings.ui.useChatCopy && !blankMessage}
        <button
            class="flex items-center hover:text-blue-500 transition-colors button-icon-copy"
            onclick={async () => {
                // The persona this message's chat shows, read before the awaits below (the selected
                // chat can change meanwhile).
                const copyChat = displayedChat;
                const copyUserName = getUserName(copyChat);
                const copyUserIcon = getUserIcon(copyChat);
                const copyText = renderRawStreaming ? displayPrePass(rawStreamingText) : msgDisplay;
                if (window.navigator.clipboard.write) {
                    try {
                        alertWait(language.loading);
                        const root = document.querySelector(":root") as HTMLElement;

                        const parser = new DOMParser();
                        const doc = parser.parseFromString(
                            await ParseMarkdown(copyText, selectedCharacter(), "normal", idx, getCbsCondition()),
                            "text/html",
                        );

                        doc.querySelectorAll("mark").forEach((el) => {
                            const d = el.getAttribute("risu-mark");
                            if (d === "quote1" || d === "quote2") {
                                const newEle = document.createElement("div");
                                newEle.textContent = el.textContent;
                                newEle.setAttribute(
                                    "style",
                                    `background: transparent; color: ${root.style.getPropertyValue(
                                        "--FontColorQuote" + d.slice(-1),
                                    )};`,
                                );
                                el.replaceWith(newEle);
                                return;
                            }
                        });
                        doc.querySelectorAll("p").forEach((el) => {
                            el.setAttribute("style", `color: ${root.style.getPropertyValue("--FontColorStandard")};`);
                        });
                        doc.querySelectorAll("em").forEach((el) => {
                            el.setAttribute(
                                "style",
                                `font-style: italic; color: ${root.style.getPropertyValue("--FontColorItalic")};`,
                            );
                        });
                        doc.querySelectorAll("strong").forEach((el) => {
                            el.setAttribute(
                                "style",
                                `font-weight: bold; color: ${root.style.getPropertyValue("--FontColorBold")};`,
                            );
                        });
                        doc.querySelectorAll("em strong").forEach((el) => {
                            el.setAttribute(
                                "style",
                                `font-weight: bold; font-style: italic; color: ${root.style.getPropertyValue("--FontColorItalicBold")};`,
                            );
                        });
                        doc.querySelectorAll("strong em").forEach((el) => {
                            el.setAttribute(
                                "style",
                                `font-weight: bold; font-style: italic; color: ${root.style.getPropertyValue("--FontColorItalicBold")};`,
                            );
                        });

                        const imgs = doc.querySelectorAll("img");
                        for (const img of imgs) {
                            img.setAttribute("alt", "from Risuai");
                            const url = img.getAttribute("src");

                            img.setAttribute(
                                "style",
                                `
                        max-width: 100%;
                        margin: 10px 0;
                        border-radius: 8px;
                        box-shadow: rgba(0,0,0,0.1) 0px 2px 8px;
                        display: block;
                        margin-left: auto;
                        margin-right: auto;
                    `,
                            );

                            if (
                                url &&
                                (url.startsWith("http://asset.localhost") ||
                                    url.startsWith("https://asset.localhost") ||
                                    url.startsWith("https://sv.risuai") ||
                                    url.startsWith("data:") ||
                                    url.startsWith("blob:") ||
                                    url.startsWith("http") ||
                                    url.startsWith("/"))
                            ) {
                                try {
                                    let fetchUrl = url;
                                    if (url.startsWith("/")) {
                                        fetchUrl = window.location.origin + url;
                                    }

                                    const data = await fetch(fetchUrl);
                                    if (data.ok) {
                                        const canvas = document.createElement("canvas");
                                        const ctx = canvas.getContext("2d");
                                        const imgElement = new Image();
                                        imgElement.crossOrigin = "anonymous";
                                        imgElement.src = await data.blob().then(
                                            (b) =>
                                                new Promise((resolve, reject) => {
                                                    const reader = new FileReader();
                                                    reader.onload = () => resolve(reader.result as string);
                                                    reader.onerror = reject;
                                                    reader.readAsDataURL(b);
                                                }),
                                        );
                                        await new Promise((resolve) => {
                                            imgElement.onload = resolve;
                                        });
                                        canvas.width = imgElement.width;
                                        canvas.height = imgElement.height;
                                        ctx.drawImage(imgElement, 0, 0);
                                        const dataURL = canvas.toDataURL("image/jpeg", 0.6);
                                        img.setAttribute("src", dataURL);
                                    }
                                } catch (error) {
                                    console.error("Image error:", error);
                                }
                            }
                        }

                        let iconDataUrl = "";
                        let hasValidImage = false;

                        try {
                            const iconImage = (await getFileSrc(currentCharacter.image ?? "")) ?? "";

                            if (
                                iconImage &&
                                (iconImage.startsWith("http://asset.localhost") ||
                                    iconImage.startsWith("https://asset.localhost") ||
                                    iconImage.startsWith("https://sv.risuai") ||
                                    iconImage.startsWith("data:") ||
                                    iconImage.startsWith("blob:") ||
                                    iconImage.startsWith("http") ||
                                    iconImage.startsWith("/"))
                            ) {
                                if (iconImage.startsWith("data:")) {
                                    iconDataUrl = iconImage;
                                    hasValidImage = true;
                                } else {
                                    const data = await fetch(iconImage);
                                    if (data.ok) {
                                        const canvas = document.createElement("canvas");
                                        const ctx = canvas.getContext("2d");
                                        const img = new Image();
                                        img.crossOrigin = "anonymous";
                                        img.src = await data.blob().then(
                                            (b) =>
                                                new Promise((resolve, reject) => {
                                                    const reader = new FileReader();
                                                    reader.onload = () => resolve(reader.result as string);
                                                    reader.onerror = reject;
                                                    reader.readAsDataURL(b);
                                                }),
                                        );
                                        await new Promise((resolve, reject) => {
                                            img.onload = () => {
                                                canvas.width = img.width;
                                                canvas.height = img.height;
                                                ctx.drawImage(img, 0, 0);
                                                iconDataUrl = canvas.toDataURL("image/jpeg", 0.9);
                                                hasValidImage = true;
                                                resolve(true);
                                            };
                                            img.onerror = () => {
                                                hasValidImage = false;
                                                resolve(false);
                                            };
                                        });
                                    }
                                }
                            }
                        } catch (error) {
                            console.error("Icon error:", error);
                            hasValidImage = false;
                        }

                        const isUserMessage = role === "user";
                        const displayName = isUserMessage ? copyUserName : name;
                        const modelInfo = messageGenerationInfo
                            ? capitalize(getModelInfo(messageGenerationInfo.model).shortName)
                            : isUserMessage
                              ? "User"
                              : "AI";

                        let finalIconDataUrl = iconDataUrl;
                        let finalHasValidImage = hasValidImage;

                        if (isUserMessage) {
                            finalHasValidImage = false;
                            const userIcon = copyUserIcon;
                            if (userIcon) {
                                try {
                                    const userIconSrc = await getFileSrc(userIcon);
                                    if (
                                        userIconSrc &&
                                        (userIconSrc.startsWith("http://asset.localhost") ||
                                            userIconSrc.startsWith("https://asset.localhost") ||
                                            userIconSrc.startsWith("https://sv.risuai") ||
                                            userIconSrc.startsWith("data:") ||
                                            userIconSrc.startsWith("blob:") ||
                                            userIconSrc.startsWith("http") ||
                                            userIconSrc.startsWith("/"))
                                    ) {
                                        if (userIconSrc.startsWith("data:")) {
                                            finalIconDataUrl = userIconSrc;
                                            finalHasValidImage = true;
                                        } else {
                                            const data = await fetch(userIconSrc);
                                            if (data.ok) {
                                                const canvas = document.createElement("canvas");
                                                const ctx = canvas.getContext("2d");
                                                const img = new Image();
                                                img.crossOrigin = "anonymous";
                                                img.src = await data.blob().then(
                                                    (b) =>
                                                        new Promise((resolve, reject) => {
                                                            const reader = new FileReader();
                                                            reader.onload = () => resolve(reader.result as string);
                                                            reader.onerror = reject;
                                                            reader.readAsDataURL(b);
                                                        }),
                                                );
                                                await new Promise((resolve, reject) => {
                                                    img.onload = () => {
                                                        canvas.width = img.width;
                                                        canvas.height = img.height;
                                                        ctx.drawImage(img, 0, 0);
                                                        finalIconDataUrl = canvas.toDataURL("image/jpeg", 0.9);
                                                        finalHasValidImage = true;
                                                        resolve(true);
                                                    };
                                                    img.onerror = () => {
                                                        finalHasValidImage = false;
                                                        resolve(false);
                                                    };
                                                });
                                            }
                                        }
                                    }
                                } catch (error) {
                                    console.error("User icon error:", error);
                                    finalHasValidImage = false;
                                }
                            }
                        }

                        const html = `<div style="font-family: 'Segoe UI', Roboto, Arial, sans-serif; color: ${root.style.getPropertyValue("--risu-theme-textcolor")}; line-height: 1.6; max-width: 600px; margin: 1rem auto; background: ${root.style.getPropertyValue("--risu-theme-bgcolor")}; border-radius: 12px; box-shadow: 0px 4px 12px rgba(0,0,0,0.15); overflow: hidden;">
<div style="padding: 20px;">
<div style="display: flex; flex-direction: column; align-items: center; margin-bottom: 1rem; text-align: center;">
    ${finalHasValidImage ? `<img style="width: 80px; height: 80px; border-radius: 50%; border: 3px solid ${root.style.getPropertyValue("--risu-theme-darkborderc")}; margin-bottom: 0.75rem; object-fit: cover;" src="${finalIconDataUrl}" alt="profile">` : ""}
    <h3 style="color: ${root.style.getPropertyValue("--risu-theme-textcolor")}; font-weight: 600; font-size: 1.5rem; margin: 0 0 0.5rem 0;">${displayName}</h3>
    ${!isUserMessage ? `<span style="display: inline-block; border-radius: 16px; font-size: 0.8rem; padding: 0.25rem 0.75rem; background: ${root.style.getPropertyValue("--risu-theme-darkbg")}; color: ${root.style.getPropertyValue("--risu-theme-textcolor")}; border: 1px solid ${root.style.getPropertyValue("--risu-theme-darkborderc")};">${modelInfo}</span>` : ""}
</div>
<div style="border-top: 1px solid ${root.style.getPropertyValue("--risu-theme-darkborderc")}; padding-top: 1rem;">
    ${doc.body.innerHTML}
</div>
<div style="text-align: center; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid ${root.style.getPropertyValue("--risu-theme-darkborderc")};">
    <span style="font-size: 0.75rem; color: ${root.style.getPropertyValue("--risu-theme-textcolor2")}; opacity: 0.7;">From Risuai</span>
</div>
</div>
</div>`;

                        await window.navigator.clipboard.write([
                            new ClipboardItem({
                                "text/plain": new Blob([copyText], { type: "text/plain" }),
                                "text/html": new Blob([html], { type: "text/html" }),
                            }),
                        ]);
                        alertNormal(language.copied);
                        return;
                    } catch (e) {
                        alertClear();
                        window.navigator.clipboard.writeText(copyText).then(() => {
                            setStatusMessage(language.copied);
                        });
                    }
                }
                window.navigator.clipboard.writeText(copyText).then(() => {
                    setStatusMessage(language.copied);
                });
            }}
        >
            <CopyIcon size={20} />
            {#if showNames}
                <span class="ml-1">{language.copy}</span>
            {/if}
        </button>
    {/if}
    {#if idx > -1}
        {#if currentCharacter.type !== "group" && currentCharacter.ttsMode !== "none" && currentCharacter.ttsMode}
            <button
                class="flex items-center hover:text-blue-500 transition-colors button-icon-tts"
                onclick={() => {
                    return sayTTS(null, isOptimizedStreamingMessage ? rawStreamingText : message);
                }}
            >
                <Volume2Icon size={20} />
                {#if showNames}
                    <span class="ml-1">TTS</span>
                {/if}
            </button>
        {/if}
        <button
            class={"flex items-center transition-colors button-icon-remove " +
                (locked ? "opacity-50 cursor-not-allowed" : "hover:text-blue-500")}
            disabled={locked}
            onclick={(e) => rm(e, false)}
            use:longpress={(e) => rm(e, true)}
        >
            <TrashIcon size={20} />

            {#if showNames}
                <span class="ml-1">{language.remove}</span>
            {/if}
        </button>
    {/if}
{/snippet}

{#snippet translationButton(showNames = false)}
    {#if settings.memoryTranslateMedia.translator !== "" && !blankMessage && !isOptimizedStreamingMessage}
        <button
            class={"flex items-center transition-colors button-icon-translate " +
                (translationViewControlsDisabled
                    ? "opacity-50 cursor-not-allowed"
                    : "cursor-pointer hover:text-blue-500") +
                (translationViewOn ? " text-blue-400" : "")}
            class:translating={storedPath ? storedPending : translating}
            disabled={translationViewControlsDisabled}
            onclick={toggleTranslation}
        >
            <LanguagesIcon />
            {#if showNames}
                <span class="ml-1">{language.translate}</span>
            {/if}
        </button>
    {/if}
    {#if idx > -1 && !isOptimizedStreamingMessage}
        <button
            class={"flex items-center transition-colors button-icon-edit " +
                (editMode
                    ? "text-blue-400 hover:text-blue-500"
                    : originalEditControlDisabled
                      ? "opacity-50 cursor-not-allowed"
                      : "hover:text-blue-500")}
            disabled={originalEditControlDisabled}
            onclick={toggleOriginalEdit}
        >
            <PencilIcon size={20} />

            {#if showNames}
                <span class="ml-1">{language.edit}</span>
            {/if}
        </button>
    {/if}
{/snippet}

{#snippet rerolls()}
    {#if rerollIcon || altGreeting}
        {#if settings.ui.swipe || altGreeting}
            <button
                class="flex items-center hover:text-blue-500 transition-colors button-icon-unreroll"
                class:dyna-icon={rerollIcon === "dynamic"}
                class:opacity-50={locked}
                disabled={locked}
                onclick={unReroll}
            >
                <ArrowLeft size={22} />
            </button>
            {#if firstMessage && settings.ui.swipe && settings.ui.showFirstMessagePages}
                <span class="flex items-center text-xs text-textcolor2">{currentPage}/{totalPages}</span>
            {/if}
            <button
                class="flex items-center hover:text-blue-500 transition-colors button-icon-reroll"
                class:dyna-icon={rerollIcon === "dynamic"}
                class:opacity-50={locked}
                disabled={locked}
                onclick={onReroll}
            >
                <ArrowRight size={22} />
            </button>
        {:else}
            <button
                class="flex items-center hover:text-blue-500 transition-colors button-icon-reroll"
                class:dyna-icon={rerollIcon === "dynamic"}
                class:opacity-50={locked}
                disabled={locked}
                onclick={onReroll}
            >
                <RefreshCcwIcon size={20} />
            </button>
        {/if}
    {/if}
{/snippet}

{#snippet minorIconButtonsBody(showNames: boolean)}
    {#if messageId}
        <!-- The server transform keeps a message as first rendered: this renders it again, bypassing the cache. -->
        <button
            class="flex items-center hover:text-blue-500 transition-colors button-icon-rerender"
            title={language.rerender}
            onclick={() => {
                const target = messageTarget();
                if (!target) {
                    return;
                }
                rerenderMessage(target.ref, target.id);
                ReloadChatPointer.update((v) => {
                    v[reloadChatKey(messageId, idx)] = (v[reloadChatKey(messageId, idx)] ?? 0) + 1;
                    return v;
                });
            }}
        >
            <RotateCwIcon size={20} />
            {#if showNames}
                <span class="ml-1">{language.rerender}</span>
            {/if}
        </button>
    {/if}
    {#if settings.ui.enableBookmark}
        <button
            class="flex items-center hover:text-blue-500 transition-colors button-icon-bookmark {isBookmarked
                ? 'text-yellow-400'
                : ''}"
            onclick={async () => {
                await sleep(1);
                toggleBookmark();
            }}
        >
            <BookmarkIcon size={20} />
            {#if showNames}
                <span class="ml-1">{language.bookmark}</span>
            {/if}
        </button>
    {/if}

    <button
        class="flex items-center hover:text-blue-500 transition-colors"
        onclick={async () => {
            const target = messageTarget();
            // Captured with the target: its owner (a replacement of the character's chats meanwhile
            // gets no branch) and its selection (a newer selection in that character is kept).
            const ownerToken = target ? chatOwnerToken(target.ref.chaId) : null;
            const selectedVersion = target ? chatSelectionVersion(target.ref.chaId) : 0;
            await sleep(1);
            // Loaded again: the captured chat (it may no longer be the selected one after the wait).
            const currentChat = target ? await ensureChatLoaded(target.ref) : undefined;
            const branchIndex = currentChat?.message.findIndex((entry) => entry.chatId === target?.id) ?? -1;
            // The chat's own character (by id), not whatever is selected after the wait.
            const owner = target ? characterList().find((entry) => entry?.chaId === target.ref.chaId) : undefined;
            if (
                !target ||
                !currentChat ||
                !owner ||
                chatOwnerToken(target.ref.chaId) !== ownerToken ||
                branchIndex === -1
            ) {
                return;
            }

            if (settings.ui.createFolderOnBranch && chatFolderOf(currentChat, owner.chatFolders) == null) {
                const folderId = v4();
                owner.chatFolders ??= [];
                owner.chatFolders.unshift({
                    id: folderId,
                    name: `Branches of ${currentChat.name}`,
                    folded: false,
                });
                setChatMeta(target.ref, { folderId });
            }

            const currentMessage = currentChat.message[branchIndex];
            const source = $state.snapshot(currentChat);
            const branchComment: Message = {
                role: "char",
                data:
                    "{{specialcomment::branchedfrom::" +
                    currentChat.id +
                    "::" +
                    currentChat.name +
                    "::" +
                    currentMessage.chatId +
                    "::}}",
                isComment: true,
                disabled: true,
                chatId: v4(),
            };
            const newChat = {
                ...source,
                name: createChatCopyName(source.name, "Branch", target.ref.chaId),
                id: v4(),
                message: [...source.message.slice(0, branchIndex + 1), branchComment],
            };
            delete newChat.pinned;

            // Selected by id in its own character (the selection of another character is not changed),
            // unless that character's selection changed while the branch was made.
            createChat(target.ref.chaId, newChat, {
                index: 0,
                select: chatSelectionVersion(target.ref.chaId) === selectedVersion,
            });
        }}
    >
        <SplitIcon size={20} />
        {#if showNames}
            <span class="ml-1">{language.branch}</span>
        {/if}
    </button>

    <button
        class="flex items-center hover:text-blue-500 transition-colors"
        class:opacity-50={locked}
        disabled={locked}
        onclick={async () => {
            const target = messageTarget();
            await sleep(1);
            const currentMessage = target
                ? (await ensureChatLoaded(target.ref))?.message.find((entry) => entry.chatId === target.id)
                : undefined;
            if (target && currentMessage && !refuseLocked(target.ref, [target.id])) {
                patchMessage(target.ref, target.id, { disabled: !currentMessage.disabled });
            }
        }}
    >
        <PowerOff size={20} />
        {#if showNames}
            <span class="ml-1">{language.disableMessage}</span>
        {/if}
    </button>

    <button
        class="flex items-center hover:text-blue-500 transition-colors"
        class:opacity-50={locked}
        disabled={locked}
        onclick={async () => {
            const target = messageTarget();
            await sleep(1);
            const currentMessage = target
                ? (await ensureChatLoaded(target.ref))?.message.find((entry) => entry.chatId === target.id)
                : undefined;
            if (target && currentMessage && !refuseLocked(target.ref, [target.id])) {
                patchMessage(target.ref, target.id, {
                    disabled: currentMessage.disabled === "allBefore" ? false : "allBefore",
                });
            }
        }}
    >
        <Scissors size={20} />
        {#if showNames}
            <span class="ml-1">{language.disableAbove}</span>
        {/if}
    </button>
{/snippet}

{#snippet senderIcon(options: { rounded?: boolean; styleFix?: string } = {})}
    {#if !blankMessage && !$HideIconStore}
        {#if currentCharacter?.chaId === "§playground"}
            <div
                class="shadow-lg border-textcolor2 border flex justify-center items-center text-textcolor2"
                style={options?.styleFix ??
                    `height:${(settings.ui.iconsize * 3.5) / 100}rem;width:${(settings.ui.iconsize * 3.5) / 100}rem;min-width:${(settings.ui.iconsize * 3.5) / 100}rem`}
                class:rounded-md={options?.rounded}
                class:rounded-full={options?.rounded}
            >
                {#if name === "assistant"}
                    <BotIcon />
                {:else}
                    <UserIcon />
                {/if}
            </div>
        {:else}
            {#await img}
                <div
                    class="shadow-lg bg-textcolor2"
                    style={options?.styleFix ??
                        `height:${(settings.ui.iconsize * 3.5) / 100}rem;width:${(settings.ui.iconsize * 3.5) / 100}rem;min-width:${(settings.ui.iconsize * 3.5) / 100}rem`}
                    class:rounded-md={!options?.rounded}
                    class:rounded-full={options?.rounded}
                ></div>
            {:then m}
                {#if largePortrait && !options?.rounded}
                    <div
                        class="shadow-lg bg-textcolor2"
                        style={m +
                            (options?.styleFix ??
                                `height:${(settings.ui.iconsize * 3.5) / 100 / 0.75}rem;width:${(settings.ui.iconsize * 3.5) / 100}rem;min-width:${(settings.ui.iconsize * 3.5) / 100}rem`)}
                        class:rounded-md={!options?.rounded}
                        class:rounded-full={options?.rounded}
                    ></div>
                {:else}
                    <div
                        class="shadow-lg bg-textcolor2"
                        style={m +
                            (options?.styleFix ??
                                `height:${(settings.ui.iconsize * 3.5) / 100}rem;width:${(settings.ui.iconsize * 3.5) / 100}rem;min-width:${(settings.ui.iconsize * 3.5) / 100}rem`)}
                        class:rounded-md={!options?.rounded}
                        class:rounded-full={options?.rounded}
                    ></div>
                {/if}
            {/await}
        {/if}
    {/if}
{/snippet}

{#snippet renderGuiHtmlPart(dom: HTMLElement)}
    {#if dom.tagName === "IMG"}
        <img class={dom.getAttribute("class") ?? ""} alt="" style={dom.getAttribute("style") ?? ""} />
    {:else if dom.tagName === "A"}
        <a
            target="_blank"
            rel="noreferrer"
            href={dom.getAttribute("href") && dom.getAttribute("href").startsWith("https")
                ? dom.getAttribute("href")
                : ""}
            class={dom.getAttribute("class") ?? ""}
            style={dom.getAttribute("style") ?? ""}
        >
            {@render renderChilds(dom)}
        </a>
    {:else if dom.tagName === "SPAN"}
        <span class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </span>
    {:else if dom.tagName === "DIV"}
        <div class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </div>
    {:else if dom.tagName === "P"}
        <p class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </p>
    {:else if dom.tagName === "H1"}
        <h1 class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </h1>
    {:else if dom.tagName === "H2"}
        <h2 class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </h2>
    {:else if dom.tagName === "H3"}
        <h3 class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </h3>
    {:else if dom.tagName === "H4"}
        <h4 class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </h4>
    {:else if dom.tagName === "H5"}
        <h5 class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </h5>
    {:else if dom.tagName === "H6"}
        <h6 class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </h6>
    {:else if dom.tagName === "UL"}
        <ul class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </ul>
    {:else if dom.tagName === "OL"}
        <ol class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </ol>
    {:else if dom.tagName === "LI"}
        <li class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </li>
    {:else if dom.tagName === "TABLE"}
        <table class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </table>
    {:else if dom.tagName === "TR"}
        <tr class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </tr>
    {:else if dom.tagName === "TD"}
        <td class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </td>
    {:else if dom.tagName === "TH"}
        <th class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </th>
    {:else if dom.tagName === "HR"}
        <hr class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""} />
    {:else if dom.tagName === "BR"}
        <br class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""} />
    {:else if dom.tagName === "CODE"}
        <code class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </code>
    {:else if dom.tagName === "PRE"}
        <pre class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </pre>
    {:else if dom.tagName === "BLOCKQUOTE"}
        <blockquote class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </blockquote>
    {:else if dom.tagName === "EM"}
        <em class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </em>
    {:else if dom.tagName === "STRONG"}
        <strong class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </strong>
    {:else if dom.tagName === "U"}
        <u class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </u>
    {:else if dom.tagName === "DEL"}
        <del class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </del>
    {:else if dom.tagName === "BUTTON"}
        <button class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </button>
    {:else if dom.tagName === "RISUTEXTBOX"}
        {@render textBox()}
    {:else if dom.tagName === "RISUICON"}
        {@render senderIcon()}
    {:else if dom.tagName === "RISUBUTTONS"}
        {@render iconButtons()}
    {:else if dom.tagName === "RISUGENINFO"}
        {@render genInfo()}
    {:else if dom.tagName === "STYLE"}
        <svelte:element this={"style"}>
            {dom.innerHTML}
        </svelte:element>
    {:else}
        <div class={dom.getAttribute("class") ?? ""} style={dom.getAttribute("style") ?? ""}>
            {@render renderChilds(dom)}
        </div>
    {/if}
{/snippet}

{#snippet renderChilds(dom: HTMLElement)}
    {#each dom.childNodes as node}
        {#if node.nodeType === Node.TEXT_NODE}
            {node.textContent}
        {:else if node.nodeType === Node.ELEMENT_NODE}
            {@render renderGuiHtmlPart(node as HTMLElement)}
        {/if}
    {/each}
{/snippet}

{#if disabled === true}
    <div class="w-full border-t-2 border-dashed border-blue-500"></div>
{/if}
<div
    class="flex max-w-full justify-center risu-chat"
    class:chat-row-pending={pendingReveal}
    data-chat-index={idx}
    data-chat-id={currentChat?.message?.[idx]?.chatId ?? ""}
    style={isLastMemory ? `border-top:${settings.ui.memoryLimitThickness}px solid rgba(98, 114, 164, 0.7);` : ""}
    onclickcapture={handleButtonTriggerWithin}
>
    <div
        class="text-textcolor mt-1 ml-4 mr-4 mb-1 p-2 bg-transparent grow border-t-gray-900 border-opacity/30 border-transparent flexium items-start max-w-full"
    >
        {#if settings.ui.theme === "mobilechat" && !blankMessage}
            <div class={role === "user" ? "flex items-start w-full justify-end" : "flex items-start"}>
                {#if role !== "user"}
                    {@render senderIcon({ rounded: true })}
                {/if}
                <div
                    class="bg-gray-100 rounded-lg p-3 max-w-[70%] mx-2"
                    class:rounded-tl-none={role !== "user"}
                    class:rounded-tr-none={role === "user"}
                >
                    <p class="text-gray-800">{@render textBox()}</p>
                    {#if currentChat?.message?.[idx]?.time}
                        <span class="text-xs text-textcolor2 mt-1 block">
                            {new Intl.DateTimeFormat(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                                month: "2-digit",
                                day: "2-digit",
                                hour12: false,
                            }).format(currentChat.message[idx].time)}
                        </span>
                    {/if}
                </div>
                {#if role === "user"}
                    {@render senderIcon({ rounded: true })}
                {/if}
            </div>
        {:else if settings.ui.theme === "cardboard" && !blankMessage}
            <div class="w-full flex flex-col px-0 sm:px-4 py-4 relative">
                <div
                    class="bg-linear-to-b from-gray-100 to-gray-200 rounded-lg shadow-lg border-gray-400 border p-4 flex flex-col"
                >
                    <div class="flex gap-4 mt-2 flex-col sm:flex-row">
                        <div class="flex flex-col items-center">
                            <div class="sm:h-96 sm:w-72 sm:min-w-72 w-48 h-64">
                                {@render senderIcon({ rounded: false, styleFix: "height:100%;width:100%;" })}
                            </div>
                            <h2 class="text-base font-bold text-gray-500 text-center mt-2 max-w-full text-ellipsis">
                                {name}
                            </h2>
                        </div>
                        {#if editMode}
                            <textarea
                                class="grow h-138 sm:h-96 overflow-y-auto bg-transparent text-black p-2 mb-2 resize-none message-edit-area"
                                bind:value={draft}></textarea>
                        {:else}
                            <div class="grow h-138 sm:h-96 overflow-y-auto p-2 mb-2 sm:mb-0">
                                {@render textBox()}
                            </div>
                        {/if}
                    </div>
                </div>
                <div
                    class="absolute bottom-0 right-0 bg-linear-to-b from-gray-200 to-gray-300 p-2 rounded-md border border-gray-400 text-gray-400"
                >
                    {@render iconButtons({ applyTextColors: false })}
                </div>
            </div>
        {:else if settings.ui.theme === "customHTML" && !blankMessage && !$SafeModeStore}
            <!-- Safe mode (the CSS hotkey or a safe boot) shows the classic row instead of the GUI HTML. -->
            {@render renderGuiHtmlPart(RenderGUIHtml(settings.ui.guiHTML))}
        {:else}
            {@render senderIcon({ rounded: settings.ui.roundIcons })}
            <span class="flex flex-col ml-4 w-full max-w-full min-w-0 text-black">
                <div class="flexium items-center chat-width">
                    {#if currentCharacter?.chaId === "§playground" && !blankMessage && currentChat?.message?.[idx]}
                        <span class="chat-width text-xl border-darkborderc flex items-center text-textcolor">
                            <span>{currentChat.message[idx].role === "char" ? "Assistant" : "User"}</span>
                            <button
                                class="ml-2 text-textcolor2 hover:text-textcolor"
                                class:opacity-50={locked}
                                disabled={locked}
                                onclick={() => {
                                    const target = messageTarget();
                                    const current = target
                                        ? findChat(target.ref)?.message.find((entry) => entry.chatId === target.id)
                                        : undefined;
                                    if (target && current && !refuseLocked(target.ref, [target.id])) {
                                        patchMessage(target.ref, target.id, {
                                            role: current.role === "char" ? "user" : "char",
                                        });
                                    }
                                    ReloadChatPointer.update((v) => {
                                        v[reloadChatKey(messageId, idx)] = (v[reloadChatKey(messageId, idx)] ?? 0) + 1;
                                        return v;
                                    });
                                }}><ArrowLeftRightIcon size="18" /></button
                            >
                        </span>
                    {:else if !blankMessage && !$HideIconStore}
                        <div class="chat-width text-xl unmargin text-textcolor flex items-center">
                            <span>{name}</span>
                        </div>
                    {/if}
                    {@render iconButtons()}
                </div>
                {@render genInfo()}
                {@render textBox()}
            </span>
        {/if}
    </div>
</div>

{#if disabled}
    <div
        class={{
            "w-full border-t-2 border-dashed": true,
            "border-blue-500": disabled === true,
            "border-amber-500": disabled === "allBefore",
        }}
    ></div>
{/if}
