<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import {
        AccessibilityIcon,
        ActivityIcon,
        AudioLinesIcon,
        BrainIcon,
        ImageIcon,
        PackageIcon,
        BoxIcon,
        CodeIcon,
        ContactIcon,
        DatabaseBackupIcon,
        GlobeIcon,
        LanguagesIcon,
        MonitorIcon,
        MousePointerClickIcon,
        CircleXIcon,
        KeyboardIcon,
        CpuIcon,
        ScrollTextIcon,
    } from "@lucide/svelte";
    import { language } from "src/lang";
    import type { Component } from "svelte";
    import DisplaySettings from "./Pages/DisplaySettings.svelte";
    import UserSettings from "./Pages/UserSettings.svelte";
    import ModelSettings from "./Pages/ModelSettings.svelte";
    import ModelProfilesSettings from "./Pages/ModelProfilesSettings.svelte";
    import ApiKeysSettings from "./Pages/ApiKeysSettings.svelte";
    import PromptPresetSettings from "./Pages/PromptPresetSettings.svelte";
    import MemorySettings from "./Pages/MemorySettings.svelte";
    import ImageGenerationSettings from "./Pages/ImageGenerationSettings.svelte";
    import VoiceSettings from "./Pages/VoiceSettings.svelte";
    import PluginSettings from "./Pages/PluginSettings.svelte";
    import AdvancedSettings from "./Pages/AdvancedSettings.svelte";
    import {
        additionalSettingsMenu,
        MODEL_SETTINGS_MENU,
        API_KEYS_SETTINGS_MENU,
        MODEL_PROFILES_SETTINGS_MENU,
        PROMPT_SETTINGS_MENU,
        TRANSLATION_SETTINGS_MENU,
        MEMORY_SETTINGS_MENU,
        IMAGE_GENERATION_SETTINGS_MENU,
        VOICE_SETTINGS_MENU,
        INTERACTION_SETTINGS_MENU,
        SettingsMenuIndex,
        settingsOpen,
    } from "src/ts/stores.svelte";
    import LanguageSettings from "./Pages/LanguageSettings.svelte";
    import TranslationSettings from "./Pages/TranslationSettings.svelte";
    import InteractionSettings from "./Pages/InteractionSettings.svelte";
    import AccessibilitySettings from "./Pages/AccessibilitySettings.svelte";
    import PersonaSettings from "./Pages/PersonaSettings.svelte";
    import PromptSettings from "./Pages/PromptSettings.svelte";
    import ThanksPage from "./Pages/ThanksPage.svelte";
    import ModuleSettings from "./Pages/Module/ModuleSettings.svelte";
    import HotkeySettings from "./Pages/HotkeySettings.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";

    /**
     * The sidebar, in groups (settings UI plan slice 9). An entry opens its first menu index and is
     * highlighted on any of them: Model covers its three tabs (`Model/ModelMenuTabs.svelte`), Prompt its
     * template editor (13). Labels are read at render, so a language switch shows in the next render.
     * Plugin-added menus follow the last group.
     */
    interface NavEntry {
        menus: number[];
        icon: Component;
        label: () => string;
    }
    const navGroups: { id: string; label: () => string; entries: NavEntry[] }[] = [
        {
            id: "chat",
            label: () => language.settingsNavGroupChatSetup,
            entries: [
                {
                    menus: [MODEL_SETTINGS_MENU, MODEL_PROFILES_SETTINGS_MENU, API_KEYS_SETTINGS_MENU],
                    icon: CpuIcon,
                    label: () => language.model,
                },
                { menus: [PROMPT_SETTINGS_MENU, 13], icon: ScrollTextIcon, label: () => language.prompt },
                { menus: [12], icon: ContactIcon, label: () => language.persona },
            ],
        },
        {
            id: "features",
            label: () => language.settingsNavGroupFeatures,
            entries: [
                { menus: [MEMORY_SETTINGS_MENU], icon: BrainIcon, label: () => language.memorySettings },
                { menus: [IMAGE_GENERATION_SETTINGS_MENU], icon: ImageIcon, label: () => language.imageGeneration },
                { menus: [VOICE_SETTINGS_MENU], icon: AudioLinesIcon, label: () => language.voiceSettings },
                {
                    menus: [TRANSLATION_SETTINGS_MENU],
                    icon: LanguagesIcon,
                    label: () => language.translationSettings,
                },
                { menus: [14], icon: PackageIcon, label: () => language.modules },
                { menus: [4], icon: CodeIcon, label: () => language.plugin },
            ],
        },
        {
            id: "interface",
            label: () => language.settingsNavGroupInterface,
            entries: [
                { menus: [3], icon: MonitorIcon, label: () => language.display },
                {
                    menus: [INTERACTION_SETTINGS_MENU],
                    icon: MousePointerClickIcon,
                    label: () => language.interactionSettings,
                },
                { menus: [11], icon: AccessibilityIcon, label: () => language.accessibility },
                { menus: [10], icon: GlobeIcon, label: () => language.language },
                { menus: [15], icon: KeyboardIcon, label: () => language.hotkey },
            ],
        },
        {
            id: "data",
            label: () => language.settingsNavGroupData,
            entries: [{ menus: [0], icon: DatabaseBackupIcon, label: () => language.backups }],
        },
        {
            id: "advanced",
            label: () => language.settingsNavGroupAdvanced,
            entries: [
                { menus: [6], icon: ActivityIcon, label: () => language.advancedSettings },
                { menus: [77], icon: BoxIcon, label: () => language.supporterThanks },
            ],
        },
    ];
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
                {#each navGroups as group (group.id)}
                    <div class="flex flex-col gap-2" role="group" aria-labelledby="settings-nav-{group.id}">
                        <h3
                            id="settings-nav-{group.id}"
                            class="mt-2 text-xs font-semibold uppercase tracking-wide text-textcolor2"
                        >
                            {group.label()}
                        </h3>
                        {#each group.entries as entry (entry.menus[0])}
                            {@const selected = entry.menus.includes($SettingsMenuIndex)}
                            <button
                                class="flex gap-2 items-center hover:text-textcolor"
                                class:text-textcolor={selected}
                                class:text-textcolor2={!selected}
                                onclick={() => {
                                    $SettingsMenuIndex = entry.menus[0];
                                }}
                            >
                                <entry.icon />
                                <span>{entry.label()}</span>
                            </button>
                        {/each}
                        {#if group.id === "advanced"}
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
                        {/if}
                    </div>
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
                    {:else if $SettingsMenuIndex === MEMORY_SETTINGS_MENU}
                        <MemorySettings />
                    {:else if $SettingsMenuIndex === IMAGE_GENERATION_SETTINGS_MENU}
                        <ImageGenerationSettings />
                    {:else if $SettingsMenuIndex === VOICE_SETTINGS_MENU}
                        <VoiceSettings />
                    {:else if $SettingsMenuIndex === 3}
                        <DisplaySettings />
                    {:else if $SettingsMenuIndex === 4}
                        <PluginSettings />
                    {:else if $SettingsMenuIndex === 6}
                        <AdvancedSettings />
                    {:else if $SettingsMenuIndex === 10}
                        <LanguageSettings />
                    {:else if $SettingsMenuIndex === TRANSLATION_SETTINGS_MENU}
                        <TranslationSettings />
                    {:else if $SettingsMenuIndex === INTERACTION_SETTINGS_MENU}
                        <InteractionSettings />
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
                    {:else if $SettingsMenuIndex === 15}
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

<style>
    .setting-bg {
        background: linear-gradient(to right, var(--risu-theme-darkbg) 50%, var(--risu-theme-bgcolor) 50%);
    }
</style>
