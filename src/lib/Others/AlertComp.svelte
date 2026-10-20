<script lang="ts">
    import { findChat, loadChats, pinChats, selectedChat } from "src/ts/storage/chatStore.svelte";
    import { untrack } from "svelte";
    import { selectedCharacter, characterList } from "src/ts/storage/characterStore.svelte";
    import { setCurrentChatMeta } from "src/ts/storage/chatEdits";
    import { alertRequestLogs } from "../../ts/alert";
    import { jobDebugInfo } from "../../ts/diagnostics/jobDebugInfo";

    import { getCharImage } from "../../ts/characters";
    import { ParseMarkdown } from "../../ts/parser/parser.svelte";
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { ChevronRightIcon, User } from "@lucide/svelte";
    import { isCharacterHasAssets } from "src/ts/characterCards";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import { aiLawApplies } from "src/ts/globalApi.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import { XIcon, CopyIcon, CheckIcon } from "@lucide/svelte";
    import RequestLogsPopup from "./RequestLogs/RequestLogsPopup.svelte";
    import UpstreamImportReport from "../Setting/Pages/UpstreamImportReport.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import { language } from "src/lang";
    import { getFetchData } from "src/ts/globalApi.svelte";
    import { alertStore } from "src/ts/stores.svelte";
    import { tokenize } from "src/ts/tokenizer";
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
    import { ColorSchemeTypeStore } from "src/ts/gui/colorscheme";
    import { getChatBranches } from "src/ts/gui/branches";
    import { type Chat } from "src/ts/storage/database.svelte";
    import { translateStackTrace } from "../../ts/sourcemap";
    import { getDetailedOSLabel, getFallbackOSLabel, getRisuEnvironmentLabel } from "src/ts/platform";
    import versionData from "../../../version.json";

    const currentCharacter = $derived(selectedCharacter());
    const currentChat = $derived(selectedChat());
    /** A `requestdata` dialog's own generation info and message, captured when it was opened. */
    const requestInfo = $derived($alertStore.type === "requestdata" ? $alertStore.generationInfo : undefined);
    const requestMessage = $derived(requestInfo?.message);
    /** The alert shown now, for closes that must close only this one (a later write after an await). */
    const shown = $derived($alertStore);
    let showDetails = $state(false);
    let translatedStackTrace = $state("");
    let stackTraceTranslationFailed = $state(false);
    let isTranslating = $state(false);
    let osLabel = $state(getFallbackOSLabel());
    const displayedStackTrace = $derived(translatedStackTrace || $alertStore.stackTrace || "");
    const risuVersion = versionData.version;
    const risuEnvironment = getRisuEnvironmentLabel();
    const userAgent = typeof navigator === "undefined" ? "Unknown" : navigator.userAgent || "Unknown";
    const stackTraceCodeBlock = $derived.by(() => {
        const lines = [
            `Risu version: ${risuVersion}`,
            `OS: ${osLabel}`,
            `User-Agent: ${userAgent}`,
            `Risu environment: ${risuEnvironment}`,
        ];

        if (stackTraceTranslationFailed) {
            lines.push(language.stackTraceTranslationFailed);
        } else if (isTranslating) {
            lines.push(language.translating);
        }

        if (displayedStackTrace) {
            lines.push("", displayedStackTrace);
        }

        return lines.join("\n");
    });

    let btn;
    let input = $state("");
    let cardExportType = $state("");
    let cardExportType2 = $state("charxJpeg");
    let cardLicense = $state("");
    let generationInfoMenuIndex = $state(0);
    let branchHover: null | {
        x: number;
        y: number;
        content: string;
    } = $state(null);
    let copiedKey: string | null = $state(null);

    $effect(() => {
        void loadDetailedOSLabel();
    });

    async function copyToClipboard(text: string, key: string) {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // fallback
            const textarea = document.createElement("textarea");
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
        }
        copiedKey = key;
        setTimeout(() => {
            if (copiedKey === key) copiedKey = null;
        }, 1500);
    }

    async function loadDetailedOSLabel() {
        try {
            osLabel = await getDetailedOSLabel();
        } catch (error) {
            console.warn("Failed to load detailed OS information:", error);
        }
    }

    $effect.pre(() => {
        showDetails = false;
        translatedStackTrace = "";
        stackTraceTranslationFailed = false;
        isTranslating = false;
        if (btn) {
            btn.focus();
        }
        if ($alertStore.type !== "input") {
            input = "";
        }
        if ($alertStore.type !== "branches") {
            branchHover = null;
        }
        if ($alertStore.type !== "cardexport") {
            cardExportType = "";
            cardExportType2 = "charxJpeg";
            cardLicense = "";
        }
    });

    $effect(() => {
        if (
            $alertStore.type === "error" &&
            $alertStore.stackTrace &&
            !translatedStackTrace &&
            !stackTraceTranslationFailed &&
            !isTranslating
        ) {
            void loadTranslatedTrace();
        }
    });

    /**
     * The character whose chats the branch view shows: its chats are pinned while the view is open
     * (pinned before they load) and the view renders once they are loaded.
     */
    let branchCharacter: string | null = $state(null);
    $effect(() => {
        if ($alertStore.type !== "branches") {
            return;
        }
        const chaId = untrack(() => selectedCharacter()?.chaId);
        if (chaId === undefined) {
            return;
        }
        const release = pinChats(chaId);
        let open = true;
        // Untracked: the effect follows the alert only (the branches below follow the chats).
        untrack(() => loadChats(chaId))
            .then(() => {
                if (open) {
                    branchCharacter = chaId;
                }
            })
            .catch((error) => console.error(error));
        return () => {
            open = false;
            release();
            branchCharacter = null;
        };
    });
    const branches = $derived(branchCharacter === null ? [] : getChatBranches(branchCharacter));

    /** The text of a branch node: the message at its depth in the chat it was first seen in. */
    function branchText(chatId: string, y: number): string {
        return branchCharacter === null
            ? ""
            : (findChat({ chaId: branchCharacter, chatId })?.message[y - 1]?.data ?? "");
    }

    async function loadTranslatedTrace() {
        if (isTranslating || translatedStackTrace || stackTraceTranslationFailed || !$alertStore.stackTrace) return;
        isTranslating = true;
        try {
            const result = await translateStackTrace($alertStore.stackTrace);
            if (result.didTranslate) {
                translatedStackTrace = result.stackTrace;
            } else {
                stackTraceTranslationFailed = true;
            }
        } catch (e) {
            console.error("Failed to translate stack trace:", e);
            stackTraceTranslationFailed = true;
        } finally {
            isTranslating = false;
        }
    }

    const beautifyJSON = (data: string) => {
        try {
            return JSON.stringify(JSON.parse(data), null, 2);
        } catch (error) {
            return data;
        }
    };

    /** Edits the text of one HypaV2 chunk of the selected chat (the whole memory data is saved through the chat module). */
    function setHypaV2ChunkText(list: "chunks" | "mainChunks", index: number, text: string) {
        const data = selectedChat()?.hypaV2Data;
        if (!data?.[list]?.[index]) {
            return;
        }
        const next = JSON.parse(JSON.stringify(data)) as Chat["hypaV2Data"];
        next[list][index].text = text;
        setCurrentChatMeta({ hypaV2Data: next });
    }
</script>

{#if $alertStore.type !== "none" && $alertStore.type !== "toast" && $alertStore.type !== "cardexport" && $alertStore.type !== "branches" && $alertStore.type !== "selectModule" && $alertStore.type !== "pukmakkurit" && $alertStore.type !== "requestlogs" && $alertStore.type !== "upstreamImportReport"}
    <div
        data-alert-dialog
        class="absolute w-full h-full z-50 bg-black/50 flex justify-center items-center"
        class:vis={$alertStore.type === "wait2"}
    >
        <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl max-h-full overflow-y-auto">
            {#if $alertStore.type === "error"}
                <h2 class="text-red-700 mt-0 mb-2 w-40 max-w-full">Error</h2>
            {:else if $alertStore.type === "ask"}
                <h2 class="text-green-700 mt-0 mb-2 w-40 max-w-full">Confirm</h2>
            {:else if $alertStore.type === "pluginconfirm"}
                <h2 class="text-green-700 mt-0 mb-2 w-40 max-w-full">Plugin Import</h2>
            {:else if $alertStore.type === "selectChar"}
                <h2 class="text-green-700 mt-0 mb-2 w-40 max-w-full">Select</h2>
            {:else if $alertStore.type === "input"}
                <h2 class="text-green-700 mt-0 mb-2 w-40 max-w-full">Input</h2>
            {/if}
            {#if $alertStore.type === "markdown"}
                <div class="overflow-y-auto">
                    <span class="text-gray-300 chattext prose chattext2" class:prose-invert={$ColorSchemeTypeStore}>
                        {#await ParseMarkdown($alertStore.msg) then msg}
                            {@html msg}
                        {/await}
                    </span>
                </div>
            {:else if $alertStore.type === "pluginconfirm"}
                {@const parts = $alertStore.msg.split("\n\n")}
                {@const mainPart = parts[0]}
                {@const confirmMessage = parts[1]}
                {@const mainParts = mainPart.split("\n")}
                {@const pluginName = mainParts[0]}
                {@const warnings = mainParts.slice(1)}
                <div class="plugin-confirm-content">
                    <p class="plugin-name">{pluginName}</p>
                    {#if warnings.length > 0}
                        <ul class="warnings-list">
                            {#each warnings as warning}
                                <li class="warning-item">{warning}</li>
                            {/each}
                        </ul>
                    {/if}
                    <p class="confirm-message">{confirmMessage}</p>
                </div>
            {:else if $alertStore.type !== "select" && $alertStore.type !== "requestdata" && $alertStore.type !== "addchar" && $alertStore.type !== "hypaV2" && $alertStore.type !== "chatOptions"}
                <span class="text-gray-300 whitespace-pre-wrap">{$alertStore.msg}</span>
                {#if $alertStore.submsg && $alertStore.type !== "progress"}
                    <span class="text-gray-500 text-sm">{$alertStore.submsg}</span>
                {/if}

                {#if $alertStore.type === "error" && $alertStore.stackTrace}
                    <div class="mt-4">
                        <Button styled="outlined" size="sm" onclick={() => (showDetails = !showDetails)}>
                            {showDetails ? language.hideErrorDetails : language.showErrorDetails}
                            {#if showDetails}
                                <XIcon class="inline ml-2" />
                            {:else}
                                <ChevronRightIcon class="inline ml-2" />
                            {/if}
                        </Button>
                        {#if showDetails}
                            <div class="stack-trace-wrap">
                                <button
                                    class="stack-trace-copy"
                                    onclick={() => copyToClipboard(stackTraceCodeBlock, "stack-trace")}
                                    title={language.copy}
                                    aria-label={language.copy}
                                >
                                    {#if copiedKey === "stack-trace"}
                                        <CheckIcon size={14} />
                                    {:else}
                                        <CopyIcon size={14} />
                                    {/if}
                                </button>
                                <pre class="stack-trace">{stackTraceCodeBlock}</pre>
                            </div>
                        {/if}
                    </div>
                {/if}

                {#if $alertStore.type === "error" && $alertStore.jobFailure}
                    {@const failure = $alertStore.jobFailure}
                    <div class="mt-4 flex flex-wrap gap-2">
                        <Button
                            styled="outlined"
                            size="sm"
                            onclick={() => copyToClipboard(jobDebugInfo(failure, risuVersion), "job-debug")}
                        >
                            {#if copiedKey === "job-debug"}
                                <CheckIcon size={14} class="inline mr-2 text-success-500" />
                            {:else}
                                <CopyIcon size={14} class="inline mr-2" />
                            {/if}
                            {language.copyDebugInfo}
                        </Button>
                        <Button
                            styled="outlined"
                            size="sm"
                            onclick={() => {
                                // The history replaces this error: close it first (the viewer queues behind it otherwise).
                                const jobId = failure.jobId;
                                const own = shown;
                                alertStore.answer("", own);
                                alertRequestLogs({ jobId });
                            }}
                        >
                            {language.openInRequestHistory}
                        </Button>
                    </div>
                {/if}
            {/if}
            {#if $alertStore.type === "progress"}
                <div class="w-full min-w-64 md:min-w-138 h-2 bg-darkbg border border-darkborderc rounded-md mt-6">
                    <div
                        class="h-full bg-linear-to-r from-blue-500 to-purple-800 saving-animation transition-[width]"
                        style:width={$alertStore.submsg + "%"}
                    ></div>
                </div>
                <div class="w-full flex justify-center mt-6">
                    <span class="text-gray-500 text-sm">{$alertStore.submsg + "%"}</span>
                </div>
            {/if}

            {#if $alertStore.type === "ask" || $alertStore.type === "pluginconfirm"}
                <div class="flex gap-2 w-full">
                    <Button
                        className="mt-4 grow"
                        onclick={() => {
                            alertStore.answer("yes");
                        }}>YES</Button
                    >
                    <Button
                        className="mt-4 grow"
                        onclick={() => {
                            alertStore.answer("no");
                        }}>NO</Button
                    >
                </div>
            {:else if $alertStore.type === "select"}
                {@const hasDisplay = $alertStore.msg.startsWith("__DISPLAY__")}
                {#if hasDisplay}
                    {@const parts = $alertStore.msg.substring(11).split("||")}
                    <div class="mb-4 text-textcolor">{parts[0]}</div>
                    {#each parts.slice(1) as n, i}
                        <Button
                            className="mt-4"
                            onclick={() => {
                                alertStore.answer(i.toString());
                            }}>{n}</Button
                        >
                    {/each}
                {:else}
                    {@const parts = $alertStore.msg.split("||")}
                    {#each parts as n, i}
                        <Button
                            className="mt-4"
                            onclick={() => {
                                alertStore.answer(i.toString());
                            }}>{n}</Button
                        >
                    {/each}
                {/if}
            {:else if $alertStore.type === "error" || $alertStore.type === "normal" || $alertStore.type === "markdown"}
                <Button
                    className="mt-4"
                    onclick={() => {
                        alertStore.answer("");
                    }}>OK</Button
                >
            {:else if $alertStore.type === "input"}
                <TextInput
                    value={$alertStore.defaultValue}
                    id="alert-input"
                    autocomplete="off"
                    marginTop
                    list="alert-input-list"
                />
                <Button
                    className="mt-4"
                    onclick={() => {
                        alertStore.answer(
                            (document.querySelector("#alert-input") as HTMLInputElement | null)?.value ?? "",
                        );
                    }}>OK</Button
                >
                {#if $alertStore.datalist}
                    <datalist id="alert-input-list">
                        {#each $alertStore.datalist as item}
                            <option value={item[0]} label={item[1] ? item[1] : item[0]}
                                >{item[1] ? item[1] : item[0]}</option
                            >
                        {/each}
                    </datalist>
                {/if}
            {:else if $alertStore.type === "selectChar"}
                <div class="flex w-full items-start flex-wrap gap-2 justify-start">
                    {#each characterList() as char, i}
                        {#if char.type !== "group"}
                            {#if char.image}
                                {#await getCharImage(char.image, "css")}
                                    <BarIcon
                                        onClick={() => {
                                            alertStore.answer(char.chaId);
                                        }}
                                    >
                                        <User />
                                    </BarIcon>
                                {:then im}
                                    <BarIcon
                                        onClick={() => {
                                            alertStore.answer(char.chaId);
                                        }}
                                        additionalStyle={im}
                                    />
                                {/await}
                            {:else}
                                <BarIcon
                                    onClick={() => {
                                        alertStore.answer(char.chaId);
                                    }}
                                >
                                    <User />
                                </BarIcon>
                            {/if}
                        {/if}
                    {/each}
                </div>
            {:else if $alertStore.type === "requestdata" && requestInfo}
                {#if aiLawApplies()}
                    <div>
                        {language.generatedByAIDisclaimer}
                    </div>
                {/if}
                <div class="flex flex-wrap gap-2">
                    <Button
                        selected={generationInfoMenuIndex === 0}
                        size="sm"
                        onclick={() => {
                            generationInfoMenuIndex = 0;
                        }}
                    >
                        {language.tokens}
                    </Button>
                    <Button
                        selected={generationInfoMenuIndex === 1}
                        size="sm"
                        onclick={() => {
                            generationInfoMenuIndex = 1;
                        }}
                    >
                        {language.metaData}
                    </Button>
                    <Button
                        selected={generationInfoMenuIndex === 2}
                        size="sm"
                        onclick={() => {
                            generationInfoMenuIndex = 2;
                        }}
                    >
                        {language.log}
                    </Button>
                    <Button
                        selected={generationInfoMenuIndex === 3}
                        size="sm"
                        onclick={() => {
                            generationInfoMenuIndex = 3;
                        }}
                    >
                        {language.prompt}
                    </Button>
                    <button
                        class="ml-auto"
                        onclick={() => {
                            alertStore.answer("");
                        }}>✖</button
                    >
                </div>
                {#if generationInfoMenuIndex === 0}
                    <div class="mt-4 flex justify-center w-full">
                        <div
                            class="w-32 h-32 border-darkborderc border-4 rounded-lg"
                            style:background={`linear-gradient(0deg,
                            rgb(59,130,246) 0%,
                            rgb(59,130,246) ${(requestInfo.genInfo.inputTokens / requestInfo.genInfo.maxContext) * 100}%,
                            rgb(34 197 94) ${(requestInfo.genInfo.inputTokens / requestInfo.genInfo.maxContext) * 100}%,
                            rgb(34 197 94) ${((requestInfo.genInfo.outputTokens + requestInfo.genInfo.inputTokens) / requestInfo.genInfo.maxContext) * 100}%,
                            rgb(156 163 175) ${((requestInfo.genInfo.outputTokens + requestInfo.genInfo.inputTokens) / requestInfo.genInfo.maxContext) * 100}%,
                            rgb(156 163 175) 100%)`}
                        ></div>
                    </div>
                    <div class="grid grid-cols-2 gap-y-2 gap-x-4 mt-4">
                        <span class="text-blue-500">{language.inputTokens}</span>
                        <span class="text-blue-500 justify-self-end"
                            >{requestInfo.genInfo.inputTokens ?? "?"} {language.tokens}</span
                        >
                        <span class="text-green-500">{language.outputTokens}</span>
                        <span class="text-green-500 justify-self-end"
                            >{requestInfo.genInfo.outputTokens ?? "?"} {language.tokens}</span
                        >
                        <span class="text-gray-400">{language.maxContextSize}</span>
                        <span class="text-gray-400 justify-self-end"
                            >{requestInfo.genInfo.maxContext ?? "?"} {language.tokens}</span
                        >
                    </div>
                    <span class="text-textcolor2 text-sm">{language.tokenWarning}</span>
                {/if}
                {#if generationInfoMenuIndex === 1}
                    <div class="grid grid-cols-2 gap-y-2 gap-x-4 mt-4">
                        <span class="text-blue-500">Index</span>
                        <span class="text-blue-500 justify-self-end">{requestInfo.idx}</span>
                        <span class="text-amber-500">Model</span>
                        <span class="text-amber-500 justify-self-end">{requestInfo.genInfo.model}</span>
                        <span class="text-green-500">ID</span>
                        <span class="text-green-500 justify-self-end">{requestMessage?.chatId ?? "None"}</span>
                        <span class="text-red-500">GenID</span>
                        <span class="text-red-500 justify-self-end">{requestInfo.genInfo.generationId}</span>
                        <span class="text-cyan-500">Saying</span>
                        <span class="text-cyan-500 justify-self-end">{requestMessage?.saying ?? ""}</span>
                        <span class="text-purple-500">Size</span>
                        <span class="text-purple-500 justify-self-end"
                            >{requestMessage ? JSON.stringify(requestMessage).length : 0} Bytes</span
                        >
                        <span class="text-yellow-500">Time</span>
                        <span class="text-yellow-500 justify-self-end"
                            >{new Date(requestMessage?.time ?? 0).toLocaleString()}</span
                        >
                        {#if requestInfo.genInfo.stageTiming}
                            {@const stage1 = parseFloat(
                                ((requestInfo.genInfo.stageTiming.stage1 ?? 0) / 1000).toFixed(1),
                            )}
                            {@const stage2 = parseFloat(
                                ((requestInfo.genInfo.stageTiming.stage2 ?? 0) / 1000).toFixed(1),
                            )}
                            {@const stage3 = parseFloat(
                                ((requestInfo.genInfo.stageTiming.stage3 ?? 0) / 1000).toFixed(1),
                            )}
                            {@const stage4 = parseFloat(
                                ((requestInfo.genInfo.stageTiming.stage4 ?? 0) / 1000).toFixed(1),
                            )}
                            {@const totalRounded = (stage1 + stage2 + stage3 + stage4).toFixed(1)}
                            <span class="text-gray-400">Timing</span>
                            <span class="text-gray-400 justify-self-end">
                                <span style="color: #60a5fa;">{stage1}</span> +
                                <span style="color: #db2777;">{stage2}</span> +
                                <span style="color: #34d399;">{stage3}</span> +
                                <span style="color: #8b5cf6;">{stage4}</span> =
                                <span class="text-white font-bold">{totalRounded}s</span>
                            </span>
                        {/if}

                        <span class="text-green-500">Tokens</span>
                        {#await tokenize(requestMessage?.data ?? "")}
                            <span class="text-green-500 justify-self-end">Loading</span>
                        {:then tokens}
                            <span class="text-green-500 justify-self-end">{tokens}</span>
                        {/await}
                    </div>
                {/if}
                {#if generationInfoMenuIndex === 2}
                    {#await getFetchData($alertStore.msg) then data}
                        {#if !data}
                            <span class="text-gray-300 text-lg mt-2">{language.errors.requestLogRemoved}</span>
                            <span class="text-gray-500">{language.errors.requestLogRemovedDesc}</span>
                        {:else}
                            <h1 class="text-2xl font-bold my-4">URL</h1>
                            <code class="text-gray-300 border border-darkborderc p-2 rounded-md whitespace-pre-wrap"
                                >{data.url}</code
                            >
                            <h1 class="text-2xl font-bold my-4">Request Body</h1>
                            <code class="text-gray-300 border border-darkborderc p-2 rounded-md whitespace-pre-wrap"
                                >{beautifyJSON(data.body)}</code
                            >
                            <h1 class="text-2xl font-bold my-4">Response</h1>
                            <code class="text-gray-300 border border-darkborderc p-2 rounded-md whitespace-pre-wrap"
                                >{beautifyJSON(data.response)}</code
                            >
                        {/if}
                    {/await}
                {/if}
                {#if generationInfoMenuIndex === 3}
                    {@const promptInfo = requestMessage?.promptInfo}
                    {#if !promptInfo || Object.keys(promptInfo).length === 0}
                        <div class="text-gray-300 text-lg mt-2">{language.promptInfoEmptyMessage}</div>
                    {:else}
                        <div class="grid grid-cols-2 gap-y-2 gap-x-4 mt-4">
                            <span class="text-blue-500">Preset Name</span>
                            <span class="text-blue-500 justify-self-end">{promptInfo.promptName}</span>
                            <span class="text-purple-500">Toggles</span>
                            <div
                                class="col-span-2 max-h-32 overflow-y-auto border border-stone-500 rounded-sm p-2 bg-gray-900"
                            >
                                {#if (promptInfo.promptToggles ?? []).length === 0}
                                    <div class="text-gray-500 italic text-center py-4">
                                        {language.promptInfoEmptyToggle}
                                    </div>
                                {:else}
                                    <div class="grid grid-cols-2 gap-y-2 gap-x-4">
                                        {#each promptInfo.promptToggles ?? [] as toggle}
                                            <span class="text-gray-200 truncate">{toggle.key}</span>
                                            <span class="text-gray-200 justify-self-end truncate">{toggle.value}</span>
                                        {/each}
                                    </div>
                                {/if}
                            </div>
                            <span class="text-red-500">Prompt Text</span>
                            <div
                                class="col-span-2 max-h-80 overflow-y-auto border border-stone-500 rounded-sm p-4 bg-gray-900"
                            >
                                {#if !promptInfo.promptText}
                                    <div class="text-gray-500 italic text-center py-4">
                                        {language.promptInfoEmptyText}
                                    </div>
                                {:else}
                                    {#each promptInfo.promptText as block}
                                        <div class="mb-2">
                                            <div class="font-bold text-gray-600">{block.role}</div>
                                            <pre
                                                class="whitespace-pre-wrap text-sm bg-stone-900 p-2 rounded-sm border border-stone-500">{block.content}</pre>
                                        </div>
                                    {/each}
                                {/if}
                            </div>
                        </div>
                    {/if}
                {/if}
            {:else if $alertStore.type === "hypaV2" && currentChat}
                <div class="flex flex-wrap gap-2 mb-4 max-w-full w-124">
                    <Button
                        selected={generationInfoMenuIndex === 0}
                        size="sm"
                        onclick={() => {
                            generationInfoMenuIndex = 0;
                        }}
                    >
                        Chunks
                    </Button>
                    <Button
                        selected={generationInfoMenuIndex === 1}
                        size="sm"
                        onclick={() => {
                            generationInfoMenuIndex = 1;
                        }}
                    >
                        Summarized
                    </Button>
                    <button
                        class="ml-auto"
                        onclick={() => {
                            alertStore.answer("");
                        }}>✖</button
                    >
                </div>
                {#if generationInfoMenuIndex === 0}
                    <div class="flex flex-col gap-2 w-full">
                        {#each currentChat.hypaV2Data.chunks as chunk, i}
                            <TextAreaInput
                                bind:value={() => chunk.text, (text) => setHypaV2ChunkText("chunks", i, text)}
                            />
                        {/each}

                        <!-- Adding non-bound chunk is not okay, change the user flow to edit existing ones. -->
                    </div>
                {:else}
                    {#each currentChat.hypaV2Data.mainChunks as chunk, i}
                        <!-- Summarized should be mainChunks, afaik. Be aware of that chunks are created with mainChunks, however this editing would not change related chunks. -->
                        <div class="flex flex-col p-2 rounded-md border-darkborderc border">
                            {#if i === 0}
                                <span class="text-green-500">Active</span>
                            {:else}
                                <span>Inactive</span>
                            {/if}
                            <TextAreaInput
                                bind:value={() => chunk.text, (text) => setHypaV2ChunkText("mainChunks", i, text)}
                            />
                        </div>
                    {/each}
                {/if}
            {:else if $alertStore.type === "addchar"}
                <div class="w-2xl flex flex-col max-w-full">
                    <button
                        class="border-darkborderc border py-12 px-8 flex rounded-md hover:ring-2 justify-center items-center"
                        onclick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            alertStore.answer("importFromRealm");
                        }}
                    >
                        <div class="flex flex-col justify-start items-start">
                            <span class="text-2xl font-bold">{language.importFromRealm}</span>
                            <span class="text-textcolor2">{language.importFromRealmDesc}</span>
                        </div>
                        <div class="ml-9 float-right flex-1 flex justify-end">
                            <ChevronRightIcon />
                        </div>
                    </button>
                    <button
                        class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2"
                        onclick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            alertStore.answer("importCharacter");
                        }}
                    >
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.importCharacter}</span>
                        </div>
                        <div class="ml-9 float-right flex-1 flex justify-end">
                            <ChevronRightIcon />
                        </div>
                    </button>
                    <button
                        class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2"
                        onclick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            alertStore.answer("createfromScratch");
                        }}
                    >
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.createfromScratch}</span>
                        </div>
                        <div class="ml-9 float-right flex-1 flex justify-end">
                            <ChevronRightIcon />
                        </div>
                    </button>
                    <button
                        class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2"
                        onclick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            alertStore.answer("cancel");
                        }}
                    >
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.cancel}</span>
                        </div>
                    </button>
                </div>
            {:else if $alertStore.type === "chatOptions"}
                <div class="w-2xl flex flex-col max-w-full">
                    <h1 class="text-xl mb-4 font-bold">
                        {language.chatOptions}
                    </h1>
                    <button
                        class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2"
                        onclick={() => {
                            alertStore.answer("0");
                        }}
                    >
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.createCopy}</span>
                        </div>
                        <div class="ml-9 float-right flex-1 flex justify-end">
                            <ChevronRightIcon />
                        </div>
                    </button>
                    <button
                        class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2"
                        onclick={() => {
                            alertStore.answer("1");
                        }}
                    >
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.chatBinding.chatSettings}</span>
                        </div>
                        <div class="ml-9 float-right flex-1 flex justify-end">
                            <ChevronRightIcon />
                        </div>
                    </button>
                    <button
                        class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2"
                        onclick={() => {
                            alertStore.answer("cancel");
                        }}
                    >
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.cancel}</span>
                        </div>
                    </button>
                </div>
            {/if}
        </div>
    </div>
{:else if $alertStore.type === "cardexport"}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
        data-alert-dialog
        class="fixed top-0 left-0 h-full w-full bg-black/50 flex flex-col z-50 items-center justify-center"
        role="button"
        tabindex="0"
        onclick={close}
    >
        <div
            class="bg-darkbg rounded-md p-4 max-w-full flex flex-col w-2xl"
            role="button"
            tabindex="0"
            onclick={(e) => {
                e.stopPropagation();
            }}
        >
            <h1 class="font-bold text-2xl w-full">
                <span>
                    {language.shareExport}
                </span>
                <button
                    class="float-right text-textcolor2 hover:text-green-500"
                    onclick={() => {
                        alertStore.answer(
                            JSON.stringify({
                                type: "cancel",
                                type2: cardExportType2,
                            }),
                        );
                    }}
                >
                    <XIcon />
                </button>
            </h1>
            <span class="text-textcolor mt-4">{language.type}</span>
            {#if cardExportType === ""}
                <span class="text-textcolor2 text-sm">{language.ccv3Desc}</span>
                {#if cardExportType2 !== "charx" && cardExportType2 !== "charxJpeg" && isCharacterHasAssets(currentCharacter)}
                    <span class="text-red-500 text-sm">{language.notCharxWarn}</span>
                {/if}
            {:else if cardExportType === "ccv2"}
                <span class="text-textcolor2 text-sm">{language.ccv2Desc}</span>
                <span class="text-red-500 text-sm">{language.v2Warning}</span>
            {/if}
            <div class="flex items-center flex-wrap mt-2">
                <button
                    class="bg-bgcolor px-2 py-4 rounded-lg flex-1"
                    class:ring-1={cardExportType === ""}
                    onclick={() => {
                        cardExportType = "";
                        cardExportType2 = "charxJpeg";
                    }}>Character Card V3</button
                >
                <button
                    class="bg-bgcolor px-2 py-4 rounded-lg ml-2 flex-1"
                    class:ring-1={cardExportType === "ccv2"}
                    onclick={() => {
                        cardExportType = "ccv2";
                    }}>Character Card V2</button
                >
            </div>
            {#if cardExportType === ""}
                <span class="text-textcolor mt-4">{language.format}</span>
                <SelectInput bind:value={cardExportType2} className="mt-2">
                    <OptionInput value="charx">CHARX</OptionInput>
                    <OptionInput value="charxJpeg">CHARX-JPEG</OptionInput>
                    <OptionInput value="">PNG</OptionInput>
                    <OptionInput value="json">JSON</OptionInput>
                </SelectInput>
            {/if}
            <Button
                className="mt-4"
                onclick={() => {
                    alertStore.answer(
                        JSON.stringify({
                            type: cardExportType,
                            type2: cardExportType2,
                        }),
                    );
                }}>{language.export}</Button
            >
        </div>
    </div>
{:else if $alertStore.type === "toast"}
    <!-- Keyed: each toast runs its own animation, and its end clears the status only while it is still that toast. -->
    {#each [$alertStore] as toast (toast)}
        <div
            class="toast-anime absolute right-0 bottom-0 bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl max-h-11/12 overflow-y-auto z-50 text-textcolor"
            onanimationend={() => {
                alertStore.clearStatus(toast);
            }}
        >
            {toast.msg}
        </div>
    {/each}
{:else if $alertStore.type === "selectModule"}
    <div data-alert-dialog class="contents">
        <ModuleChatMenu
            alertMode
            close={(d) => {
                alertStore.answer(d);
            }}
        />
    </div>
{:else if $alertStore.type === "pukmakkurit"}
    <!-- Log Generator by dootaang, GPL3 -->
    <!-- Svelte, Typescript version by Kwaroran -->

    <div data-alert-dialog class="absolute w-full h-full z-50 bg-black/50 flex justify-center items-center">
        <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl max-h-full overflow-y-auto">
            <h2 class="text-green-700 mt-0 mb-2 w-40 max-w-full">{language.preview}</h2>
        </div>
    </div>
{:else if $alertStore.type === "branches"}
    <div
        data-alert-dialog
        class="absolute w-full h-full z-50 bg-black/80 flex justify-center items-center overflow-x-auto overflow-y-auto"
    >
        {#if branchHover !== null}
            <div
                class="z-30 whitespace-pre-wrap p-4 text-textcolor bg-darkbg border-darkborderc border rounded-md absolute"
                style="top: {branchHover.y * 80 + 24}px; left: {(branchHover.x + 1) * 80 + 24}px"
            >
                {branchHover.content}
            </div>
        {/if}

        <div class="x-50 right-2 top-2 absolute">
            <button
                class="bg-darkbg border-darkborderc border p-2 rounded-md"
                onclick={() => {
                    alertStore.answer("");
                }}
            >
                <XIcon />
            </button>
        </div>

        {#each branches as obj}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <div
                role="table"
                class="peer w-12 h-12 z-20 bg-bgcolor border border-darkborderc rounded-full flex justify-center items-center overflow-y-auto absolute"
                style="top: {obj.y * 80 + 24}px; left: {obj.x * 80 + 24}px"
                onmouseenter={() => {
                    if (branchHover === null) {
                        branchHover = {
                            x: obj.x,
                            y: obj.y,
                            content: branchText(obj.chatId, obj.y),
                        };
                    }
                }}
                onclick={() => {
                    if (branchHover === null) {
                        branchHover = {
                            x: obj.x,
                            y: obj.y,
                            content: branchText(obj.chatId, obj.y),
                        };
                    }
                }}
                onmouseleave={() => {
                    branchHover = null;
                }}
            ></div>
            {#if obj.connectX === obj.x}
                {#if obj.multiChild}
                    <div
                        class="w-0 h-20 border-x border-x-red-500 absolute"
                        style="top: {(obj.y - 1) * 80 + 24}px; left: {obj.x * 80 + 45}px"
                    ></div>
                {:else}
                    <div
                        class="w-0 h-20 border-x border-x-blue-500 absolute"
                        style="top: {(obj.y - 1) * 80 + 24}px; left: {obj.x * 80 + 45}px"
                    ></div>
                {/if}
            {:else if obj.connectX !== -1}
                <div
                    class="w-0 h-10 border-x border-x-red-500 absolute"
                    style="top: {obj.y * 80}px; left: {obj.x * 80 + 45}px"
                ></div>
                <div
                    class="h-0 border-y border-y-red-500 absolute"
                    style="top: {obj.y * 80}px; left: {obj.connectX * 80 + 46}px"
                    style:width={Math.abs((obj.x - obj.connectX) * 80) + "px"}
                ></div>
            {/if}
        {/each}
    </div>
{:else if $alertStore.type === "requestlogs"}
    <div data-alert-dialog class="contents">
        <RequestLogsPopup />
    </div>
{:else if $alertStore.type === "upstreamImportReport"}
    <div data-alert-dialog class="contents">
        <UpstreamImportReport />
    </div>
{/if}

<style>
    .plugin-confirm-content .plugin-name {
        font-size: 1.25rem;
        font-weight: bold;
        color: white;
    }
    .plugin-confirm-content .warnings-list {
        list-style-type: disc;
        list-style-position: inside;
        margin-top: 0.5rem;
        margin-bottom: 0.5rem;
        padding-left: 1rem;
        color: #f87171; /* red-400 */
    }
    .plugin-confirm-content .warning-item {
        margin-bottom: 0.25rem;
    }
    .plugin-confirm-content .confirm-message {
        margin-top: 1rem;
        color: #d1d5db; /* gray-300 */
    }
    .break-any {
        word-break: normal;
        overflow-wrap: anywhere;
    }
    @keyframes toastAnime {
        0% {
            opacity: 0;
        }
        50% {
            opacity: 1;
        }
        100% {
            opacity: 0;
        }
    }

    .toast-anime {
        animation: toastAnime 1s ease-out;
    }

    .vis {
        opacity: 1 !important;
        --tw-bg-opacity: 1 !important;
    }

    .stack-trace-wrap {
        position: relative;
        margin-top: 0.5rem;
    }

    .stack-trace {
        background-color: var(--risu-theme-bgcolor);
        color: var(--risu-theme-textcolor2);
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.25rem;
        padding: 0.75rem 2.75rem 0.75rem 0.75rem;
        font-family: monospace;
        font-size: 0.75rem;
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 200px;
        overflow-y: auto;
    }

    .stack-trace-copy {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.75rem;
        height: 1.75rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.375rem;
        background-color: var(--risu-theme-darkbg);
        color: var(--risu-theme-textcolor2);
        transition:
            background-color 0.2s ease,
            color 0.2s ease,
            border-color 0.2s ease;
    }

    .stack-trace-copy:hover {
        background-color: var(--risu-theme-bgcolor);
        color: var(--risu-theme-textcolor);
    }
</style>
