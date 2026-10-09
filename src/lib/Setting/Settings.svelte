<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import {
        AccessibilityIcon,
        ActivityIcon,
        PackageIcon,
        BoxIcon,
        CodeIcon,
        ContactIcon,
        LanguagesIcon,
        MonitorIcon,
        Sailboat,
        UserIcon,
        CircleXIcon,
        KeyboardIcon,
        CpuIcon,
        ScrollTextIcon,
        KeyRoundIcon,
    } from "@lucide/svelte";
    import { language } from "src/lang";
    import DisplaySettings from "./Pages/DisplaySettings.svelte";
    import UserSettings from "./Pages/UserSettings.svelte";
    import ModelSettings from "./Pages/ModelSettings.svelte";
    import ModelProfilesSettings from "./Pages/ModelProfilesSettings.svelte";
    import ApiKeysSettings from "./Pages/ApiKeysSettings.svelte";
    import PromptPresetSettings from "./Pages/PromptPresetSettings.svelte";
    import OtherBotSettings from "./Pages/OtherBotSettings.svelte";
    import PluginSettings from "./Pages/PluginSettings.svelte";
    import AdvancedSettings from "./Pages/AdvancedSettings.svelte";
    import {
        additionalSettingsMenu,
        MODEL_SETTINGS_MENU,
        API_KEYS_SETTINGS_MENU,
        MODEL_PROFILES_SETTINGS_MENU,
        PROMPT_SETTINGS_MENU,
        SettingsMenuIndex,
        settingsOpen,
    } from "src/ts/stores.svelte";
    import Communities from "./Pages/Communities.svelte";
    import GlobalLoreBookSettings from "./Pages/GlobalLoreBookSettings.svelte";
    import Lorepreset from "./lorepreset.svelte";
    import GlobalRegex from "./Pages/GlobalRegex.svelte";
    import LanguageSettings from "./Pages/LanguageSettings.svelte";
    import AccessibilitySettings from "./Pages/AccessibilitySettings.svelte";
    import PersonaSettings from "./Pages/PersonaSettings.svelte";
    import PromptSettings from "./Pages/PromptSettings.svelte";
    import ThanksPage from "./Pages/ThanksPage.svelte";
    import ModuleSettings from "./Pages/Module/ModuleSettings.svelte";
    import HotkeySettings from "./Pages/HotkeySettings.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";

    let openLoreList = $state(false);
    if (window.innerWidth >= 900 && $SettingsMenuIndex === -1) {
        $SettingsMenuIndex = MODEL_SETTINGS_MENU;
    }
</script>

<div class="h-full w-full flex justify-center rs-setting-cont setting-bg">
    <div class="h-full max-w-(--breakpoint-lg) w-full flex relative rs-setting-cont-2">
        {#if window.innerWidth >= 700 || $SettingsMenuIndex === -1}
            <div
                class="flex h-full flex-col p-4 pt-8 gap-2 overflow-y-auto relative rs-setting-cont-3 shrink-0 bg-darkbg"
                class:w-full={window.innerWidth < 700}
            >
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === MODEL_SETTINGS_MENU}
                    class:text-textcolor2={$SettingsMenuIndex !== MODEL_SETTINGS_MENU}
                    onclick={() => {
                        $SettingsMenuIndex = MODEL_SETTINGS_MENU;
                    }}
                >
                    <CpuIcon />
                    <span>{language.model}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === MODEL_PROFILES_SETTINGS_MENU}
                    class:text-textcolor2={$SettingsMenuIndex !== MODEL_PROFILES_SETTINGS_MENU}
                    onclick={() => {
                        $SettingsMenuIndex = MODEL_PROFILES_SETTINGS_MENU;
                    }}
                >
                    <CpuIcon />
                    <span>{language.modelProfiles.title}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === API_KEYS_SETTINGS_MENU}
                    class:text-textcolor2={$SettingsMenuIndex !== API_KEYS_SETTINGS_MENU}
                    onclick={() => {
                        $SettingsMenuIndex = API_KEYS_SETTINGS_MENU;
                    }}
                >
                    <KeyRoundIcon />
                    <span>{language.apiKeys}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === PROMPT_SETTINGS_MENU || $SettingsMenuIndex === 13}
                    class:text-textcolor2={$SettingsMenuIndex !== PROMPT_SETTINGS_MENU && $SettingsMenuIndex !== 13}
                    onclick={() => {
                        $SettingsMenuIndex = PROMPT_SETTINGS_MENU;
                    }}
                >
                    <ScrollTextIcon />
                    <span>{language.prompt}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 12}
                    class:text-textcolor2={$SettingsMenuIndex !== 12}
                    onclick={() => {
                        $SettingsMenuIndex = 12;
                    }}
                >
                    <ContactIcon />
                    <span>{language.persona}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 2}
                    class:text-textcolor2={$SettingsMenuIndex !== 2}
                    onclick={() => {
                        $SettingsMenuIndex = 2;
                    }}
                >
                    <Sailboat />
                    <span>{language.otherBots}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 3}
                    class:text-textcolor2={$SettingsMenuIndex !== 3}
                    onclick={() => {
                        $SettingsMenuIndex = 3;
                    }}
                >
                    <MonitorIcon />
                    <span>{language.display}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 10}
                    class:text-textcolor2={$SettingsMenuIndex !== 10}
                    onclick={() => {
                        $SettingsMenuIndex = 10;
                    }}
                >
                    <LanguagesIcon />
                    <span>{language.language}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 11}
                    class:text-textcolor2={$SettingsMenuIndex !== 11}
                    onclick={() => {
                        $SettingsMenuIndex = 11;
                    }}
                >
                    <AccessibilityIcon />
                    <span>{language.accessibility}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 14}
                    class:text-textcolor2={$SettingsMenuIndex !== 14}
                    onclick={() => {
                        $SettingsMenuIndex = 14;
                    }}
                >
                    <PackageIcon />
                    <span>{language.modules}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 4}
                    class:text-textcolor2={$SettingsMenuIndex !== 4}
                    onclick={() => {
                        $SettingsMenuIndex = 4;
                    }}
                >
                    <CodeIcon />
                    <span>{language.plugin}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 0}
                    class:text-textcolor2={$SettingsMenuIndex !== 0}
                    onclick={() => {
                        $SettingsMenuIndex = 0;
                    }}
                >
                    <UserIcon />
                    <span>{language.files}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 15}
                    class:text-textcolor2={$SettingsMenuIndex !== 15}
                    onclick={() => {
                        $SettingsMenuIndex = 15;
                    }}
                >
                    <KeyboardIcon />
                    <span>{language.hotkey}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 6}
                    class:text-textcolor2={$SettingsMenuIndex !== 6}
                    onclick={() => {
                        $SettingsMenuIndex = 6;
                    }}
                >
                    <ActivityIcon />
                    <span>{language.advancedSettings}</span>
                </button>
                <button
                    class="flex gap-2 items-center hover:text-textcolor"
                    class:text-textcolor={$SettingsMenuIndex === 77}
                    class:text-textcolor2={$SettingsMenuIndex !== 77}
                    onclick={() => {
                        $SettingsMenuIndex = 77;
                    }}
                >
                    <BoxIcon />
                    <span>{language.supporterThanks}</span>
                </button>
                {#each additionalSettingsMenu as menu}
                    <button
                        class="flex gap-2 items-center hover:text-textcolor text-textcolor2"
                        onclick={() => {
                            menu.callback();
                        }}
                    >
                        <PluginDefinedIcon ico={menu} />
                        <span>{menu.name}</span>
                    </button>
                {/each}

                {#if window.innerWidth < 700}
                    <button
                        class="absolute top-2 right-2 hover:text-green-500 text-textcolor"
                        onclick={() => {
                            settingsOpen.set(false);
                        }}
                    >
                        <CircleXIcon size={settings.ui.settingsCloseButtonSize} />
                    </button>
                {/if}
            </div>
        {/if}
        {#if window.innerWidth >= 700 || $SettingsMenuIndex !== -1}
            {#key $SettingsMenuIndex}
                <div
                    class="grow py-6 px-4 bg-bgcolor flex flex-col text-textcolor overflow-y-auto relative rs-setting-cont-4 min-w-0"
                >
                    {#if $SettingsMenuIndex === 0}
                        <UserSettings />
                    {:else if $SettingsMenuIndex === MODEL_SETTINGS_MENU}
                        <ModelSettings />
                    {:else if $SettingsMenuIndex === MODEL_PROFILES_SETTINGS_MENU}
                        <ModelProfilesSettings />
                    {:else if $SettingsMenuIndex === API_KEYS_SETTINGS_MENU}
                        <ApiKeysSettings />
                    {:else if $SettingsMenuIndex === PROMPT_SETTINGS_MENU}
                        <PromptPresetSettings
                            goPromptTemplate={() => {
                                $SettingsMenuIndex = 13;
                            }}
                        />
                    {:else if $SettingsMenuIndex === 2}
                        <OtherBotSettings />
                    {:else if $SettingsMenuIndex === 3}
                        <DisplaySettings />
                    {:else if $SettingsMenuIndex === 4}
                        <PluginSettings />
                    {:else if $SettingsMenuIndex === 6}
                        <AdvancedSettings />
                    {:else if $SettingsMenuIndex === 7}
                        <Communities />
                    {:else if $SettingsMenuIndex === 8}
                        <GlobalLoreBookSettings bind:openLoreList />
                    {:else if $SettingsMenuIndex === 9}
                        <GlobalRegex />
                    {:else if $SettingsMenuIndex === 10}
                        <LanguageSettings />
                    {:else if $SettingsMenuIndex === 11}
                        <AccessibilitySettings />
                    {:else if $SettingsMenuIndex === 12}
                        <PersonaSettings />
                    {:else if $SettingsMenuIndex === 14}
                        <ModuleSettings />
                    {:else if $SettingsMenuIndex === 13}
                        <PromptSettings
                            onGoBack={() => {
                                $SettingsMenuIndex = PROMPT_SETTINGS_MENU;
                            }}
                        />
                    {:else if $SettingsMenuIndex === 15 && window.innerWidth >= 768}
                        <HotkeySettings />
                    {:else if $SettingsMenuIndex === 77}
                        <ThanksPage />
                    {/if}
                </div>
            {/key}
            <button
                class="absolute top-2 right-2 hover:text-green-500 text-textcolor"
                onclick={() => {
                    if (window.innerWidth >= 700) {
                        settingsOpen.set(false);
                    } else {
                        $SettingsMenuIndex = -1;
                    }
                }}
            >
                <CircleXIcon size={settings.ui.settingsCloseButtonSize} />
            </button>
        {/if}
    </div>
</div>
{#if openLoreList}
    <Lorepreset
        close={() => {
            openLoreList = false;
        }}
    />
{/if}

<style>
    .setting-bg {
        background: linear-gradient(to right, var(--risu-theme-darkbg) 50%, var(--risu-theme-bgcolor) 50%);
    }
</style>
