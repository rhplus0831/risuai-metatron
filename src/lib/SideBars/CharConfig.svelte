<script lang="ts">
    import { selectedChat } from "src/ts/storage/chatStore.svelte";
    import { selectedCharacter, characterList } from "src/ts/storage/characterStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { language } from "../../lang";
    import { tokenizeAccurate } from "../../ts/tokenizer";
    import { saveImage as saveAsset, type character, type groupChat } from "../../ts/storage/database.svelte";
    import { setCurrentChatMeta } from "../../ts/storage/chatEdits";
    import { untrack } from "svelte";
    import { CharConfigSubMenu, hypaV3ModalOpen } from "../../ts/stores.svelte";
    import {
        PlusIcon,
        SmileIcon,
        TrashIcon,
        UserIcon,
        ActivityIcon,
        BookIcon,
        User,
        Braces,
        Volume2Icon,
        DownloadIcon,
        HardDriveUploadIcon,
        Share2Icon,
        ImageIcon,
        ImageOffIcon,
        ArrowUp,
        ArrowDown,
    } from "@lucide/svelte";
    import Check from "../UI/GUI/CheckInput.svelte";
    import {
        addCharEmotion,
        addingEmotion,
        getCharImage,
        rmCharEmotion,
        selectCharImg,
        makeGroupImage,
        removeChar,
        changeCharImage,
    } from "../../ts/characters";
    import LoreBook from "./LoreBook/LoreBookSetting.svelte";
    import { alertNormal, showHypaV2Alert } from "../../ts/alert";
    import BarIcon from "./BarIcon.svelte";
    import { findCharacterbyId, getAuthorNoteDefaultText, selectMultipleFile, selectSingleFile } from "../../ts/util";
    import Help from "../Others/Help.svelte";
    import { exportChar } from "src/ts/characterCards";
    import {
        getElevenTTSVoices,
        getWebSpeechTTSVoices,
        getVOICEVOXVoices,
        oaiVoices,
        getNovelAIVoices,
    } from "src/ts/process/tts";
    import { getFileSrc } from "src/ts/globalApi.svelte";
    import { addGroupChar, rmCharFromGroup } from "src/ts/process/group";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import NumberInput from "../UI/GUI/NumberInput.svelte";
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import RegexList from "./Scripts/RegexList.svelte";
    import TriggerList from "./Scripts/TriggerList.svelte";
    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import { updateInlayScreen } from "src/ts/process/inlayScreen";
    import { registerOnnxModel } from "src/ts/process/transformers";
    import MultiLangInput from "../UI/GUI/MultiLangInput.svelte";
    import { applyModule } from "src/ts/process/modules";
    import { exportRegex, importRegex } from "src/ts/process/regexFiles";
    import { updateCharacter } from "src/ts/storage/characterStore.svelte";
    import SliderInput from "../UI/GUI/SliderInput.svelte";
    import Toggles from "./Toggles.svelte";
    import { convertCharacterToModule } from "src/ts/interchangeability";

    const currentCharacter = $derived(selectedCharacter());
    const currentChat = $derived(selectedChat());
    let iconRemoveMode = $state(false);
    let viewSubMenu = $state(0);
    let emos: [string, string][] = $state([]);
    let iconButtonSize = window.innerWidth > 360 ? (24 as const) : (20 as const);
    let tokens = $state({
        desc: 0,
        firstMsg: 0,
        localNote: 0,
        charaNote: 0,
    });

    let lasttokens = {
        desc: "",
        firstMsg: "",
        localNote: "",
        charaNote: "",
    };

    async function loadTokenize(desc: string | null, firstMsg: string | null, localNote: string) {
        if (desc !== null && lasttokens.desc !== desc) {
            lasttokens.desc = desc;
            tokens.desc = await tokenizeAccurate(desc);
        }
        if (firstMsg !== null && lasttokens.firstMsg !== firstMsg) {
            lasttokens.firstMsg = firstMsg;
            tokens.firstMsg = await tokenizeAccurate(firstMsg);
        }
        if (lasttokens.localNote !== localNote) {
            lasttokens.localNote = localNote;
            tokens.localNote = await tokenizeAccurate(localNote);
        }
    }

    let assetFileExtensions: string[] = $state([]);
    let assetFilePath: string[] = $state([]);
    let licensed = $state(selectedCharacter().type === "character" ? (selectedCharacter() as character).license : "");

    $effect.pre(() => {
        emos = currentCharacter.emotionImages;
    });

    $effect.pre(() => {
        const chara = currentCharacter;
        const desc = chara.type !== "group" ? (chara as character).desc : null;
        const firstMsg = chara.type !== "group" ? chara.firstMessage : null;
        const localNote = currentChat?.note;

        untrack(() => {
            loadTokenize(desc, firstMsg, localNote);
        });
    });

    $effect.pre(() => {
        if (currentCharacter.type === "character" && settings.ui.useAdditionalAssetsPreview) {
            if ((currentCharacter as character).additionalAssets) {
                for (let i = 0; i < (currentCharacter as character).additionalAssets.length; i++) {
                    if (
                        (currentCharacter as character).additionalAssets[i].length > 2 &&
                        (currentCharacter as character).additionalAssets[i][2]
                    ) {
                        assetFileExtensions[i] = (currentCharacter as character).additionalAssets[i][2];
                    } else
                        assetFileExtensions[i] = (currentCharacter as character).additionalAssets[i][1]
                            .split(".")
                            .pop();
                    getFileSrc((currentCharacter as character).additionalAssets[i][1]).then((filePath) => {
                        assetFilePath[i] = filePath;
                    });
                }
            }
        }
    });

    $effect.pre(() => {
        licensed = currentCharacter.type === "character" ? (currentCharacter as character).license : "";
    });
    $effect.pre(() => {
        if (currentCharacter.ttsMode === "novelai" && (currentCharacter as character).naittsConfig === undefined) {
            (currentCharacter as character).naittsConfig = {
                customvoice: false,
                voice: "Aini",
                version: "v2",
            };
        }
    });
    $effect.pre(() => {
        if (currentCharacter.ttsMode === "gptsovits" && (currentCharacter as character).gptSoVitsConfig === undefined) {
            (currentCharacter as character).gptSoVitsConfig = {
                url: "",
                use_auto_path: false,
                ref_audio_path: "",
                use_long_audio: false,
                ref_audio_data: {
                    fileName: "",
                    assetId: "",
                },
                volume: 1.0,
                text_lang: "auto",
                text: "en",
                use_prompt: false,
                prompt_lang: "en",
                top_p: 1,
                temperature: 0.7,
                speed: 1,
                top_k: 5,
                text_split_method: "cut0",
            };
        }
    });

    let fishSpeechModels: {
        _id: string;
        title: string;
        description: string;
    }[] = $state([]);

    $effect.pre(() => {
        if (
            currentCharacter.ttsMode === "fishspeech" &&
            (currentCharacter as character).fishSpeechConfig === undefined
        ) {
            (currentCharacter as character).fishSpeechConfig = {
                model: {
                    _id: "",
                    title: "",
                    description: "",
                },
                chunk_length: 200,
                normalize: false,
            };
        }
    });

    $effect.pre(() => {
        if (currentCharacter.ttsMode === "openai" && (currentCharacter as character).oaiTTSConfig === undefined) {
            (currentCharacter as character).oaiTTSConfig = {
                enabled: false,
                format: "mp3",
            };
        }
    });

    $effect.pre(() => {
        if (currentCharacter.type === "group" && ($CharConfigSubMenu === 4 || $CharConfigSubMenu === 5)) {
            $CharConfigSubMenu = 0;
        }
    });

    async function getFishSpeechModels() {
        try {
            const res = await fetch(`https://api.fish.audio/model?self=true`, {
                headers: {
                    Authorization: `Bearer ${settings.secrets.fishSpeechKey}`,
                },
            });
            const data = await res.json();
            console.log(data.items);
            console.log(currentCharacter);

            if (Array.isArray(data.items)) {
                fishSpeechModels = data.items.map((item) => ({
                    _id: item._id || "",
                    title: item.title || "",
                    description: item.description || "",
                }));
            } else {
                console.error("Expected an array of items, but received:", data.items);
                fishSpeechModels = [];
            }
        } catch (error) {
            console.error("Error fetching fish speech models:", error);
            fishSpeechModels = [];
        }
    }

    function moveAlternateGreetingUp(index: number) {
        if (index === 0) return;
        if (currentCharacter.type === "character") {
            let alternateGreetings = currentCharacter.alternateGreetings;
            let temp = alternateGreetings[index];
            alternateGreetings[index] = alternateGreetings[index - 1];
            alternateGreetings[index - 1] = temp;
            currentCharacter.alternateGreetings = alternateGreetings;
        }
    }

    function moveAlternateGreetingDown(index: number) {
        if (index === currentCharacter.alternateGreetings.length - 1) return;
        if (currentCharacter.type === "character") {
            let alternateGreetings = currentCharacter.alternateGreetings;
            let temp = alternateGreetings[index];
            alternateGreetings[index] = alternateGreetings[index + 1];
            alternateGreetings[index + 1] = temp;
            currentCharacter.alternateGreetings = alternateGreetings;
        }
    }
</script>

{#if licensed !== "private"}
    <div class="flex mb-2" class:gap-2={iconButtonSize === 24} class:gap-1={iconButtonSize < 24}>
        <button
            class={$CharConfigSubMenu === 0 ? "text-textcolor " : "text-textcolor2"}
            onclick={() => {
                $CharConfigSubMenu = 0;
            }}
        >
            <UserIcon size={iconButtonSize} />
        </button>
        <button
            class={$CharConfigSubMenu === 1 ? "text-textcolor" : "text-textcolor2"}
            onclick={() => {
                $CharConfigSubMenu = 1;
            }}
        >
            <SmileIcon size={iconButtonSize} />
        </button>
        <button
            class={$CharConfigSubMenu === 3 ? "text-textcolor" : "text-textcolor2"}
            onclick={() => {
                $CharConfigSubMenu = 3;
            }}
        >
            <BookIcon size={iconButtonSize} />
        </button>
        {#if currentCharacter.type === "character"}
            <button
                class={$CharConfigSubMenu === 5 ? "text-textcolor" : "text-textcolor2"}
                onclick={() => {
                    $CharConfigSubMenu = 5;
                }}
            >
                <Volume2Icon size={iconButtonSize} />
            </button>
            <button
                class={$CharConfigSubMenu === 4 ? "text-textcolor" : "text-textcolor2"}
                onclick={() => {
                    $CharConfigSubMenu = 4;
                }}
            >
                <Braces size={iconButtonSize} />
            </button>
        {/if}
        <button
            class={$CharConfigSubMenu === 2 ? "text-textcolor" : "text-textcolor2"}
            onclick={() => {
                $CharConfigSubMenu = 2;
            }}
        >
            <ActivityIcon size={iconButtonSize} />
        </button>
        {#if currentCharacter.type === "character"}
            <button
                class={$CharConfigSubMenu === 6 ? "text-textcolor" : "text-textcolor2"}
                onclick={() => {
                    $CharConfigSubMenu = 6;
                }}
            >
                <Share2Icon size={iconButtonSize} />
            </button>
        {/if}
    </div>
{/if}

{#if $CharConfigSubMenu === 0}
    {#if currentCharacter.type !== "group" && licensed !== "private"}
        <TextInput size="xl" marginBottom placeholder="Character Name" bind:value={currentCharacter.name} />
        <span class="text-textcolor">{language.description} <Help key="charDesc" /></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={(currentCharacter as character).desc}
        ></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm">{tokens.desc} {language.tokens}</span>
        <span class="text-textcolor">{language.firstMessage} <Help key="charFirstMessage" /></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={currentCharacter.firstMessage}
        ></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm">{tokens.firstMsg} {language.tokens}</span>
    {:else if licensed !== "private" && currentCharacter.type === "group"}
        <TextInput size="xl" marginBottom placeholder="Group Name" bind:value={currentCharacter.name} />
        <span class="text-textcolor">{language.character}</span>
        <div class="p-4 gap-2 bg-bgcolor rounded-lg char-grid">
            {#if (currentCharacter as groupChat).characters.length === 0}
                <span class="text-textcolor2">No Character</span>
            {:else}
                <div></div>
                <div class="text-center">{language.talkness}</div>
                <div class="text-center">{language.active}</div>
                {#each (currentCharacter as groupChat).characters as char, i}
                    {#await getCharImage(findCharacterbyId(char).image, "css")}
                        <BarIcon
                            onClick={() => {
                                rmCharFromGroup(i);
                            }}
                        >
                            <User />
                        </BarIcon>
                    {:then im}
                        <BarIcon
                            onClick={() => {
                                rmCharFromGroup(i);
                            }}
                            additionalStyle={im}
                        />
                    {/await}
                    <div class="flex items-center px-2 py-3">
                        {#each [1, 2, 3, 4, 5, 6] as barIndex}
                            <button
                                class="bg-selected h-full flex-1 border-r-bgcolor border-r"
                                aria-labelledby="loading"
                                class:bg-green-500={(currentCharacter as groupChat).characterTalks[i] >=
                                    (1 / 6) * barIndex}
                                class:bg-selected={(currentCharacter as groupChat).characterTalks[i] <
                                    (1 / 6) * barIndex}
                                class:rounded-l-lg={barIndex === 1}
                                class:rounded-r-lg={barIndex === 6}
                                onclick={() => {
                                    if (currentCharacter.type === "group") {
                                        (currentCharacter as groupChat).characterTalks[i] = (1 / 6) * barIndex;
                                    }
                                }}
                            ></button>
                        {/each}
                    </div>
                    <div class="flex items-center justify-center">
                        <Check margin={false} bind:check={(currentCharacter as groupChat).characterActive[i]} />
                    </div>
                {/each}
            {/if}
        </div>
        <div class="text-textcolor2 mt-1 flex mb-6">
            <button onclick={addGroupChar} class="hover:text-textcolor cursor-pointer">
                <PlusIcon />
            </button>
        </div>
    {/if}
    <span class="text-textcolor">{language.authorNote} <Help key="chatNote" /></span>
    <TextAreaInput
        margin="both"
        autocomplete="off"
        bind:value={() => currentChat.note, (note) => setCurrentChatMeta({ note })}
        highlight
        placeholder={getAuthorNoteDefaultText()}
    />
    <span class="text-textcolor2 mb-6 text-sm">{tokens.localNote} {language.tokens}</span>

    <Toggles chara={currentCharacter} noContainer />

    {#if currentCharacter.type === "group"}
        <div class="flex mt-2 items-center">
            <Check bind:check={(currentCharacter as groupChat).orderByOrder} name={language.orderByOrder} />
        </div>
    {/if}
{:else if licensed === "private"}
    <span>You are not allowed</span>
    {(() => {
        $CharConfigSubMenu = 0;
    })()}
{:else if $CharConfigSubMenu === 1}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.characterDisplay}</h2>

    <div class="flex w-full rounded-md border border-selected mb-4">
        <button
            onclick={() => {
                viewSubMenu = 0;
            }}
            class="p-2 flex-1"
            class:bg-selected={viewSubMenu === 0}
        >
            <span>{currentCharacter.type !== "group" ? language.charIcon : language.groupIcon}</span>
        </button>
        <button
            onclick={() => {
                viewSubMenu = 1;
            }}
            class="p2 flex-1 border-r border-l border-selected"
            class:bg-selected={viewSubMenu === 1}
        >
            <span>{language.viewScreen}</span>
        </button>
        <button
            onclick={() => {
                viewSubMenu = 2;
            }}
            class="p-2 flex-1"
            class:bg-selected={viewSubMenu === 2}
        >
            <span>{language.additionalAssets}</span>
        </button>
    </div>

    {#if viewSubMenu === 0}
        {#if currentCharacter.type === "group"}
            <button
                onclick={async () => {
                    await selectCharImg(currentCharacter.chaId);
                }}
            >
                {#await getCharImage(currentCharacter.image, "css")}
                    <div class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3"></div>
                {:then im}
                    <div class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3" style={im}></div>
                {/await}
            </button>
        {:else}
            <div class="p-2 border-darkborderc border rounded-md flex flex-wrap gap-2">
                {#if currentCharacter.image !== "" && currentCharacter.image}
                    <button
                        onclick={() => {
                            if (
                                currentCharacter.type === "character" &&
                                currentCharacter.image !== "" &&
                                currentCharacter.image &&
                                iconRemoveMode
                            ) {
                                currentCharacter.image = "";
                                if (
                                    (currentCharacter as character).ccAssets &&
                                    (currentCharacter as character).ccAssets.length > 0
                                ) {
                                    changeCharImage(currentCharacter.chaId, 0);
                                }
                                iconRemoveMode = false;
                            }
                        }}
                    >
                        {#await getCharImage(currentCharacter.image, (currentCharacter as character).largePortrait ? "lgcss" : "css")}
                            <div
                                class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3 transition-shadow"
                                class:ring-red-500={iconRemoveMode}
                            ></div>
                        {:then im}
                            <div
                                class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3 transition-shadow"
                                class:ring-red-500={iconRemoveMode}
                                style={im}
                            ></div>
                        {/await}
                    </button>
                {/if}
                {#if (currentCharacter as character).ccAssets}
                    {#each (currentCharacter as character).ccAssets as assets, i}
                        <button
                            onclick={async () => {
                                if (!iconRemoveMode) {
                                    changeCharImage(currentCharacter.chaId, i);
                                } else if (currentCharacter.type === "character") {
                                    (currentCharacter as character).ccAssets.splice(i, 1);
                                    iconRemoveMode = false;
                                }
                            }}
                        >
                            {#await getCharImage(assets.uri, (currentCharacter as character).largePortrait ? "lgcss" : "css")}
                                <div
                                    class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow"
                                    class:ring-red-500={iconRemoveMode}
                                    class:ring-3={iconRemoveMode}
                                ></div>
                            {:then im}
                                <div
                                    class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow"
                                    style={im}
                                    class:ring-red-500={iconRemoveMode}
                                    class:ring-3={iconRemoveMode}
                                ></div>
                            {/await}
                        </button>
                    {/each}
                {/if}
                <button
                    onclick={async () => {
                        await selectCharImg(currentCharacter.chaId);
                    }}
                >
                    <div
                        class="rounded-md h-24 w-24 cursor-pointer border-darkborderc border border-dashed flex justify-center items-center hover:border-blue-500"
                        style={(currentCharacter as character).largePortrait ? "height: 10.66rem;" : ""}
                    >
                        <PlusIcon />
                    </div>
                </button>
            </div>
            <div class="flex w-full items-end justify-end mt-2">
                <button
                    class={iconRemoveMode ? "text-red-500" : "text-textcolor2 hover:text-textcolor"}
                    onclick={() => {
                        iconRemoveMode = !iconRemoveMode;
                    }}
                >
                    <TrashIcon size="18" />
                </button>
            </div>
        {/if}

        {#if currentCharacter.type === "character" && currentCharacter.image !== ""}
            <div class="flex items-center mt-4">
                <Check bind:check={(currentCharacter as character).largePortrait} name={language.largePortrait} />
            </div>
        {/if}

        {#if currentCharacter.type === "group"}
            <Button onclick={makeGroupImage}>
                {language.createGroupImg}
            </Button>
        {/if}
    {:else if viewSubMenu === 1}
        <!-- svelte-ignore block_empty -->

        {#if currentCharacter.type !== "group"}
            <SelectInput
                className="mb-2"
                bind:value={currentCharacter.viewScreen}
                onchange={() => {
                    if (currentCharacter.type === "character") {
                        updateInlayScreen(currentCharacter as character);
                    }
                }}
            >
                <OptionInput value="none">{language.none}</OptionInput>
                <OptionInput value="emotion">{language.emotionImage}</OptionInput>
                <OptionInput value="imggen">{language.imageGeneration}</OptionInput>
            </SelectInput>
        {:else}
            <SelectInput className="mb-2" bind:value={currentCharacter.viewScreen}>
                <OptionInput value="none">{language.none}</OptionInput>
                <OptionInput value="single">{language.singleView}</OptionInput>
                <OptionInput value="multiple">{language.SpacedView}</OptionInput>
                <OptionInput value="emp">{language.emphasizedView}</OptionInput>
            </SelectInput>
        {/if}

        {#if currentCharacter.viewScreen === "emotion"}
            <span class="text-textcolor mt-6">{language.emotionImage} <Help key="emotion" /></span>
            <span class="text-textcolor2 text-xs">{language.emotionWarn}</span>

            <div class="w-full max-w-full border border-selected p-2 rounded-md">
                <table class="w-full max-w-full tabler">
                    <tbody>
                        <tr>
                            <th class="font-medium w-1/3">{language.image}</th>
                            <th class="font-medium w-1/2">{language.emotion}</th>
                            <th class="font-medium"></th>
                        </tr>
                        {#if currentCharacter.emotionImages.length === 0}
                            <tr>
                                <td colspan="3">{language.noImages}</td>
                            </tr>
                        {:else}
                            {#each emos as emo, i}
                                <tr>
                                    {#await getCharImage(emo[1], "plain")}
                                        <td class="font-medium truncate w-1/3"></td>
                                    {:then im}
                                        <td class="font-medium truncate w-1/3"
                                            ><img src={im} alt="img" class="w-full" /></td
                                        >
                                    {/await}
                                    <td class="font-medium truncate w-1/2">
                                        <TextInput
                                            marginBottom
                                            size="lg"
                                            bind:value={currentCharacter.emotionImages[i][0]}
                                        />
                                    </td>
                                    <td>
                                        <button
                                            class="font-medium cursor-pointer hover:text-green-500"
                                            onclick={() => {
                                                rmCharEmotion(currentCharacter.chaId, i);
                                            }}><TrashIcon /></button
                                        >
                                    </td>
                                </tr>
                            {/each}
                        {/if}
                    </tbody>
                </table>
            </div>

            <div class="text-textcolor2 hover:text-textcolor mt-2 flex">
                {#if !$addingEmotion}
                    <button
                        class="cursor-pointer hover:text-green-500"
                        onclick={() => {
                            addCharEmotion(currentCharacter.chaId);
                        }}
                    >
                        <PlusIcon />
                    </button>
                {:else}
                    <span>Loading...</span>
                {/if}
            </div>

            {#if (currentCharacter as character).inlayViewScreen}
                <span class="text-textcolor mt-2">{language.imgGenInstructions}</span>
                <TextAreaInput highlight bind:value={(currentCharacter as character).newGenData.emotionInstructions} />
            {/if}

            <CheckInput
                bind:check={(currentCharacter as character).inlayViewScreen}
                name={language.inlayViewScreen}
                onChange={() => {
                    if (currentCharacter.type === "character") {
                        if (
                            (currentCharacter as character).inlayViewScreen &&
                            (currentCharacter as character).additionalAssets === undefined
                        ) {
                            (currentCharacter as character).additionalAssets = [];
                        } else if (
                            !(currentCharacter as character).inlayViewScreen &&
                            (currentCharacter as character).additionalAssets.length === 0
                        ) {
                            (currentCharacter as character).additionalAssets = undefined;
                        }

                        updateInlayScreen(currentCharacter as character);
                    }
                }}
            />
        {/if}
        {#if currentCharacter.viewScreen === "imggen"}
            <span class="text-textcolor mt-6">{language.imageGeneration} <Help key="imggen" /></span>
            <span class="text-textcolor2 text-xs">{language.emotionWarn}</span>

            <span class="text-textcolor mt-2">{language.imgGenPrompt}</span>
            <TextAreaInput highlight bind:value={(currentCharacter as character).newGenData.prompt} />
            <span class="text-textcolor mt-2">{language.imgGenNegatives}</span>
            <TextAreaInput highlight bind:value={(currentCharacter as character).newGenData.negative} />
            <span class="text-textcolor mt-2">{language.imgGenInstructions}</span>
            <TextAreaInput highlight bind:value={(currentCharacter as character).newGenData.instructions} />

            <CheckInput
                bind:check={(currentCharacter as character).inlayViewScreen}
                name={language.inlayViewScreen}
                onChange={() => {
                    if ((currentCharacter as character).type === "character") {
                        updateInlayScreen(currentCharacter as character);
                    }
                }}
            />
        {/if}
    {:else if viewSubMenu === 2}
        {#if settings.memoryTranslateMedia.newImageHandlingBeta}
            <CheckInput bind:check={currentCharacter.prebuiltAssetCommand} name={language.insertAssetPrompt} />

            <span class="text-textcolor mt-2">{language.assetStyle}</span>
            <SelectInput className="mb-2" bind:value={currentCharacter.prebuiltAssetStyle}>
                <OptionInput value="">{language.static}</OptionInput>
                <OptionInput value="dynamic">{language.dynamic}</OptionInput>
            </SelectInput>
        {/if}
        <div class="w-full max-w-full border border-selected rounded-md p-2 mt-2">
            <table class="contain w-full max-w-full tabler mt-2">
                <tbody>
                    <tr>
                        <th class="font-medium">{language.value}</th>
                        <th class="font-medium cursor-pointer w-10">
                            <button
                                class="hover:text-green-500"
                                onclick={async () => {
                                    if (currentCharacter.type === "character") {
                                        // The character this was opened for, found again after each await.
                                        const chaId = currentCharacter.chaId;
                                        const target = () => {
                                            const found = characterList().find((entry) => entry?.chaId === chaId);
                                            return found?.type === "character" ? found : undefined;
                                        };
                                        const da = await selectMultipleFile([
                                            "png",
                                            "webp",
                                            "mp4",
                                            "mp3",
                                            "gif",
                                            "jpeg",
                                            "jpg",
                                            "ttf",
                                            "otf",
                                            "css",
                                            "webm",
                                            "woff",
                                            "woff2",
                                            "svg",
                                            "avif",
                                        ]);
                                        if (!target()) {
                                            return;
                                        }
                                        target().additionalAssets = target().additionalAssets ?? [];
                                        if (!da) {
                                            return;
                                        }
                                        for (const f of da) {
                                            const img = f.data;
                                            const name = f.name;
                                            const extension = name.split(".").pop().toLowerCase();
                                            const imgp = await saveAsset(img, "", extension);
                                            const char = target();
                                            if (!char) {
                                                return;
                                            }
                                            char.additionalAssets.push([name, imgp, extension]);
                                            char.additionalAssets = char.additionalAssets;
                                        }
                                    }
                                }}
                            >
                                <PlusIcon />
                            </button>
                        </th>
                    </tr>
                    {#if !currentCharacter.additionalAssets || currentCharacter.additionalAssets.length === 0}
                        <tr>
                            <td class="text-textcolor2"> No Assets</td>
                        </tr>
                    {:else}
                        {#each currentCharacter.additionalAssets as assets, i}
                            <tr>
                                <td class="font-medium truncate">
                                    {#if assetFilePath[i] && settings.ui.useAdditionalAssetsPreview}
                                        {#if assetFileExtensions[i] === "mp4"}
                                            <!-- svelte-ignore a11y_media_has_caption -->
                                            <video controls class="mt-2 px-2 w-full m-1 rounded-md"
                                                ><source src={assetFilePath[i]} type="video/mp4" /></video
                                            >
                                        {:else if assetFileExtensions[i] === "mp3"}
                                            <audio controls class="mt-2 px-2 w-full h-16 m-1 rounded-md" loop
                                                ><source src={assetFilePath[i]} type="audio/mpeg" /></audio
                                            >
                                        {:else if ["png", "webp", "jpeg", "jpg", "gif"].includes(assetFileExtensions[i])}
                                            <img
                                                src={assetFilePath[i]}
                                                class="w-16 h-16 m-1 rounded-md"
                                                alt={assets[0]}
                                            />
                                        {/if}
                                    {/if}
                                    <TextInput
                                        size="sm"
                                        marginBottom
                                        bind:value={currentCharacter.additionalAssets[i][0]}
                                        placeholder="..."
                                    />
                                </td>

                                <th class="font-medium cursor-pointer w-10">
                                    <button
                                        class="hover:text-blue-500"
                                        onclick={() => {
                                            if (currentCharacter.type === "character") {
                                                setCurrentChatMeta({ fmIndex: -1 });
                                                let additionalAssets = currentCharacter.additionalAssets;
                                                additionalAssets.splice(i, 1);
                                                currentCharacter.additionalAssets = additionalAssets;
                                            }
                                        }}
                                    >
                                        <TrashIcon />
                                    </button>
                                    {#if settings.ui.useAdditionalAssetsPreview}
                                        <button
                                            class="hover:text-blue-500"
                                            class:text-textcolor2={currentCharacter.prebuiltAssetExclude?.includes?.(
                                                assets[1],
                                            )}
                                            onclick={() => {
                                                currentCharacter.prebuiltAssetExclude ??= [];
                                                if (currentCharacter.prebuiltAssetExclude.includes(assets[1])) {
                                                    currentCharacter.prebuiltAssetExclude =
                                                        currentCharacter.prebuiltAssetExclude.filter(
                                                            (e) => e !== assets[1],
                                                        );
                                                } else {
                                                    currentCharacter.prebuiltAssetExclude.push(assets[1]);
                                                }
                                            }}
                                        >
                                            {#if currentCharacter?.prebuiltAssetExclude?.includes?.(assets[1])}
                                                <ImageOffIcon />
                                            {:else}
                                                <ImageIcon />
                                            {/if}
                                        </button>
                                    {/if}
                                </th>
                            </tr>
                        {/each}
                    {/if}
                </tbody>
            </table>
        </div>
    {/if}
{:else if $CharConfigSubMenu === 3}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.loreBook} <Help key="lorebook" /></h2>
    <LoreBook />
{:else if $CharConfigSubMenu === 4}
    {#if currentCharacter.type === "character"}
        <h2 class="mb-2 text-2xl font-bold mt-2">{language.scripts}</h2>

        <span class="text-textcolor mt-2">{language.backgroundHTML} <Help key="backgroundHTML" /></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={currentCharacter.backgroundHTML}
        ></TextAreaInput>

        <span class="text-textcolor mt-4">{language.regexScript} <Help key="regexScript" /></span>
        <RegexList bind:value={currentCharacter.customscript} />
        <div class="text-textcolor2 mt-2 flex gap-2">
            <button
                class="font-medium cursor-pointer hover:text-green-500"
                onclick={() => {
                    if (currentCharacter.type === "character") {
                        let script = currentCharacter.customscript;
                        script.push({
                            comment: "",
                            in: "",
                            out: "",
                            type: "editinput",
                        });
                        currentCharacter.customscript = script;
                    }
                }}><PlusIcon /></button
            >
            <button
                class="font-medium cursor-pointer hover:text-green-500"
                onclick={() => {
                    exportRegex(currentCharacter.customscript);
                }}><DownloadIcon /></button
            >
            <button
                class="font-medium cursor-pointer hover:text-green-500"
                onclick={async () => {
                    const character = currentCharacter;
                    const chaId = character.chaId;
                    const scripts = await importRegex($state.snapshot(character.customscript));
                    updateCharacter(chaId, { customscript: scripts });
                }}><HardDriveUploadIcon /></button
            >
        </div>

        <span class="text-textcolor mt-4">{language.triggerScript} <Help key="triggerScript" /></span>
        <TriggerList
            bind:value={(currentCharacter as character).triggerscript}
            lowLevelAble={currentCharacter.lowLevelAccess}
        />
    {/if}
{:else if $CharConfigSubMenu === 6}
    {#if currentCharacter.license !== "CC BY-NC-SA 4.0" && currentCharacter.license !== "CC BY-SA 4.0" && currentCharacter.license !== "CC BY-ND 4.0" && currentCharacter.license !== "CC BY-NC-ND 4.0"}
        <Button
            size="sm"
            onclick={async () => {
                const res = await exportChar(currentCharacter.chaId);
            }}
            className="mt-2">{language.exportCharacter}</Button
        >
    {/if}

    <Button
        onclick={async () => {
            removeChar(currentCharacter.chaId, currentCharacter.name);
        }}
        className="mt-2"
        size="sm">{currentCharacter.type === "group" ? language.removeGroup : language.removeCharacter}</Button
    >
{:else if $CharConfigSubMenu === 5}
    {#if currentCharacter.type === "character"}
        <h2 class="mb-2 text-2xl font-bold mt-2">TTS</h2>
        <span class="text-textcolor">{language.provider}</span>
        <SelectInput
            className="mb-4 mt-2"
            bind:value={currentCharacter.ttsMode}
            onchange={(e) => {
                if (currentCharacter.type === "character") {
                    (currentCharacter as character).ttsSpeech = "";
                }
            }}
        >
            <OptionInput value="">{language.disabled}</OptionInput>
            <OptionInput value="elevenlab">ElevenLabs</OptionInput>
            <OptionInput value="webspeech">Web Speech</OptionInput>
            <OptionInput value="VOICEVOX">VOICEVOX</OptionInput>
            <OptionInput value="openai">OpenAI</OptionInput>
            <OptionInput value="novelai">NovelAI</OptionInput>
            <OptionInput value="huggingface">Huggingface</OptionInput>
            <OptionInput value="vits">VITS</OptionInput>
            <OptionInput value="gptsovits">GPT-SoVITS</OptionInput>
            <OptionInput value="fishspeech">fish-speech</OptionInput>
        </SelectInput>

        {#if currentCharacter.ttsMode === "webspeech"}
            {#if !speechSynthesis}
                <span class="text-textcolor">Web Speech isn't supported in your browser or OS</span>
            {:else}
                <span class="text-textcolor">{language.Speech}</span>
                <SelectInput className="mb-4 mt-2" bind:value={(currentCharacter as character).ttsSpeech}>
                    <OptionInput value="">Auto</OptionInput>
                    {#each getWebSpeechTTSVoices() as voice}
                        <OptionInput value={voice}>{voice}</OptionInput>
                    {/each}
                </SelectInput>
                {#if (currentCharacter as character).ttsSpeech !== ""}
                    <span class="text-red-400 text-sm"
                        >If you do not set it to Auto, it may not work properly when importing from another OS or
                        browser.</span
                    >
                {/if}
            {/if}
        {:else if currentCharacter.ttsMode === "elevenlab"}
            <span class="text-sm mb-2 text-textcolor2"
                >Please set the ElevenLabs API key in "global Settings → Bot Settings → Others → ElevenLabs API key"</span
            >
            {#await getElevenTTSVoices() then voices}
                <span class="text-textcolor">{language.Speech}</span>
                <SelectInput className="mb-4 mt-2" bind:value={(currentCharacter as character).ttsSpeech}>
                    <OptionInput value="">Unset</OptionInput>
                    {#each voices as voice}
                        <OptionInput value={voice.voice_id}>{voice.name}</OptionInput>
                    {/each}
                </SelectInput>
            {/await}
        {:else if currentCharacter.ttsMode === "VOICEVOX"}
            <span class="text-textcolor">Speaker</span>
            <SelectInput className="mb-4 mt-2" bind:value={currentCharacter.voicevoxConfig.speaker}>
                {#await getVOICEVOXVoices() then voices}
                    {#each voices as voice}
                        <OptionInput
                            value={voice.list}
                            selected={currentCharacter.voicevoxConfig.speaker === voice.list}>{voice.name}</OptionInput
                        >
                    {/each}
                {/await}
            </SelectInput>
            {#if currentCharacter.voicevoxConfig.speaker}
                <span class="text=neutral-200">Style</span>
                <SelectInput className="mb-4 mt-2" bind:value={currentCharacter.ttsSpeech}>
                    {#each JSON.parse(currentCharacter.voicevoxConfig.speaker) as styles}
                        <OptionInput value={styles.id} selected={currentCharacter.ttsSpeech === styles.id}
                            >{styles.name}</OptionInput
                        >
                    {/each}
                </SelectInput>
            {/if}
            <span class="text-textcolor">Speed scale</span>
            <NumberInput size={"sm"} marginBottom bind:value={currentCharacter.voicevoxConfig.SPEED_SCALE} />

            <span class="text-textcolor">Pitch scale</span>
            <NumberInput size={"sm"} marginBottom bind:value={currentCharacter.voicevoxConfig.PITCH_SCALE} />

            <span class="text-textcolor">Volume scale</span>
            <NumberInput size={"sm"} marginBottom bind:value={currentCharacter.voicevoxConfig.VOLUME_SCALE} />

            <span class="text-textcolor">Intonation scale</span>
            <NumberInput size={"sm"} marginBottom bind:value={currentCharacter.voicevoxConfig.INTONATION_SCALE} />
            <span class="text-sm mb-2 text-textcolor2"
                >To use VOICEVOX, you need to run a colab and put the localtunnel URL in "Settings → Other Bots".
                https://colab.research.google.com/drive/1tyeXJSklNfjW-aZJAib1JfgOMFarAwze</span
            >
        {:else if currentCharacter.ttsMode === "novelai"}
            <span class="text-textcolor">Custom Voice Seed</span>
            <Check bind:check={currentCharacter.naittsConfig.customvoice} />
            {#if !currentCharacter.naittsConfig.customvoice}
                <span class="text-textcolor">Voice</span>
                <SelectInput className="mb-4 mt-2" bind:value={currentCharacter.naittsConfig.voice}>
                    {#await getNovelAIVoices() then voices}
                        {#each voices as voiceGroup}
                            <optgroup label={voiceGroup.gender} class="bg-darkbg appearance-none">
                                {#each voiceGroup.voices as voice}
                                    <OptionInput value={voice} selected={currentCharacter.naittsConfig.voice === voice}
                                        >{voice}</OptionInput
                                    >
                                {/each}
                            </optgroup>
                        {/each}
                    {/await}
                </SelectInput>
            {:else}
                <span class="text-textcolor">Voice</span>
                <TextInput size={"sm"} bind:value={currentCharacter.naittsConfig.voice} />
            {/if}
            <span class="text-textcolor">Version</span>
            <SelectInput className="mb-4 mt-2" bind:value={currentCharacter.naittsConfig.version}>
                <OptionInput value="v1">v1</OptionInput>
                <OptionInput value="v2">v2</OptionInput>
            </SelectInput>
        {:else if currentCharacter.ttsMode === "openai"}
            <span class="text-textcolor">Voice</span>
            {#if !currentCharacter.oaiTTSConfig?.enabled}
                <SelectInput className="mb-4 mt-2" bind:value={currentCharacter.oaiVoice}>
                    <OptionInput value="">Unset</OptionInput>
                    {#each oaiVoices as voice}
                        <OptionInput value={voice}>{voice}</OptionInput>
                    {/each}
                </SelectInput>
            {:else}
                <TextInput
                    className="mb-4 mt-2"
                    bind:value={currentCharacter.oaiTTSConfig.voice}
                    placeholder={currentCharacter.oaiVoice || "alloy"}
                />
            {/if}

            <span class="text-textcolor">Advanced (OpenAI-compatible endpoint)</span>
            <Check bind:check={currentCharacter.oaiTTSConfig.enabled} />

            {#if currentCharacter.oaiTTSConfig?.enabled}
                <span class="text-textcolor">Base URL</span>
                <TextInput
                    className="mb-4 mt-2"
                    bind:value={currentCharacter.oaiTTSConfig.baseURL}
                    placeholder="https://api.openai.com/v1"
                />

                <span class="text-textcolor">API Key (overrides global)</span>
                <TextInput
                    className="mb-4 mt-2"
                    hideText={settings.ui.hideApiKey}
                    bind:value={currentCharacter.oaiTTSConfig.apiKey}
                    placeholder="Leave empty to use global OpenAI API key"
                />

                <span class="text-textcolor">Model</span>
                <TextInput className="mb-4 mt-2" bind:value={currentCharacter.oaiTTSConfig.model} placeholder="tts-1" />

                <span class="text-textcolor">Response Format</span>
                <SelectInput className="mb-4 mt-2" bind:value={currentCharacter.oaiTTSConfig.format}>
                    <OptionInput value="mp3">mp3</OptionInput>
                    <OptionInput value="opus">opus</OptionInput>
                    <OptionInput value="aac">aac</OptionInput>
                    <OptionInput value="flac">flac</OptionInput>
                    <OptionInput value="wav">wav</OptionInput>
                    <OptionInput value="pcm">pcm</OptionInput>
                </SelectInput>
            {/if}
        {:else if currentCharacter.ttsMode === "huggingface"}
            <span class="text-textcolor">Model</span>
            <TextInput className="mb-4 mt-2" bind:value={currentCharacter.hfTTS.model} />

            <span class="text-textcolor">Language</span>
            <TextInput className="mb-4 mt-2" bind:value={currentCharacter.hfTTS.language} placeholder="en" />
        {:else if currentCharacter.ttsMode === "vits"}
            {#if currentCharacter.vits}
                <span class="text-textcolor">{currentCharacter.vits.name ?? "Unnamed VitsModel"}</span>
            {:else}
                <span class="text-textcolor">No Model</span>
            {/if}
            <Button
                onclick={async () => {
                    // The character this was opened for, whatever is selected once the model is registered.
                    const chaId = currentCharacter.chaId;
                    const model = await registerOnnxModel();
                    const target = characterList().find((entry) => entry?.chaId === chaId);
                    if (model && target?.type === "character") {
                        target.vits = model;
                    }
                }}>{language.selectModel}</Button
            >
        {:else if currentCharacter.ttsMode === "gptsovits"}
            <span class="text-textcolor">Volume</span>
            <SliderInput
                min={0.0}
                max={1.0}
                step={0.01}
                fixed={2}
                bind:value={currentCharacter.gptSoVitsConfig.volume}
            />
            <span class="text-textcolor">URL</span>
            <TextInput className="mb-4 mt-2" bind:value={currentCharacter.gptSoVitsConfig.url} />

            <span class="text-textcolor">Use Auto Path</span>
            <Check bind:check={currentCharacter.gptSoVitsConfig.use_auto_path} />

            {#if !currentCharacter.gptSoVitsConfig.use_auto_path}
                <span class="text-textcolor"
                    >Reference Audio Path (e.g. C:/Users/user/Downloads/GPT-SoVITS-v2-240821)</span
                >
                <TextInput className="mb-4 mt-2" bind:value={currentCharacter.gptSoVitsConfig.ref_audio_path} />
            {/if}

            <span class="text-textcolor">Use Long Audio</span>
            <Check bind:check={currentCharacter.gptSoVitsConfig.use_long_audio} />

            <span class="text-textcolor">Reference Audio Data (3~10s audio file)</span>
            <Button
                onclick={async () => {
                    // The character this was opened for, whatever is selected once the audio is saved.
                    const chaId = currentCharacter.chaId;
                    const audio = await selectSingleFile(["wav", "ogg", "aac", "mp3"]);
                    if (!audio) {
                        return null;
                    }
                    const saveId = await saveAsset(audio.data);
                    const target = characterList().find((entry) => entry?.chaId === chaId);
                    if (target?.type !== "character") {
                        return null;
                    }
                    target.gptSoVitsConfig.ref_audio_data = {
                        fileName: audio.name,
                        assetId: saveId,
                    };
                }}
                className="h-10"
            >
                {#if currentCharacter.gptSoVitsConfig.ref_audio_data.assetId === "" || currentCharacter.gptSoVitsConfig.ref_audio_data.assetId === undefined}
                    {language.selectFile}
                {:else}
                    {currentCharacter.gptSoVitsConfig.ref_audio_data.fileName}
                {/if}
            </Button>
            <span class="text-textcolor">Text Language</span>
            <SelectInput className="mb-4 mt-2" bind:value={currentCharacter.gptSoVitsConfig.text_lang}>
                <OptionInput value="auto">Multi-language Mixed</OptionInput>
                <OptionInput value="auto_yue">Multi-language Mixed (Cantonese)</OptionInput>
                <OptionInput value="en">English</OptionInput>
                <OptionInput value="zh">Chinese-English Mixed</OptionInput>
                <OptionInput value="ja">Japanese-English Mixed</OptionInput>
                <OptionInput value="yue">Cantonese-English Mixed</OptionInput>
                <OptionInput value="ko">Korean-English Mixed</OptionInput>
                <OptionInput value="all_zh">Chinese</OptionInput>
                <OptionInput value="all_ja">Japanese</OptionInput>
                <OptionInput value="all_yue">Cantonese</OptionInput>
                <OptionInput value="all_ko">Korean</OptionInput>
            </SelectInput>

            {#if !currentCharacter.gptSoVitsConfig.use_long_audio}
                <span class="text-textcolor">Use Reference Audio Script</span>
                <Check bind:check={currentCharacter.gptSoVitsConfig.use_prompt} />
            {/if}

            {#if currentCharacter.gptSoVitsConfig.use_prompt && !currentCharacter.gptSoVitsConfig.use_long_audio}
                <span class="text-textcolor">Reference Audio Script</span>
                <TextAreaInput className="mb-4 mt-2" bind:value={currentCharacter.gptSoVitsConfig.prompt} />
            {/if}

            <span class="text-textcolor">Reference Audio Language</span>
            <SelectInput className="mb-4 mt-2" bind:value={currentCharacter.gptSoVitsConfig.prompt_lang}>
                <OptionInput value="auto">Multi-language Mixed</OptionInput>
                <OptionInput value="auto_yue">Multi-language Mixed (Cantonese)</OptionInput>
                <OptionInput value="en">English</OptionInput>
                <OptionInput value="zh">Chinese-English Mixed</OptionInput>
                <OptionInput value="ja">Japanese-English Mixed</OptionInput>
                <OptionInput value="yue">Cantonese-English Mixed</OptionInput>
                <OptionInput value="ko">Korean-English Mixed</OptionInput>
                <OptionInput value="all_zh">Chinese</OptionInput>
                <OptionInput value="all_ja">Japanese</OptionInput>
                <OptionInput value="all_yue">Cantonese</OptionInput>
                <OptionInput value="all_ko">Korean</OptionInput>
            </SelectInput>
            <span class="text-textcolor">Top P</span>
            <SliderInput
                min={0.0}
                max={1.0}
                step={0.05}
                fixed={2}
                bind:value={currentCharacter.gptSoVitsConfig.top_p}
            />

            <span class="text-textcolor">Temperature</span>
            <SliderInput
                min={0.0}
                max={1.0}
                step={0.05}
                fixed={2}
                bind:value={currentCharacter.gptSoVitsConfig.temperature}
            />

            <span class="text-textcolor">Speed</span>
            <SliderInput
                min={0.6}
                max={1.65}
                step={0.05}
                fixed={2}
                bind:value={currentCharacter.gptSoVitsConfig.speed}
            />

            <span class="text-textcolor">Top K</span>
            <SliderInput min={1} max={100} step={1} bind:value={currentCharacter.gptSoVitsConfig.top_k} />

            <span class="text-textcolor">Text Split Method</span>
            <SelectInput className="mb-4 mt-2" bind:value={currentCharacter.gptSoVitsConfig.text_split_method}>
                <OptionInput value="cut0">Cut 0 (No splitting)</OptionInput>
                <OptionInput value="cut1">Cut 1 (Split every 4 sentences)</OptionInput>
                <OptionInput value="cut2">Cut 2 (Split every 50 characters)</OptionInput>
                <OptionInput value="cut3">Cut 3 (Split by Chinese periods)</OptionInput>
                <OptionInput value="cut4">Cut 4 (Split by English periods)</OptionInput>
                <OptionInput value="cut5">Cut 5 (Split by various punctuation marks)</OptionInput>
            </SelectInput>
        {:else if currentCharacter.ttsMode === "fishspeech"}
            {#await getFishSpeechModels()}
                <span class="text-textcolor">Loading...</span>
            {:then}
                <span class="text-textcolor">Model</span>
                <SelectInput className="mb-4 mt-2" bind:value={currentCharacter.fishSpeechConfig.model._id}>
                    <OptionInput value="">Not selected</OptionInput>
                    {#each fishSpeechModels as model}
                        <OptionInput value={model._id}>
                            <div class="flex items-center">
                                <span>{model.title}</span>
                                <span class="text-sm text-textcolor2">{model.description}</span>
                            </div>
                        </OptionInput>
                    {/each}
                </SelectInput>
            {:catch}
                <span class="text-textcolor">An error occurred while fetching the models.</span>
            {/await}

            <span class="text-textcolor">Chunk Length</span>
            <NumberInput className="mb-4 mt-2" bind:value={currentCharacter.fishSpeechConfig.chunk_length} />

            <span class="mt-2 text-textcolor">Normalize</span>
            <Check className="mb-4 mt-2" bind:check={currentCharacter.fishSpeechConfig.normalize} />
        {/if}
        {#if currentCharacter.ttsMode}
            <div class="flex items-center mt-2">
                <Check bind:check={currentCharacter.ttsReadOnlyQuoted} name={language.ttsReadOnlyQuoted} />
            </div>
        {/if}
    {/if}
{:else if $CharConfigSubMenu === 2}
    <h2 class="mb-2 text-2xl font-bold mt-2">{language.advancedSettings}</h2>
    {#if currentCharacter.type !== "group"}
        <span class="text-textcolor mt-2">Bias <Help key="bias" /></span>
        <div class="w-full max-w-full border border-selected rounded-md p-2 mb-2">
            <table class="w-full max-w-full tabler mt-2">
                <tbody>
                    <tr>
                        <th class="font-medium w-1/2">Bias</th>
                        <th class="font-medium w-1/3">{language.value}</th>
                        <th>
                            <button
                                class="font-medium cursor-pointer hover:text-green-500"
                                onclick={() => {
                                    if (currentCharacter.type === "character") {
                                        (currentCharacter as character).bias.push(["", 0]);
                                    }
                                }}><PlusIcon /></button
                            >
                        </th>
                    </tr>
                    {#if (currentCharacter as character).bias.length === 0}
                        <tr>
                            <td colspan="3">{language.noBias}</td>
                        </tr>
                    {/if}
                    {#each (currentCharacter as character).bias as bias, i}
                        <tr class="align-middle text-center">
                            <td class="font-medium truncate w-1/2">
                                <TextInput
                                    fullh
                                    fullwidth
                                    bind:value={(currentCharacter as character).bias[i][0]}
                                    placeholder="string"
                                />
                            </td>
                            <td class="font-medium truncate w-1/3">
                                <NumberInput
                                    fullh
                                    fullwidth
                                    bind:value={(currentCharacter as character).bias[i][1]}
                                    max={100}
                                    min={-100}
                                />
                            </td>
                            <td>
                                <button
                                    class="font-medium flex justify-center items-center w-full h-full cursor-pointer hover:text-green-500"
                                    onclick={() => {
                                        if (currentCharacter.type === "character") {
                                            (currentCharacter as character).bias.splice(i, 1);
                                        }
                                    }}><TrashIcon /></button
                                >
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>

        <span class="text-textcolor">{language.exampleMessage} <Help key="exampleMessage" /></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={currentCharacter.exampleMessage}
        ></TextAreaInput>

        <span class="text-textcolor">{language.creatorNotes} <Help key="creatorQuotes" /></span>
        <MultiLangInput
            bind:value={currentCharacter.creatorNotes}
            className="my-2"
            onInput={() => {
                currentCharacter.removedQuotes = false;
            }}
        ></MultiLangInput>

        <span class="text-textcolor">{language.systemPrompt} <Help key="systemPrompt" /></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={currentCharacter.systemPrompt}
        ></TextAreaInput>

        <span class="text-textcolor">{language.replaceGlobalNote} <Help key="replaceGlobalNote" /></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={currentCharacter.replaceGlobalNote}
        ></TextAreaInput>

        <span class="text-textcolor mt-2">{language.additionalText} <Help key="additionalText" /></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={currentCharacter.additionalText}
        ></TextAreaInput>

        {#if settings.ui.showUnrecommended || currentCharacter.personality.length > 3}
            <span class="text-textcolor">{language.personality} <Help key="personality" unrecommended /></span>
            <TextAreaInput highlight margin="both" autocomplete="off" bind:value={currentCharacter.personality}
            ></TextAreaInput>
        {/if}
        {#if settings.ui.showUnrecommended || currentCharacter.scenario.length > 3}
            <span class="text-textcolor">{language.scenario} <Help key="scenario" unrecommended /></span>
            <TextAreaInput highlight margin="both" autocomplete="off" bind:value={currentCharacter.scenario}
            ></TextAreaInput>
        {/if}

        <span class="text-textcolor mt-2">{language.defaultVariables} <Help key="defaultVariables" /></span>
        <TextAreaInput margin="both" autocomplete="off" bind:value={currentCharacter.defaultVariables}></TextAreaInput>

        <span class="text-textcolor mt-2">{language.translatorNote} <Help key="translatorNote" /></span>
        <TextAreaInput margin="both" autocomplete="off" bind:value={currentCharacter.translatorNote}></TextAreaInput>

        <span class="text-textcolor mt-2"
            >{language.customPromptTemplateToggle} <Help key="customPromptTemplateToggle" /></span
        >
        <TextAreaInput margin="both" autocomplete="off" bind:value={currentCharacter.customModuleToggle}
        ></TextAreaInput>

        <span class="text-textcolor">{language.creator}</span>
        <TextInput size="sm" autocomplete="off" bind:value={currentCharacter.additionalData.creator} />

        <span class="text-textcolor">{language.CharVersion}</span>
        <TextInput size="sm" bind:value={currentCharacter.additionalData.character_version} />

        <span class="text-textcolor">{language.nickname} <Help key="nickname" /></span>
        <TextInput size="sm" bind:value={currentCharacter.nickname} />

        <span class="text-textcolor">{language.depthPrompt}</span>
        <div class="flex justify-center items-center">
            <NumberInput size="sm" bind:value={currentCharacter.depth_prompt.depth} className="w-12" />
            <TextInput size="sm" bind:value={currentCharacter.depth_prompt.prompt} className="flex-1" />
        </div>

        <span class="text-textcolor mt-2">{language.altGreet}</span>
        <div class="w-full max-w-full border border-selected rounded-md p-2">
            <table class="contain w-full max-w-full tabler mt-2">
                <tbody>
                    <tr>
                        <th class="font-medium">{language.value}</th>
                        <th class="font-medium cursor-pointer w-8">
                            <button
                                class="hover:text-green-500"
                                onclick={() => {
                                    if (currentCharacter.type === "character") {
                                        let alternateGreetings = currentCharacter.alternateGreetings;
                                        alternateGreetings.push("");
                                        currentCharacter.alternateGreetings = alternateGreetings;
                                    }
                                }}
                            >
                                <PlusIcon />
                            </button>
                        </th>
                    </tr>
                    {#if currentCharacter.alternateGreetings.length === 0}
                        <tr>
                            <td colspan="3">{language.noData}</td>
                        </tr>
                    {/if}
                    {#each currentCharacter.alternateGreetings as bias, i}
                        <tr>
                            <td class="font-medium truncate">
                                <TextAreaInput
                                    highlight
                                    bind:value={currentCharacter.alternateGreetings[i]}
                                    placeholder="..."
                                    fullwidth
                                />
                            </td>
                            <th class="font-medium cursor-pointer w-8">
                                <div class="flex flex-col items-center">
                                    <button
                                        class="hover:text-blue-500 p-1"
                                        onclick={() => moveAlternateGreetingUp(i)}
                                        disabled={i === 0}
                                    >
                                        <ArrowUp size={16} />
                                    </button>
                                    <button
                                        class="hover:text-blue-500 p-1"
                                        onclick={() => moveAlternateGreetingDown(i)}
                                        disabled={i === currentCharacter.alternateGreetings.length - 1}
                                    >
                                        <ArrowDown size={16} />
                                    </button>
                                    <button
                                        class="hover:text-red-500 p-1"
                                        onclick={() => {
                                            if (currentCharacter.type === "character") {
                                                setCurrentChatMeta({ fmIndex: -1 });
                                                let alternateGreetings = currentCharacter.alternateGreetings;
                                                alternateGreetings.splice(i, 1);
                                                currentCharacter.alternateGreetings = alternateGreetings;
                                            }
                                        }}
                                    >
                                        <TrashIcon size={16} />
                                    </button>
                                </div>
                            </th>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>

        <div class="flex items-center mt-4">
            <Check bind:check={currentCharacter.lowLevelAccess} name={language.lowLevelAccess} />
            <span> <Help key="lowLevelAccess" name={language.lowLevelAccess} /></span>
        </div>

        <div class="flex items-center mt-4">
            <Check bind:check={currentCharacter.hideChatIcon} name={language.hideChatIcon} />
        </div>

        <div class="flex items-center mt-4">
            <Check bind:check={currentCharacter.utilityBot} name={language.utilityBot} />
            <span> <Help key="utilityBot" name={language.utilityBot} /></span>
        </div>

        <div class="flex items-center mt-4">
            <Check bind:check={currentCharacter.escapeOutput} name={language.escapeOutput} />
        </div>

        {#if settings.memoryTranslateMedia.supaModelType !== "none" && settings.memoryTranslateMedia.hypav2}
            <Button
                onclick={() => {
                    if (!selectedChat()?.hypaV2Data) {
                        setCurrentChatMeta({ hypaV2Data: { lastMainChunkID: 0, mainChunks: [], chunks: [] } });
                    }
                    showHypaV2Alert();
                }}
                className="mt-4"
            >
                {language.hypaMemoryV2Modal}
            </Button>
        {:else if settings.memoryTranslateMedia.hypaV3}
            <Button
                onclick={() => {
                    $hypaV3ModalOpen = true;
                }}
                className="mt-4"
            >
                {language.hypaMemoryV3Modal}
            </Button>
        {:else if (currentChat.supaMemoryData && currentChat.supaMemoryData.length > 4) || currentCharacter.supaMemory}
            <span class="text-textcolor mt-4">{language.SuperMemory}</span>
            <TextAreaInput
                margin="both"
                autocomplete="off"
                bind:value={
                    () => currentChat.supaMemoryData, (supaMemoryData) => setCurrentChatMeta({ supaMemoryData })
                }
            ></TextAreaInput>
        {/if}

        <Button onclick={applyModule} className="mt-4">
            {language.applyModule}
        </Button>

        <Button
            onclick={async () => {
                const char = selectedCharacter();
                if (char.type === "group") {
                    return;
                }
                const m = convertCharacterToModule(char);
                settings.modules.push(m);
                alertNormal(language.successfullyConverted);
            }}
            className="mt-4"
        >
            {language.convertToModule}
        </Button>
    {:else}
        {#if (currentChat.supaMemoryData && currentChat.supaMemoryData.length > 4) || currentCharacter.supaMemory}
            <span class="text-textcolor mt-4">{language.SuperMemory}</span>
            <TextAreaInput
                margin="both"
                autocomplete="off"
                bind:value={
                    () => currentChat.supaMemoryData, (supaMemoryData) => setCurrentChatMeta({ supaMemoryData })
                }
            ></TextAreaInput>
        {/if}

        <div class="flex items-center mt-4">
            <Check bind:check={currentCharacter.lowLevelAccess} name={language.lowLevelAccess} />
            <span> <Help key="lowLevelAccess" name={language.lowLevelAccess} /></span>
        </div>
    {/if}
{/if}

<style>
    .tabler {
        table-layout: fixed;
    }

    .tabler td {
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .char-grid {
        display: grid;
        grid-template-columns: auto 1fr auto;
    }
</style>
