<script lang="ts">
    import { getModelInfoForMode } from "src/ts/model/modellist";
    import { selectedCharacter, characterList } from "src/ts/storage/characterStore.svelte";
    import { settings, activePreset, activePersona, currentPersonaRecord } from "src/ts/storage/settingsViews.svelte";
    import Suggestion from "./Suggestion.svelte";
    import {
        CameraIcon,
        DatabaseIcon,
        DicesIcon,
        GlobeIcon,
        ImagePlusIcon,
        LanguagesIcon,
        Laugh,
        MenuIcon,
        MessageCircleQuestionIcon,
        MicOffIcon,
        PackageIcon,
        PinIcon,
        Plus,
        RefreshCcwIcon,
        ReplyIcon,
        Send,
        StepForwardIcon,
        XIcon,
        BrainIcon,
        ArrowDown,
    } from "@lucide/svelte";
    import {
        PlaygroundStore,
        createSimpleCharacter,
        hypaV3ModalOpen,
        ScrollToMessageStore,
        ShowLatestMessageStore,
        additionalChatMenu,
        additionalFloatingActionButtons,
        chatPanelStore,
        chatBindingDialog,
    } from "../../ts/stores.svelte";
    import { chatBinding } from "../../ts/storage/chatBinding.svelte";
    import { refuseOrphanedOverrides } from "src/ts/process/loreOverrides";
    import { askLoreBudgetStop, wantsLoreBudgetStop } from "src/ts/process/loreBudgetStop";
    import type { ServerSendResult } from "src/ts/process/serverGeneration";
    import { onDestroy, tick, untrack } from "svelte";
    import Chat from "./Chat.svelte";
    import {
        greetingIndex,
        greetingText,
        nextGreetingIndex,
        previousGreetingIndex,
    } from "../../../shared/greetings.ts";
    import { GENERATION_STAGES } from "../../../shared/jobs.ts";
    import { chatMemoryAlgorithm } from "../../../shared/chatMemory.ts";
    import { chatMemorySettings } from "src/ts/storage/chatMemory.svelte";
    import { STRUCTURED_MEMORY_ALGORITHM } from "../../../shared/structuredMemory.ts";
    import { ChatStyleRegistry, setChatStyleRegistry } from "../../ts/parser/chatStyles";
    import { type Message } from "../../ts/storage/database.svelte";
    import {
        appendMessage,
        chatEntry,
        chatOwnerToken,
        type ChatRef,
        currentChatRef,
        ensureChatLoaded,
        findChat,
        pinChat,
        retrySelectedChatLoad,
        setChatMeta,
        selectedChat,
        selectedChatLoad,
    } from "../../ts/storage/chatStore.svelte";
    import { editChatSync } from "../../ts/storage/chatEdits";
    import { getCharImage } from "../../ts/characters";
    import { sendChat } from "../../ts/process/index.svelte";
    import {
        chatStatusKey,
        generatingChatKeys,
        foreignJobChatKeys,
        isChatBusy,
        memoryHealthStates,
    } from "src/ts/process/chatStatus.svelte";
    import { beginLocalSend, isLocalSend, localSends } from "src/ts/process/localSends";
    import { openOocPanel } from "src/ts/ooc/oocPanel.svelte";
    import { createSendAborts } from "src/ts/process/sendAborts.svelte";
    import { createInputHookRuns } from "src/ts/process/inputHookRuns.svelte";
    import { runInputHook } from "src/ts/process/inputHooks";
    import { draftHookOf, type InputHook } from "../../../shared/inputHooks.ts";
    import { followedJobs, followedJobsOf, loadingJobChats, stopChatJob } from "src/ts/process/serverCommands";
    import HandoffControls from "./HandoffControls.svelte";
    import RemoteSendMarker from "./RemoteSendMarker.svelte";
    import InputHookPicker from "./InputHookPicker.svelte";
    import { jobStages, jobRetries, chatStageOf } from "src/ts/process/jobStages";
    import { foreignGeneration } from "src/ts/process/generationProgress.svelte";
    import { abortGenerationJob, generationClientId } from "src/ts/network/generationJobs";
    import { sleep } from "../../ts/util";
    import { language } from "../../lang";
    import { isExpTranslator, translate } from "../../ts/translator/translator";
    import { alertError, alertNormal, alertWait, showHypaV2Alert } from "../../ts/alert";
    import sendSound from "../../etc/send.mp3";
    import CreatorQuote from "./CreatorQuote.svelte";
    import { stopTTS } from "src/ts/process/tts";
    import MainMenu from "../UI/MainMenu.svelte";
    import RefusedDataBanner from "../UI/RefusedDataBanner.svelte";
    import ClosedChatScreen from "./ClosedChatScreen.svelte";
    import { selection } from "src/ts/storage/selection.svelte";
    import AssetInput from "./AssetInput.svelte";
    import {
        aiLawApplies,
        chatFoldedState,
        chatFoldedStateMessageIndex,
        downloadFile,
        withFileSrcFetch,
    } from "src/ts/globalApi.svelte";
    import { v4 } from "uuid";
    import { neighborCandidateId, rerollCarrier, switchCandidate } from "src/ts/process/rerollCandidates";
    import { rerollTurnStart, restoredScriptstate } from "../../../shared/rerollCandidates.ts";
    import { serverRerollsInPlace } from "src/ts/network/eventFeed";
    import { createRerollHistory } from "src/ts/process/rerollHistory";
    import { composerSendText, createSendDrafts, type SendDraft } from "src/ts/process/sendDraft";
    import { createComposer } from "src/ts/process/composerDrafts.svelte";
    import { pageDraftJournal } from "src/ts/storage/draftJournal";
    import { getResourceEpoch } from "src/ts/storage/resourceClient";
    import {
        createInputTranslation,
        handleMainComposerKeydown,
        handleTranslationComposerKeydown,
    } from "src/ts/process/inputTranslation.svelte";
    import { processMultiCommand } from "src/ts/process/command";
    import { postChatFile } from "src/ts/process/files/multisend";
    import { getInlayAsset, getInlayMetadata } from "src/ts/process/files/inlays";
    import { composerPlaceholder } from "./composerPlaceholder";
    import Chats from "./Chats.svelte";
    import ContextMeter from "./ContextMeter.svelte";
    import ChatStatusBadge from "../SideBars/ChatStatusBadge.svelte";
    import { memoryHealthText } from "../SideBars/chatStatus";
    import Button from "../UI/GUI/Button.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import { getAdditionalChatLoadPages, getInitialChatLoadPages } from "src/ts/chatLoadPages";
    import {
        cancelMessageJump,
        claimMessageJump,
        completeMessageJump,
        isMessageJumpCurrent,
        type MessageJump,
        messageJumpStopped,
        pendingMessageJump,
    } from "src/ts/messageSearch.svelte";
    import { runMessageJump } from "./messageJump";
    import { prepareScreenshotCapture } from "./screenshotCapture";
    import { composeScreenshot, measureScreenshotRow, planScreenshotPages } from "./screenshotExport";

    /**
     * The chat screen inside the layout of `ChatScreen.svelte`: the composers, send/reroll, and the menus. It shows
     * the home menu or the playground menu without a selected character, `ClosedChatScreen.svelte` while
     * `selection.chatOpen` is false (the playground chat is always open), a loading or load-failure state while the
     * selected chat loads, and otherwise the chat.
     *
     * The screen owns the transcript's row window (`loadPages`); `Chats.svelte` renders it and asks for trims
     * (`onTrim`), which the screen refuses during a screenshot, a message jump, or an unbounded window. The chat
     * scroller publishes `settings.ui.chatScreenWidth` as `--chat-screen-width`; the transcript, the composer, and
     * the rows around them carry `chat-screen-content-width` (`src/styles.css`), and a new row in the scroller gets
     * the class too.
     */

    const subModel = $derived(getModelInfoForMode("submodel").id);
    /**
     * Which memory view the menu row opens. Structured memory and HypaV3 always get the row; HypaV2's alert
     * stays behind `showMenuHypaMemoryModal`.
     */
    const memoryMenuKind = $derived.by(() => {
        const algorithm = chatMemoryAlgorithm(chatMemorySettings(), selectedChat());
        if (algorithm === STRUCTURED_MEMORY_ALGORITHM) return "structuredMemory";
        if (algorithm === "hypaMemoryV3") return "hypaV3";
        if (algorithm === "hypaMemoryV2") return settings.ui.showMenuHypaMemoryModal ? "hypaV2" : null;
        return null;
    });
    /** The open chat's memory health state, shown above the composer and opening the panel like the menu row. */
    const memoryHealth = $derived.by(() => {
        const ref = currentChatRef();
        return ref ? (memoryHealthStates().get(chatStatusKey(ref)) ?? null) : null;
    });

    const loadPlaygroundMenu = () => import("../Playground/PlaygroundMenu.svelte").then((m) => m.default);

    interface Props {
        openModuleList?: boolean;
        openChatList?: boolean;
        customStyle?: string;
    }

    const sendDrafts = createSendDrafts();
    const inputHookRuns = createInputHookRuns();
    const isScreenBusy = (ref: ChatRef) => isChatBusy(ref) || inputHookRuns.kindOf(ref) !== null;
    const composer = createComposer({
        journal: pageDraftJournal(),
        epoch: getResourceEpoch,
        retryIdFor: (key, draft) => {
            const [chaId, chatId] = key.split("\u0000");
            return sendDrafts.retryIdFor({ chaId, chatId }, draft);
        },
    });
    let displayGeneration = 0;
    onDestroy(() => {
        displayGeneration++;
        composer.destroy();
    });
    let openMenu = $state(false);
    const rerollHistory = createRerollHistory();
    const chatKeyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;
    let btwPicker: { ref: ChatRef; hooks: InputHook[] } | null = $state.raw(null);
    let btwResults: ReadonlyMap<string, string> = $state.raw(new Map());
    const btwResult = $derived.by(() => {
        const ref = currentChatRef();
        return ref && ref.chaId !== "§playground" ? btwResults.get(chatKeyOf(ref)) : undefined;
    });
    let toggleStickers: boolean = $state(false);
    let showNewMessageButton = $state(false);
    let chatsInstance: any = $state();
    /**
     * `Chats.revealing`: the opening's reveal is still running (some of its rows may already show). The separate
     * greeting row (`pendingReveal`) stays hidden until it ends, by visibility, so its layout does not change.
     */
    let revealing = $state(false);
    // Rows added above the view wait out the reader's scroll; loading more meanwhile would only
    // stack more of them while the transcript's top stays in reach (held rows add no height).
    let rowsHeld = $state(false);
    let greetingInstance: { whenRendered: () => Promise<void> } | undefined = $state();
    // Running jumps to a message: trimming waits for them.
    let scrollingToMessage = $state(0);
    const isScrollingToMessage = $derived(scrollingToMessage > 0);
    /** The chat scroller (`.default-chat-screen`): jumps look their rows and images up under it. */
    let chatScroller: HTMLElement | undefined = $state();
    let takingScreenshot = $state(false);
    // The chat rows' shared stylesheets: one per distinct CSS, after the rows.
    const chatStyles = new ChatStyleRegistry();
    setChatStyleRegistry(chatStyles);
    onDestroy(() => chatStyles.destroy());
    let { openModuleList = $bindable(false), openChatList = $bindable(false), customStyle = "" }: Props = $props();
    let currentCharacter = $derived(selectedCharacter());
    let currentChat = $derived(selectedChat());
    const ownedJobIds = $derived.by(() => {
        const ref = currentChatRef();
        return ref ? followedJobsOf($followedJobs, ref) : [];
    });
    // The chat is on screen: its chat is open, or it is the playground chat (always open).
    let chatShown = $derived(
        currentCharacter !== undefined && (selection.chatOpen || currentCharacter.chaId === "§playground"),
    );
    const showDraft = $derived(
        currentCharacter?.chaId !== "§playground" &&
            (!!draftHookOf(settings.inputHooks ?? [], currentChat?.draftHookId) || composer.draft !== ""),
    );
    // While the selected chat loads (null when it is loaded or nothing is selected).
    let selectedLoad = $derived(selectedChatLoad());
    /**
     * The selected chat cannot be sent until its binding is complete: the send button sets it up, and both
     * composers are `readonly`, not `disabled`, so they keep their text, focus, and the focus hotkey, and Enter
     * still opens the setup. Nothing can be typed meanwhile, and a pasted image is ignored. Text other controls
     * add (a suggestion, an additional asset) still lands in the draft, which a send keeps until the setup is
     * done; a `/` command line still runs first and is consumed.
     */
    let bindingIncomplete = $derived.by(() => {
        const ref = currentChatRef();
        return ref !== null && chatBinding(ref)?.ok === false;
    });
    let messages = $derived(currentChat?.message ?? []);
    // The open chat's identity: only a switch to another chat resets `loadPages`.
    let chatKey = $derived.by(() => {
        const ref = currentChatRef();
        return ref === null ? null : chatKeyOf(ref);
    });
    const inputTranslation = createInputTranslation({
        translate,
        isExperimental: isExpTranslator,
        enabled: () => settings.memoryTranslateMedia.useAutoTranslateInput,
        getText: (field) => (field === "main" ? composer.input : composer.translate),
        setText: (field, text) => {
            if (field === "main") composer.input = text;
            else composer.translate = text;
        },
        getChatKey: () => chatKey,
    });
    onDestroy(() => inputTranslation.invalidate());
    $effect(() => {
        if (!settings.memoryTranslateMedia.useAutoTranslateInput) {
            inputTranslation.invalidate();
        }
    });
    /**
     * How many messages render from the end (or from the fold); load more grows it, an append at the bottom may
     * trim it. Unfolding (the show-all button) adds `messages.length - foldedIndex`, so the folded window's oldest
     * row stays shown.
     */
    let loadPages = $derived.by(() => {
        chatKey;
        return untrack(() => getInitialChatLoadPages(settings.ui));
    });
    $effect(() => {
        chatKey;
        chatShown;
        displayGeneration++;
    });
    $effect(() => {
        chatKey;
        inputTranslation.invalidate();
        untrack(() => {
            composer.switchTo(chatKey);
            const ref = currentChatRef();
            if (ref) {
                const draft = sendDrafts.takeUnplaced(ref, (send) => composerEmptyFor(ref, send));
                if (draft) {
                    composer.placeSend(chatKeyOf(ref), draft);
                }
            }
            if (ref) {
                void composer
                    .restore(chatKeyOf(ref), {
                        landed: async (userMessageId) => {
                            try {
                                const chat = await ensureChatLoaded(ref);
                                return chat?.message.some(
                                    (message) => message.role === "user" && message.chatId === userMessageId,
                                );
                            } catch {
                                return undefined;
                            }
                        },
                        inlayExists: async (id) => {
                            try {
                                return (await getInlayMetadata(id)) !== null;
                            } catch {
                                return undefined;
                            }
                        },
                    })
                    .then((draft) => {
                        if (draft)
                            sendDrafts.adopt(ref, {
                                input: draft.text,
                                userMessageId: draft.userMessageId,
                                requestId: draft.requestId,
                                ...(draft.composer ? { composer: draft.composer } : {}),
                            });
                    });
            }
        });
    });

    function scrollToBottom() {
        chatsInstance?.scrollToLatestMessage();
    }
    // A notification's chat, open already or not: its newest message from the start, wherever the
    // reader left it. A chat that opens anew is aligned by its opening too.
    $effect(() => {
        if (ShowLatestMessageStore.value) {
            ShowLatestMessageStore.value = false;
            void tick().then(() => chatsInstance?.scrollToLatestMessage());
        }
    });
    /**
     * A bookmark's jump (`ScrollToMessageStore`, an index into the selected chat). The index names its message
     * id once, when the jump starts; from there the jump follows the id, as a search hit's does.
     */
    let pendingBookmark: Pick<MessageJump, "ref" | "messageId"> | null = null;
    $effect(() => {
        const index = ScrollToMessageStore.value;
        if (index !== -1) {
            ScrollToMessageStore.value = -1;
            untrack(() => {
                stopOwnedJump();
                const ref = currentChatRef();
                const messageId = messages[index]?.chatId;
                pendingBookmark = ref && messageId ? { ref, messageId } : null;
            });
        }
        const ref = currentChatRef();
        const shown = chatShown;
        const chats = chatsInstance;
        const scroller = chatScroller;
        const jump = pendingBookmark;
        if (!jump) return;
        if (!shown || ref?.chaId !== jump.ref.chaId || ref.chatId !== jump.ref.chatId) {
            pendingBookmark = null;
            return;
        }
        // Keep the captured id while a bookmark opened from the closed chat waits for its transcript.
        if (!chats || !scroller) return;
        pendingBookmark = null;
        untrack(() => void scrollToMessageId(jump));
    });

    // A search hit's jump (`src/ts/messageSearch.svelte.ts`): claimed once its chat is selected,
    // loaded and shown, before any await, so it runs once.
    $effect(() => {
        const pending = pendingMessageJump();
        if (!pending) return;
        const ref = currentChatRef();
        if (
            ref === null ||
            ref.chaId !== pending.ref.chaId ||
            ref.chatId !== pending.ref.chatId ||
            selectedLoad !== null ||
            !chatShown ||
            !currentChat ||
            !chatsInstance ||
            !chatScroller
        ) {
            return;
        }
        untrack(() => {
            const claimed = claimMessageJump(ref);
            if (claimed) {
                void scrollToMessageId(claimed);
            }
        });
    });

    let destroyed = false;
    /** Bookmark and search jumps share one owner, including a way to release pending waits. */
    let ownedJump: { stop(): void; isCurrent(): boolean } | null = null;
    function stopOwnedJump() {
        pendingBookmark = null;
        const previous = ownedJump;
        ownedJump = null;
        previous?.stop();
    }
    onDestroy(() => {
        destroyed = true;
        stopOwnedJump();
    });
    $effect.pre(() => {
        chatKey;
        chatShown;
        chatsInstance;
        chatScroller;
        untrack(() => {
            if (ownedJump && !ownedJump.isCurrent()) stopOwnedJump();
        });
    });

    /** Waits until the scroller's images loaded or failed, at most 4 s or until `stopped`. */
    function settleImages(scroller: HTMLElement, stopped: Promise<void>): Promise<void> {
        const images = Array.from(scroller.querySelectorAll("img")).filter((img) => !img.complete);
        if (images.length === 0) return Promise.resolve();
        return new Promise((resolve) => {
            let left = images.length;
            const finish = () => {
                clearTimeout(timer);
                for (const img of images) {
                    img.removeEventListener("load", settled);
                    img.removeEventListener("error", settled);
                }
                resolve();
            };
            const seen = new Set<EventTarget>();
            function settled(event: Event) {
                if (event.target && !seen.has(event.target)) {
                    seen.add(event.target);
                    left -= 1;
                    if (left === 0) finish();
                }
            }
            const timer = setTimeout(finish, 4000);
            for (const img of images) {
                img.addEventListener("load", settled);
                img.addEventListener("error", settled);
            }
            void stopped.then(finish);
        });
    }

    /**
     * Runs a bookmark or claimed search jump through `runMessageJump` (`messageJump.ts`), as the screen's one
     * owned jump. A newer jump, a chat switch, a replaced transcript, or the screen's destruction stops it; after
     * every await the chat must still be selected and shown. Messages are found by id; a greeting target
     * loads the full history and finds the row at -1. While it runs,
     * trimming is suspended and the transcript's scroll anchor is released.
     */
    async function scrollToMessageId(jump: Pick<MessageJump, "ref" | "messageId"> & { token?: number }) {
        const { token, ref, messageId } = jump;
        stopOwnedJump();
        const chats = chatsInstance;
        const scroller = chatScroller;
        if (!chats || !scroller) {
            if (token !== undefined) cancelMessageJump(token);
            return;
        }
        let stop!: () => void;
        const localStopped = new Promise<void>((resolve) => {
            stop = resolve;
        });
        const owner = {
            stop: () => {
                stop();
                if (token !== undefined) cancelMessageJump(token);
            },
            isCurrent: () => {
                const now = untrack(() => currentChatRef());
                return (
                    !destroyed &&
                    ownedJump === owner &&
                    (token === undefined || isMessageJumpCurrent(token)) &&
                    now?.chaId === ref.chaId &&
                    now.chatId === ref.chatId &&
                    untrack(() => chatShown && chatsInstance === chats && chatScroller === scroller) &&
                    scroller.isConnected
                );
            },
        };
        ownedJump = owner;
        scrollingToMessage += 1;
        const stopped = token === undefined ? localStopped : Promise.race([localStopped, messageJumpStopped(token)]);
        const isCurrent = owner.isCurrent;
        try {
            const outcome = await runMessageJump(messageId, {
                isCurrent,
                stopped,
                messages: () => untrack(() => selectedChat()?.message ?? null),
                foldedIndex: () => untrack(() => chatFoldedStateMessageIndex.index),
                clearFold: () => {
                    chatFoldedState.data = null;
                },
                loadPages: () => untrack(() => loadPages),
                setLoadPages: (value) => {
                    loadPages = value;
                },
                tick,
                whenRendered: () => chats.whenRendered(),
                findRow: (index) => {
                    const row = scroller.querySelector<HTMLElement>(`[data-chat-index="${index}"]`);
                    return row?.isConnected ? row : null;
                },
                scrollTo: (row) => row.scrollIntoView({ behavior: "instant", block: "start" }),
                settleImages: () => settleImages(scroller, stopped),
                ring: (row) => {
                    row.classList.add("ring-2", "ring-primary-500");
                    setTimeout(() => {
                        row.classList.remove("ring-2", "ring-primary-500");
                    }, 2000);
                },
            });
            if (token !== undefined) {
                if (outcome === "stopped" || !isCurrent()) {
                    cancelMessageJump(token);
                } else {
                    completeMessageJump(token);
                    if (outcome === "gone") {
                        alertNormal(language.messageSearch.messageGone);
                    }
                }
            }
        } catch (error) {
            if (token !== undefined) cancelMessageJump(token);
            console.error("The jump to the message failed", error);
        } finally {
            owner.stop();
            if (ownedJump === owner) {
                ownedJump = null;
            }
            scrollingToMessage -= 1;
        }
    }

    async function send() {
        return sendMain(false);
    }
    async function sendContinue() {
        return sendMain(true);
    }

    /** A whole draft snapshot may replace only an entirely empty composer; ordinary sends need only the main box. */
    function composerEmptyFor(ref: ChatRef, send: SendDraft): boolean {
        const draft = composer.at(chatKeyOf(ref));
        return (
            draft.input === "" &&
            (!send.composer || (draft.draft === "" && draft.translate === "" && draft.files.length === 0))
        );
    }

    async function runDraftHook(ref: ChatRef, hook: InputHook) {
        if (isChatBusy(ref)) {
            alertError(language.chatGenerating);
            return;
        }
        const run = inputHookRuns.begin(ref, "draft");
        if (!run) {
            alertError(language.chatGenerating);
            return;
        }
        const { signal, release } = sendAborts.begin(ref);
        const key = chatKeyOf(ref);
        const revision = composer.textRevision(key);
        const display = displayGeneration;
        const eligible = () =>
            !signal.aborted &&
            chatShown &&
            selection.chatOpen &&
            chatKey === key &&
            displayGeneration === display &&
            !!findChat(ref) &&
            composer.textRevision(key) === revision;
        try {
            const draft = composer.at(key);
            const result = await runInputHook(hook, { ref, content: draft.input, draft: draft.draft, signal });
            if (!eligible()) return;
            if (!result.trim()) {
                alertError(language.errors.emptyText);
                return;
            }
            composer.at(key).draft = result;
        } catch (error) {
            if (eligible()) alertError(error instanceof Error ? error.message : String(error));
        } finally {
            release();
            run.end();
        }
    }

    function chooseBtwHook() {
        openMenu = false;
        const ref = currentChatRef();
        const hooks = (settings.inputHooks ?? []).filter((hook) => hook.type === "btw");
        if (!ref || ref.chaId === "§playground" || hooks.length === 0) return;
        if (hooks.length === 1) {
            void runBtwHook(ref, hooks[0]);
        } else {
            btwPicker = { ref, hooks };
        }
    }

    function runPickedBtwHook(hook: InputHook) {
        const picker = btwPicker;
        if (!picker) return;
        btwPicker = null;
        void runBtwHook(picker.ref, hook);
    }

    /** Keeps a BTW answer for its chat without changing any composer field or persisted record. */
    async function runBtwHook(ref: ChatRef, hook: InputHook) {
        if (!findChat(ref)) return;
        if (isChatBusy(ref)) {
            alertError(language.chatGenerating);
            return;
        }
        const run = inputHookRuns.begin(ref, "btw");
        if (!run) {
            alertError(language.chatGenerating);
            return;
        }
        const { signal, release } = sendAborts.begin(ref);
        const key = chatKeyOf(ref);
        const display = displayGeneration;
        const eligible = () =>
            !signal.aborted &&
            chatShown &&
            selection.chatOpen &&
            chatKey === key &&
            displayGeneration === display &&
            !!findChat(ref);
        try {
            const draft = composer.at(key);
            const result = (await runInputHook(hook, { ref, content: draft.input, draft: draft.draft, signal })).trim();
            if (signal.aborted || !findChat(ref)) return;
            if (!result) {
                if (eligible()) alertError(language.errors.emptyText);
                return;
            }
            btwResults = new Map(btwResults).set(key, result);
        } catch (error) {
            if (eligible()) alertError(error instanceof Error ? error.message : String(error));
        } finally {
            release();
            run.end();
        }
    }

    function dismissBtwResult() {
        const ref = currentChatRef();
        if (!ref) return;
        const next = new Map(btwResults);
        next.delete(chatKeyOf(ref));
        btwResults = next;
    }

    /**
     * Send (`send`) and Continue (`sendContinue`) from the selected chat's composer. The checks run in
     * this order, all before the composer or reroll history is consumed:
     * the chat busy or running a hook (`isScreenBusy`), a slash command (`processMultiCommand`, which
     * reserves the chat and consumes its line only if unchanged), the chat busy again after a line that is not
     * a command, an incomplete binding (`chatBindingDialog`), then orphaned lore overrides. A chosen Draft hook runs on nonblank main text and returns without
     * consuming anything; Continue, commands, blank main text, and the playground keep the send path.
     * While the binding is incomplete the send button reads "Set up this chat" and keeps the
     * `button-icon-send` class, so the send hotkey opens the setup too, and the composers are read-only.
     * The send text is `composerSendText`, which appends the queued
     * `{{inlayed::id}}` tags; an empty one (Continue included) appends "*says nothing*" only with
     * `useSayNothing` on, outside a group, and when the last message is not the user's. Consuming the
     * input clears the chat's bundle history, and nothing awaits between it and the send's admission.
     *
     * The send asks to stop over the lore budget (`sendChatMain`'s `askLoreStop`). A stop opens the dialog
     * (`offerLoreStop`) when the chat holds the send's user message or there was no input; a stop whose
     * text went back to the composer shows the job's message as an alert instead. The repeat sends the same
     * input under the same `userMessageId` and a new request id, and never reads the composer again.
     */
    async function sendMain(continueResponse: boolean) {
        // The chat this send writes to, captured before any await; everything after an await
        // resolves it again by id (and stops when it is gone).
        const ref = currentChatRef();
        if (!ref) {
            return;
        }
        const draft = composer.at(chatKeyOf(ref));
        // Only this chat's own work refuses the send (a send of this tab, a followed job, or a lock),
        // before the text, translation draft, attachments, or reroll history are consumed; other chats
        // send at the same time.
        if (isScreenBusy(ref)) {
            alertError(language.chatGenerating);
            return;
        }
        const characterOf = () => characterList().find((character) => character?.chaId === ref.chaId);

        if (draft.input.startsWith("/")) {
            const submitted = draft.input;
            const release = beginLocalSend(ref);
            if (!release) {
                alertError(language.chatGenerating);
                return;
            }
            try {
                const commandProcessed = await processMultiCommand(submitted, ref, release);
                if (commandProcessed !== false) {
                    if (draft.input === submitted) {
                        draft.input = "";
                        inputTranslation.invalidate();
                    }
                    return;
                }
            } catch (error) {
                alertError(error);
                return;
            } finally {
                release();
            }
            if (draft.input !== submitted) return;
            // Not a command: the chat may have started work meanwhile.
            if (isScreenBusy(ref)) {
                alertError(language.chatGenerating);
                return;
            }
        }
        const char = characterOf();
        const cha = findChat(ref)?.message;
        if (!char || !cha) {
            return;
        }
        // An incomplete binding opens its setup before anything is consumed (also for Continue): the
        // text, the translation draft, and the attachments stay in this chat's composer.
        if (chatBinding(ref)?.ok === false) {
            chatBindingDialog.set(ref);
            return;
        }
        if (refuseOrphanedOverrides(ref)) {
            return;
        }

        const hook = draftHookOf(settings.inputHooks ?? [], findChat(ref)?.draftHookId);
        if (!continueResponse && ref.chaId !== "§playground" && draft.input.trim() && hook) {
            await runDraftHook(ref, hook);
            return;
        }

        const snapshot = {
            input: draft.input,
            draft: draft.draft,
            translate: draft.translate,
            files: [...draft.files],
        };
        const input = composerSendText(snapshot);
        // The job runs the input stage and appends the user message.
        let serverInput: SendDraft | null = null;
        if (input === "") {
            if (char.type !== "group") {
                if (cha.length === 0 || cha[cha.length - 1].role !== "user") {
                    if (settings.ui.useSayNothing) {
                        appendMessage(ref, { role: "user", data: "*says nothing*" });
                    }
                }
            }
        } else {
            // Retried text keeps its id: the server skips an input it already appended under it.
            serverInput = { input, ...sendDrafts.idsFor(ref, input, !continueResponse) };
            composer.beginSend(chatKeyOf(ref), {
                snapshot,
                userMessageId: serverInput.userMessageId,
                requestId: continueResponse ? undefined : serverInput.requestId,
            });
        }
        draft.files = [];
        draft.input = "";
        draft.translate = "";
        inputTranslation.invalidate();
        rerollHistory.clear(ref);
        // The send is admitted without another await after the input is consumed.
        void sleep(10).then(updateInputSizeAll);
        return sendConsumed(continueResponse, ref, serverInput);
    }

    /** Sends the draft box through the ordinary path, retaining the whole composer for a failed send. */
    async function sendDraftMessage() {
        const ref = currentChatRef();
        if (!ref || ref.chaId === "§playground") return;
        if (isScreenBusy(ref)) {
            alertError(language.chatGenerating);
            return;
        }
        if (!characterList().some((character) => character?.chaId === ref.chaId) || !findChat(ref)?.message) return;
        if (chatBinding(ref)?.ok === false) {
            chatBindingDialog.set(ref);
            return;
        }
        if (refuseOrphanedOverrides(ref)) return;
        const draft = composer.at(chatKeyOf(ref));
        if (!draft.draft.trim()) return;
        const snapshot = {
            input: draft.input,
            draft: draft.draft,
            translate: draft.translate,
            files: [...draft.files],
        };
        const input = composerSendText(snapshot, "draft");
        const hook = draftHookOf(settings.inputHooks ?? [], findChat(ref)?.draftHookId);
        const serverInput: SendDraft = {
            input,
            ...sendDrafts.idsFor(ref, input, true, snapshot),
            composer: snapshot,
            ...(hook?.translation === true && snapshot.input.trim() !== "" ? { inputOriginal: snapshot.input } : {}),
        };
        composer.beginSend(chatKeyOf(ref), {
            snapshot,
            userMessageId: serverInput.userMessageId,
            requestId: serverInput.requestId,
            sent: "draft",
        });
        draft.input = "";
        draft.draft = "";
        draft.translate = "";
        draft.files = [];
        inputTranslation.invalidate();
        rerollHistory.clear(ref);
        void sleep(10).then(updateInputSizeAll);
        return sendConsumed(false, ref, serverInput);
    }

    /** Admits a consumed composer immediately and handles the lore-stop choice for either sent box. */
    async function sendConsumed(continueResponse: boolean, ref: ChatRef, serverInput: SendDraft | null) {
        const end = await sendChatMain(continueResponse, ref, serverInput, undefined, { askLoreStop: true });
        if (!end.loreStop) {
            return;
        }
        const owner = chatOwnerToken(ref.chaId);
        const release = pinChat(ref);
        try {
            if (serverInput && !holdsUserMessage(ref, serverInput.userMessageId)) {
                // The text is back in the composer (or kept for it): sending it again asks again.
                alertError(end.loreStop.message);
                return;
            }
            // The user message is in the chat and its draft is gone, so the repeat names both ids itself:
            // the server skips an input the chat already holds under that id. The stopped request's id
            // would replay its stop.
            const repeated: SendDraft | null = serverInput && {
                ...serverInput,
                requestId: v4(),
                requestUncertain: false,
            };
            await offerLoreStop(ref, owner, end.loreStop, serverInput !== null, () =>
                sendChatMain(continueResponse, ref, repeated),
            );
        } finally {
            release();
        }
    }

    type LoreStop = NonNullable<ServerSendResult["loreStop"]>;

    /** Whether the loaded chat holds the user message a send appends under `userMessageId`. */
    function holdsUserMessage(ref: ChatRef, userMessageId: string): boolean {
        return (
            findChat(ref)?.message.some((message) => message.chatId === userMessageId && message.role === "user") ??
            false
        );
    }

    /**
     * Asks what to do about a send of `ref` that stopped over the lore budget, once the caller has put the chat
     * back as its failed send leaves it. On "Don't warn in this chat and send" it sets the chat's
     * `loreBudgetWarnOff` and runs `resend`, the caller's own request again (which asks for no stop); any other
     * choice sends nothing. The dialog is awaited, so nothing here reads the selected chat. `owner` is the
     * `chatOwnerToken` the caller took when it saw the stop: the choice is dropped when the character's chats
     * were replaced since, or the chat left the list. The caller keeps `ref` pinned from the stop until this
     * returns, since the flag can be set only on a loaded chat.
     */
    async function offerLoreStop(
        ref: ChatRef,
        owner: string,
        stop: LoreStop,
        messageKept: boolean,
        resend: () => Promise<unknown>,
    ) {
        const choice = await askLoreBudgetStop(ref, stop.lore, { messageKept });
        if (choice !== "warnOffAndSend" || chatOwnerToken(ref.chaId) !== owner || !chatEntry(ref)) {
            return;
        }
        try {
            setChatMeta(ref, { loreBudgetWarnOff: true });
        } catch (error) {
            alertError(error);
            return;
        }
        await resend();
    }

    // A swiped reply reads from its start, like a new one, while the reader follows the newest
    // message. Read before the swap; the transcript shows it after the next flush.
    function followsSwap() {
        return (
            !!settings.ui.autoScrollToNewMessage &&
            !takingScreenshot &&
            !isScrollingToMessage &&
            (!!settings.ui.alwaysScrollToNewMessage || !!chatsInstance?.followsLatest())
        );
    }
    async function showSwappedReply(ref: ChatRef, follow: boolean) {
        if (!follow) return;
        await tick();
        const now = currentChatRef();
        if (now?.chaId === ref.chaId && now.chatId === ref.chatId) chatsInstance?.scrollToLatestMessage();
    }

    /**
     * Refused while the selected chat is busy. Tries the carrier's next candidate, then bundle history.
     * A new reroll checks lore overrides and regenerates a single reply in place when the connection
     * supports it. Other tails use removal, a send, and the bundle history's guarded restoration
     * (`rerollByRemoval`). Both ask to stop over the lore budget; an in-place reroll that stopped always
     * opens the dialog (`offerLoreStop`) and repeats with the same message id and speaker.
     */
    async function reroll() {
        const ref = currentChatRef();
        // Nothing while the selected chat loads.
        if (!ref || !currentChat) {
            return;
        }
        // Refused while this chat has work of its own (a send of this tab, a followed job, or a lock:
        // the last reply stays locked until its server job releases it).
        if (isScreenBusy(ref)) {
            alertError(language.chatGenerating);
            return;
        }
        const carrier = rerollCarrier(currentChat);
        const next = neighborCandidateId(carrier, 1);
        if (next) {
            const follow = followsSwap();
            try {
                await switchCandidate(ref, carrier.chatId, next);
                void showSwappedReply(ref, follow);
            } catch (error) {
                alertError(error);
            }
            return;
        }
        if (rerollHistory.canForward(ref)) {
            const follow = followsSwap();
            rerollHistory.forward(ref);
            void showSwappedReply(ref, follow);
            return;
        }
        if (refuseOrphanedOverrides(ref)) {
            return;
        }
        if (carrier && serverRerollsInPlace()) {
            openMenu = false;
            const rerollTarget = {
                rerollMessageId: carrier.chatId,
                ...(carrier.saying ? { speakerChaId: carrier.saying } : {}),
            };
            const end = await sendChatMain(false, ref, null, rerollTarget, { askLoreStop: true });
            if (!end.loreStop) {
                return;
            }
            const owner = chatOwnerToken(ref.chaId);
            const release = pinChat(ref);
            try {
                await offerLoreStop(ref, owner, end.loreStop, false, () =>
                    sendChatMain(false, ref, null, rerollTarget),
                );
            } finally {
                release();
            }
            return;
        }
        if (currentChat.message.length === 0) {
            return;
        }
        openMenu = false;
        await rerollByRemoval(ref, true);
    }

    /**
     * The reroll of a tail that is not regenerated in place: removes `ref`'s replies after its last user
     * message and sends again; a send that brought no reply puts them back (`rerollHistory.restore`). It reads
     * the chat by `ref`, never the selected one, and makes the reroll's checks itself before it removes
     * anything (the chat busy, orphaned lore overrides), because it also runs as the repeat after a lore
     * budget stop, when another chat may be selected.
     *
     * `askLoreStop`: the send asks to stop over the lore budget. A stop opens the dialog (`offerLoreStop`) once
     * the removed replies are back, or when there were none to remove; its repeat is this function again
     * without the ask. A stop whose replies could not be put back shows the job's message as an alert instead
     * (and the unsafe-restoration alert after it).
     */
    async function rerollByRemoval(ref: ChatRef, askLoreStop: boolean) {
        if (isScreenBusy(ref)) {
            alertError(language.chatGenerating);
            return;
        }
        if (refuseOrphanedOverrides(ref)) {
            return;
        }
        const chat = findChat(ref);
        if (!chat) {
            return;
        }
        if (chat.message.length === 0) {
            return;
        }
        const start = rerollTurnStart(chat.message);
        const cha = chat.message.slice(0, start);
        const removed = safeStructuredClone(chat.message.slice(start)) as Message[];
        const anchor = cha.at(-1)?.chatId ?? null;
        rerollHistory.begin(ref, anchor, removed);
        // The replies after the last user message go, then the send runs again.
        const owner = chatOwnerToken(ref.chaId);
        const kept = new Set(cha.map((message) => message.chatId));
        const checkpoint = removed.findLast((message) => !message.isComment)?.scriptstateCheckpoint;
        const before = safeStructuredClone(chat.scriptstate ?? null);
        // Queue variables before the removal so a refused send can still withdraw its final remove op.
        if (checkpoint?.after !== undefined) {
            editChatSync(ref, (draft) => {
                draft.scriptstate = restoredScriptstate(checkpoint.before, checkpoint.after, draft.scriptstate);
            });
        }
        const variables = { before, after: safeStructuredClone(findChat(ref)?.scriptstate ?? null) };
        editChatSync(ref, (draft) => {
            draft.message = draft.message.filter((message) => kept.has(message.chatId));
        });
        // A send that brought no reply (refused, failed, or stopped before one) puts the replies back.
        const end = await sendChatMain(false, ref, null, undefined, { askLoreStop });
        const stop = end.loreStop;
        // From the stop on the chat stays loaded (the dialog's first choice sets a chat flag), and the
        // choice is checked against the owner the chat has now.
        const stopOwner = chatOwnerToken(ref.chaId);
        const release = stop ? pinChat(ref) : null;
        try {
            const restored = await rerollHistory.restore(ref, owner, anchor, removed, end, undefined, variables);
            if (stop && (restored === "restored" || removed.length === 0)) {
                await offerLoreStop(ref, stopOwner, stop, false, () => rerollByRemoval(ref, false));
                return;
            }
            if (stop) {
                alertError(stop.message);
            }
            if (restored === "unsafe") {
                alertError(language.rerollRepliesNotRestored);
            }
        } finally {
            release?.();
        }
    }

    /** Refused while busy; switches to the previous stored candidate, then falls back to bundle history. */
    async function unReroll() {
        const ref = currentChatRef();
        // Nothing while the selected chat loads.
        if (!ref || !currentChat) {
            return;
        }
        // Refused while this chat has work of its own (a send of this tab, a followed job, or a lock:
        // the last reply stays locked until its server job releases it).
        if (isScreenBusy(ref)) {
            alertError(language.chatGenerating);
            return;
        }
        const carrier = rerollCarrier(currentChat);
        const previous = neighborCandidateId(carrier, -1);
        if (previous) {
            const follow = followsSwap();
            try {
                await switchCandidate(ref, carrier.chatId, previous);
                void showSwappedReply(ref, follow);
            } catch (error) {
                alertError(error);
            }
            return;
        }
        const follow = followsSwap();
        if (rerollHistory.back(ref)) void showSwappedReply(ref, follow);
    }

    // This screen's sends and hook runs by chat: Stop aborts the selected chat's.
    const sendAborts = createSendAborts();
    // Stop shows for this screen's send in the selected chat or any followed job of it.
    const stoppable = $derived(sendAborts.has(currentChatRef()) || ownedJobIds.length > 0);
    const retryCount = $derived.by(() => {
        for (let i = ownedJobIds.length - 1; i >= 0; i--) {
            const count = $jobRetries.get(ownedJobIds[i]);
            if (count !== undefined) return count;
        }
        return null;
    });
    const loadingJobChat = $derived.by(() => {
        const ref = currentChatRef();
        return ref !== null && followedJobsOf($loadingJobChats, ref).length > 0;
    });
    const foreignProgress = $derived.by(() => {
        const ref = currentChatRef();
        return ref ? foreignGeneration(ref.chaId, ref.chatId, generationClientId()) : null;
    });
    const foreignProcessStage = $derived(
        foreignProgress?.stage ? GENERATION_STAGES.indexOf(foreignProgress.stage) + 1 : 0,
    );
    const foreignStoppable = $derived.by(() => {
        const ref = currentChatRef();
        return !stoppable && ref !== null && (foreignJobChatKeys().has(chatStatusKey(ref)) || foreignProgress !== null);
    });
    /**
     * The Stop button's `chat-process-stage-<n>`: 1 to 4 for the stage (`GENERATION_STAGES` order) of the selected
     * chat's newest own staged job, falling back to its foreign job's stage while a remote send runs, else 0.
     * Another chat's job never colors it.
     */
    const processStage = $derived.by(() => {
        const ref = currentChatRef();
        const stage = ref ? chatStageOf($jobStages, ref) : null;
        return stage === null ? foreignProcessStage : GENERATION_STAGES.indexOf(stage) + 1;
    });

    /**
     * Sends in `target` (default: the selected chat now), captured by the caller before its awaits.
     * `serverInput`: the input a server job appends (its user message is not part of the reroll).
     * `rerollTarget`: regenerates the named carrier in place, without recording a removed bundle.
     * Without input, Continue names the last message seen now; it and in-place rerolls get a fresh
     * request id for remote eligibility on every call. Other no-input sends stay local. With input,
     * Continue uses the input's fresh ids and continues the user message its job appends.
     * `ran`: false for a refusal or an ambiguous create (the job may exist); it does not prove no job ran.
     * `ok`: whether it ran to a reply (`sendChat`'s result: false for a failed, lost, or stopped job too).
     * `settled`: nothing of the send writes to the chat any more (`sendChat`'s `onEnd`; false when it threw).
     * `blockedChats`: the chats a flush refused for a generation waited on.
     * It rechecks `target`'s busy state including hook runs, takes the chat's Stop controller (`sendAborts`, from
     * `createSendAborts`), and calls `sendChat` with `target` and `serverInput`'s ids. An input that
     * neither landed nor succeeded keeps its text and `userMessageId` (`sendDrafts.settle`), and the text
     * goes back only to an empty main input for its chat. A draft send restores its whole raw composer
     * only when all four parts are empty. Both restore at once when selected, else when shown next
     * (`takeUnplaced`). The raw snapshot never reaches `sendChat`. Auto mode is `runAutoMode`.
     *
     * `options.askLoreStop`: the send asks its job to stop before the model request when the lore budget
     * leaves an activated entry out, while the setting is on and the chat has not turned the warning off
     * (`wantsLoreBudgetStop`, read right before the send). Only the send and continue, the in-place reroll,
     * and the reroll by removal pass it; auto mode and the repeat after a stop do not.
     * `loreStop`: the job stopped that way and no alert was raised for it (`sendChat`'s `onEnd`): the entries
     * left out and the job's English message, for the caller to show (`offerLoreStop`) after its own
     * failure handling.
     */
    async function sendChatMain(
        continued: boolean = false,
        target: ChatRef | null = currentChatRef(),
        serverInput: SendDraft | null = null,
        rerollTarget?: { rerollMessageId: string; speakerChaId?: string },
        options: { askLoreStop?: boolean } = {},
    ): Promise<{
        ran: boolean;
        ok: boolean;
        settled: boolean;
        blockedChats: readonly ChatRef[];
        loreStop?: LoreStop;
    }> {
        if (!target) {
            return { ran: false, ok: false, settled: true, blockedChats: [] };
        }
        const anchor = serverInput ? serverInput.userMessageId : (findChat(target)?.message.at(-1)?.chatId ?? null);
        let ok = false;
        let ran = true;
        let end: {
            settled: boolean;
            blockedChats: readonly ChatRef[];
            requestUncertain?: boolean;
            loreStop?: LoreStop;
        } = {
            settled: false,
            blockedChats: [],
        };
        let releaseAbort: (() => void) | null = null;
        try {
            // Only this chat's own work refuses it; `sendChat` takes the chat's entry synchronously
            // right after this check.
            if (isScreenBusy(target)) {
                alertError(language.chatGenerating);
                end = {
                    settled: !serverInput?.requestUncertain,
                    blockedChats: [],
                    requestUncertain: serverInput?.requestUncertain === true,
                };
                return { ran: false, ok: false, ...end };
            }
            const { signal, release } = sendAborts.begin(target);
            releaseAbort = release;
            const { composer: consumedComposer, ...sendInput } = serverInput ?? {};
            ok = await sendChat(-1, {
                target,
                signal,
                continue: continued,
                ...sendInput,
                ...(!serverInput && ((continued && anchor !== null) || rerollTarget) ? { requestId: v4() } : {}),
                ...(!serverInput && continued && anchor !== null ? { continueMessageId: anchor } : {}),
                ...rerollTarget,
                ...(options.askLoreStop && wantsLoreBudgetStop(target) ? { stopOverLoreBudget: true } : {}),
                onServerRefused: () => {
                    ran = false;
                },
                onEnd: (sendEnd) => {
                    end = sendEnd;
                },
            });
            if (!ran) {
                return { ran, ok, ...end };
            }
            const messages = findChat(target)?.message ?? [];
            const anchorIndex = anchor === null ? -1 : messages.findIndex((message) => message.chatId === anchor);
            if (!rerollTarget && (anchor === null || anchorIndex !== -1) && anchorIndex + 1 < messages.length) {
                rerollHistory.record(target, anchor, messages.slice(anchorIndex + 1));
            }
        } catch (error) {
            ran = false;
            console.error(error);
            alertError(error);
        } finally {
            releaseAbort?.();
            if (serverInput) {
                const landed = holdsUserMessage(target, serverInput.userMessageId);
                const selected = currentChatRef();
                const result = sendDrafts.settle(target, serverInput, {
                    landed,
                    ok,
                    requestUncertain: !continued && (end.requestUncertain ?? !end.settled),
                    selected: selected?.chaId === target.chaId && selected?.chatId === target.chatId,
                    composerEmpty: composerEmptyFor(target, serverInput),
                });
                composer.settleSend(chatKeyOf(target), serverInput.userMessageId, result === "drop", {
                    requestId: continued ? undefined : serverInput.requestId,
                    retainedRequestId: sendDrafts.retryIdFor(
                        target,
                        serverInput.composer ?? {
                            input: serverInput.input,
                            draft: "",
                            translate: "",
                            files: [],
                        },
                    )?.requestId,
                });
                if (result === "restore") {
                    composer.placeSend(chatKeyOf(target), serverInput);
                }
            }
        }
        if (ran && settings.ui.playMessage) {
            const audio = new Audio(sendSound);
            audio.play().catch(() => {});
        }
        return { ran, ok, ...end };
    }

    function abortChat() {
        const selected = currentChatRef();
        if (!selected) {
            return;
        }
        if (autoRun?.key === chatKeyOf(selected)) {
            autoRun = null;
        }
        sendAborts.abort(selected);
        for (const id of ownedJobIds) {
            void abortGenerationJob(id).catch((error) => console.error("[Generation]", error));
        }
    }

    // The auto mode loop, bound to the chat it started in (compared by key: `currentChatRef()`
    // returns a new object each call). Raw state: the loop compares the run by identity.
    let autoRun: { key: string } | null = $state.raw(null);
    const autoMode = $derived(autoRun !== null && autoRun.key === chatKey);
    // Switching to another chat or closing the chat (Go Back, the browser's back) ends the run at
    // once, so a switch back during the round does not resume it; the round itself finishes.
    $effect(() => {
        const key = chatKey;
        const open = selection.chatOpen;
        untrack(() => {
            if (autoRun && (autoRun.key !== key || !open)) {
                autoRun = null;
            }
        });
    });
    onDestroy(() => {
        autoRun = null;
    });

    /**
     * Auto mode: rounds of `sendChatMain` in the chat it started in, one after another. It ends on Stop
     * (`abortChat`), an unsuccessful round (`ok` false: refused, failed, lost, or stopped), toggling it
     * again, leaving or closing that chat (the `autoRun` effect), or the screen's destruction. Its rounds
     * never ask to stop over the lore budget: nobody is asked between them.
     */
    async function runAutoMode() {
        const ref = currentChatRef();
        if (!ref) {
            return;
        }
        const key = chatKeyOf(ref);
        if (autoRun?.key === key) {
            autoRun = null;
            return;
        }
        const run = { key };
        autoRun = run;
        try {
            // Each round needs the last one to have run to a reply: a refusal, a failed job, or Stop
            // ends the loop.
            while (autoRun === run) {
                if (!(await sendChatMain(false, ref)).ok) {
                    break;
                }
            }
        } finally {
            if (autoRun === run) {
                autoRun = null;
            }
        }
    }

    // The selected chat's bound persona when it exists, else the tab's: the persona view resolves
    // that order itself.
    let { userIconPortrait, currentUsername, userIcon } = $derived.by(() => {
        const persona = currentPersonaRecord();
        return {
            currentUsername: activePersona.name,
            userIconPortrait: persona?.largePortrait,
            userIcon: persona?.icon,
        };
    });
    let inputPlaceholder = $derived(
        composerPlaceholder({
            setupNeeded: bindingIncomplete,
            playground: currentCharacter?.chaId === "§playground",
            persona: currentUsername,
            character: currentCharacter?.name ?? "",
        }),
    );

    let inputHeight = $state("44px");
    let inputEle: HTMLTextAreaElement = $state();
    let inputTranslateHeight = $state("44px");
    let inputTranslateEle: HTMLTextAreaElement = $state();
    let inputDraftHeight = $state("44px");
    let inputDraftEle: HTMLTextAreaElement = $state();

    function updateInputSizeAll() {
        updateInputSize();
        updateInputTranslateSize();
        if (inputDraftEle) {
            inputDraftEle.style.height = "0";
            inputDraftHeight = inputDraftEle.scrollHeight + "px";
            inputDraftEle.style.height = inputDraftHeight;
        }
    }

    function updateInputTranslateSize() {
        if (inputTranslateEle) {
            inputTranslateEle.style.height = "0";
            inputTranslateHeight = inputTranslateEle.scrollHeight + "px";
            inputTranslateEle.style.height = inputTranslateHeight;
        }
    }
    function updateInputSize() {
        if (inputEle) {
            inputEle.style.height = "0";
            inputHeight = inputEle.scrollHeight + "px";
            inputEle.style.height = inputHeight;
        }
    }

    $effect.pre(() => {
        updateInputSizeAll();
    });
    $effect(() => {
        composer.draft;
        showDraft;
        void tick().then(updateInputSizeAll);
    });

    /**
     * Captures the transcript as whole-row PNG Blob pages. `loadPages = Infinity` mounts every row (while folded,
     * every row up to the fold), which `Chats.svelte` takes as a capture: no staging, reveal batch, held rows, or
     * containment, and `takingScreenshot` suspends trimming.
     * The capture starts only once every row and the greeting have rendered their current markdown
     * (`whenRendered`). The previous window and scroll offset come back in `finally`, only while the same chat is
     * still open.
     */
    async function screenShot() {
        const previousWindow = loadPages;
        const capturedChat = chatKey;
        const scroller = document.querySelector(".default-chat-screen");
        const previousScroll = scroller?.scrollTop ?? 0;
        takingScreenshot = true;
        try {
            loadPages = Infinity;
            await tick();
            const html2canvas = await import("html-to-image");
            await Promise.all([chatsInstance?.whenRendered(), greetingInstance?.whenRendered()]);
            const chats = document.querySelectorAll<HTMLElement>(".default-chat-screen .risu-chat");
            const pages = planScreenshotPages(chats, measureScreenshotRow);
            alertWait("Taking screenShot...");
            await withFileSrcFetch(async () => {
                const capture = await prepareScreenshotCapture(
                    html2canvas,
                    pages.flatMap((page) => page.rows.map(({ row }) => row)),
                );
                return composeScreenshot({
                    pages,
                    background:
                        getComputedStyle(document.documentElement).getPropertyValue("--risu-theme-bgcolor").trim() ||
                        "#282a36",
                    capture,
                    createCanvas: () => document.createElement("canvas"),
                    download: downloadFile,
                    baseName: `chat-${v4()}`,
                    onProgress: (done, total) => alertWait("Taking screenShot... " + done + "/" + total),
                });
            });
            alertNormal(language.screenshotSaved);
        } catch (error) {
            console.error(error);
            alertError("Error while taking screenshot");
        } finally {
            if (chatKey === capturedChat) {
                loadPages = previousWindow;
                await tick();
                if (scroller) scroller.scrollTop = previousScroll;
            }
            takingScreenshot = false;
        }
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="w-full h-full relative"
    class:flex={chatShown && !!currentChat}
    class:flex-col={chatShown && !!currentChat}
    class:min-h-0={chatShown && !!currentChat}
    style={customStyle}
    onclick={() => {
        openMenu = false;
    }}
>
    {#if showNewMessageButton && chatShown}
        {#if settings.ui.newMessageButtonStyle === "bottom-center" || !settings.ui.newMessageButtonStyle}
            <button
                class="absolute bottom-16 left-1/2 -translate-x-1/2 bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors"
                onclick={scrollToBottom}
            >
                <ArrowDown size={16} />
                <span>{language.newMessage}</span>
            </button>
        {/if}

        {#if settings.ui.newMessageButtonStyle === "bottom-right"}
            <button
                class="absolute bottom-20 right-4 bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors"
                onclick={scrollToBottom}
            >
                <ArrowDown size={16} />
                <span>{language.newMessage}</span>
            </button>
        {/if}

        {#if settings.ui.newMessageButtonStyle === "bottom-left"}
            <button
                class="absolute bottom-20 left-4 bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors"
                onclick={scrollToBottom}
            >
                <ArrowDown size={16} />
                <span>{language.newMessage}</span>
            </button>
        {/if}

        {#if settings.ui.newMessageButtonStyle === "floating-circle"}
            <button
                class="absolute bottom-36 right-4 bg-blue-500 text-white w-12 h-12 rounded-full shadow-lg z-50 flex items-center justify-center hover:bg-blue-600 transition-colors"
                onclick={scrollToBottom}
                title="4. 원형 (우하단)"
            >
                <ArrowDown size={20} />
            </button>
        {/if}

        {#if settings.ui.newMessageButtonStyle === "right-center"}
            <button
                class="absolute top-1/2 right-2 -translate-y-1/2 bg-blue-500 text-white px-2 py-3 rounded-l-lg shadow-lg z-50 flex flex-col items-center gap-1 hover:bg-blue-600 transition-colors"
                onclick={scrollToBottom}
            >
                <ArrowDown size={14} />
                <span class="text-xs writing-mode-vertical">{language.newMessage}</span>
            </button>
        {/if}

        {#if settings.ui.newMessageButtonStyle === "top-bar"}
            <button
                class="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-500 text-white px-6 py-1.5 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors text-sm"
                onclick={scrollToBottom}
            >
                <ArrowDown size={14} />
                <span>{language.newMessage}</span>
            </button>
        {/if}
    {/if}
    {#if isScrollingToMessage}
        <div
            class="absolute inset-0 z-50 flex items-center justify-center bg-black/50 text-white text-xl font-bold backdrop-blur-sm"
        >
            Loading...
        </div>
    {/if}
    {#if currentCharacter === undefined}
        {#if $PlaygroundStore === 0}
            <MainMenu />
        {:else}
            {#await loadPlaygroundMenu() then PlaygroundMenu}
                <PlaygroundMenu />
            {/await}
        {/if}
    {:else if !chatShown}
        <ClosedChatScreen character={currentCharacter} />
    {:else if currentChat}
        {@const displayedChat = currentChatRef()}
        {@const screenBusy =
            displayedChat !== null && (isLocalSend(displayedChat, $localSends) || isScreenBusy(displayedChat))}
        {@const canContinue = currentChat.message.length >= 2 && currentChat.message.at(-1)?.role === "char"}
        {@const draftSendDisabled = !composer.draft.trim() || screenBusy}
        {#if displayedChat}
            <div class="chat-screen-content-width" style:--chat-screen-width="{settings.ui.chatScreenWidth ?? 900}px">
                <RefusedDataBanner form="chat" chaId={displayedChat.chaId} chatId={displayedChat.chatId} />
            </div>
        {/if}
        <div
            class="min-h-0 flex-1 w-full flex flex-col-reverse overflow-y-auto relative default-chat-screen"
            bind:this={chatScroller}
            class:metatron-chat-theme={settings.ui.theme === "metatron"}
            style:--chat-screen-width="{settings.ui.chatScreenWidth ?? 900}px"
            onscroll={(e) => {
                //@ts-expect-error scrollHeight/clientHeight/scrollTop don't exist on EventTarget, but target is HTMLElement here
                const scrolled = e.target.scrollHeight - e.target.clientHeight + e.target.scrollTop;
                if (scrolled < 100 && !rowsHeld && (currentChat?.message.length ?? 0) > loadPages) {
                    loadPages += getAdditionalChatLoadPages(settings.ui);
                }
                const chatTarget = e.target as HTMLElement;
                const chatsContainer =
                    settings.ui.fixedChatTextarea && chatTarget.children[1]
                        ? chatTarget.children[1]
                        : chatTarget.children[0];
                const lastEl = chatsContainer?.firstElementChild;
                const isAtBottom = lastEl
                    ? lastEl.getBoundingClientRect().top <= chatTarget.getBoundingClientRect().bottom + 100
                    : true;
                if (isAtBottom) {
                    showNewMessageButton = false;
                }
            }}
        >
            <div
                class="{settings.ui.fixedChatTextarea
                    ? 'sticky pt-2 pb-2 right-0 bottom-0 bg-bgcolor'
                    : 'relative mt-2 mb-2'} chat-screen-content-width flex flex-col w-full"
                style={settings.ui.fixedChatTextarea ? "z-index:29;" : ""}
            >
                <!-- One line above the composer row: the remote send marker and the health badge on the left, the
                     meter on the right. Too narrow for all of them, the meter wraps above the others. -->
                <div class="flex min-w-0 flex-wrap-reverse items-center">
                    {#if currentCharacter?.chaId !== "§playground"}
                        <RemoteSendMarker />
                    {/if}
                    {#if displayedChat && memoryHealth}
                        <!-- The memory health badge, left of the meter's chip; shown with the meter off too. -->
                        <div class="mb-1 ml-4 flex min-w-0">
                            <button
                                type="button"
                                class="flex max-w-full min-w-0 items-center hover:underline"
                                title={memoryHealthText(memoryHealth)}
                                onclick={() => ($hypaV3ModalOpen = true)}
                                data-memory-health-badge={memoryHealth}
                            >
                                <ChatStatusBadge
                                    status="health"
                                    health={memoryHealth}
                                    inline
                                    label={memoryHealthText(memoryHealth)}
                                />
                            </button>
                        </div>
                    {/if}
                    {#if displayedChat}
                        {#key chatKey}
                            <ContextMeter
                                chatRef={displayedChat}
                                group={currentCharacter.type === "group"}
                                height={inputHeight}
                                draft={composer.input}
                                generating={stoppable ||
                                    isLocalSend(displayedChat, $localSends) ||
                                    generatingChatKeys().has(chatStatusKey(displayedChat))}
                            />
                        {/key}
                    {/if}
                </div>
                {#if btwResult}
                    <div class="chat-screen-content-width px-4 mb-2">
                        <section
                            class="flex flex-col gap-2 rounded-md border border-darkborderc bg-darkbg p-3 text-textcolor"
                            aria-label={language.inputHooks.btwResult}
                        >
                            <div class="flex items-center gap-2">
                                <h2 class="m-0 text-sm font-medium text-textcolor2">{language.inputHooks.btwResult}</h2>
                                <button
                                    type="button"
                                    class="ml-auto text-textcolor2 hover:text-textcolor transition-colors"
                                    aria-label={language.inputHooks.btwDismiss}
                                    onclick={dismissBtwResult}
                                >
                                    <XIcon size={18} />
                                </button>
                            </div>
                            <div class="max-h-[30vh] overflow-y-auto whitespace-pre-wrap break-words text-sm">
                                {btwResult}
                            </div>
                        </section>
                    </div>
                {/if}
                <div class="relative flex items-stretch w-full">
                    {#if settings.ui.useChatSticker && currentCharacter.type !== "group"}
                        <div
                            onclick={() => {
                                toggleStickers = !toggleStickers;
                            }}
                            class={"ml-4 bg-textcolor2 flex justify-center items-center  w-12 h-12 rounded-md hover:bg-blue-500 transition-colors " +
                                (toggleStickers ? "text-green-500" : "text-textcolor")}
                        >
                            <Laugh />
                        </div>
                    {/if}

                    <textarea
                        class="peer text-input-area focus:border-textcolor transition-colors outline-hidden text-textcolor p-2 min-w-0 border border-r-0 bg-transparent rounded-md rounded-r-none input-text text-xl grow ml-4 border-darkborderc resize-none overflow-y-hidden overflow-x-hidden max-w-full placeholder:whitespace-pre placeholder:overflow-hidden placeholder:text-ellipsis read-only:cursor-not-allowed"
                        placeholder={inputPlaceholder}
                        readonly={bindingIncomplete}
                        bind:value={composer.input}
                        bind:this={inputEle}
                        oncompositionstart={() => inputTranslation.compositionStart("main")}
                        oncompositionend={() => inputTranslation.compositionEnd("main")}
                        onkeydown={(e) =>
                            handleMainComposerKeydown(e, { sendWithEnter: settings.ui.sendWithEnter, send, reroll })}
                        onpaste={(e) => {
                            const ref = currentChatRef();
                            if (!ref || bindingIncomplete) return;
                            const items = e.clipboardData?.items;
                            if (!items) {
                                return;
                            }
                            let canceled = false;

                            for (const item of items) {
                                if (item.kind === "file" && item.type.startsWith("image")) {
                                    if (!canceled) {
                                        e.preventDefault();
                                        canceled = true;
                                    }
                                    const file = item.getAsFile();
                                    if (file) {
                                        const reader = new FileReader();
                                        reader.onload = async (e) => {
                                            const buf = e.target?.result as ArrayBuffer;
                                            const uint8 = new Uint8Array(buf);
                                            const results = await postChatFile(
                                                {
                                                    name: file.name,
                                                    data: uint8,
                                                },
                                                ref,
                                            );
                                            if (!results) return;
                                            const draft = composer.at(chatKeyOf(ref));
                                            for (const res of results) {
                                                if (res?.type === "asset") {
                                                    draft.addFile(res.data);
                                                }
                                                if (res?.type === "text") {
                                                    draft.input += `{{file::${res.name}::${res.data}}}`;
                                                }
                                            }
                                            updateInputSizeAll();
                                        };
                                        reader.readAsArrayBuffer(file);
                                    }
                                }
                            }
                        }}
                        oninput={() => {
                            updateInputSizeAll();
                            inputTranslation.run(false);
                        }}
                        style:height={inputHeight}></textarea>

                    {#if stoppable}
                        <button
                            aria-labelledby="cancel"
                            class="peer-focus:border-textcolor flex justify-center border-y border-darkborderc items-center text-textcolor p-3 hover:bg-blue-500 hover:text-white transition-colors"
                            onclick={abortChat}
                            style:height={inputHeight}
                        >
                            <div class="loadmove chat-process-stage-{processStage}" class:autoload={autoMode}></div>
                            {#if inputHookRuns.kindOf(currentChatRef()) === "draft"}
                                <span class="ml-2 text-sm whitespace-nowrap" role="status"
                                    >{language.inputHooks.runningDraft}</span
                                >
                            {:else if inputHookRuns.kindOf(currentChatRef()) === "btw"}
                                <span class="ml-2 text-sm whitespace-nowrap" role="status"
                                    >{language.inputHooks.runningBtw}</span
                                >
                            {/if}
                            {#if loadingJobChat}
                                <span class="ml-2 text-sm whitespace-nowrap" role="status"
                                    >{language.serverJob.chatLoading}</span
                                >
                            {/if}
                            {#if retryCount !== null}
                                <span class="ml-2 text-sm whitespace-nowrap" role="status"
                                    >{language.serverJob.retried.replace("{count}", () => String(retryCount))}</span
                                >
                            {/if}
                        </button>
                        <HandoffControls jobIds={ownedJobIds} height={inputHeight} />
                    {:else if bindingIncomplete}
                        <!-- Keeps `button-icon-send`: the send hotkey clicks it and opens the setup too. -->
                        <button
                            onclick={() => {
                                const ref = currentChatRef();
                                if (ref) {
                                    chatBindingDialog.set(ref);
                                }
                            }}
                            class="flex justify-center border-y border-darkborderc items-center text-draculared text-sm p-3 peer-focus:border-textcolor hover:bg-blue-500 hover:text-white transition-colors button-icon-send whitespace-nowrap"
                            style:height={inputHeight}
                        >
                            {language.chatBinding.setUp}
                        </button>
                    {:else}
                        <button
                            onclick={send}
                            class="flex justify-center border-y border-darkborderc items-center text-textcolor p-3 peer-focus:border-textcolor hover:bg-blue-500 hover:text-white transition-colors button-icon-send"
                            style:height={inputHeight}
                        >
                            <Send />
                        </button>
                    {/if}
                    {#if foreignStoppable}
                        <button
                            aria-label={language.serverJob.stopOther.label}
                            title={language.serverJob.stopOther.label}
                            class="peer-focus:border-textcolor flex justify-center border-y border-darkborderc items-center text-textcolor p-3 hover:bg-darkbutton transition-colors"
                            onclick={() => {
                                const ref = currentChatRef();
                                if (ref) void stopChatJob(ref);
                            }}
                            style:height={inputHeight}
                        >
                            <div class="loadmove chat-process-stage-{foreignProcessStage}"></div>
                            {#if loadingJobChat}
                                <span class="ml-2 text-sm whitespace-nowrap" role="status"
                                    >{language.serverJob.chatLoading}</span
                                >
                            {/if}
                        </button>
                    {/if}
                    {#if currentCharacter?.chaId !== "§playground"}
                        <button
                            onclick={(e) => {
                                openMenu = !openMenu;
                                e.stopPropagation();
                            }}
                            class="peer-focus:border-textcolor mr-2 flex border-y border-r border-darkborderc justify-center items-center text-textcolor p-3 rounded-r-md hover:bg-blue-500 hover:text-white transition-colors"
                            style:height={inputHeight}
                        >
                            <MenuIcon />
                        </button>
                    {:else}
                        <div
                            onclick={(e) => {
                                const ref = currentChatRef();
                                if (ref) {
                                    appendMessage(ref, { role: "char", data: "" });
                                }
                            }}
                            class="peer-focus:border-textcolor mr-2 flex border-y border-r border-darkborderc justify-center items-center text-textcolor p-3 rounded-r-md hover:bg-blue-500 hover:text-white transition-colors"
                            style:height={inputHeight}
                        >
                            <Plus />
                        </div>
                    {/if}

                    <!-- Anchored to the composer row so it opens above the menu button inside the chat column. -->
                    {#if openMenu}
                        <div
                            class="absolute right-2 bottom-full mb-2 z-30 p-5 bg-darkbg flex flex-col gap-3 text-textcolor rounded-md"
                            onclick={(e) => {
                                e.stopPropagation();
                            }}
                        >
                            {#if currentCharacter.type === "group"}
                                <div
                                    class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                    onclick={runAutoMode}
                                >
                                    <DicesIcon />
                                    <span class="ml-2">{language.autoMode}</span>
                                </div>
                            {/if}

                            <!-- svelte-ignore block_empty -->
                            {#if currentCharacter.ttsMode}
                                <div
                                    class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                    onclick={() => {
                                        stopTTS();
                                    }}
                                >
                                    <MicOffIcon />
                                    <span class="ml-2">{language.ttsStop}</span>
                                </div>
                            {/if}

                            <button
                                type="button"
                                class="flex items-center enabled:hover:text-green-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                disabled={screenBusy || !canContinue}
                                onclick={() => {
                                    if (canContinue) void sendContinue();
                                }}
                            >
                                <StepForwardIcon />
                                <span class="ml-2">{language.continueResponse}</span>
                            </button>

                            <div
                                class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                onclick={() => {
                                    const ref = currentChatRef();
                                    if (ref) {
                                        if (currentChat.pinned === true) {
                                            setChatMeta(ref, {}, ["pinned"]);
                                        } else {
                                            setChatMeta(ref, { pinned: true });
                                        }
                                    }
                                    openMenu = false;
                                }}
                            >
                                <PinIcon />
                                <span class="ml-2"
                                    >{currentChat.pinned === true ? language.unpinChat : language.pinChat}</span
                                >
                            </div>

                            {#if settings.ui.showMenuChatList}
                                <div
                                    class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                    onclick={() => {
                                        openChatList = true;
                                        openMenu = false;
                                    }}
                                >
                                    <DatabaseIcon />
                                    <span class="ml-2">{language.chatList}</span>
                                </div>
                            {/if}

                            {#each additionalChatMenu as menu}
                                <div
                                    class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                    onclick={() => {
                                        menu.callback();
                                        openMenu = false;
                                    }}
                                >
                                    <PluginDefinedIcon ico={menu} />
                                    <span class="ml-2">{menu.name}</span>
                                </div>
                            {/each}

                            {#if memoryMenuKind}
                                <div
                                    class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                    onclick={() => {
                                        if (memoryMenuKind === "hypaV2") {
                                            const ref = currentChatRef();
                                            if (ref && !findChat(ref)?.hypaV2Data) {
                                                setChatMeta(ref, {
                                                    hypaV2Data: { lastMainChunkID: 0, mainChunks: [], chunks: [] },
                                                });
                                            }
                                            showHypaV2Alert();
                                        } else {
                                            $hypaV3ModalOpen = true;
                                        }

                                        openMenu = false;
                                    }}
                                >
                                    <BrainIcon />
                                    <span class="ml-2">
                                        {memoryMenuKind === "structuredMemory"
                                            ? language.structuredMemory.panel.title
                                            : memoryMenuKind === "hypaV2"
                                              ? language.hypaMemoryV2Modal
                                              : language.hypaMemoryV3Modal}
                                    </span>
                                </div>
                            {/if}

                            {#if currentCharacter?.type !== "group"}
                                <div
                                    class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                    onclick={() => {
                                        openOocPanel();
                                        openMenu = false;
                                    }}
                                >
                                    <MessageCircleQuestionIcon />
                                    <span class="ml-2">{language.oocPanel.title}</span>
                                </div>
                            {/if}

                            {#if currentCharacter.chaId !== "§playground" && (settings.inputHooks ?? []).some((hook) => hook.type === "btw")}
                                <button
                                    type="button"
                                    class="flex items-center hover:text-green-500 transition-colors"
                                    onclick={chooseBtwHook}
                                >
                                    <MessageCircleQuestionIcon />
                                    <span class="ml-2">{language.inputHooks.btw}</span>
                                </button>
                            {/if}

                            {#if settings.memoryTranslateMedia.translator !== ""}
                                <div
                                    class={"flex items-center cursor-pointer " +
                                        (settings.memoryTranslateMedia.useAutoTranslateInput
                                            ? "text-green-500"
                                            : "lg:hover:text-green-500")}
                                    onclick={() => {
                                        settings.memoryTranslateMedia.useAutoTranslateInput =
                                            !settings.memoryTranslateMedia.useAutoTranslateInput;
                                    }}
                                >
                                    <GlobeIcon />
                                    <span class="ml-2">{language.autoTranslateInput}</span>
                                </div>
                            {/if}

                            <div
                                class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                onclick={() => {
                                    screenShot();
                                }}
                            >
                                <CameraIcon />
                                <span class="ml-2">{language.screenshot}</span>
                            </div>

                            <div
                                class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                onclick={async () => {
                                    const ref = currentChatRef();
                                    if (!ref) return;
                                    const results = await postChatFile(composer.at(chatKeyOf(ref)).input, ref);
                                    if (!results) return;
                                    const draft = composer.at(chatKeyOf(ref));
                                    for (const res of results) {
                                        if (res?.type === "asset") {
                                            draft.addFile(res.data);
                                        }
                                        if (res?.type === "text") {
                                            draft.input += `{{file::${res.name}::${res.data}}}`;
                                        }
                                    }
                                    updateInputSizeAll();
                                }}
                            >
                                <ImagePlusIcon />
                                <span class="ml-2">{language.postFile}</span>
                            </div>

                            <div
                                class={"flex items-center cursor-pointer " +
                                    (settings.ui.useAutoSuggestions ? "text-green-500" : "lg:hover:text-green-500")}
                                onclick={async () => {
                                    settings.ui.useAutoSuggestions = !settings.ui.useAutoSuggestions;
                                }}
                            >
                                <ReplyIcon />
                                <span class="ml-2">{language.autoSuggest}</span>
                            </div>

                            <div
                                class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                onclick={() => {
                                    openModuleList = true;
                                    openMenu = false;
                                }}
                            >
                                <PackageIcon />
                                <span class="ml-2">{language.modules}</span>
                            </div>

                            {#if settings.ui.sideMenuRerollButton}
                                <button
                                    type="button"
                                    class="flex items-center enabled:hover:text-green-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                    disabled={screenBusy}
                                    onclick={reroll}
                                >
                                    <RefreshCcwIcon />
                                    <span class="ml-2">{language.reroll}</span>
                                </button>
                            {/if}
                        </div>
                    {/if}
                </div>
            </div>
            {#if showDraft}
                <div class="chat-screen-content-width flex flex-col gap-2 mt-2 mb-2 px-4">
                    <label for="messageInputDraft" class="text-textcolor">{language.inputHooks.draft}</label>
                    <div class="flex items-end gap-2">
                        <textarea
                            id="messageInputDraft"
                            class="text-textcolor rounded-md p-2 min-w-0 bg-transparent input-text text-xl grow border-darkbutton resize-none focus:bg-selected overflow-y-hidden overflow-x-hidden max-w-full read-only:cursor-not-allowed"
                            readonly={bindingIncomplete}
                            bind:value={composer.draft}
                            bind:this={inputDraftEle}
                            onkeydown={(event) =>
                                handleTranslationComposerKeydown(event, {
                                    sendWithEnter: settings.ui.sendWithEnter,
                                    send: () => {
                                        if (!draftSendDisabled) void sendDraftMessage();
                                    },
                                    reroll,
                                })}
                            oninput={updateInputSizeAll}
                            placeholder={language.inputHooks.draftPlaceholder}
                            style:height={inputDraftHeight}></textarea>
                        <button
                            type="button"
                            class="p-3 rounded-md border border-darkborderc text-textcolor hover:bg-darkbutton transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled={draftSendDisabled}
                            onclick={sendDraftMessage}>{language.inputHooks.sendDraft}</button
                        >
                    </div>
                </div>
            {/if}
            {#if settings.memoryTranslateMedia.useAutoTranslateInput && currentCharacter?.chaId !== "§playground"}
                <div class="chat-screen-content-width flex items-center mt-2 mb-2">
                    <label for="messageInputTranslate" class="text-textcolor ml-4">
                        <LanguagesIcon />
                    </label>
                    <textarea
                        id="messageInputTranslate"
                        class="text-textcolor rounded-md p-2 min-w-0 bg-transparent input-text text-xl grow ml-4 mr-2 border-darkbutton resize-none focus:bg-selected overflow-y-hidden overflow-x-hidden max-w-full read-only:cursor-not-allowed"
                        readonly={bindingIncomplete}
                        bind:value={composer.translate}
                        bind:this={inputTranslateEle}
                        oncompositionstart={() => inputTranslation.compositionStart("translation")}
                        oncompositionend={() => inputTranslation.compositionEnd("translation")}
                        onkeydown={(e) =>
                            handleTranslationComposerKeydown(e, {
                                sendWithEnter: settings.ui.sendWithEnter,
                                send,
                                reroll,
                            })}
                        oninput={() => {
                            updateInputSizeAll();
                            inputTranslation.run(true);
                        }}
                        placeholder={language.enterMessageForTranslateToEnglish}
                        style:height={inputTranslateHeight}></textarea>
                </div>
            {/if}

            {#if composer.files.length > 0}
                <div
                    class="chat-screen-content-width flex items-center ml-4 flex-wrap p-2 m-2 border-darkborderc border rounded-md"
                >
                    {#each composer.files as file, i}
                        {#await getInlayAsset(file) then inlayAsset}
                            <div class="relative">
                                {#if inlayAsset.type === "image"}
                                    <img
                                        src={inlayAsset.data}
                                        alt="Inlay"
                                        class="max-w-48 max-h-48 border border-darkborderc"
                                    />
                                {:else if inlayAsset.type === "video"}
                                    <video controls class="max-w-48 max-h-48 border border-darkborderc">
                                        <source src={inlayAsset.data} type="video/mp4" />
                                        <track kind="captions" />
                                        Your browser does not support the video tag.
                                    </video>
                                {:else if inlayAsset.type === "audio"}
                                    <audio controls class="max-w-48 max-h-24 border border-darkborderc">
                                        <source src={inlayAsset.data} type="audio/mpeg" />
                                        Your browser does not support the audio tag.
                                    </audio>
                                {:else}
                                    <div class="max-w-24 max-h-24">{file}</div>
                                {/if}
                                <button
                                    class="absolute -right-1 -top-1 p-1 bg-darkbg text-textcolor rounded-md transition-colors hover:text-draculared focus:text-draculared"
                                    onclick={() => {
                                        composer.removeFileAt(i);
                                        updateInputSizeAll();
                                    }}
                                >
                                    <XIcon size={18} />
                                </button>
                            </div>
                        {/await}
                    {/each}
                </div>
            {/if}

            {#if toggleStickers}
                <div class="chat-screen-content-width ml-4 flex flex-wrap">
                    <AssetInput
                        {currentCharacter}
                        onSelect={(additionalAsset) => {
                            let fileType = "img";
                            if (additionalAsset.length > 2 && additionalAsset[2]) {
                                const fileExtension = additionalAsset[2];
                                if (fileExtension === "mp4" || fileExtension === "webm") fileType = "video";
                                else if (fileExtension === "mp3" || fileExtension === "wav") fileType = "audio";
                            }
                            composer.input += `<span class='notranslate' translate='no'>{{${fileType}::${additionalAsset[0]}}}</span> *${additionalAsset[0]} added*`;
                            updateInputSizeAll();
                        }}
                    />
                </div>
            {/if}

            {#if settings.ui.useAutoSuggestions}
                <Suggestion
                    messageInput={(msg) =>
                        (composer.input =
                            (subModel === "textgen_webui" || subModel === "mancer" || subModel.startsWith("local_")) &&
                            settings.ui.autoSuggestClean
                                ? msg.replace(/ +\(.+?\) *$| - [^"'*]*?$/, "")
                                : msg)}
                    {send}
                />
            {/if}

            {#if chatPanelStore.length > 0}
                <div class="chat-screen-content-width mx-4 my-2 flex flex-col gap-2">
                    {#each chatPanelStore as panel (panel.id)}
                        <!-- Keep plugin positioning inside the panel and plugin attributes off its containment boundary. -->
                        <section
                            class="contain-paint rounded-md border border-darkborderc bg-darkbg/80 p-3 text-textcolor"
                        >
                            <div class={panel.className ?? ""} data-plugin-chat-panel={panel.id}>
                                {@html panel.html}
                            </div>
                        </section>
                    {/each}
                </div>
            {/if}

            {#if chatFoldedStateMessageIndex.index !== -1}
                <button class="chat-screen-content-width w-full flex justify-center max-w-full p-4">
                    <Button
                        className="max-w-xl w-full"
                        onclick={() => {
                            loadPages += messages.length - chatFoldedStateMessageIndex.index;
                            chatFoldedState.data = null;
                        }}
                    >
                        {language.loadMore}
                    </Button>
                </button>
            {/if}

            <Chats
                bind:this={chatsInstance}
                bind:revealing
                bind:holding={rowsHeld}
                {messages}
                {loadPages}
                suspendTrim={takingScreenshot || isScrollingToMessage}
                onTrim={(keep) => {
                    if (takingScreenshot || isScrollingToMessage || !Number.isFinite(loadPages)) return;
                    loadPages = keep;
                    return keep;
                }}
                onReroll={reroll}
                rerollBusy={screenBusy}
                {unReroll}
                {currentCharacter}
                {currentUsername}
                {userIcon}
                {userIconPortrait}
                bind:hasNewUnreadMessage={showNewMessageButton}
            />

            {#if currentChat.message.length <= loadPages}
                {#if currentCharacter.type !== "group"}
                    {#key chatKey}
                        {@const greetingChatRef = untrack(currentChatRef)}
                        <Chat
                            bind:this={greetingInstance}
                            chatRef={greetingChatRef}
                            pendingReveal={revealing}
                            character={createSimpleCharacter(currentCharacter)}
                            name={currentCharacter.name}
                            message={greetingText(currentCharacter, currentChat?.fmIndex)}
                            role="char"
                            img={getCharImage(
                                currentCharacter.image,
                                "css",
                                settings.ui.theme === "cardboard" ? undefined : 512,
                            )}
                            idx={-1}
                            altGreeting={currentCharacter.alternateGreetings.length > 0}
                            rerollBusy={screenBusy}
                            largePortrait={currentCharacter.largePortrait}
                            firstMessage={true}
                            onReroll={() => {
                                const ref = greetingChatRef;
                                const cha = characterList().find((entry) => entry.chaId === ref?.chaId);
                                const chat = ref ? findChat(ref) : undefined;
                                if (cha && cha.type !== "group" && ref && chat) {
                                    setChatMeta(ref, {
                                        fmIndex: nextGreetingIndex(chat.fmIndex, cha.alternateGreetings.length),
                                    });
                                }
                            }}
                            unReroll={() => {
                                const ref = greetingChatRef;
                                const cha = characterList().find((entry) => entry.chaId === ref?.chaId);
                                const chat = ref ? findChat(ref) : undefined;
                                if (cha && cha.type !== "group" && ref && chat) {
                                    setChatMeta(ref, {
                                        fmIndex: previousGreetingIndex(chat.fmIndex, cha.alternateGreetings.length),
                                    });
                                }
                            }}
                            isLastMemory={false}
                            currentPage={greetingIndex(
                                currentChat?.fmIndex,
                                currentCharacter.alternateGreetings.length,
                            ) + 2}
                            totalPages={currentCharacter.alternateGreetings.length + 1}
                        />
                    {/key}
                    {#if aiLawApplies() && currentChat.message.length === 0}
                        <div
                            class="chat-screen-content-width ml-auto mr-auto mt-4 text-textcolor2 italic max-w-2/3 wrap-break-word text-center"
                        >
                            {language.aiGenerationWarning}
                        </div>
                    {/if}
                    {#if !currentCharacter.removedQuotes && currentCharacter.creatorNotes.length >= 2}
                        <CreatorQuote
                            quote={currentCharacter.creatorNotes}
                            onRemove={() => {
                                const cha = selectedCharacter();
                                if (cha.type !== "group") {
                                    cha.removedQuotes = true;
                                }
                            }}
                        />
                    {/if}
                {/if}
            {/if}

            <!-- The rows' shared stylesheets, after the rows (and the greeting) as their own copies were. -->
            <div hidden {@attach chatStyles.attach}></div>
        </div>
    {:else}
        <!-- The selected chat loads: nothing chat-dependent renders until it is here. -->
        <div class="h-full w-full flex flex-col items-center justify-center gap-2 text-textcolor2">
            {#if selectedLoad?.error}
                <span>{language.chatLoadFailed.replace("{0}", selectedLoad.error)}</span>
                <Button onclick={() => retrySelectedChatLoad()}>{language.chatLoadRetry}</Button>
            {:else}
                <span>{language.loading}</span>
            {/if}
        </div>
    {/if}
</div>

{#if btwPicker}
    <InputHookPicker hooks={btwPicker.hooks} onchoose={runPickedBtwHook} onclose={() => (btwPicker = null)} />
{/if}

{#if additionalFloatingActionButtons.length > 0}
    <div class="fixed top-4 right-4 flex flex-col gap-3 z-50">
        {#each additionalFloatingActionButtons as button}
            <button
                class="bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 hover:bg-blue-600 transition-colors"
                onclick={() => {
                    button.callback();
                }}
            >
                <PluginDefinedIcon ico={button} />
            </button>
        {/each}
    </div>
{/if}

<style>
    /* The Stop button's ring by job stage: preparing, memory, generating, finishing. `.autoload` (auto mode)
       is declared after them, so it wins over every stage. The class names and colors stay as they are:
       `display.customCSS` can target them. */
    .chat-process-stage-1 {
        border-top: 0.4rem solid #60a5fa;
        border-left: 0.4rem solid #60a5fa;
    }

    .chat-process-stage-2 {
        border-top: 0.4rem solid #db2777;
        border-left: 0.4rem solid #db2777;
    }

    .chat-process-stage-3 {
        border-top: 0.4rem solid #34d399;
        border-left: 0.4rem solid #34d399;
    }

    .chat-process-stage-4 {
        border-top: 0.4rem solid #8b5cf6;
        border-left: 0.4rem solid #8b5cf6;
    }

    .autoload {
        border-top: 0.4rem solid #10b981;
        border-left: 0.4rem solid #10b981;
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
