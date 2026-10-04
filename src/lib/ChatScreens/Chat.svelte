<script module lang="ts">
    /**
     * The server manual trigger whose id `CurrentTriggerIdStore` holds (Phase 5 slice 8b): only the
     * invocation that set it clears it, so a refused click or an older timer leaves a newer one alone.
     */
    let serverTriggerIdOwner: object | null = null;
</script>

<script lang="ts">
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
    import { DBState, ReloadChatPointer, CurrentTriggerIdStore, popupStore } from "src/ts/stores.svelte";
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
        type CbsConditions,
        type simpleCharacterArgument,
    } from "../../ts/parser/parser.svelte";
    import {
        getCurrentCharacter,
        type Message,
        type MessageGenerationInfo,
        type StreamingDisplayOptimizationMode,
    } from "../../ts/storage/database.svelte";
    import {
        type ChatRef,
        chatSaveVersion,
        createChat,
        currentChatRef,
        findChat,
        isMessageLocked,
        removeMessages,
        replaceMessage,
        setChatMeta,
        setMessageText,
    } from "../../ts/storage/chatStore.svelte";
    import { selectedCharID } from "../../ts/stores.svelte";
    import { HideIconStore, ReloadGUIPointer, selIdState } from "../../ts/stores.svelte";
    import AutoresizeArea from "../UI/GUI/TextAreaResizable.svelte";
    import ChatBody from "./ChatBody.svelte";
    import PopupButton from "../UI/PopupButton.svelte";
    import PartialEditController from "./PartialEditController.svelte";
    import { getLLMCache, setLLMCache } from "../../ts/translator/translator";

    let translating = $state(false);
    let editMode = $state(false);
    let statusMessage: string = $state("");
    let retranslate = $state(false);
    let editTranslationMode = $state(false);
    let loadingTranslationEdit = $state(false);
    let editTranslationText = $state("");
    let editTranslationKey: string | null = null;
    let chatBodyRevision = $state(0);
    /** Whether this message was locked when last seen (the server transform skips a locked message). */
    let wasLocked = false;
    let bodyRoot: HTMLElement | null = $state(null);
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
        totalLength?: number;
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
        totalLength = 0,
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
    }: Props = $props();

    let msgDisplay = $state("");
    let translated = $state(false);
    let partialEditEnabled = $state(true);
    let translationViewControlsDisabled = $derived(editMode || editTranslationMode || loadingTranslationEdit);
    /** The chat this message is shown in (a branched or copied chat shares its source's message ids). */
    let displayedChat = $derived.by((): ChatRef | null => {
        const character = DBState.db.characters[selIdState.selId];
        const chat = character?.chats?.[character.chatPage];
        return character && chat?.id ? { chaId: character.chaId, chatId: chat.id } : null;
    });
    /**
     * Whether this message is locked by a server generation job (its edit, delete, and regenerate are
     * off): while it streams and until the job releases it, and also a previous group speaker's reply.
     */
    let locked = $derived(isMessageLocked(displayedChat, messageId));
    let originalEditControlDisabled = $derived(editTranslationMode || loadingTranslationEdit || locked);
    let translationEditControlDisabled = $derived(editMode || loadingTranslationEdit);

    export function updateStreamingDisplay(state: {
        isOptimizedStreamingMessage: boolean;
        streamingOptimizationMode: StreamingDisplayOptimizationMode;
        rawStreamingText: string;
    }) {
        isOptimizedStreamingMessage = state.isOptimizedStreamingMessage;
        streamingOptimizationMode = state.streamingOptimizationMode;
        rawStreamingText = state.rawStreamingText;
    }

    // A row rendered before its chat's first save had no transform context (the script stage was
    // skipped): it renders again once the save lands (Phase 5 cutover).
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

        const rm = DBState.db.askRemoval ? await alertConfirm(language.removeChat) : true;
        if (rm) {
            if (DBState.db.instantRemove || rec) {
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
            setMessageText(target.ref, target.id, message);
        }
        return true;
    }

    function startOriginalEdit() {
        if (originalEditControlDisabled) return;
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
        translated = !translated;
    }

    function requestRetranslation() {
        if (translationViewControlsDisabled) return;
        retranslate = true;
    }

    async function handlePartialEditSave(
        e: CustomEvent<{ newData: string; target: "original" | "translation"; translationKey?: string }>,
    ) {
        if (idx < 0) return;

        if (e.detail.target === "translation") {
            if (!e.detail.translationKey) return;

            await updateTranslationCache(e.detail.translationKey, e.detail.newData);
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
        await setLLMCache(key, data);
        editTranslationText = data;
        chatBodyRevision += 1;
    }

    async function getTranslationPartialEditContext() {
        if (!translated || DBState.db.translatorType !== "llm") {
            return null;
        }

        const key = await getTranslationCacheKey();
        if (!key) {
            return null;
        }
        const data = await getLLMCache(key);
        if (data === null) {
            return null;
        }

        return { key, data };
    }

    function getCbsCondition() {
        try {
            const cbsConditions: CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole:
                    DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage]
                        ?.message?.[idx]?.role ?? null,
            };
            return cbsConditions;
        } catch (e) {
            return {
                firstmsg: firstMessage ?? false,
                chatRole: null,
            };
        }
    }

    async function getTranslationCacheKey(): Promise<string> {
        if (DBState.db.translateBeforeHTMLFormatting) {
            return msgDisplay;
        }
        if (!DBState.db.legacyTranslation) {
            return await ParseMarkdown(msgDisplay, character, "pretranslate", idx, getCbsCondition());
        }
        return await ParseMarkdown(msgDisplay, character, "notrim", idx, getCbsCondition());
    }

    async function loadTranslationForEdit() {
        if (translationViewControlsDisabled) return;

        loadingTranslationEdit = true;
        try {
            const key = await getTranslationCacheKey();
            const cached = await getLLMCache(key);
            editTranslationKey = key;
            editTranslationText = cached ?? "";
            editTranslationMode = true;
        } catch (error) {
            editTranslationKey = null;
            throw error;
        } finally {
            loadingTranslationEdit = false;
        }
    }

    async function saveTranslationEdit() {
        if (editTranslationKey === null) return;

        await updateTranslationCache(editTranslationKey, editTranslationText);
        editTranslationKey = null;
        editTranslationMode = false;
    }

    function displaya(message: string) {
        msgDisplay = risuChatParser(message, {
            chara: name,
            chatID: idx,
            rmVar: true,
            visualize: true,
            cbsConditions: getCbsCondition(),
        });
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
    let displayMessage = $derived(isOptimizedStreamingMessage ? rawStreamingText : message);
    let renderRawStreaming = $derived(isOptimizedStreamingMessage && streamingOptimizationMode === "strong");

    function updateDisplayedMessage() {
        if (renderRawStreaming) {
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
        const currentChar = getCurrentCharacter();
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

        // The server runs manual triggers and Lua buttons (Phase 5 slices 8a, 8b); their changes arrive
        // as the server's records.
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
                        v[idx] = (v[idx] ?? 0) + 1;
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
                v[idx] = (v[idx] ?? 0) + 1;
                return v;
            });
        }
    }

    let isBookmarked = $derived(
        messageId !== undefined &&
            (DBState.db.characters[selIdState.selId]?.chats[
                DBState.db.characters[selIdState.selId].chatPage
            ]?.bookmarks?.includes(messageId) ??
                false),
    );

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
        {#if messageGenerationInfo && (DBState.db.requestInfoInsideChat || aiLawApplies())}
            <button
                class="text-sm p-1 text-textcolor2 border-darkborderc float-end mr-2 my-1
                    hover:ring-darkbutton hover:ring-3 rounded-md hover:text-textcolor transition-all flex justify-center items-center"
                onclick={() => {
                    const currentGenerationInfo =
                        idx >= 0
                            ? DBState.db.characters[$selectedCharID].chats[
                                  DBState.db.characters[$selectedCharID].chatPage
                              ].message[idx].generationInfo
                            : messageGenerationInfo;

                    alertRequestData({
                        genInfo: currentGenerationInfo,
                        idx: idx,
                    });
                }}
            >
                <BotIcon size={20} />
                <span class="ml-1">
                    {capitalize(getModelInfo(messageGenerationInfo.model).shortName)}
                </span>
            </button>
        {/if}
        {#if DBState.db.translatorType === "llm" && translated}
            <button
                class={"text-sm p-1 text-textcolor2 border-darkborderc float-end mr-2 my-1 rounded-md transition-all flex justify-center items-center " +
                    (translationViewControlsDisabled
                        ? "opacity-50 cursor-not-allowed"
                        : "hover:ring-darkbutton hover:ring-3 hover:text-textcolor")}
                disabled={translationViewControlsDisabled}
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
            bind:value={message}
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
        {@const chatReloadPointer = $ReloadGUIPointer + ($ReloadChatPointer[idx] ?? 0)}
        {@const totalLengthPointer = idx > totalLength - 6 ? totalLength : 0}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span
            class="text chat-width chattext prose minw-0"
            class:hidden={editTranslationMode}
            class:prose-invert={$ColorSchemeTypeStore}
            bind:this={bodyRoot}
            onclick={() => {
                if (DBState.db.clickToEdit && idx > -1 && !isOptimizedStreamingMessage) {
                    startOriginalEdit();
                }
            }}
            style:font-size="{0.875 * (DBState.db.zoomsize / 100)}rem"
            style:line-height="{(DBState.db.lineHeight ?? 1.25) * (DBState.db.zoomsize / 100)}rem"
        >
            {#key `${totalLengthPointer}|${chatReloadPointer}`}
                <ChatBody
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
                />
            {/key}
        </span>
        {#if idx >= 0 && !editMode && !editTranslationMode && !isOptimizedStreamingMessage && !locked && partialEditEnabled && (DBState.db.enableBlockPartialEdit || DBState.db.enableDragPartialEdit)}
            <PartialEditController
                messageData={message}
                chatIndex={idx}
                {bodyRoot}
                blockEditEnabled={DBState.db.enableBlockPartialEdit}
                dragEditEnabled={DBState.db.enableDragPartialEdit}
                translatedView={translated}
                getTranslationEditContext={getTranslationPartialEditContext}
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
                    {#if DBState.db.characters[selIdState.selId]}
                        <PopupButton>
                            {@render minorIconButtonsBody(true)}
                        </PopupButton>
                    {/if}
                {:else}
                    {#if DBState.db.characters[selIdState.selId]}
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
    {#if DBState.db.useChatCopy && !blankMessage}
        <button
            class="flex items-center hover:text-blue-500 transition-colors button-icon-copy"
            onclick={async () => {
                const copyText = renderRawStreaming
                    ? risuChatParser(rawStreamingText, {
                          chara: name,
                          chatID: idx,
                          rmVar: true,
                          visualize: true,
                          cbsConditions: getCbsCondition(),
                      })
                    : msgDisplay;
                if (window.navigator.clipboard.write) {
                    try {
                        alertWait(language.loading);
                        const root = document.querySelector(":root") as HTMLElement;

                        const parser = new DOMParser();
                        const doc = parser.parseFromString(
                            await ParseMarkdown(copyText, getCurrentCharacter(), "normal", idx, getCbsCondition()),
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
                            const iconImage =
                                (await getFileSrc(DBState.db.characters[selIdState.selId].image ?? "")) ?? "";

                            if (
                                iconImage &&
                                (iconImage.startsWith("http://asset.localhost") ||
                                    iconImage.startsWith("https://asset.localhost") ||
                                    iconImage.startsWith("https://sv.risuai") ||
                                    iconImage.startsWith("data:") ||
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
                        const displayName = isUserMessage ? getUserName() : name;
                        const modelInfo = messageGenerationInfo
                            ? capitalize(getModelInfo(messageGenerationInfo.model).shortName)
                            : isUserMessage
                              ? "User"
                              : "AI";

                        let finalIconDataUrl = iconDataUrl;
                        let finalHasValidImage = hasValidImage;

                        if (isUserMessage) {
                            finalHasValidImage = false;
                            const userIcon = getUserIcon();
                            if (userIcon) {
                                try {
                                    const userIconSrc = await getFileSrc(userIcon);
                                    if (
                                        userIconSrc &&
                                        (userIconSrc.startsWith("http://asset.localhost") ||
                                            userIconSrc.startsWith("https://asset.localhost") ||
                                            userIconSrc.startsWith("https://sv.risuai") ||
                                            userIconSrc.startsWith("data:") ||
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
        {#if DBState.db.characters[selIdState.selId].type !== "group" && DBState.db.characters[selIdState.selId].ttsMode !== "none" && DBState.db.characters[selIdState.selId].ttsMode}
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
    {#if DBState.db.translator !== "" && !blankMessage && !isOptimizedStreamingMessage}
        <button
            class={"flex items-center transition-colors button-icon-translate " +
                (translationViewControlsDisabled
                    ? "opacity-50 cursor-not-allowed"
                    : "cursor-pointer hover:text-blue-500") +
                (translated ? " text-blue-400" : "")}
            class:translating
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
        {#if DBState.db.swipe || altGreeting}
            <button
                class="flex items-center hover:text-blue-500 transition-colors button-icon-unreroll"
                class:dyna-icon={rerollIcon === "dynamic"}
                class:opacity-50={locked}
                disabled={locked}
                onclick={unReroll}
            >
                <ArrowLeft size={22} />
            </button>
            {#if firstMessage && DBState.db.swipe && DBState.db.showFirstMessagePages}
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
                    v[idx] = (v[idx] ?? 0) + 1;
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
    {#if DBState.db.enableBookmark}
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
            await sleep(1);
            const currentChat = target ? findChat(target.ref) : undefined;
            const branchIndex = currentChat?.message.findIndex((entry) => entry.chatId === target?.id) ?? -1;
            if (!target || !currentChat || branchIndex === -1) {
                return;
            }

            if (DBState.db.createFolderOnBranch && !currentChat.folderId) {
                const folderId = v4();
                DBState.db.characters[selIdState.selId].chatFolders ??= [];
                DBState.db.characters[selIdState.selId].chatFolders.unshift({
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
                name: createChatCopyName(source.name, "Branch"),
                id: v4(),
                message: [...source.message.slice(0, branchIndex + 1), branchComment],
            };

            createChat(target.ref.chaId, newChat, { index: 0, select: true });
            changeChatTo(0);
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
                ? findChat(target.ref)?.message.find((entry) => entry.chatId === target.id)
                : undefined;
            if (target && currentMessage && !refuseLocked(target.ref, [target.id])) {
                replaceMessage(target.ref, { ...$state.snapshot(currentMessage), disabled: !currentMessage.disabled });
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
                ? findChat(target.ref)?.message.find((entry) => entry.chatId === target.id)
                : undefined;
            if (target && currentMessage && !refuseLocked(target.ref, [target.id])) {
                replaceMessage(target.ref, {
                    ...$state.snapshot(currentMessage),
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
        {#if DBState.db.characters[selIdState.selId]?.chaId === "§playground"}
            <div
                class="shadow-lg border-textcolor2 border flex justify-center items-center text-textcolor2"
                style={options?.styleFix ??
                    `height:${(DBState.db.iconsize * 3.5) / 100}rem;width:${(DBState.db.iconsize * 3.5) / 100}rem;min-width:${(DBState.db.iconsize * 3.5) / 100}rem`}
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
                        `height:${(DBState.db.iconsize * 3.5) / 100}rem;width:${(DBState.db.iconsize * 3.5) / 100}rem;min-width:${(DBState.db.iconsize * 3.5) / 100}rem`}
                    class:rounded-md={!options?.rounded}
                    class:rounded-full={options?.rounded}
                ></div>
            {:then m}
                {#if largePortrait && !options?.rounded}
                    <div
                        class="shadow-lg bg-textcolor2"
                        style={m +
                            (options?.styleFix ??
                                `height:${(DBState.db.iconsize * 3.5) / 100 / 0.75}rem;width:${(DBState.db.iconsize * 3.5) / 100}rem;min-width:${(DBState.db.iconsize * 3.5) / 100}rem`)}
                        class:rounded-md={!options?.rounded}
                        class:rounded-full={options?.rounded}
                    ></div>
                {:else}
                    <div
                        class="shadow-lg bg-textcolor2"
                        style={m +
                            (options?.styleFix ??
                                `height:${(DBState.db.iconsize * 3.5) / 100}rem;width:${(DBState.db.iconsize * 3.5) / 100}rem;min-width:${(DBState.db.iconsize * 3.5) / 100}rem`)}
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
    data-chat-index={idx}
    data-chat-id={DBState.db.characters?.[selIdState.selId]?.chats?.[
        DBState.db.characters?.[selIdState.selId]?.chatPage
    ]?.message?.[idx]?.chatId ?? ""}
    style={isLastMemory ? `border-top:${DBState.db.memoryLimitThickness}px solid rgba(98, 114, 164, 0.7);` : ""}
    onclickcapture={handleButtonTriggerWithin}
>
    <div
        class="text-textcolor mt-1 ml-4 mr-4 mb-1 p-2 bg-transparent grow border-t-gray-900 border-opacity/30 border-transparent flexium items-start max-w-full"
    >
        {#if DBState.db.theme === "mobilechat" && !blankMessage}
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
                    {#if DBState.db.characters?.[selIdState.selId]?.chats?.[DBState.db.characters?.[selIdState.selId]?.chatPage]?.message?.[idx]?.time}
                        <span class="text-xs text-textcolor2 mt-1 block">
                            {new Intl.DateTimeFormat(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                                second: "2-digit",
                                month: "2-digit",
                                day: "2-digit",
                                hour12: false,
                            }).format(
                                DBState.db.characters[selIdState.selId].chats[
                                    DBState.db.characters[selIdState.selId].chatPage
                                ].message[idx].time,
                            )}
                        </span>
                    {/if}
                </div>
                {#if role === "user"}
                    {@render senderIcon({ rounded: true })}
                {/if}
            </div>
        {:else if DBState.db.theme === "cardboard" && !blankMessage}
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
                                bind:value={message}></textarea>
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
        {:else if DBState.db.theme === "customHTML" && !blankMessage}
            {@render renderGuiHtmlPart(RenderGUIHtml(DBState.db.guiHTML))}
        {:else}
            {@render senderIcon({ rounded: DBState.db.roundIcons })}
            <span class="flex flex-col ml-4 w-full max-w-full min-w-0 text-black">
                <div class="flexium items-center chat-width">
                    {#if DBState.db.characters[selIdState.selId]?.chaId === "§playground" && !blankMessage && DBState.db.characters[selIdState.selId]?.chats?.[DBState.db.characters[selIdState.selId]?.chatPage]?.message?.[idx]}
                        <span class="chat-width text-xl border-darkborderc flex items-center text-textcolor">
                            <span
                                >{DBState.db.characters[selIdState.selId].chats[
                                    DBState.db.characters[selIdState.selId].chatPage
                                ].message[idx].role === "char"
                                    ? "Assistant"
                                    : "User"}</span
                            >
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
                                        replaceMessage(target.ref, {
                                            ...$state.snapshot(current),
                                            role: current.role === "char" ? "user" : "char",
                                        });
                                    }
                                    ReloadChatPointer.update((v) => {
                                        v[idx] = (v[idx] ?? 0) + 1;
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
