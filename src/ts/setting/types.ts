/**
 * Settings Structure Types
 *
 * This module defines the schema for data-driven settings UI.
 * Settings are defined as data and rendered automatically by SettingRenderer.
 */

import type {
    ActiveModelPreset,
    ModelProfileView,
    ActivePersona,
    ActivePreset,
    SettingsRootKey,
    SettingsViews,
} from "../storage/settingsViews.svelte";
import type { CustomComponentId, CustomComponentProps } from "./customComponents";
import type { LLMModel } from "../model/types";

/**
 * Context passed to condition functions for visibility checks
 */
export interface SettingContext {
    /** The settings record views (`settings.<section>.<field>`, the collections). */
    settings: SettingsViews;
    /** The selected prompt preset, by its own field names. */
    preset: ActivePreset;
    /** The selected model preset, by its own slot fields. */
    modelPreset: ActiveModelPreset;
    /** The main slot's profile, with schema defaults for a missing profile. */
    modelProfile: ModelProfileView;
    /** The selected persona. */
    persona: ActivePersona;
    modelInfo: LLMModel;
    subModelInfo: LLMModel;
}

/**
 * Supported setting input types
 */
export type SettingType =
    | "check" // Checkbox (CheckInput)
    | "text" // Text input (TextInput)
    | "number" // Number input (NumberInput)
    | "textarea" // Multiline text (TextAreaInput)
    | "slider" // Slider (SliderInput)
    | "select" // Dropdown (SelectInput)
    | "segmented" // Sliding segmented control (SegmentedControl)
    | "color" // Color picker (ColorInput)
    | "header" // Section header (h2, span, warning)
    | "button" // Action button (Button)
    | "accordion" // Collapsible section (Accordion)
    | "custom"; // Custom component from registry

/**
 * Select option for dropdown
 */
export interface SelectOption {
    value: string;
    label?: string;
    /** i18n key for translation — takes precedence over label */
    labelKey?: string;
    /** Optional condition — when provided, the option is only shown if this returns true */
    condition?: (ctx: SettingContext) => boolean;
}

/**
 * Segment option for sliding segmented control
 */
export interface SegmentOption {
    value: string | number;
    label?: string;
    /** i18n key for translation — takes precedence over label */
    labelKey?: string;
    /** Optional condition — when provided, the option is only shown if this returns true */
    condition?: (ctx: SettingContext) => boolean;
}

/**
 * Type-specific options for setting items
 */
export interface SettingOptions {
    // number, slider
    min?: number;
    max?: number;
    step?: number;
    fixed?: number; // Decimal places for slider
    disableable?: boolean; // Allow -1000 to disable
    customText?: string | ((value: number) => string); // Custom display text for slider
    multiple?: number; // Multiplier for display value
    nullable?: boolean; // Allow null for color inputs

    // select
    selectOptions?: SelectOption[];

    // segmented control
    segmentOptions?: SegmentOption[];

    // text, textarea
    placeholder?: string;
    hideText?: boolean; // For password-like inputs
    inputClassName?: string;
    marginBottom?: boolean;

    // button
    onClick?: () => void | Promise<void>;

    // header
    level?: "h2" | "span" | "warning";

    // accordion
    styled?: boolean; // Use styled accordion
    children?: SettingItem[]; // Nested items inside accordion
}

/**
 * Single setting item definition
 */
export interface SettingItem {
    /** Unique identifier for this setting */
    id: string;

    /** UI component type */
    type: SettingType;

    /** Language key for label (language.xxx) */
    labelKey?: string;

    /** Fallback label if language key doesn't exist */
    fallbackLabel?: string;

    /** Key for help tooltip lookup in language.help */
    helpKey?: string;

    /** If true, the help icon will show as unrecommended (triangle warning icon) */
    helpUnrecommended?: boolean;

    /** If true, shows an additional experimental marker (flask icon) */
    showExperimental?: boolean;

    /**
     * Root field name for binding (a section field, a forwarded preset field by its root name, a
     * persona alias, or a collection), resolved through the settings views (`readSettingsRoot`).
     * Only for input types (check, text, number, textarea, slider, select, color)
     */
    bindKey?: SettingsRootKey;

    /**
     * Path for nested object binding (e.g., 'ooba.top_p')
     * Use when binding to nested properties like the selected preset's `ooba.top_p`; the first
     * segment is a root field name, resolved like `bindKey`
     * Takes precedence over bindKey if both are specified
     */
    bindPath?: `${SettingsRootKey}.${string}`;

    /**
     * Condition function for visibility
     * Return true to show, false to hide
     * @param ctx - Contains settings, preset, persona, modelInfo, and subModelInfo
     */
    condition?: (ctx: SettingContext) => boolean;

    /** Type-specific options */
    options?: SettingOptions;

    /** Search keywords for future search feature */
    keywords?: string[];

    /** Custom CSS classes for the main container or label */
    classes?: string;

    /** Custom CSS classes for wrapper around label + input controls */
    containerClasses?: string;

    /**
     * Component ID for custom components (type: 'custom')
     * Must be a key in customComponents registry
     */
    componentId?: CustomComponentId;

    /**
     * Props to pass to custom component
     */
    componentProps?: CustomComponentProps;

    /**
     * Optional getter function for the setting's value.
     * Recommended over bindKey/bindPath for complete type safety and reactivity.
     * TODO: Consider making SettingItem generic or using discriminated unions to eliminate `any` from accessor signatures.
     */
    getValue?: (ctx: SettingContext) => any;

    /**
     * Optional setter function for the setting's value.
     * TODO: Consider making SettingItem generic or using discriminated unions to eliminate `any` from accessor signatures.
     */
    setValue?: (val: any, ctx: SettingContext) => void;

    /**
     * Optional callback fired when the value changes (useful for side-effects like CSS updates)
     */
    onChange?: (val: any, ctx: SettingContext) => void;
}

/**
 * A named group of items on a settings page, rendered by `SettingsSections.svelte`: an always-visible
 * region with a heading, or a closed accordion when `collapsible` (only for advanced, experimental,
 * developer, and legacy groups).
 *
 * Section ids are independent of item ids. An item keeps its `SettingItem.id` when it moves between
 * sections or pages. `items` holds the leaf array's own objects, looked up with `itemsById`
 * (`sections.ts`), never copies, so `getFullSettingsData` lists each item once.
 */
export interface SettingSection {
    /** Unique across every sectioned page; stable (tests and browser checks address it). */
    id: string;
    /** Language key for the heading (language.xxx) */
    labelKey: string;
    /** Language key for a short description under the heading */
    descriptionKey?: string;
    /** Language key for a small pill beside the heading, such as "Experimental" */
    badgeKey?: string;
    /** Render as a closed accordion instead of a visible region */
    collapsible?: boolean;
    items: SettingItem[];
}

/**
 * Category definition for grouping settings
 */
export interface SettingCategory {
    id: string;
    labelKey: string;
    icon?: string;
    items: SettingItem[];
}
