/**
 * Custom Component Registry
 *
 * Maps component IDs (strings) to actual Svelte components.
 * This enables the data-driven settings structure to reference
 * complex components without circular import issues.
 *
 * Usage in settings data:
 *   { type: 'custom', componentId: 'ModelSelector' }
 *
 * The SettingRenderer will look up the component from this registry
 * and render it dynamically.
 */

import type { Component } from "svelte";

// Import custom components here
import TranslatorPresetSettings from "src/lib/Setting/Pages/Translation/TranslatorPresetSettings.svelte";
import BanCharacterSetSettings from "src/lib/Setting/Pages/Advanced/BanCharacterSetSettings.svelte";
import CustomModelsSettings from "src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte";
import SettingsExportButtons from "src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte";
import DiagnosticsPanel from "src/lib/Setting/Pages/Advanced/DiagnosticsPanel.svelte";
import StorageOverview from "src/lib/Setting/Pages/Storage/StorageOverview.svelte";
import StorageCleanup from "src/lib/Setting/Pages/Storage/StorageCleanup.svelte";
import StorageSnapshots from "src/lib/Setting/Pages/Storage/StorageSnapshots.svelte";
import StorageOwners from "src/lib/Setting/Pages/Storage/StorageOwners.svelte";
import StorageDetails from "src/lib/Setting/Pages/Storage/StorageDetails.svelte";
import ColorSchemeSelect from "src/lib/Setting/Pages/Display/ColorSchemeSelect.svelte";
import CustomColorSchemeEditor from "src/lib/Setting/Pages/Display/CustomColorSchemeEditor.svelte";
import CustomTextThemeEditor from "src/lib/Setting/Pages/Display/CustomTextThemeEditor.svelte";
import CustomBackgroundToggle from "src/lib/Setting/Pages/Display/CustomBackgroundToggle.svelte";
import NullableTextColorToggle from "src/lib/Setting/Pages/Display/NullableTextColorToggle.svelte";
import HandoffToggles from "src/lib/Setting/Pages/Display/HandoffToggles.svelte";
import NotificationToggle from "src/lib/Setting/Pages/Display/NotificationToggle.svelte";

/**
 * Registry of custom components.
 * Add new components here as needed.
 */
export const customComponents: Record<string, Component<any>> = {
    TranslatorPresetSettings: TranslatorPresetSettings,
    BanCharacterSetSettings: BanCharacterSetSettings,
    CustomModelsSettings: CustomModelsSettings,
    SettingsExportButtons: SettingsExportButtons,
    DiagnosticsPanel: DiagnosticsPanel,
    StorageOverview,
    StorageCleanup,
    StorageSnapshots,
    StorageOwners,
    StorageDetails,
    ColorSchemeSelect: ColorSchemeSelect,
    CustomColorSchemeEditor: CustomColorSchemeEditor,
    CustomTextThemeEditor: CustomTextThemeEditor,
    CustomBackgroundToggle: CustomBackgroundToggle,
    NullableTextColorToggle: NullableTextColorToggle,
    NotificationToggle: NotificationToggle,
    HandoffToggles,
    // Add more as we migrate complex settings
} as const;

/**
 * Type-safe component ID type.
 * Will be populated as components are added to the registry.
 */
export type CustomComponentId = keyof typeof customComponents;

/**
 * Props that can be passed to custom components
 */
export interface CustomComponentProps {
    /** Any additional props to pass to the component */
    [key: string]: unknown;
}
