<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { saveAsset, globalFetch } from "src/ts/globalApi.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import { getCharImage } from "src/ts/characters";
    import { alertError, alertNormal } from "src/ts/alert";
    import { onMount } from "svelte";
    import CredentialStatusLink from "../CredentialStatusLink.svelte";
    import { scrollToCredential, takeCredentialRequest } from "src/ts/setting/credentialLinks";

    // The NovelAI key is edited only here (settings UI plan slice 8); NovelAI TTS links to it. A link
    // shows it even while another image provider is selected.
    const revealNovelAIKey = takeCredentialRequest("NAIApiKey");
    onMount(() => {
        if (revealNovelAIKey) void scrollToCredential("NAIApiKey");
    });

    // wavespeed
    interface WavespeedModel {
        model_id: string;
        name: string;
        base_price: number;
        supportsImageInput: boolean;
        supportsLoras: boolean;
    }
    interface LoraItem {
        path: string;
        scale: number;
    }
    let wavespeedModels = $state<WavespeedModel[]>([]);
    let isWavespeedLoading = $state(false);
    let wavespeedSearchQuery = $state("");
    // The rows start from the saved LoRAs (padded to three), so the sync effect below does not clear
    // them when the page mounts. A malformed saved value starts blank rows, as before.
    const storedLoras: unknown = settings.secrets.wavespeedImage?.loras;
    const savedLoras = (Array.isArray(storedLoras) ? storedLoras : [])
        .filter((item): item is LoraItem => typeof item?.path === "string" && item.path.trim() !== "")
        .map(({ path, scale }) => ({ path, scale: typeof scale === "number" ? scale : 1.0 }));
    let wavespeedLoras = $state<LoraItem[]>([
        ...savedLoras,
        ...Array.from({ length: Math.max(0, 3 - savedLoras.length) }, () => ({ path: "", scale: 1.0 })),
    ]);

    /**
     * Fetch models from WaveSpeed API dynamically
     * https://wavespeed.ai/docs/docs-common-api/models
     */
    async function fetchWavespeedModels() {
        if (!settings.secrets.wavespeedImage.key || settings.secrets.wavespeedImage.key.trim() === "") {
            alertError("WaveSpeed API Key not set");
            return [];
        }

        isWavespeedLoading = true;
        try {
            const result = await globalFetch("https://api.wavespeed.ai/api/v3/models", {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${settings.secrets.wavespeedImage.key}`,
                },
            });

            if (!result.ok || !result.data) {
                alertError("Failed to fetch WaveSpeed models");
                return;
            }

            let responseData;
            try {
                responseData = typeof result.data === "string" ? JSON.parse(result.data) : result.data;
            } catch (e) {
                alertError("Failed to parse WaveSpeed response");
                return;
            }

            if (responseData.code !== 200 || !Array.isArray(responseData.data)) {
                alertError("Invalid WaveSpeed API response");
                return;
            }

            // Filter, transform, and sort models by name
            const filteredModels: WavespeedModel[] = responseData.data
                .filter((model: any) => model.type === "text-to-image" || model.type === "image-to-image")
                .map((model: any) => {
                    // Check if model supports LoRAs
                    const supportsLoras =
                        model.api_schema?.api_schemas?.some(
                            (schema: any) => schema.request_schema?.properties?.loras !== undefined,
                        ) ?? false;

                    return {
                        model_id: model.model_id,
                        name: model.name,
                        base_price: model.base_price,
                        type: model.type,
                        supportsImageInput: model.type === "image-to-image",
                        supportsLoras: supportsLoras,
                    };
                })
                .sort((a, b) => a.name.localeCompare(b.model_id));

            wavespeedModels = filteredModels;
            alertNormal(`Successfully loaded ${filteredModels.length} models`);
        } catch (error) {
            alertError(`Failed to fetch models: ${error}`);
        } finally {
            isWavespeedLoading = false;
        }
    }

    /**
     * Handle model selection change
     */
    function handleModelChange() {
        const selectedModel = wavespeedModels.find((m) => m.model_id === settings.secrets.wavespeedImage.model);

        // Reset reference_mode for text-to-image models
        if (selectedModel?.supportsImageInput) {
            settings.secrets.wavespeedImage.reference_mode = "";
            settings.secrets.wavespeedImage.reference_image = undefined;
            settings.secrets.wavespeedImage.reference_base64image = undefined;
        }

        // Reset loras if model doesn't support them
        if (!selectedModel?.supportsLoras) {
            settings.secrets.wavespeedImage.loras = undefined;
        }
    }

    /**
     * Get display name for a WaveSpeed model
     * @param model - The model to get display name for
     */
    function getModelDisplayName(model: WavespeedModel): string {
        const imageInputIcon = model.supportsImageInput ? "✓" : "✗";
        const loraIcon = model.supportsLoras ? "✓" : "✗";
        return `${model.name} (price: ${model.base_price}) [${imageInputIcon} Image] [${loraIcon} LoRA]`;
    }

    /**
     * Filter and sort models based on search query
     */
    function getFilteredModels(): WavespeedModel[] {
        if (wavespeedSearchQuery === "") return wavespeedModels;

        const searchTerms = wavespeedSearchQuery.toLowerCase().trim().split(/\s+/);
        return wavespeedModels.filter((model) => {
            const modelText = (model.name + " " + model.model_id).toLowerCase();
            return searchTerms.every((term) => modelText.includes(term));
        });
    }

    $effect(() => {
        // Sync loras to DB, filtering out empty URLs
        if (settings.secrets.wavespeedImage) {
            settings.secrets.wavespeedImage.loras = wavespeedLoras
                .filter((item) => item.path && item.path.trim() !== "")
                .map((item) => ({
                    path: item.path,
                    scale: item.scale,
                }));
        }
    });
    // End wavespeed
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.imageGeneration}</h2>

<span class="text-textcolor mt-2">{language.imageGeneration} {language.provider} <Help key="sdProvider" /></span>
<SelectInput className="mt-2 mb-4" bind:value={settings.memoryTranslateMedia.sdProvider}>
    <OptionInput value="">None</OptionInput>
    <OptionInput value="webui">Stable Diffusion WebUI</OptionInput>
    <OptionInput value="novelai">Novel AI</OptionInput>
    <OptionInput value="dalle">Dall-E</OptionInput>
    <OptionInput value="stability">Stability API</OptionInput>
    <OptionInput value="fal">Fal.ai</OptionInput>
    <OptionInput value="comfyui">ComfyUI</OptionInput>
    <OptionInput value="Imagen">Imagen</OptionInput>
    <OptionInput value="openai-compat">OpenAI Compatible</OptionInput>
    <OptionInput value="wavespeed">WaveSpeedAI</OptionInput>

    <!-- Legacy -->
    {#if settings.memoryTranslateMedia.sdProvider === "comfy"}
        <OptionInput value="comfy">ComfyUI (Legacy)</OptionInput>
    {/if}
</SelectInput>

{#if revealNovelAIKey && settings.memoryTranslateMedia.sdProvider !== "novelai"}
    <div class="flex flex-col" data-credential="NAIApiKey">
        <span class="text-textcolor">Novel AI API Key</span>
        <TextInput size="sm" marginBottom placeholder="pst-..." bind:value={settings.secrets.NAIApiKey} />
    </div>
{/if}

{#if settings.memoryTranslateMedia.sdProvider === "webui"}
    <span class="text-draculared text-xs mb-2">You must use WebUI with --api flag</span>
    <span class="text-draculared text-xs mb-2"
        >You must use WebUI without agpl license or use unmodified version with agpl license to observe the contents of
        the agpl license.</span
    >
    <span class="text-textcolor mt-2">WebUI {language.providerURL}</span>
    <TextInput size="sm" marginBottom placeholder="https://..." bind:value={settings.memoryTranslateMedia.webUiUrl} />
    <span class="text-textcolor">Steps</span>
    <NumberInput size="sm" marginBottom min={0} max={100} bind:value={settings.memoryTranslateMedia.sdSteps} />

    <span class="text-textcolor">CFG Scale</span>
    <NumberInput size="sm" marginBottom min={0} max={20} bind:value={settings.memoryTranslateMedia.sdCFG} />

    <span class="text-textcolor">Width</span>
    <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={settings.memoryTranslateMedia.sdConfig.width} />
    <span class="text-textcolor">Height</span>
    <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={settings.memoryTranslateMedia.sdConfig.height} />
    <span class="text-textcolor">Sampler</span>
    <TextInput size="sm" marginBottom bind:value={settings.memoryTranslateMedia.sdConfig.sampler_name} />

    <div class="flex items-center mt-2">
        <Check bind:check={settings.memoryTranslateMedia.sdConfig.enable_hr} name="Enable Hires" />
    </div>
    {#if settings.memoryTranslateMedia.sdConfig.enable_hr === true}
        <span class="text-textcolor">denoising_strength</span>
        <NumberInput
            size="sm"
            marginBottom
            min={0}
            max={10}
            bind:value={settings.memoryTranslateMedia.sdConfig.denoising_strength}
        />
        <span class="text-textcolor">hr_scale</span>
        <NumberInput
            size="sm"
            marginBottom
            min={0}
            max={10}
            bind:value={settings.memoryTranslateMedia.sdConfig.hr_scale}
        />
        <span class="text-textcolor">Upscaler</span>
        <TextInput size="sm" marginBottom bind:value={settings.memoryTranslateMedia.sdConfig.hr_upscaler} />
    {/if}
{/if}

{#if settings.memoryTranslateMedia.sdProvider === "novelai"}
    <span class="text-textcolor mt-2">Novel AI {language.providerURL}</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="https://image.novelai.net"
        bind:value={settings.memoryTranslateMedia.NAIImgUrl}
    />
    <div class="flex flex-col" data-credential="NAIApiKey">
        <span class="text-textcolor">API Key</span>
        <TextInput size="sm" marginBottom placeholder="pst-..." bind:value={settings.secrets.NAIApiKey} />
    </div>

    <span class="text-textcolor">Model</span>
    <SelectInput className="mb-4" bind:value={settings.memoryTranslateMedia.NAIImgModel}>
        <OptionInput value="nai-diffusion-5-full">nai-diffusion-5-full</OptionInput>
        <OptionInput value="nai-diffusion-5-curated">nai-diffusion-5-curated</OptionInput>
        <OptionInput value="nai-diffusion-4-5-full">nai-diffusion-4-5-full</OptionInput>
        <OptionInput value="nai-diffusion-4-5-curated">nai-diffusion-4-5-curated</OptionInput>
        <OptionInput value="nai-diffusion-4-full">nai-diffusion-4-full</OptionInput>
        <OptionInput value="nai-diffusion-4-curated-preview">nai-diffusion-4-curated-preview</OptionInput>
        <OptionInput value="nai-diffusion-3">nai-diffusion-3</OptionInput>
        <OptionInput value="nai-diffusion-furry-3">nai-diffusion-furry-3</OptionInput>
        <OptionInput value="nai-diffusion-2">nai-diffusion-2</OptionInput>
    </SelectInput>

    <span class="text-textcolor">Width</span>
    <NumberInput
        size="sm"
        marginBottom
        min={0}
        max={2048}
        bind:value={settings.memoryTranslateMedia.NAIImgConfig.width}
    />
    <span class="text-textcolor">Height</span>
    <NumberInput
        size="sm"
        marginBottom
        min={0}
        max={2048}
        bind:value={settings.memoryTranslateMedia.NAIImgConfig.height}
    />
    <span class="text-textcolor">Sampler</span>

    {#if settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-full" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-curated-preview" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-5-full" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-5-curated"}
        <SelectInput className="mb-4" bind:value={settings.memoryTranslateMedia.NAIImgConfig.sampler}>
            <OptionInput value="k_euler_ancestral">Euler Ancestral</OptionInput>
            <OptionInput value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</OptionInput>
            <OptionInput value="k_dpmpp_2m_sde">DPM++ 2M SDE</OptionInput>
            <OptionInput value="k_euler">Euler</OptionInput>
            <OptionInput value="k_dpmpp_2m">DPM++ 2M</OptionInput>
            <OptionInput value="k_dpmpp_sde">DPM++ SDE</OptionInput>
        </SelectInput>
    {:else}
        <SelectInput className="mb-4" bind:value={settings.memoryTranslateMedia.NAIImgConfig.sampler}>
            <OptionInput value="k_euler_ancestral">Euler Ancestral</OptionInput>
            <OptionInput value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</OptionInput>
            <OptionInput value="k_dpmpp_sde">DPM++ SDE</OptionInput>
            <OptionInput value="k_euler">Euler</OptionInput>
            <OptionInput value="k_dpmpp_2m">DPM++ 2M</OptionInput>
            <OptionInput value="k_dpmpp_2s">DPM++ 2S</OptionInput>
            <OptionInput value="ddim_v3">DDIM</OptionInput>
        </SelectInput>
    {/if}

    <span class="text-textcolor">Noise Schedule</span>
    <SelectInput className="mb-4" bind:value={settings.memoryTranslateMedia.NAIImgConfig.noise_schedule}>
        <OptionInput value="native">native</OptionInput>
        <OptionInput value="karras">karras</OptionInput>
        <OptionInput value="exponential">exponential</OptionInput>
        <OptionInput value="polyexponential">polyexponential</OptionInput>
    </SelectInput>

    <span class="text-textcolor">steps</span>
    <NumberInput
        size="sm"
        marginBottom
        min={0}
        max={2048}
        bind:value={settings.memoryTranslateMedia.NAIImgConfig.steps}
    />
    <span class="text-textcolor">CFG scale</span>
    <NumberInput
        size="sm"
        marginBottom
        min={0}
        max={2048}
        bind:value={settings.memoryTranslateMedia.NAIImgConfig.scale}
    />
    <span class="text-textcolor">CFG rescale</span>
    <NumberInput
        size="sm"
        marginBottom
        min={0}
        max={1}
        bind:value={settings.memoryTranslateMedia.NAIImgConfig.cfg_rescale}
    />

    <span class="text-textcolor">Image Reference</span>
    <SelectInput className="mb-4" bind:value={settings.memoryTranslateMedia.NAIImgConfig.reference_mode}>
        <OptionInput value="">None</OptionInput>
        <OptionInput value="vibe">Vibe Trasfer</OptionInput>
        {#if settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-5-full" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-5-curated"}
            <OptionInput value="character">Character Reference</OptionInput>
        {/if}
    </SelectInput>

    {#if settings.memoryTranslateMedia.NAIImgConfig.reference_mode === "vibe"}
        <div class="relative">
            <button
                class="mb-4"
                onclick={async () => {
                    const file = await selectSingleFile(["naiv4vibe"]);
                    if (!file) {
                        return null;
                    }
                    try {
                        const vibeData = JSON.parse(new TextDecoder().decode(file.data));
                        if (vibeData.version !== 1 || vibeData.identifier !== "novelai-vibe-transfer") {
                            alertError("Invalid vibe file. Version must be 1.");
                            return;
                        }

                        // Store the vibe data
                        settings.memoryTranslateMedia.NAIImgConfig.vibe_data = vibeData;

                        // Set the thumbnail as preview image for display
                        if (vibeData.thumbnail) {
                            // Clear the array and add the thumbnail
                            settings.memoryTranslateMedia.NAIImgConfig.reference_image_multiple = [];

                            // Set default model selection based on current model
                            if (settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-full")) {
                                settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection = "v4full";
                            } else if (settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-curated")) {
                                settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection = "v4curated";
                            } else if (settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-5-full")) {
                                settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection = "v4-5full";
                            } else if (
                                settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-5-curated")
                            ) {
                                settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection = "v4-5curated";
                            }

                            // Set InfoExtracted to the first value for the selected model
                            const selectedModel = settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection;
                            if (selectedModel && vibeData.encodings[selectedModel]) {
                                const encodings = vibeData.encodings[selectedModel];
                                const firstKey = Object.keys(encodings)[0];
                                if (firstKey) {
                                    settings.memoryTranslateMedia.NAIImgConfig.InfoExtracted = Number(
                                        encodings[firstKey].params.information_extracted,
                                    );
                                }
                            }
                        }

                        // Initialize reference_strength_multiple if not set
                        if (
                            !settings.memoryTranslateMedia.NAIImgConfig.reference_strength_multiple ||
                            !Array.isArray(settings.memoryTranslateMedia.NAIImgConfig.reference_strength_multiple)
                        ) {
                            settings.memoryTranslateMedia.NAIImgConfig.reference_strength_multiple = [0.7];
                        }
                    } catch (error) {
                        alertError("Error parsing vibe file: " + error);
                    }
                }}
            >
                {#if !settings.memoryTranslateMedia.NAIImgConfig.vibe_data || !settings.memoryTranslateMedia.NAIImgConfig.vibe_data.thumbnail}
                    <div
                        class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center"
                    >
                        <span class="text-sm">Upload<br />Vibe</span>
                    </div>
                {:else}
                    <img
                        src={settings.memoryTranslateMedia.NAIImgConfig.vibe_data.thumbnail}
                        alt="Vibe Preview"
                        class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                    />
                {/if}
            </button>

            {#if settings.memoryTranslateMedia.NAIImgConfig.vibe_data}
                <button
                    onclick={() => {
                        settings.memoryTranslateMedia.NAIImgConfig.vibe_data = undefined;
                        settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection = undefined;
                    }}
                    class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm"
                >
                    Delete
                </button>
            {/if}
        </div>

        {#if settings.memoryTranslateMedia.NAIImgConfig.vibe_data}
            <span class="text-textcolor">Vibe Model</span>
            <SelectInput
                className="mb-2"
                bind:value={settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection}
                onchange={(e) => {
                    // When vibe model changes, set InfoExtracted to the first value
                    if (
                        settings.memoryTranslateMedia.NAIImgConfig.vibe_data?.encodings &&
                        settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection &&
                        settings.memoryTranslateMedia.NAIImgConfig.vibe_data.encodings[
                            settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection
                        ]
                    ) {
                        const encodings =
                            settings.memoryTranslateMedia.NAIImgConfig.vibe_data.encodings[
                                settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection
                            ];
                        const firstKey = Object.keys(encodings)[0];
                        if (firstKey) {
                            settings.memoryTranslateMedia.NAIImgConfig.InfoExtracted = Number(
                                encodings[firstKey].params.information_extracted,
                            );
                        }
                    }
                }}
            >
                {#if settings.memoryTranslateMedia.NAIImgConfig.vibe_data.encodings?.v4full}
                    <OptionInput value="v4full">nai-diffusion-4-full</OptionInput>
                {/if}
                {#if settings.memoryTranslateMedia.NAIImgConfig.vibe_data.encodings?.v4curated}
                    <OptionInput value="v4curated">nai-diffusion-4-curated</OptionInput>
                {/if}
                {#if settings.memoryTranslateMedia.NAIImgConfig.vibe_data.encodings?.["v4-5full"]}
                    <OptionInput value="v4-5full">nai-diffusion-4-5-full</OptionInput>
                {/if}
                {#if settings.memoryTranslateMedia.NAIImgConfig.vibe_data.encodings?.["v4-5curated"]}
                    <OptionInput value="v4-5curated">nai-diffusion-4-5-curated</OptionInput>
                {/if}
            </SelectInput>

            <span class="text-textcolor">Information Extracted</span>
            <SelectInput className="mb-2" bind:value={settings.memoryTranslateMedia.NAIImgConfig.InfoExtracted}>
                {#if settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection && settings.memoryTranslateMedia.NAIImgConfig.vibe_data.encodings[settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection]}
                    {#each Object.entries(settings.memoryTranslateMedia.NAIImgConfig.vibe_data.encodings[settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection]) as [key, value]}
                        <OptionInput value={value.params.information_extracted}
                            >{value.params.information_extracted}</OptionInput
                        >
                    {/each}
                {/if}
            </SelectInput>

            <span class="text-textcolor">Reference Strength Multiple</span>
            <SliderInput
                marginBottom
                min={0}
                max={1}
                step={0.1}
                fixed={2}
                bind:value={settings.memoryTranslateMedia.NAIImgConfig.reference_strength_multiple[0]}
            />
        {/if}
    {/if}

    {#if settings.memoryTranslateMedia.NAIImgConfig.reference_mode === "character" && (settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-5-full" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-5-curated")}
        <div class="relative">
            <button
                class="mb-2"
                onclick={async () => {
                    const img = await selectSingleFile(["jpg", "jpeg", "png", "webp"]);
                    if (!img) {
                        return null;
                    }

                    const imageData = img.data;

                    settings.memoryTranslateMedia.NAIImgConfig.character_base64image =
                        Buffer.from(imageData).toString("base64");
                    const saveId = await saveAsset(imageData);
                    settings.memoryTranslateMedia.NAIImgConfig.character_image = saveId;
                    console.log("Character image set:", settings.memoryTranslateMedia.NAIImgConfig.character_image);
                }}
            >
                {#if !settings.memoryTranslateMedia.NAIImgConfig.character_image || settings.memoryTranslateMedia.NAIImgConfig.character_image === ""}
                    <div
                        class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center"
                    >
                        <span class="text-sm">Upload<br />Image</span>
                    </div>
                {:else}
                    {#await getCharImage(settings.memoryTranslateMedia.NAIImgConfig.character_image, "plain")}
                        <div
                            class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center"
                        >
                            <span class="text-sm">Uploading<br />Image..</span>
                        </div>
                    {:then im}
                        <img
                            src={im}
                            class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                            alt="Base Preview"
                        />
                    {/await}
                {/if}
            </button>

            {#if settings.memoryTranslateMedia.NAIImgConfig.character_image && settings.memoryTranslateMedia.NAIImgConfig.character_image !== ""}
                <button
                    onclick={() => {
                        settings.memoryTranslateMedia.NAIImgConfig.character_image = undefined;
                        settings.memoryTranslateMedia.NAIImgConfig.character_base64image = undefined;
                    }}
                    class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm"
                >
                    Delete
                </button>
            {/if}
        </div>

        <span class="text-textcolor2 text-xs mb-2 block">Leave blank to use the character's default image.</span>

        <Check
            className="mb-4"
            bind:check={settings.memoryTranslateMedia.NAIImgConfig.style_aware}
            name="Style Aware"
        />
    {/if}

    {#if (settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-3" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-furry-3" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-2") && settings.memoryTranslateMedia.NAIImgConfig.sampler !== "ddim_v3"}
        <Check bind:check={settings.memoryTranslateMedia.NAIImgConfig.sm} name="Use SMEA" />
    {/if}

    {#if settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-3" && settings.memoryTranslateMedia.NAIImgConfig.sampler !== "ddim_v3"}
        <Check bind:check={settings.memoryTranslateMedia.NAIImgConfig.sm_dyn} name="Use DYN" />
    {/if}

    {#if settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-5-full" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-5-curated" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-full" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-curated-preview" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-3" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-furry-3"}
        <Check bind:check={settings.memoryTranslateMedia.NAIImgConfig.variety_plus} name="Variety+" />
    {/if}

    {#if settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-3" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-furry-3" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-2"}
        <Check bind:check={settings.memoryTranslateMedia.NAIImgConfig.decrisp} name="Decrisp" />
    {/if}

    {#if settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-full" || settings.memoryTranslateMedia.NAIImgModel === "nai-diffusion-4-curated-preview"}
        <Check bind:check={settings.memoryTranslateMedia.NAIImgConfig.legacy_uc} name="Use legacy uc" />
    {/if}

    <Check className="mt-4 mb-4" bind:check={settings.memoryTranslateMedia.NAII2I} name="Enable I2I" />

    {#if settings.memoryTranslateMedia.NAII2I}
        <div class="relative">
            <button
                class="mb-2"
                onclick={async () => {
                    const img = await selectSingleFile(["jpg", "jpeg", "png", "webp"]);
                    if (!img) {
                        return null;
                    }
                    settings.memoryTranslateMedia.NAIImgConfig.base64image = Buffer.from(img.data).toString("base64");
                    const saveId = await saveAsset(img.data);
                    settings.memoryTranslateMedia.NAIImgConfig.image = saveId;
                }}
            >
                {#if !settings.memoryTranslateMedia.NAIImgConfig.image || settings.memoryTranslateMedia.NAIImgConfig.image === ""}
                    <div
                        class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center"
                    >
                        <span class="text-sm">Upload<br />Image</span>
                    </div>
                {:else}
                    {#await getCharImage(settings.memoryTranslateMedia.NAIImgConfig.image, "plain")}
                        <div
                            class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center"
                        >
                            <span class="text-sm">Uploading<br />Image..</span>
                        </div>
                    {:then im}
                        <img
                            src={im}
                            class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                            alt="Base Preview"
                        />
                    {/await}
                {/if}
            </button>

            {#if settings.memoryTranslateMedia.NAIImgConfig.image && settings.memoryTranslateMedia.NAIImgConfig.image !== ""}
                <button
                    onclick={() => {
                        settings.memoryTranslateMedia.NAIImgConfig.image = undefined;
                        settings.memoryTranslateMedia.NAIImgConfig.base64image = undefined;
                    }}
                    class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm"
                >
                    Delete
                </button>
            {/if}
        </div>
        <span class="text-textcolor2 text-xs block">Leave blank to use the character's default image.</span>

        <span class="text-textcolor mt-2">Strength</span>
        <SliderInput
            min={0}
            max={0.99}
            step={0.01}
            fixed={2}
            bind:value={settings.memoryTranslateMedia.NAIImgConfig.strength}
        />
        <span class="text-textcolor mt-2">Noise</span>
        <SliderInput
            min={0}
            max={0.99}
            step={0.01}
            fixed={2}
            bind:value={settings.memoryTranslateMedia.NAIImgConfig.noise}
        />
    {/if}
{/if}

{#if settings.memoryTranslateMedia.sdProvider === "dalle"}
    <CredentialStatusLink credential="openAIKey" label="OpenAI API Key" />

    <span class="text-textcolor mt-4">Dall-E Quality</span>
    <SelectInput className="mt-2 mb-4" bind:value={settings.memoryTranslateMedia.dallEQuality}>
        <OptionInput value="standard">Standard</OptionInput>
        <OptionInput value="hd">HD</OptionInput>
    </SelectInput>
{/if}

{#if settings.memoryTranslateMedia.sdProvider === "stability"}
    <span class="text-textcolor">Stability API Key</span>
    <TextInput size="sm" marginBottom placeholder="..." bind:value={settings.secrets.stabilityKey} />

    <span class="text-textcolor">Stability Model</span>
    <SelectInput className="mt-2 mb-4" bind:value={settings.memoryTranslateMedia.stabilityModel}>
        <OptionInput value="ultra">SD Ultra</OptionInput>
        <OptionInput value="core">SD Core</OptionInput>
        <OptionInput value="sd3-large">SD3 Large</OptionInput>
        <OptionInput value="sd3-medium">SD3 Medium</OptionInput>
    </SelectInput>

    {#if settings.memoryTranslateMedia.stabilityModel === "core"}
        <span class="text-textcolor">SD Core Style</span>
        <SelectInput className="mt-2 mb-4" bind:value={settings.memoryTranslateMedia.stabllityStyle}>
            <OptionInput value="">Unspecified</OptionInput>
            <OptionInput value="3d-model">3D Model</OptionInput>
            <OptionInput value="analog-film">Analog Film</OptionInput>
            <OptionInput value="anime">Anime</OptionInput>
            <OptionInput value="cinematic">Cinematic</OptionInput>
            <OptionInput value="comic-book">Comic Book</OptionInput>
            <OptionInput value="digital-art">Digital Art</OptionInput>
            <OptionInput value="enhance">Enhance</OptionInput>
            <OptionInput value="fantasy-art">Fantasy Art</OptionInput>
            <OptionInput value="isometric">Isometric</OptionInput>
            <OptionInput value="line-art">Line Art</OptionInput>
            <OptionInput value="low-poly">Low Poly</OptionInput>
            <OptionInput value="modeling-compound">Modeling Compound</OptionInput>
            <OptionInput value="neon-punk">Neon Punk</OptionInput>
            <OptionInput value="origami">Origami</OptionInput>
            <OptionInput value="photographic">Photographic</OptionInput>
            <OptionInput value="pixel-art">Pixel Art</OptionInput>
            <OptionInput value="tile-texture">Tile Texture</OptionInput>
        </SelectInput>
    {/if}
{/if}

{#if settings.memoryTranslateMedia.sdProvider === "comfyui"}
    <span class="text-textcolor mt-2">ComfyUI {language.providerURL}</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="http://127.0.0.1:8188"
        bind:value={settings.memoryTranslateMedia.comfyUiUrl}
    />

    <span class="text-textcolor">Workflow <Help key="comfyWorkflow" /></span>
    <TextInput size="sm" marginBottom bind:value={settings.memoryTranslateMedia.comfyConfig.workflow} />

    <span class="text-textcolor">Timeout (sec)</span>
    <NumberInput
        size="sm"
        marginBottom
        bind:value={settings.memoryTranslateMedia.comfyConfig.timeout}
        min={1}
        max={120}
    />
{/if}

{#if settings.memoryTranslateMedia.sdProvider === "comfy"}
    <span class="text-draculared text-xs mb-2">The first image generated by the prompt will be selected. </span>
    <span class="text-draculared text-xs mb-2">"Please run comfyUI with --enable-cors-header."</span>
    <span class="text-textcolor mt-2">ComfyUI {language.providerURL}</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="http://127.0.0.1:8188"
        bind:value={settings.memoryTranslateMedia.comfyUiUrl}
    />
    <span class="text-textcolor">Workflow</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="valid ComfyUI API json (Enable Dev mode Options in ComfyUI)"
        bind:value={settings.memoryTranslateMedia.comfyConfig.workflow}
    />

    <span class="text-textcolor">Positive Text Node: ID</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="eg. 1, 3, etc"
        bind:value={settings.memoryTranslateMedia.comfyConfig.posNodeID}
    />
    <span class="text-textcolor">Positive Text Node: Input Field Name</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="eg. text"
        bind:value={settings.memoryTranslateMedia.comfyConfig.posInputName}
    />
    <span class="text-textcolor">Negative Text Node: ID</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="eg. 1, 3, etc"
        bind:value={settings.memoryTranslateMedia.comfyConfig.negNodeID}
    />
    <span class="text-textcolor">Positive Text Node: Input Field Name</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="eg. text"
        bind:value={settings.memoryTranslateMedia.comfyConfig.negInputName}
    />
    <span class="text-textcolor">Timeout (sec)</span>
    <NumberInput
        size="sm"
        marginBottom
        bind:value={settings.memoryTranslateMedia.comfyConfig.timeout}
        min={1}
        max={120}
    />
{/if}

{#if settings.memoryTranslateMedia.sdProvider === "fal"}
    <span class="text-textcolor">Fal.ai API Key</span>
    <TextInput size="sm" marginBottom placeholder="..." bind:value={settings.secrets.falToken} />

    <span class="text-textcolor mt-4">Width</span>
    <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={settings.memoryTranslateMedia.sdConfig.width} />
    <span class="text-textcolor mt-4">Height</span>
    <NumberInput size="sm" marginBottom min={0} max={2048} bind:value={settings.memoryTranslateMedia.sdConfig.height} />

    <span class="text-textcolor mt-4">Model</span>
    <SelectInput className="mt-2" bind:value={settings.memoryTranslateMedia.falModel}>
        <OptionInput value="fal-ai/flux/dev">Flux[Dev]</OptionInput>
        <OptionInput value="fal-ai/flux-lora">Flux[Dev] with Lora</OptionInput>
        <OptionInput value="fal-ai/flux-pro">Flux[Pro]</OptionInput>
        <OptionInput value="fal-ai/flux/schnell">Flux[Schnell]</OptionInput>
    </SelectInput>

    {#if settings.memoryTranslateMedia.falModel === "fal-ai/flux-lora"}
        <span class="text-textcolor mt-4">Lora Model URL <Help key="urllora" /></span>
        <TextInput size="sm" marginBottom bind:value={settings.memoryTranslateMedia.falLora} />

        <span class="text-textcolor mt-4">Lora Weight</span>
        <SliderInput fixed={2} min={0} max={2} step={0.01} bind:value={settings.memoryTranslateMedia.falLoraScale} />
    {/if}
{/if}

{#if settings.memoryTranslateMedia.sdProvider === "Imagen"}
    <div class="mt-2 flex flex-col">
        <CredentialStatusLink credential="google" label="GoogleAI API Key" />
    </div>

    <span class="text-textcolor">Model</span>
    <SelectInput className="mb-4" bind:value={settings.memoryTranslateMedia.ImagenModel}>
        <OptionInput value="imagen-4.0-generate-001">Imagen 4</OptionInput>
        <OptionInput value="imagen-4.0-ultra-generate-001">Imagen 4 Ultra</OptionInput>
        <OptionInput value="imagen-4.0-fast-generate-001">Imagen 4 Fast</OptionInput>
        <OptionInput value="imagen-3.0-generate-002">Imagen 3.0</OptionInput>
    </SelectInput>

    {#if settings.memoryTranslateMedia.ImagenModel === "imagen-4.0-generate-001" || settings.memoryTranslateMedia.ImagenModel === "imagen-4.0-ultra-generate-001"}
        <span class="text-textcolor">Image size</span>
        <SelectInput className="mb-4" bind:value={settings.memoryTranslateMedia.ImagenImageSize}>
            <OptionInput value="1K">1K</OptionInput>
            <OptionInput value="2K">2K</OptionInput>
        </SelectInput>
    {/if}

    <span class="text-textcolor">Aspect ratio</span>
    <SelectInput className="mb-4" bind:value={settings.memoryTranslateMedia.ImagenAspectRatio}>
        <OptionInput value="1:1">1:1</OptionInput>
        <OptionInput value="3:4">3:4</OptionInput>
        <OptionInput value="4:3">4:3</OptionInput>
        <OptionInput value="9:16">9:16</OptionInput>
        <OptionInput value="16:9">16:9</OptionInput>
    </SelectInput>

    <span class="text-textcolor">Person generation</span>
    <SelectInput className="mb-4" bind:value={settings.memoryTranslateMedia.ImagenPersonGeneration}>
        <OptionInput value="allow_all">Allow all</OptionInput>
        <OptionInput value="allow_adult">Allow adult</OptionInput>
        <OptionInput value="dont_allow">Don't allow</OptionInput>
    </SelectInput>
{/if}

{#if settings.memoryTranslateMedia.sdProvider === "openai-compat"}
    <span class="text-textcolor mt-2">API URL</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="https://api.example.com/v1/images/generations"
        bind:value={settings.secrets.openaiCompatImage.url}
    />

    <span class="text-textcolor">API Key</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="sk-..."
        hideText={settings.ui.hideApiKey}
        bind:value={settings.secrets.openaiCompatImage.key}
    />

    <span class="text-textcolor">Model</span>
    <TextInput size="sm" marginBottom placeholder="dall-e-3" bind:value={settings.secrets.openaiCompatImage.model} />

    <span class="text-textcolor">Image Size</span>
    <SelectInput className="mb-4" bind:value={settings.secrets.openaiCompatImage.size}>
        <OptionInput value="1024x1024">1024x1024</OptionInput>
        <OptionInput value="1536x1024">1536x1024</OptionInput>
        <OptionInput value="1024x1536">1024x1536</OptionInput>
        <OptionInput value="512x512">512x512</OptionInput>
        <OptionInput value="256x256">256x256</OptionInput>
    </SelectInput>

    <span class="text-textcolor">Quality</span>
    <SelectInput className="mb-4" bind:value={settings.secrets.openaiCompatImage.quality}>
        <OptionInput value="auto">Auto</OptionInput>
        <OptionInput value="low">Low</OptionInput>
        <OptionInput value="medium">Medium</OptionInput>
        <OptionInput value="high">High</OptionInput>
    </SelectInput>
{/if}

{#if settings.memoryTranslateMedia.sdProvider === "wavespeed"}
    <span class="text-textcolor">API Key</span>
    <TextInput
        size="sm"
        marginBottom
        placeholder="sk-..."
        hideText={settings.ui.hideApiKey}
        bind:value={settings.secrets.wavespeedImage.key}
    />

    <span class="text-textcolor">Model</span>
    <button
        class="px-3 py-2 bg-darkbutton rounded-md hover:bg-textcolor2 transition-colors disabled:opacity-50"
        disabled={isWavespeedLoading}
        onclick={fetchWavespeedModels}
    >
        {isWavespeedLoading ? "Loading..." : "Refresh Models"}
    </button>
    <TextInput bind:value={wavespeedSearchQuery} placeholder="Search models..." size="sm" marginBottom />
    <SelectInput className="mb-4" bind:value={settings.secrets.wavespeedImage.model} onchange={handleModelChange}>
        <OptionInput value="">Select a model...</OptionInput>
        {#if wavespeedModels.length > 0}
            {#each getFilteredModels() as model}
                <OptionInput value={model.model_id}>
                    {getModelDisplayName(model)}
                </OptionInput>
            {/each}
        {:else if settings.secrets.wavespeedImage.model}
            <OptionInput value={settings.secrets.wavespeedImage.model}
                >{settings.secrets.wavespeedImage.model}</OptionInput
            >
        {/if}
    </SelectInput>

    <span class="text-textcolor mt-4">LoRAs</span>
    {#if wavespeedModels.find((m) => m.model_id === settings.secrets.wavespeedImage.model)?.supportsLoras}
        {#each wavespeedLoras as lora, index}
            <TextInput
                size="sm"
                marginBottom
                marginTop
                placeholder={`LoRA ${index + 1} URL (optional)`}
                bind:value={lora.path}
            />
            <SliderInput marginBottom min={0} max={4} step={0.1} fixed={1} bind:value={lora.scale} />
        {/each}
        <span class="text-textcolor2 text-xs mb-2 block">
            Only .safetensors files are supported. Use owner/model-name (Hugging Face) or direct URL (Civitai).
        </span>
    {:else}
        <span class="text-textcolor2 text-xs mb-2 block">
            Model does not support LoRA. Or refresh model list to update model status.
        </span>
    {/if}

    <span class="text-textcolor">Image Reference</span>
    {#if wavespeedModels.find((m) => m.model_id === settings.secrets.wavespeedImage.model)?.supportsImageInput}
        <SelectInput className="mb-4" bind:value={settings.secrets.wavespeedImage.reference_mode}>
            <OptionInput value="">None</OptionInput>
            <OptionInput value="image">Upload Image</OptionInput>
            <OptionInput value="character">Use Character Image</OptionInput>
        </SelectInput>

        {#if settings.secrets.wavespeedImage.reference_mode === "image"}
            <div class="relative">
                <button
                    class="mb-2"
                    onclick={async () => {
                        const img = await selectSingleFile(["jpg", "jpeg", "png", "webp"]);
                        if (!img) {
                            return null;
                        }

                        const imageData = img.data;

                        settings.secrets.wavespeedImage.reference_base64image =
                            Buffer.from(imageData).toString("base64");
                        const saveId = await saveAsset(imageData);
                        settings.secrets.wavespeedImage.reference_image = saveId;
                        console.log("Character image set:", settings.secrets.wavespeedImage.reference_image);
                    }}
                >
                    {#if !settings.secrets.wavespeedImage.reference_image || settings.secrets.wavespeedImage.reference_image === ""}
                        <div
                            class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center"
                        >
                            <span class="text-sm">Upload<br />Image</span>
                        </div>
                    {:else}
                        {#await getCharImage(settings.secrets.wavespeedImage.reference_image, "plain")}
                            <div
                                class="rounded-md h-20 w-20 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500 flex items-center justify-center"
                            >
                                <span class="text-sm">Uploading<br />Image..</span>
                            </div>
                        {:then im}
                            <img
                                src={im}
                                class="rounded-md h-40 shadow-lg bg-textcolor2 cursor-pointer hover:text-green-500"
                                alt="Base Preview"
                            />
                        {/await}
                    {/if}
                </button>

                {#if settings.secrets.wavespeedImage.reference_image && settings.secrets.wavespeedImage.reference_image !== ""}
                    <button
                        onclick={() => {
                            settings.secrets.wavespeedImage.reference_image = undefined;
                            settings.secrets.wavespeedImage.reference_base64image = undefined;
                        }}
                        class="absolute top-2 right-2 bg-red-500 hover:bg-red-700 text-white font-bold py-1 px-2 rounded-sm"
                    >
                        Delete
                    </button>
                {/if}
            </div>
        {/if}
        {#if settings.secrets.wavespeedImage.reference_mode === "character"}
            <span class="text-textcolor2 text-xs mb-2 block">Use the character's default image.</span>
        {/if}
    {:else}
        <span class="text-textcolor2 text-xs mb-2 block">
            Model does not support image input. Or refresh model list to update model status.
        </span>
    {/if}
{/if}
