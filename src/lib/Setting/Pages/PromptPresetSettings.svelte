<script lang="ts">
    import { settings, activePreset, currentPresetRecord } from "src/ts/storage/settingsViews.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";

    import { downloadFile } from "src/ts/globalApi.svelte";
    import { tokenizeAccurate } from "src/ts/tokenizer";
    import DropList from "src/lib/SideBars/DropList.svelte";
    import { PlusIcon, TrashIcon, HardDriveUploadIcon, DownloadIcon, UploadIcon, ListIcon } from "@lucide/svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import OobaSettings from "./OobaSettings.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import PromptSettings from "./PromptSettings.svelte";
    import { openPresetList } from "src/ts/stores.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { getModelInfoForMode, LLMFormat } from "src/ts/model/modellist";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { allBasicParameterItems } from "src/ts/setting/botSettingsParamsData";
    import BindingScopeNote from "../BindingScopeNote.svelte";
    import SettingsSections from "../SettingsSections.svelte";
    import { promptSettingsSections } from "src/ts/setting/promptSettingsData";

    /**
     * The prompt preset's page (`docs/plan/split-preset.md`, slice 4): the selected prompt preset's
     * sampling parameters, prompts and template, bias, regex, module integration, and icon. The
     * parameters shown follow the selected model preset's model.
     */

    let tokens = $state({
        mainPrompt: 0,
        jailbreak: 0,
        globalNote: 0,
    });

    interface Props {
        goPromptTemplate?: any;
    }

    let { goPromptTemplate = () => {} }: Props = $props();

    async function loadTokenize() {
        tokens.mainPrompt = await tokenizeAccurate(activePreset.mainPrompt, true);
        tokens.jailbreak = await tokenizeAccurate(activePreset.jailbreak, true);
        tokens.globalNote = await tokenizeAccurate(activePreset.globalNote, true);
    }

    let submenu = $state(settings.ui.useLegacyGUI ? -1 : 1);
    let modelInfo = $derived(getModelInfoForMode("model"));
    let subModelInfo = $derived(getModelInfoForMode("submodel"));
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.prompt}</h2>

<div class="flex items-center gap-2 mb-4 p-2 rounded-md border border-darkborderc">
    <span class="text-textcolor2 text-sm shrink-0">{language.promptPreset}</span>
    <BindingScopeNote field="promptPresetId" />
    {#if currentPresetRecord()?.image}
        <img src={currentPresetRecord()?.image} alt="icon" class="w-6 h-6 rounded-md" decoding="async" />
    {/if}
    <span class="grow truncate">{activePreset.name}</span>
    <Button
        size="sm"
        onclick={() => {
            $openPresetList = true;
        }}
    >
        <ListIcon size={16} />
    </Button>
</div>

{#if submenu !== -1}
    <div class="flex w-full rounded-md border border-darkborderc mb-4">
        <button
            onclick={() => {
                submenu = 1;
            }}
            class="p-2 flex-1 border-r border-darkborderc"
            class:bg-darkbutton={submenu === 1}
        >
            <span>{language.parameters}</span>
        </button>
        <button
            onclick={() => {
                submenu = 2;
            }}
            class="p-2 flex-1 border-r border-darkborderc"
            class:bg-darkbutton={submenu === 2}
        >
            <span>{language.prompt}</span>
        </button>
        <button
            onclick={() => {
                submenu = 3;
            }}
            class="p-2 flex-1"
            class:bg-darkbutton={submenu === 3}
        >
            <span>{language.others}</span>
        </button>
    </div>
{/if}

{#if submenu === 1 || submenu === -1}
    <!-- Data-driven basic parameters -->
    <SettingRenderer items={allBasicParameterItems} {modelInfo} {subModelInfo} />
    {#if modelInfo.id === "textgen_webui" || modelInfo.id === "mancer" || modelInfo.id.startsWith("local_") || modelInfo.id.startsWith("hf:::")}
        <span class="text-textcolor">Repetition Penalty</span>
        <SliderInput
            min={1}
            max={1.5}
            step={0.01}
            fixed={2}
            marginBottom
            bind:value={activePreset.ooba.repetition_penalty}
        />
        <span class="text-textcolor">Length Penalty</span>
        <SliderInput
            min={-5}
            max={5}
            step={0.05}
            marginBottom
            fixed={2}
            bind:value={activePreset.ooba.length_penalty}
        />
        <span class="text-textcolor">Top K</span>
        <SliderInput min={0} max={100} step={1} marginBottom bind:value={activePreset.ooba.top_k} />
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.ooba.top_p} />
        <span class="text-textcolor">Typical P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.ooba.typical_p} />
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.ooba.top_a} />
        <span class="text-textcolor">No Repeat n-gram Size</span>
        <SliderInput min={0} max={20} step={1} marginBottom bind:value={activePreset.ooba.no_repeat_ngram_size} />
        <div class="flex items-center mt-4">
            <Check bind:check={activePreset.ooba.do_sample} name={"Do Sample"} />
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={activePreset.ooba.add_bos_token} name={"Add BOS Token"} />
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={activePreset.ooba.ban_eos_token} name={"Ban EOS Token"} />
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={activePreset.ooba.skip_special_tokens} name={"Skip Special Tokens"} />
        </div>
        <div class="flex items-center mt-4">
            <Check
                check={!!activePreset.localStopStrings}
                name={language.customStopWords}
                onChange={() => {
                    if (!activePreset.localStopStrings) {
                        activePreset.localStopStrings = [];
                    } else {
                        activePreset.localStopStrings = null;
                    }
                }}
            />
        </div>
        {#if activePreset.localStopStrings}
            <div class="flex flex-col p-2 rounded-sm border border-selected mt-2 gap-1">
                <div class="p-2">
                    <button
                        class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                        onclick={() => {
                            let localStopStrings = activePreset.localStopStrings;
                            localStopStrings.push("");
                            activePreset.localStopStrings = localStopStrings;
                        }}><PlusIcon /></button
                    >
                </div>
                {#each activePreset.localStopStrings as stopString, i}
                    <div class="flex w-full">
                        <div class="grow">
                            <TextInput marginBottom bind:value={activePreset.localStopStrings[i]} fullwidth fullh />
                        </div>
                        <div>
                            <button
                                class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                                onclick={() => {
                                    let localStopStrings = activePreset.localStopStrings;
                                    localStopStrings.splice(i, 1);
                                    activePreset.localStopStrings = localStopStrings;
                                }}><TrashIcon /></button
                            >
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
        <Check bind:check={activePreset.ooba.formating.useName} name={language.useNamePrefix} />
    {:else if modelInfo.format === LLMFormat.NovelAI}
        <Check bind:check={activePreset.NAIadventure} name={language.textAdventureNAI} />
        <Check bind:check={activePreset.NAIappendName} name={language.appendNameNAI} />
        <div class="flex flex-col p-3 bg-darkbg mt-4">
            <span class="text-textcolor">Starter</span>
            <TextInput bind:value={activePreset.NAISettings.starter} placeholder={"⁂"} />
            <span class="text-textcolor">Seperator</span>
            <TextInput bind:value={activePreset.NAISettings.seperator} placeholder={"\\n"} />
        </div>
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.NAISettings.topP} />
        <span class="text-textcolor">Top K</span>
        <SliderInput min={0} max={100} step={1} marginBottom bind:value={activePreset.NAISettings.topK} />
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.NAISettings.topA} />
        <span class="text-textcolor">Tailfree Sampling</span>
        <SliderInput
            min={0}
            max={1}
            step={0.001}
            marginBottom
            fixed={3}
            bind:value={activePreset.NAISettings.tailFreeSampling}
        />
        <span class="text-textcolor">Typical P</span>
        <SliderInput
            min={0}
            max={1}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.typicalp}
        />
        <span class="text-textcolor">Repetition Penalty</span>
        <SliderInput
            min={0}
            max={3}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.repetitionPenalty}
        />
        <span class="text-textcolor">Repetition Penalty Range</span>
        <SliderInput
            min={0}
            max={8192}
            step={1}
            marginBottom
            fixed={0}
            bind:value={activePreset.NAISettings.repetitionPenaltyRange}
        />
        <span class="text-textcolor">Repetition Penalty Slope</span>
        <SliderInput
            min={0}
            max={10}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.repetitionPenaltySlope}
        />
        <span class="text-textcolor">Frequency Penalty</span>
        <SliderInput
            min={-2}
            max={2}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.frequencyPenalty}
        />
        <span class="text-textcolor">Presence Penalty</span>
        <SliderInput
            min={-2}
            max={2}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.presencePenalty}
        />
        <span class="text-textcolor">Mirostat LR</span>
        <SliderInput
            min={0}
            max={1}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.mirostat_lr}
        />
        <span class="text-textcolor">Mirostat Tau</span>
        <SliderInput
            min={0}
            max={6}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.mirostat_tau}
        />
        <span class="text-textcolor">Cfg Scale</span>
        <SliderInput
            min={1}
            max={3}
            step={0.01}
            marginBottom
            fixed={2}
            bind:value={activePreset.NAISettings.cfg_scale}
        />
    {:else if modelInfo.format === LLMFormat.NovelList}
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={2} step={0.01} marginBottom fixed={2} bind:value={activePreset.ainconfig.top_p} />
        <span class="text-textcolor">Reputation Penalty</span>
        <SliderInput min={0} max={2} step={0.01} marginBottom fixed={2} bind:value={activePreset.ainconfig.rep_pen} />
        <span class="text-textcolor">Reputation Penalty Range</span>
        <SliderInput
            min={0}
            max={2048}
            step={1}
            marginBottom
            fixed={2}
            bind:value={activePreset.ainconfig.rep_pen_range}
        />
        <span class="text-textcolor">Reputation Penalty Slope</span>
        <SliderInput
            min={0}
            max={10}
            step={0.1}
            marginBottom
            fixed={2}
            bind:value={activePreset.ainconfig.rep_pen_slope}
        />
        <span class="text-textcolor">Top K</span>
        <SliderInput min={1} max={500} step={1} marginBottom fixed={2} bind:value={activePreset.ainconfig.top_k} />
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.ainconfig.top_a} />
        <span class="text-textcolor">Typical P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={activePreset.ainconfig.typical_p} />
    {:else}
        <!-- Standard parameters now handled by SettingRenderer above -->
    {/if}

    {#if (settings.providers.reverseProxyOobaMode && modelInfo.id === "reverse_proxy") || modelInfo.id === "ooba"}
        <OobaSettings instructionMode={modelInfo.id === "ooba"} />
    {/if}
{/if}

{#if submenu === 3 || submenu === -1}
    <Accordion styled name="Bias " help="bias">
        <table class="contain w-full max-w-full tabler">
            <tbody>
                <tr>
                    <th class="font-medium">Bias</th>
                    <th class="font-medium">{language.value}</th>
                    <th>
                        <button
                            class="font-medium cursor-pointer hover:text-green-500 w-full flex justify-center items-center"
                            onclick={() => {
                                let bia = activePreset.bias;
                                bia.push(["", 0]);
                                activePreset.bias = bia;
                            }}><PlusIcon /></button
                        >
                    </th>
                </tr>
                {#if activePreset.bias.length === 0}
                    <tr>
                        <td colspan="3" class="text-textcolor2">{language.noBias}</td>
                    </tr>
                {/if}
                {#each activePreset.bias as bias, i}
                    <tr>
                        <td class="font-medium truncate">
                            <TextInput bind:value={activePreset.bias[i][0]} size="lg" fullwidth />
                        </td>
                        <td class="font-medium truncate">
                            <NumberInput
                                bind:value={activePreset.bias[i][1]}
                                max={100}
                                min={-101}
                                size="lg"
                                fullwidth
                            />
                        </td>
                        <td>
                            <button
                                class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                                onclick={() => {
                                    let bia = activePreset.bias;
                                    bia.splice(i, 1);
                                    activePreset.bias = bia;
                                }}><TrashIcon /></button
                            >
                        </td>
                    </tr>
                {/each}
            </tbody>
        </table>
        <div class="text-textcolor2 mt-2 flex items-center gap-2">
            <button
                class="font-medium cursor-pointer hover:text-textcolor gap-2"
                onclick={() => {
                    const data = JSON.stringify(activePreset.bias, null, 2);
                    downloadFile("bias.json", data);
                }}><DownloadIcon /></button
            >
            <button
                class="font-medium cursor-pointer hover:text-textcolor"
                onclick={async () => {
                    // The shown preset can change while the file dialog is open: the bias goes to this preset.
                    const presetId = activePreset.id;
                    const sel = await selectSingleFile(["json"]);
                    if (!sel) {
                        return;
                    }
                    const parsed = JSON.parse(new TextDecoder().decode(sel.data));
                    const target = settings.presets.find((preset) => preset.id === presetId);
                    if (Array.isArray(parsed) && target) {
                        target.bias = parsed;
                    }
                }}><HardDriveUploadIcon /></button
            >
        </div>
    </Accordion>

    <Accordion styled name={language.promptTemplate}>
        {#if activePreset.promptTemplate}
            {#if submenu !== -1}
                <PromptSettings mode="inline" subMenu={1} />
            {/if}
        {:else}
            <Check
                check={false}
                name={language.usePromptTemplate}
                onChange={() => {
                    activePreset.promptTemplate = [];
                }}
            />
        {/if}
    </Accordion>

    <Accordion styled name={language.moduleIntergration} help="moduleIntergration">
        <TextAreaInput bind:value={activePreset.moduleIntergration} fullwidth height={"32"} autocomplete="off" />
    </Accordion>

    <Accordion styled name={language.regexScript}>
        <RegexList bind:value={activePreset.regex} buttons />
    </Accordion>

    <Accordion styled name={language.icon}>
        <div class="p-2 rounded-md border border-darkborderc flex flex-col items-center gap-2">
            <span>
                {language.preview}
            </span>
            <div class="flex items-center justify-center gap-2">
                {#if currentPresetRecord()?.image}
                    <img src={currentPresetRecord()?.image} alt="icon" class="w-6 h-6 rounded-md" decoding="async" />
                    <span class="text-textcolor2">{currentPresetRecord()?.name}</span>
                {:else}
                    <span class="text-textcolor2">{language.noImages}</span>
                {/if}
            </div>
        </div>
        <button
            class="mt-2 text-textcolor2 hover:text-textcolor focus-within:text-textcolor"
            onclick={async () => {
                // The selection can change while the file dialog is open: the image goes to this preset.
                const presetId = activePreset.id;
                const sel = await selectSingleFile(["png", "jpg", "jpeg", "webp"]);
                if (!sel) {
                    return;
                }
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d");
                const img = new Image();
                //@ts-expect-error Uint8Array buffer type (ArrayBufferLike) is incompatible with BlobPart's ArrayBuffer
                const blob = new Blob([sel.data], { type: "image/png" });
                img.src = URL.createObjectURL(blob);
                await img.decode();
                canvas.width = 48;
                canvas.height = 48;
                ctx.drawImage(img, 0, 0, 48, 48);
                const data = canvas.toDataURL("image/jpeg", 0.7);
                const target = settings.presets.find((preset) => preset.id === presetId);
                if (target) {
                    target.image = data; //Since its small (max 2304 pixels), its okay to store it directly
                }
            }}
        >
            <UploadIcon />
        </button>
    </Accordion>

    <SettingsSections sections={promptSettingsSections} />
{/if}

{#if submenu === 2 || submenu === -1}
    {#if !activePreset.promptTemplate}
        <span class="text-textcolor">{language.mainPrompt} <Help key="mainprompt" /></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={activePreset.mainPrompt}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.mainPrompt} {language.tokens}</span>
        <span class="text-textcolor">{language.jailbreakPrompt} <Help key="jailbreak" /></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={activePreset.jailbreak}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.jailbreak} {language.tokens}</span>
        <span class="text-textcolor">{language.globalNote} <Help key="globalNote" /></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={activePreset.globalNote}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.globalNote} {language.tokens}</span>
        <span class="text-textcolor mb-2 mt-4">{language.formatingOrder} <Help key="formatOrder" /></span>
        <DropList bind:list={activePreset.formatingOrder} />
        <div class="flex items-center mt-4">
            <Check bind:check={activePreset.promptPreprocess} name={language.promptPreprocess} />
        </div>
    {:else if submenu === 2}
        <PromptSettings mode="inline" />
    {/if}
{/if}

{#if activePreset.promptTemplate && submenu === -1}
    <div class="mt-2">
        <Button onclick={goPromptTemplate} size="sm">{language.promptTemplate}</Button>
    </div>
{/if}
