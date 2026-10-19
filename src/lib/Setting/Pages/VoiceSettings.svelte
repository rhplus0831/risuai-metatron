<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import SecretInput from "src/lib/UI/GUI/SecretInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";

    const uid = $props.id();
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.voiceSettings}</h2>

<section class="mt-6 flex flex-col" aria-labelledby="{uid}-voice.tts" data-settings-section="voice.tts">
    <h3 id="{uid}-voice.tts" class="text-lg font-semibold text-textcolor">TTS</h3>
    <CheckInput bind:check={settings.memoryTranslateMedia.ttsAutoSpeech} name="Auto Speech" className="mt-2" />

    <span class="text-textcolor mt-2">ElevenLabs API key</span>
    <TextInput size="sm" marginBottom bind:value={settings.secrets.elevenLabKey} />

    <span class="text-textcolor mt-2">VOICEVOX URL</span>
    <TextInput size="sm" marginBottom bind:value={settings.memoryTranslateMedia.voicevoxUrl} />

    <span class="text-textcolor">OpenAI Key</span>
    <SecretInput path={{ kind: "flat", field: "openAIKey" }} marginBottom />

    <span class="text-textcolor mt-2">NovelAI API key</span>
    <TextInput size="sm" marginBottom placeholder="pst-..." bind:value={settings.secrets.NAIApiKey} />

    <span class="text-textcolor">Huggingface Key</span>
    <TextInput size="sm" marginBottom bind:value={settings.secrets.huggingfaceKey} placeholder="hf_..." />

    <span class="text-textcolor">fish-speech API Key</span>
    <TextInput size="sm" marginBottom bind:value={settings.secrets.fishSpeechKey} />
</section>

<section class="mt-6 flex flex-col" aria-labelledby="{uid}-voice.emotion" data-settings-section="voice.emotion">
    <h3 id="{uid}-voice.emotion" class="text-lg font-semibold text-textcolor">{language.emotionImage}</h3>
    <span class="text-textcolor mt-2">{language.emotionMethod}</span>

    <SelectInput className="mt-2 mb-4" bind:value={settings.memoryTranslateMedia.emotionProcesser}>
        <OptionInput value="submodel">Ax. Model</OptionInput>
        <OptionInput value="embedding">MiniLM-L6-v2</OptionInput>
    </SelectInput>
</section>
