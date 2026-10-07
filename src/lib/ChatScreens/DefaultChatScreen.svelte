<script lang="ts">
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
        MicOffIcon,
        PackageIcon,
        Plus,
        RefreshCcwIcon,
        ReplyIcon,
        Send,
        StepForwardIcon,
        XIcon,
        BrainIcon,
        ArrowDown,
        SparkleIcon,
    } from "@lucide/svelte";
    import {
        PlaygroundStore,
        createSimpleCharacter,
        hypaV3ModalOpen,
        ScrollToMessageStore,
        additionalChatMenu,
        additionalFloatingActionButtons,
        easyPanelStore,
        chatPanelStore,
    } from "../../ts/stores.svelte";
    import { tick } from "svelte";
    import Chat from "./Chat.svelte";
    import { type Message } from "../../ts/storage/database.svelte";
    import {
        appendMessage,
        applyChatResult,
        captureChatBaseline,
        type ChatRef,
        currentChatRef,
        findChat,
        isChatGenerating,
        retrySelectedChatLoad,
        setChatMeta,
        setMessageText,
        selectedChat,
        selectedChatLoad,
    } from "../../ts/storage/chatStore.svelte";
    import { editChatSync } from "../../ts/storage/chatEdits";
    import { getCharImage } from "../../ts/characters";
    import { doingChat, sendChat } from "../../ts/process/index.svelte";
    import { sleep } from "../../ts/util";
    import { language } from "../../lang";
    import { isExpTranslator, translate } from "../../ts/translator/translator";
    import { alertError, alertNormal, alertWait, showHypaV2Alert } from "../../ts/alert";
    import sendSound from "../../etc/send.mp3";
    import CreatorQuote from "./CreatorQuote.svelte";
    import { stopTTS } from "src/ts/process/tts";
    import MainMenu from "../UI/MainMenu.svelte";
    import AssetInput from "./AssetInput.svelte";
    import { aiLawApplies, chatFoldedState, chatFoldedStateMessageIndex, downloadFile } from "src/ts/globalApi.svelte";
    import { v4 } from "uuid";
    import { PreUnreroll, Prereroll } from "src/ts/process/prereroll";
    import { processMultiCommand } from "src/ts/process/command";
    import { postChatFile } from "src/ts/process/files/multisend";
    import { getInlayAsset } from "src/ts/process/files/inlays";
    import Chats from "./Chats.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import { getAdditionalChatLoadPages, getInitialChatLoadPages } from "src/ts/chatLoadPages";

    const loadPlaygroundMenu = () => import("../Playground/PlaygroundMenu.svelte").then((m) => m.default);

    interface Props {
        openModuleList?: boolean;
        openChatList?: boolean;
        customStyle?: string;
    }

    let messageInput: string = $state("");
    let messageInputTranslate: string = $state("");
    let openMenu = $state(false);
    let loadPages = $state(getInitialChatLoadPages(settings.ui));
    let autoMode = $state(false);
    let rerolls: Message[][] = [];
    let rerollid = -1;
    let lastCharId: string | undefined = undefined;
    let doingChatInputTranslate = false;
    let toggleStickers: boolean = $state(false);
    let fileInput: string[] = $state([]);
    let showNewMessageButton = $state(false);
    let chatsInstance: any = $state();
    let isScrollingToMessage = $state(false);
    let { openModuleList = $bindable(false), openChatList = $bindable(false), customStyle = "" }: Props = $props();
    let currentCharacter = $derived(selectedCharacter());
    let currentChat = $derived(selectedChat());
    // While the selected chat loads (null when it is loaded or nothing is selected).
    let selectedLoad = $derived(selectedChatLoad());
    let messages = $derived(currentChat?.message ?? []);

    function scrollToBottom() {
        chatsInstance?.scrollToLatestMessage();
    }
    $effect(() => {
        if (ScrollToMessageStore.value !== -1) {
            const index = ScrollToMessageStore.value;
            ScrollToMessageStore.value = -1;
            scrollToMessage(index);
        }
    });

    async function scrollToMessage(index: number) {
        // Forces the loading of past messages not rendered on the screen
        isScrollingToMessage = true;
        try {
            const totalMessages = messages.length;
            const neededLoadPages = totalMessages - index + 5;

            if (loadPages < neededLoadPages) {
                loadPages = neededLoadPages;
                await tick();
            }

            let element: Element | null = null;
            // Poll for element existence (max 5 seconds)
            for (let i = 0; i < 50; i++) {
                element = document.querySelector(`[data-chat-index="${index}"]`);
                if (element) break;
                await sleep(100);
            }

            const preIndex = Math.max(0, index - 3);
            const preElement = document.querySelector(`[data-chat-index="${preIndex}"]`);
            if (preElement) {
                preElement.scrollIntoView({ behavior: "instant", block: "start" });
            } else {
                element?.scrollIntoView({ behavior: "instant", block: "start" });
            }
            await sleep(50);

            if (element) {
                // Wait for images to load to prevent layout shift
                const chatContainer = document.querySelector(".default-chat-screen");
                if (chatContainer) {
                    const images = Array.from(chatContainer.querySelectorAll("img"));
                    const promises = images.map((img) => {
                        if (img.complete) return Promise.resolve();
                        return new Promise((resolve) => {
                            img.onload = () => resolve(null);
                            img.onerror = () => resolve(null);
                        });
                    });
                    // Wait for all images or timeout after 4 seconds
                    await Promise.race([Promise.all(promises), sleep(4000)]);
                }

                element.scrollIntoView({ behavior: "instant", block: "start" });

                // Small delay and scroll again to ensure position is correct after any final layout adjustments
                await sleep(50);
                element.scrollIntoView({ behavior: "instant", block: "start" });

                element.classList.add("ring-2", "ring-blue-500");
                setTimeout(() => {
                    element.classList.remove("ring-2", "ring-blue-500");
                }, 2000);
            }
        } finally {
            isScrollingToMessage = false;
        }
    }

    async function send() {
        return sendMain(false);
    }
    async function sendContinue() {
        return sendMain(true);
    }

    async function sendMain(continueResponse: boolean) {
        if ($doingChat) {
            return;
        }
        if (lastCharId !== currentCharacter?.chaId) {
            rerolls = [];
            rerollid = -1;
        }

        // The chat this send writes to, captured before any await; everything after an await
        // resolves it again by id (and stops when it is gone).
        const ref = currentChatRef();
        if (!ref) {
            return;
        }
        const characterOf = () => characterList().find((character) => character?.chaId === ref.chaId);

        if (messageInput.startsWith("/")) {
            const commandProcessed = await processMultiCommand(messageInput);
            if (commandProcessed !== false) {
                messageInput = "";
                return;
            }
        }
        const char = characterOf();
        const cha = findChat(ref)?.message;
        if (!char || !cha) {
            return;
        }

        if (fileInput.length > 0) {
            for (const file of fileInput) {
                messageInput += `{{inlayed::${file}}}`;
            }
            fileInput = [];
        }

        // The job runs the input stage and appends the user message (Phase 5 slice 9).
        let serverInput: { input: string; userMessageId: string } | null = null;
        if (messageInput === "") {
            if (char.type !== "group") {
                if (cha.length === 0 || cha[cha.length - 1].role !== "user") {
                    if (settings.ui.useSayNothing) {
                        appendMessage(ref, { role: "user", data: "*says nothing*" });
                    }
                }
            }
        } else {
            // The same text after a send that got no answer keeps its id: the server skips an input it
            // already appended under it.
            const unresolved = pendingServerInputs.get(chatKeyOf(ref));
            const pending = unresolved?.input === messageInput ? unresolved : null;
            serverInput = { input: messageInput, userMessageId: pending?.userMessageId ?? v4() };
        }
        messageInput = "";
        messageInputTranslate = "";
        rerolls = [];
        await sleep(10);
        updateInputSizeAll();
        await sendChatMain(continueResponse, ref, serverInput);
    }

    async function reroll() {
        if ($doingChat) {
            return;
        }
        if (lastCharId !== currentCharacter?.chaId) {
            rerolls = [];
            rerollid = -1;
        }
        const ref = currentChatRef();
        // Nothing while the selected chat loads.
        if (!ref || !currentChat) {
            return;
        }
        // The last reply stays locked until its server job releases it.
        if (isChatGenerating(ref)) {
            alertError(language.chatGenerating);
            return;
        }
        const lastMessage = currentChat.message.at(-1);
        const genId = lastMessage?.generationInfo?.generationId;
        if (genId) {
            const r = Prereroll(genId);
            if (r) {
                setMessageText(ref, lastMessage.chatId, r);
                return;
            }
        }
        if (rerollid < rerolls.length - 1) {
            if (Array.isArray(rerolls[rerollid + 1])) {
                rerollid += 1;
                const rerollData = safeStructuredClone(rerolls[rerollid]);
                // The last messages become the stored reroll (by id: the replaced ones go, these come).
                editChatSync(ref, (chat) => {
                    for (let i = 0; i < rerollData.length; i++) {
                        chat.message[chat.message.length - rerollData.length + i] = rerollData[i];
                    }
                });
            }
            return;
        }
        if (rerolls.length === 0) {
            rerolls.push(safeStructuredClone([currentChat.message.at(-1)]) as Message[]);
            rerollid = rerolls.length - 1;
        }
        let cha = safeStructuredClone(currentChat.message) as Message[];
        if (cha.length === 0) {
            return;
        }
        openMenu = false;
        const saying = cha[cha.length - 1].saying;
        let sayingQu = 2;
        while (cha[cha.length - 1].role !== "user") {
            if (cha[cha.length - 1].saying === saying) {
                sayingQu -= 1;
                if (sayingQu === 0) {
                    break;
                }
            }
            let msg = cha.pop();
            if (!msg) {
                return;
            }
        }
        // The replies after the last user message go, then the send runs again.
        const kept = new Set(cha.map((message) => message.chatId));
        editChatSync(ref, (chat) => {
            chat.message = chat.message.filter((message) => kept.has(message.chatId));
        });
        await sendChatMain();
    }

    async function unReroll() {
        if ($doingChat) {
            return;
        }
        if (lastCharId !== currentCharacter?.chaId) {
            rerolls = [];
            rerollid = -1;
        }
        const ref = currentChatRef();
        // Nothing while the selected chat loads.
        if (!ref || !currentChat) {
            return;
        }
        // The last reply stays locked until its server job releases it.
        if (isChatGenerating(ref)) {
            alertError(language.chatGenerating);
            return;
        }
        const lastMessage = currentChat.message.at(-1);
        const genId = lastMessage?.generationInfo?.generationId;
        if (genId) {
            const r = PreUnreroll(genId);
            if (r) {
                setMessageText(ref, lastMessage.chatId, r);
                return;
            }
        }
        if (rerollid <= 0) {
            return;
        }
        if (Array.isArray(rerolls[rerollid - 1])) {
            rerollid -= 1;
            const rerollData = safeStructuredClone(rerolls[rerollid]);
            editChatSync(ref, (chat) => {
                for (let i = 0; i < rerollData.length; i++) {
                    chat.message[chat.message.length - rerollData.length + i] = rerollData[i];
                }
            });
        }
    }

    let abortController: null | AbortController = null;
    /** Per chat: a server send's input that got no answer (it may have been appended under its id). */
    let pendingServerInputs = new Map<string, { input: string; userMessageId: string }>();
    const chatKeyOf = (ref: ChatRef) => `${ref.chaId}\u0000${ref.chatId}`;

    /**
     * Sends in `target` (default: the selected chat now), captured by the caller before its awaits.
     * `serverInput`: the input a server job appends (its user message is not part of the reroll).
     */
    async function sendChatMain(
        continued: boolean = false,
        target: ChatRef | null = currentChatRef(),
        serverInput: { input: string; userMessageId: string } | null = null,
    ) {
        if (!target) {
            return;
        }
        let previousLength = findChat(target)?.message.length ?? 0;
        messageInput = "";
        abortController = new AbortController();
        try {
            await sendChat(-1, {
                target,
                signal: abortController.signal,
                continue: continued,
                ...(serverInput
                    ? {
                          ...serverInput,
                          onServerRefused: (ambiguous: boolean) => {
                              // Appended after all (an earlier attempt that got no answer): nothing to put back.
                              if (findChat(target)?.message.some((m) => m.chatId === serverInput.userMessageId)) {
                                  pendingServerInputs.delete(chatKeyOf(target));
                                  return;
                              }
                              if (messageInput === "") {
                                  messageInput = serverInput.input;
                              }
                              // A send that got no answer may still append under its id, also after a later
                              // refusal of a retry: the id stays with the text until the chat holds it.
                              const key = chatKeyOf(target);
                              if (
                                  ambiguous ||
                                  pendingServerInputs.get(key)?.userMessageId === serverInput.userMessageId
                              ) {
                                  pendingServerInputs.set(key, serverInput);
                              }
                          },
                      }
                    : {}),
            });
            const messages = findChat(target)?.message ?? [];
            if (serverInput) {
                const userIndex = messages.findIndex((message) => message.chatId === serverInput.userMessageId);
                if (userIndex !== -1) {
                    previousLength = userIndex + 1;
                    if (pendingServerInputs.get(chatKeyOf(target))?.userMessageId === serverInput.userMessageId) {
                        pendingServerInputs.delete(chatKeyOf(target));
                    }
                }
            }
            if (previousLength < messages.length) {
                rerolls.push((safeStructuredClone(messages) as Message[]).slice(previousLength));
                rerollid = rerolls.length - 1;
            }
        } catch (error) {
            console.error(error);
            alertError(error);
        }
        lastCharId = currentCharacter?.chaId;
        $doingChat = false;
        if (settings.ui.playMessage) {
            const audio = new Audio(sendSound);
            audio.play().catch(() => {});
        }
    }

    function abortChat() {
        if (abortController) {
            abortController.abort();
        }
    }

    async function runAutoMode() {
        if (autoMode) {
            autoMode = false;
            return;
        }
        const selectedChar = currentCharacter?.chaId;
        autoMode = true;
        while (autoMode) {
            await sendChatMain();
            if (selectedChar !== selectedCharacter()?.chaId) {
                autoMode = false;
            }
        }
    }

    let { userIconPortrait, currentUsername, userIcon } = $derived.by(() => {
        const bindedPersona = currentChat?.bindedPersona;

        if (bindedPersona) {
            const persona = settings.personas.find((p) => p.id === bindedPersona);
            if (persona) {
                return {
                    currentUsername: persona.name,
                    userIconPortrait: persona.largePortrait,
                    userIcon: persona.icon,
                };
            }
        }

        const persona = currentPersonaRecord();
        return {
            currentUsername: activePersona.name,
            userIconPortrait: persona.largePortrait,
            userIcon: persona.icon,
        };
    });

    let inputHeight = $state("44px");
    let inputEle: HTMLTextAreaElement = $state();
    let inputTranslateHeight = $state("44px");
    let inputTranslateEle: HTMLTextAreaElement = $state();

    function updateInputSizeAll() {
        updateInputSize();
        updateInputTranslateSize();
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

    async function updateInputTransateMessage(reverse: boolean) {
        if (!settings.memoryTranslateMedia.useAutoTranslateInput) {
            return;
        }
        if (isExpTranslator()) {
            if (!reverse) {
                messageInputTranslate = "";
                return;
            }
            if (messageInputTranslate === "") {
                messageInput = "";
                return;
            }
            const lastMessageInputTranslate = messageInputTranslate;
            await sleep(1500);
            if (lastMessageInputTranslate === messageInputTranslate) {
                translate(reverse ? messageInputTranslate : messageInput, reverse).then((translatedMessage) => {
                    if (translatedMessage) {
                        if (reverse) messageInput = translatedMessage;
                        else messageInputTranslate = translatedMessage;
                    }
                });
            }
            return;
        }
        if (reverse && messageInputTranslate === "") {
            messageInput = "";
            return;
        }
        if (!reverse && messageInput === "") {
            messageInputTranslate = "";
            return;
        }
        translate(reverse ? messageInputTranslate : messageInput, reverse).then((translatedMessage) => {
            if (translatedMessage) {
                if (reverse) messageInput = translatedMessage;
                else messageInputTranslate = translatedMessage;
            }
        });
    }

    async function screenShot() {
        try {
            loadPages = Infinity;
            const html2canvas = await import("html-to-image");
            const chats = document.querySelectorAll(".default-chat-screen .risu-chat");
            alertWait("Taking screenShot...");
            let canvases: HTMLCanvasElement[] = [];

            for (const chat of chats) {
                const cnv = await html2canvas.toCanvas(chat as HTMLElement);
                alertWait("Taking screenShot... " + canvases.length + "/" + chats.length);
                canvases.push(cnv);
            }

            canvases.reverse();

            alertWait("Merging images...");

            let mergedCanvas = document.createElement("canvas");
            mergedCanvas.width = 0;
            mergedCanvas.height = 0;
            let mergedCtx = mergedCanvas.getContext("2d");

            let totalHeight = 0;
            let maxWidth = 0;
            for (let i = 0; i < canvases.length; i++) {
                let canvas = canvases[i];
                totalHeight += canvas.height;
                maxWidth = Math.max(maxWidth, canvas.width);

                mergedCanvas.width = maxWidth;
                mergedCanvas.height = totalHeight;
            }

            mergedCtx.fillStyle = "var(--risu-theme-bgcolor)";
            mergedCtx.fillRect(0, 0, maxWidth, totalHeight);
            let indh = 0;
            for (let i = 0; i < canvases.length; i++) {
                let canvas = canvases[i];
                indh += canvas.height;
                mergedCtx.drawImage(canvas, 0, indh - canvas.height);
                canvases[i].remove();
            }

            if (mergedCanvas) {
                await downloadFile(
                    `chat-${v4()}.png`,
                    Buffer.from(mergedCanvas.toDataURL("png").split(",").at(-1), "base64"),
                );
                mergedCanvas.remove();
            }
            alertNormal(language.screenshotSaved);
            loadPages = getInitialChatLoadPages(settings.ui);
        } catch (error) {
            console.error(error);
            alertError("Error while taking screenshot");
        }
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="w-full h-full relative"
    style={customStyle}
    onclick={() => {
        openMenu = false;
    }}
>
    {#if showNewMessageButton}
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
    {:else if currentChat}
        <div
            class="h-full w-full flex flex-col-reverse overflow-y-auto relative default-chat-screen"
            class:metatron-chat-theme={settings.ui.theme === "metatron"}
            style:--chat-screen-width="{settings.ui.chatScreenWidth ?? 900}px"
            onscroll={(e) => {
                //@ts-expect-error scrollHeight/clientHeight/scrollTop don't exist on EventTarget, but target is HTMLElement here
                const scrolled = e.target.scrollHeight - e.target.clientHeight + e.target.scrollTop;
                if (scrolled < 100 && (currentChat?.message.length ?? 0) > loadPages) {
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
                    : 'mt-2 mb-2'} chat-screen-content-width flex items-stretch w-full"
                style={settings.ui.fixedChatTextarea ? "z-index:29;" : ""}
            >
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
                    class="peer text-input-area focus:border-textcolor transition-colors outline-hidden text-textcolor p-2 min-w-0 border border-r-0 bg-transparent rounded-md rounded-r-none input-text text-xl grow ml-4 border-darkborderc resize-none overflow-y-hidden overflow-x-hidden max-w-full placeholder:text-sm"
                    bind:value={messageInput}
                    bind:this={inputEle}
                    onkeydown={(e) => {
                        if (e.key.toLocaleLowerCase() === "enter" && !e.isComposing) {
                            if (settings.ui.sendWithEnter && !e.shiftKey) {
                                send();
                                e.preventDefault();
                            } else if (!settings.ui.sendWithEnter && e.shiftKey) {
                                send();
                                e.preventDefault();
                            }
                        }
                        if (e.key.toLocaleLowerCase() === "m" && e.ctrlKey) {
                            reroll();
                            e.preventDefault();
                        }
                    }}
                    onpaste={(e) => {
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
                                        const results = await postChatFile({
                                            name: file.name,
                                            data: uint8,
                                        });
                                        if (!results) return;
                                        for (const res of results) {
                                            if (res?.type === "asset") {
                                                fileInput.push(res.data);
                                            }
                                            if (res?.type === "text") {
                                                messageInput += `{{file::${res.name}::${res.data}}}`;
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
                        updateInputTransateMessage(false);
                    }}
                    style:height={inputHeight}></textarea>

                {#if $doingChat || doingChatInputTranslate}
                    <button
                        aria-labelledby="cancel"
                        class="peer-focus:border-textcolor flex justify-center border-y border-darkborderc items-center text-textcolor p-3 hover:bg-blue-500 hover:text-white transition-colors"
                        onclick={abortChat}
                        style:height={inputHeight}
                    >
                        <div class="loadmove chat-process-stage-0" class:autoload={autoMode}></div>
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
            </div>
            {#if settings.memoryTranslateMedia.useAutoTranslateInput && currentCharacter?.chaId !== "§playground"}
                <div class="chat-screen-content-width flex items-center mt-2 mb-2">
                    <label for="messageInputTranslate" class="text-textcolor ml-4">
                        <LanguagesIcon />
                    </label>
                    <textarea
                        id="messageInputTranslate"
                        class="text-textcolor rounded-md p-2 min-w-0 bg-transparent input-text text-xl grow ml-4 mr-2 border-darkbutton resize-none focus:bg-selected overflow-y-hidden overflow-x-hidden max-w-full"
                        bind:value={messageInputTranslate}
                        bind:this={inputTranslateEle}
                        onkeydown={(e) => {
                            if (e.key.toLocaleLowerCase() === "enter" && !e.shiftKey) {
                                if (settings.ui.sendWithEnter) {
                                    send();
                                    e.preventDefault();
                                }
                            }
                            if (e.key.toLocaleLowerCase() === "m" && e.ctrlKey) {
                                reroll();
                                e.preventDefault();
                            }
                        }}
                        oninput={() => {
                            updateInputSizeAll();
                            updateInputTransateMessage(true);
                        }}
                        placeholder={language.enterMessageForTranslateToEnglish}
                        style:height={inputTranslateHeight}></textarea>
                </div>
            {/if}

            {#if fileInput.length > 0}
                <div
                    class="chat-screen-content-width flex items-center ml-4 flex-wrap p-2 m-2 border-darkborderc border rounded-md"
                >
                    {#each fileInput as file, i}
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
                                        fileInput.splice(i, 1);
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
                            messageInput += `<span class='notranslate' translate='no'>{{${fileType}::${additionalAsset[0]}}}</span> *${additionalAsset[0]} added*`;
                            updateInputSizeAll();
                        }}
                    />
                </div>
            {/if}

            {#if settings.ui.useAutoSuggestions}
                <Suggestion
                    messageInput={(msg) =>
                        (messageInput =
                            (activePreset.subModel === "textgen_webui" ||
                                activePreset.subModel === "mancer" ||
                                activePreset.subModel.startsWith("local_")) &&
                            settings.ui.autoSuggestClean
                                ? msg.replace(/ +\(.+?\) *$| - [^"'*]*?$/, "")
                                : msg)}
                    {send}
                />
            {/if}

            {#if chatPanelStore.length > 0}
                <div class="chat-screen-content-width mx-4 my-2 flex flex-col gap-2">
                    {#each chatPanelStore as panel (panel.id)}
                        <section
                            class={`rounded-md border border-darkborderc bg-darkbg/80 p-3 text-textcolor ${panel.className ?? ""}`}
                            data-plugin-chat-panel={panel.id}
                        >
                            {@html panel.html}
                        </section>
                    {/each}
                </div>
            {/if}

            {#if chatFoldedStateMessageIndex.index !== -1}
                <button class="chat-screen-content-width w-full flex justify-center max-w-full p-4">
                    <Button
                        className="max-w-xl w-full"
                        onclick={() => {
                            loadPages += chatFoldedStateMessageIndex.index + 1;
                            chatFoldedState.data = null;
                        }}
                    >
                        {language.loadMore}
                    </Button>
                </button>
            {/if}

            <Chats
                bind:this={chatsInstance}
                {messages}
                {loadPages}
                onReroll={reroll}
                {unReroll}
                {currentCharacter}
                {currentUsername}
                {userIcon}
                {userIconPortrait}
                bind:hasNewUnreadMessage={showNewMessageButton}
            />

            {#if currentChat.message.length <= loadPages}
                {#if currentCharacter.type !== "group"}
                    <Chat
                        character={createSimpleCharacter(currentCharacter)}
                        name={currentCharacter.name}
                        message={(currentChat?.fmIndex ?? -1) === -1
                            ? currentCharacter.firstMessage
                            : currentCharacter.alternateGreetings[currentChat.fmIndex]}
                        role="char"
                        img={getCharImage(currentCharacter.image, "css")}
                        idx={-1}
                        altGreeting={currentCharacter.alternateGreetings.length > 0}
                        largePortrait={currentCharacter.largePortrait}
                        firstMessage={true}
                        onReroll={() => {
                            const cha = selectedCharacter();
                            const ref = currentChatRef();
                            const chat = ref ? findChat(ref) : undefined;
                            if (cha.type !== "group" && ref && chat) {
                                setChatMeta(ref, {
                                    fmIndex: chat.fmIndex >= cha.alternateGreetings.length - 1 ? -1 : chat.fmIndex + 1,
                                });
                            }
                        }}
                        unReroll={() => {
                            const cha = selectedCharacter();
                            const ref = currentChatRef();
                            const chat = ref ? findChat(ref) : undefined;
                            if (cha.type !== "group" && ref && chat) {
                                setChatMeta(ref, {
                                    fmIndex: chat.fmIndex === -1 ? cha.alternateGreetings.length - 1 : chat.fmIndex - 1,
                                });
                            }
                        }}
                        isLastMemory={false}
                        currentPage={(currentChat?.fmIndex ?? -1) + 2}
                        totalPages={currentCharacter.alternateGreetings.length + 1}
                    />
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

            {#if openMenu}
                <div
                    class="{settings.ui.fixedChatTextarea
                        ? 'fixed'
                        : 'absolute'} right-2 bottom-16 p-5 bg-darkbg flex flex-col gap-3 text-textcolor rounded-md"
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
                    {#if currentCharacter.ttsMode === "webspeech" || currentCharacter.ttsMode === "elevenlab"}
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

                    <div
                        class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                        class:text-textcolor2={currentChat.message.length < 2 ||
                            currentChat.message[currentChat.message.length - 1].role !== "char"}
                        onclick={() => {
                            if (
                                currentChat.message.length < 2 ||
                                currentChat.message[currentChat.message.length - 1].role !== "char"
                            ) {
                                return;
                            }
                            sendContinue();
                        }}
                    >
                        <StepForwardIcon />
                        <span class="ml-2">{language.continueResponse}</span>
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

                    {#if settings.ui.enableRisuaiProTools}
                        <div
                            class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                            onclick={() => {
                                easyPanelStore.open = !easyPanelStore.open;
                            }}
                        >
                            <SparkleIcon />
                            <span class="ml-2">{language.easyPanel}</span>
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

                    {#if settings.ui.showMenuHypaMemoryModal}
                        {#if (settings.memoryTranslateMedia.supaModelType !== "none" && settings.memoryTranslateMedia.hypav2) || settings.memoryTranslateMedia.hypaV3}
                            <div
                                class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                                onclick={() => {
                                    if (settings.memoryTranslateMedia.hypav2) {
                                        const ref = currentChatRef();
                                        if (ref && !findChat(ref)?.hypaV2Data) {
                                            setChatMeta(ref, {
                                                hypaV2Data: { lastMainChunkID: 0, mainChunks: [], chunks: [] },
                                            });
                                        }
                                        showHypaV2Alert();
                                    } else if (settings.memoryTranslateMedia.hypaV3) {
                                        $hypaV3ModalOpen = true;
                                    }

                                    openMenu = false;
                                }}
                            >
                                <BrainIcon />
                                <span class="ml-2">
                                    {settings.memoryTranslateMedia.hypav2
                                        ? language.hypaMemoryV2Modal
                                        : language.hypaMemoryV3Modal}
                                </span>
                            </div>
                        {/if}
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
                            const results = await postChatFile(messageInput);
                            if (!results) return;
                            for (const res of results) {
                                if (res?.type === "asset") {
                                    fileInput.push(res.data);
                                }
                                if (res?.type === "text") {
                                    messageInput += `{{file::${res.name}::${res.data}}}`;
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
                        <div
                            class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                            onclick={reroll}
                        >
                            <RefreshCcwIcon />
                            <span class="ml-2">{language.reroll}</span>
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    {:else}
        <!-- The selected chat loads (Phase 6 slice 9b): nothing chat-dependent renders until it is here. -->
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
