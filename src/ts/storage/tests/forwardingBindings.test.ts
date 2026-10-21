// @vitest-environment happy-dom

import rfdc from "rfdc";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Svelte bindings through a forwarding layer: accessors on the root that forward the preset and
// persona fields to the selected record. Every case runs over the test-only prototype layer in
// `forwardingHarness.svelte.ts`, installed on its own `$state` holder (`prototypeRoot.svelte.ts`,
// standing where the removed whole-database aggregate stood). The real `getSettingValue` /
// `setSettingValue` resolve `bindKey`/`bindPath` through the settings record views (the real
// records), which the prototype does not back: the wrapper components here bind through a copy of
// the registry's older resolution over the holder (`prototypeRegistry.ts`), and the real
// `SettingNumber.svelte` case (same-flush switch) runs over the production records, installed as the
// app does. The cases about installing accessors on a database object (the install's descriptors and
// idempotence through the proxy, the shadowing `delete`, the plugin setters' root assignment) were
// retired with the aggregate; the kept rules they also showed (tracked reads, untracked writes into
// the selected record) are pinned on the views (`presetViews.test.ts`).
//
// `stores.svelte.ts` wires module updates into a module-level effect, `Help.svelte` (reached
// through the real wrapper) imports the alert module, and `database.svelte.ts` (reached through
// `process/scripts`) re-exports asset helpers; nothing under test needs them.
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("../../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import type { SettingContext, SettingItem } from "../../setting/types";
import { initializeRecords, resetRecords, takeRecordFields } from "../records.svelte";
import { selectPreset } from "../selection.svelte";
import { activePersona, activePreset, reconcileSelection, settings } from "../settingsViews.svelte";
import SettingNumber from "src/lib/Setting/Wrappers/SettingNumber.svelte";
import {
    createProbe,
    createRawDb,
    currentDb,
    FORWARDED_KEYS,
    mountPrototypeDb,
    persona,
    preset,
    snapshot,
    switchPersona,
    switchTo,
    type PrototypeDb,
} from "./forwardingHarness.svelte";
import { candidateContext } from "./prototypeRegistry";
import PrototypeNumberSync from "./PrototypeNumberSync.svelte";
import PrototypeSelectSync from "./PrototypeSelectSync.svelte";
import PrototypeTextSync from "./PrototypeTextSync.svelte";

type Mounted = ReturnType<typeof mount>;

const mounted: Mounted[] = [];
let db: PrototypeDb;

/** The context the prototype's wrapper components get: the candidate (`prototypeRegistry.ts`). */
function ctx(): SettingContext {
    return candidateContext();
}

/** The real registry's context (the record views), for the real wrapper over the production layer. */
function realCtx(): SettingContext {
    return {
        settings,
        preset: activePreset,
        persona: activePersona,
        modelInfo: undefined,
        subModelInfo: undefined,
    } as unknown as SettingContext;
}

function render(component: Parameters<typeof mount>[0], props: Record<string, unknown>) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = mount(component, { target, props });
    mounted.push(instance);
    flushSync();
    const input = <T extends Element>(selector: string) => {
        const element = target.querySelector<T>(selector);
        expect(element, `Expected ${selector} to be rendered`).not.toBeNull();
        return element as T;
    };
    return { target, input };
}

/** A user edit: the value changes and `input` fires; the effects are NOT flushed (the caller decides). */
function typeInto(element: HTMLInputElement, value: string) {
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * A user choosing an option. Svelte's `bind_select_value` resolves the chosen option with
 * `select.querySelector(":checked")` and otherwise falls back to the first enabled option; happy-dom
 * never matches `<option>` with `:checked`, so the query is answered from `selectedIndex` for the
 * duration of the `change` dispatch (an own property shadows the prototype method; deleting it restores).
 */
function chooseOption(element: HTMLSelectElement, value: string) {
    element.value = value;
    const querySelector = element.querySelector.bind(element);
    (element as { querySelector: unknown }).querySelector = (selector: string) =>
        selector === ":checked" ? (element.options[element.selectedIndex] ?? null) : querySelector(selector);
    try {
        element.dispatchEvent(new Event("change", { bubbles: true }));
    } finally {
        delete (element as { querySelector?: unknown }).querySelector;
    }
}

function numberItem(overrides: Partial<SettingItem> = {}): SettingItem {
    return {
        id: "spike.temperature",
        type: "number",
        fallbackLabel: "Temperature",
        bindKey: "temperature",
        onChange: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    db = mountPrototypeDb();
});

afterEach(async () => {
    const instances = mounted.splice(0);
    await Promise.all(instances.map((instance) => unmount(instance)));
    document.body.replaceChildren();
    // The real-wrapper case installs the production records; forget its records and selection.
    selectPreset("");
    resetRecords();
});

describe("bind:value on a top-level and a nested forwarded key writes the selected record", () => {
    it("top-level `temperature` through the number wrapper", () => {
        const item = numberItem();
        const { input } = render(PrototypeNumberSync, { item, ctx: ctx(), id: "p1-number" });
        const element = input<HTMLInputElement>("input#p1-number");
        expect(element.value).toBe("80");

        typeInto(element, "91");
        flushSync();
        expect(preset("a")!.temperature).toBe(91);
        expect(preset("b")!.temperature).toBe(50);

        switchTo("b");
        flushSync();
        expect(element.value).toBe("50");

        typeInto(element, "33");
        flushSync();
        expect(preset("b")!.temperature).toBe(33);
        expect(preset("a")!.temperature).toBe(91);
    });

    it("nested `promptSettings.postEndInnerFormat` through a `bindPath`, including a record where the object is null", () => {
        const item: SettingItem = {
            id: "spike.postEndInnerFormat",
            type: "text",
            fallbackLabel: "Post end inner format",
            bindPath: "promptSettings.postEndInnerFormat",
        };
        const { input } = render(PrototypeTextSync, { item, ctx: ctx(), id: "p1-text" });
        const element = input<HTMLInputElement>("input#p1-text");
        expect(element.value).toBe("a-format");

        typeInto(element, "edited-format");
        flushSync();
        expect(preset("a")!.promptSettings).toEqual({ postEndInnerFormat: "edited-format", sendChatAsSystem: false });
        expect(preset("b")!.promptSettings).toBeNull();

        switchTo("b");
        flushSync();
        expect(element.value).toBe("");

        // `setSettingValue` does `db.promptSettings ??= {}` on the way down: the setter lands the
        // container in record b, then the leaf.
        typeInto(element, "b-format");
        flushSync();
        expect(preset("b")!.promptSettings).toEqual({ postEndInnerFormat: "b-format" });
        expect(preset("a")!.promptSettings?.postEndInnerFormat).toBe("edited-format");
        expect(element.value).toBe("b-format");
    });

    it("persona field `username` (aliased to `personas[].name`) and the renamed `reasoningEffort` alias", () => {
        const item: SettingItem = {
            id: "spike.username",
            type: "text",
            fallbackLabel: "Name",
            bindKey: "username",
        };
        const { input } = render(PrototypeTextSync, { item, ctx: ctx(), id: "p1-persona" });
        const element = input<HTMLInputElement>("input#p1-persona");
        expect(element.value).toBe("User One");

        typeInto(element, "Neo");
        flushSync();
        expect(persona("p1")!.name).toBe("Neo");
        expect(persona("p2")!.name).toBe("User Two");

        switchPersona("p2");
        flushSync();
        expect(element.value).toBe("User Two");

        expect(db.reasoningEffort).toBe(1);
        db.reasoningEffort = 3;
        expect(preset("a")!.reasonEffort).toBe(3);
        expect(Object.hasOwn(preset("a")!, "reasoningEffort")).toBe(false);
        switchTo("b");
        expect(db.reasoningEffort).toBe(2);
    });
});

describe("snapshots, JSON, and key enumeration see forwarded values as plain properties", () => {
    it("$state.snapshot(db), JSON.stringify(db), Object.keys(db), for...in, and rfdc", () => {
        const forwarded = FORWARDED_KEYS.map((key) => key.rootKey);

        const snap = snapshot(db) as unknown as Record<string, unknown>;
        expect(snap.temperature).toBe(80);
        expect(snap.maxContext).toBe(4000);
        expect(snap.reasoningEffort).toBe(1);
        expect(snap.promptSettings).toEqual({ postEndInnerFormat: "a-format", sendChatAsSystem: false });
        expect(snap.username).toBe("User One");
        expect(snap.userIcon).toBe("icon-1");
        expect(snap.personaPrompt).toBe("I am one.");
        expect(snap.plainKey).toBe("plain");
        for (const key of forwarded) {
            const descriptor = Object.getOwnPropertyDescriptor(snap, key);
            expect(descriptor && "value" in descriptor, `${key} is a plain value in the snapshot`).toBe(true);
        }
        // The collection itself is still the source of truth inside the same snapshot.
        expect((snap.botPresets as { temperature: number }[])[0].temperature).toBe(80);

        const json = JSON.parse(JSON.stringify(db));
        expect(json.temperature).toBe(80);
        expect(json.reasoningEffort).toBe(1);
        expect(json.username).toBe("User One");
        expect(json.promptSettings).toEqual({ postEndInnerFormat: "a-format", sendChatAsSystem: false });

        const keys = Object.keys(db);
        for (const key of forwarded) {
            expect(keys).toContain(key);
        }
        expect(keys).toEqual(
            expect.arrayContaining(["botPresets", "botPresetId", "personas", "personaId", "plainKey"]),
        );

        const seen: string[] = [];
        for (const key in db) {
            seen.push(key);
        }
        expect(seen).toEqual(keys);

        // `safeStructuredClone` falls back to rfdc when native structuredClone throws on the proxy.
        expect(() => structuredClone(db)).toThrow();
        const cloned = rfdc()(db) as unknown as Record<string, unknown>;
        expect(cloned.temperature).toBe(80);
        expect(cloned.username).toBe("User One");

        // After a switch the same calls reflect the other record.
        switchTo("b");
        switchPersona("p2");
        expect((snapshot(db) as unknown as Record<string, unknown>).temperature).toBe(50);
        expect(JSON.parse(JSON.stringify(db)).username).toBe("User Two");
    });
});

describe("a wrapper write made in the same flush as a switch must land in the record selected at the time", () => {
    it("the real SettingNumber.svelte (a function binding): 91 lands in `a`, `b` is unchanged, onChange fires once", () => {
        // The old wrapper (`localValue` + two effects) lost this edit: the DB-to-local effect ran
        // first and overwrote `localValue` with b's value, so the guarded write-back had nothing to
        // write. The wrapper now uses the replacement pattern below; this is the regression test for
        // the real wrapper. Its registry reads the real records, so it runs over the production
        // records (presets `a` at 80 and `b` at 50, as in the harness), installed as the app does; the
        // switch is the selection.
        selectPreset("");
        initializeRecords(
            takeRecordFields({
                characters: [],
                botPresets: [
                    { id: "a", name: "A", temperature: 80 },
                    { id: "b", name: "B", temperature: 50 },
                ],
            }),
        );
        reconcileSelection();
        const real = (id: string) => settings.presets.find((entry) => entry.id === id)!;
        const item = numberItem();
        const { target } = render(SettingNumber, { item, ctx: realCtx() });
        const element = target.querySelector<HTMLInputElement>("input")!;
        expect(element.value).toBe("80");

        typeInto(element, "91");
        selectPreset("b");
        flushSync();

        expect(real("a").temperature).toBe(91);
        expect(real("b").temperature).toBe(50);
        expect(element.value).toBe("50");
        expect(item.onChange).toHaveBeenCalledTimes(1);
        expect(item.onChange).toHaveBeenCalledWith(91, expect.anything());
    });

    it("replacement pattern (function binding, synchronous setSettingValue): 91 lands in `a`, `b` is unchanged, onChange fires once", () => {
        const item = numberItem();
        const { input } = render(PrototypeNumberSync, { item, ctx: ctx(), id: "p4-sync" });
        const element = input<HTMLInputElement>("input#p4-sync");
        expect(item.onChange).not.toHaveBeenCalled();

        typeInto(element, "91");
        switchTo("b");
        flushSync();

        expect(preset("a")!.temperature).toBe(91);
        expect(preset("b")!.temperature).toBe(50);
        expect(element.value).toBe("50");
        expect(item.onChange).toHaveBeenCalledTimes(1);
        expect(item.onChange).toHaveBeenCalledWith(91, expect.anything());

        // The switch re-render and further flushes do not call onChange again.
        flushSync();
        switchTo("a");
        flushSync();
        expect(element.value).toBe("91");
        expect(item.onChange).toHaveBeenCalledTimes(1);

        typeInto(element, "42");
        flushSync();
        expect(preset("a")!.temperature).toBe(42);
        expect(item.onChange).toHaveBeenCalledTimes(2);
    });

    it("select variant: onChange fires once per user edit, not on a switch; the hidden-option fallback still writes", () => {
        const item: SettingItem = {
            id: "spike.username.select",
            type: "select",
            fallbackLabel: "Name",
            bindKey: "username",
            onChange: vi.fn(),
            options: {
                selectOptions: [
                    { value: "User One", label: "One" },
                    { value: "User Two", label: "Two" },
                    { value: "Someone", label: "Someone" },
                ],
            },
        };
        const { target } = render(PrototypeSelectSync, { item, ctx: ctx() });
        const select = target.querySelector<HTMLSelectElement>("select")!;
        expect(select.value).toBe("User One");
        expect(item.onChange).not.toHaveBeenCalled();

        chooseOption(select, "Someone");
        flushSync();
        expect(persona("p1")!.name).toBe("Someone");
        expect(persona("p2")!.name).toBe("User Two");
        expect(item.onChange).toHaveBeenCalledTimes(1);

        switchPersona("p2");
        flushSync();
        expect(select.value).toBe("User Two");
        expect(item.onChange).toHaveBeenCalledTimes(1);

        // Hidden-option fallback: a mount whose current value is not among the visible options
        // writes the last visible option through the setter, once, into the selected record.
        const hidden: SettingItem = {
            ...item,
            id: "spike.username.hidden",
            onChange: vi.fn(),
            options: {
                selectOptions: [
                    { value: "X", label: "X" },
                    { value: "Y", label: "Y" },
                ],
            },
        };
        const second = render(PrototypeSelectSync, { item: hidden, ctx: ctx() });
        const secondSelect = second.target.querySelector<HTMLSelectElement>("select")!;
        expect(persona("p2")!.name).toBe("Y");
        expect(persona("p1")!.name).toBe("Someone");
        expect(secondSelect.value).toBe("Y");
        expect(hidden.onChange).toHaveBeenCalledTimes(1);
    });
});

describe("collection replacement and removal", () => {
    it("after `db.botPresets` is replaced by a new array with the same ids, the accessor reads and writes the new records", () => {
        const probe = createProbe(() => db.temperature);
        const oldA = preset("a")!;

        const replacement = JSON.parse(JSON.stringify(snapshot(db.botPresets))) as PrototypeDb["botPresets"];
        replacement[0].temperature = 77;
        db.botPresets = replacement;
        flushSync();

        expect(probe.seen).toEqual([80, 77]);
        expect(db.temperature).toBe(77);

        db.temperature = 12;
        expect(preset("a")!.temperature).toBe(12);
        expect(preset("a")).not.toBe(oldA);
        expect(oldA.temperature).toBe(80);
        expect(db.botPresetId).toBe("a");
        probe.dispose();
    });

    it("after the selected record is removed, the getter falls back to the first record, persists the fallback, and does not throw, also inside a $derived", () => {
        const probe = createProbe(() => db.temperature);

        db.botPresets = db.botPresets.filter((p) => p.id !== "a");
        // No effect has run yet: the first read is through the derived (a DERIVED reaction, where a
        // tracked write would hit Svelte's `state_unsafe_mutation` guard).
        expect(() => probe.derived()).not.toThrow();
        expect(probe.derived()).toBe(50);
        expect(db.botPresetId).toBe("b");

        flushSync();
        expect(probe.seen).toEqual([80, 50]);

        // Now that the selection was reconciled, a write lands in b.
        db.temperature = 9;
        expect(preset("b")!.temperature).toBe(9);
        probe.dispose();
    });

    it("the fallback persist must be untracked: a tracked write to the selection inside a $derived throws", () => {
        // Why the harness wraps `db[selection] = first.id` in `untrack`: Svelte's `set` guard
        // (`reactivity/sources.js`) rejects a tracked write from a DERIVED reaction. A real layer must
        // keep the untrack, or the first read after a removal throws from any `$derived`.
        const tracked = createProbe(() => {
            db.botPresetId = "b";
            return db.temperature;
        });
        // The effect re-runs once after its own write changed the selection; the value stays b's.
        expect(tracked.seen[0]).toBe(50);
        expect(() => tracked.derived()).toThrow(/state_unsafe_mutation/);
        tracked.dispose();
    });

    it("a write whose selected id has no record is dropped, never redirected; a local splice behaves the same", () => {
        // Removal by a local splice, no read in between.
        db.botPresets.splice(0, 1);
        expect(db.botPresetId).toBe("a");

        db.temperature = 5;
        expect(preset("b")!.temperature).toBe(50);
        expect(db.botPresets).toHaveLength(1);

        // The next read reconciles; the write after it lands.
        expect(db.temperature).toBe(50);
        expect(db.botPresetId).toBe("b");
        db.temperature = 5;
        expect(preset("b")!.temperature).toBe(5);

        // An empty collection: the getter returns undefined and the setter drops the write.
        db.botPresets = [];
        expect(db.temperature).toBeUndefined();
        expect(() => {
            db.temperature = 1;
        }).not.toThrow();
        expect(db.botPresetId).toBe("b");
    });
});

describe("edit, switch, serialize, rebuild", () => {
    it("the edit is in `a` and `b` is unchanged after the mirror is rebuilt from the serialized collection", () => {
        const item = numberItem();
        const { input } = render(PrototypeNumberSync, { item, ctx: ctx(), id: "p6" });
        typeInto(input<HTMLInputElement>("input#p6"), "91");
        switchTo("b");
        flushSync();

        const text = JSON.stringify(snapshot(db.botPresets));
        const selection = db.botPresetId;

        const rebuilt = mountPrototypeDb({ ...createRawDb(), botPresets: JSON.parse(text), botPresetId: selection });
        expect(rebuilt).toBe(currentDb());
        expect(rebuilt.botPresetId).toBe("b");
        expect(rebuilt.temperature).toBe(50);
        expect(preset("a")!.temperature).toBe(91);
        expect(preset("b")!.temperature).toBe(50);

        switchTo("a");
        expect(rebuilt.temperature).toBe(91);
        expect(item.onChange).toHaveBeenCalledTimes(1);
    });
});
