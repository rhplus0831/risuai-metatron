// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { LLMFlags } from "../../../../shared/llm.ts";
import { language } from "src/lang";
import { activeMainProfile, settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import ModelSettings from "./ModelSettings.svelte";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement | undefined;
afterEach(async () => {
    if (component) await unmount(component);
    target?.remove();
    vi.clearAllMocks();
});

it("shows and binds Half Streaming below Response Streaming only while Response Streaming is off", () => {
    installFlatDatabase({
        characters: [],
        customModels: [],
        aiModel: "echo_model",
        subModel: "echo_model",
        useStreaming: false,
        halfStreaming: false,
        additionalParams: [],
    });
    activeMainProfile.enableCustomFlags = true;
    activeMainProfile.customFlags = [LLMFlags.hasStreaming];
    target = document.createElement("div");
    document.body.append(target);
    component = mount(ModelSettings, { target });
    flushSync();
    const checkbox = (label: string) => target!.querySelector<HTMLInputElement>(`input[type=checkbox][alt="${label}"]`);
    const half = () => checkbox(language.modelProfiles.halfStreaming);
    const response = () => checkbox(language.modelProfiles.responseStreaming)!;
    expect(half()).not.toBeNull();
    expect(response().compareDocumentPosition(half()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(half()!.checked).toBe(false);
    half()!.click();
    flushSync();
    expect(settings.providers.halfStreaming).toBe(true);
    response().click();
    flushSync();
    expect(settings.providers.useStreaming).toBe(true);
    expect(half()).toBeNull();
    response().click();
    flushSync();
    expect(half()!.checked).toBe(true);
    half()!.click();
    flushSync();
    expect(settings.providers.halfStreaming).toBe(false);
});

it("shows and binds Save Gemini thought signatures only for a thinking model, independently of streaming", () => {
    installFlatDatabase({
        characters: [],
        customModels: [],
        aiModel: "echo_model",
        subModel: "echo_model",
        useStreaming: false,
        saveSignatures: false,
        additionalParams: [],
    });
    // Exercise flag-based visibility even when the selected model has no streaming flag.
    activeMainProfile.enableCustomFlags = true;
    activeMainProfile.customFlags = [LLMFlags.geminiThinking];
    target = document.createElement("div");
    document.body.append(target);
    component = mount(ModelSettings, { target });
    flushSync();
    const checkbox = () =>
        target!.querySelector<HTMLInputElement>(`input[type=checkbox][alt="${language.modelProfiles.saveSignatures}"]`);
    for (const streaming of [false, true]) {
        settings.providers.useStreaming = streaming;
        flushSync();
        const control = checkbox();
        expect(control).not.toBeNull();
        expect(control!.closest("label")?.textContent).toContain(language.modelProfiles.saveSignatures);
        expect(control!.checked).toBe(false);
        control!.click();
        flushSync();
        expect(settings.providers.saveSignatures).toBe(true);
        expect(checkbox()!.checked).toBe(true);
        control!.click();
        flushSync();
        expect(settings.providers.saveSignatures).toBe(false);
    }
    activeMainProfile.customFlags = [];
    flushSync();
    expect(checkbox()).toBeNull();
    expect(target.textContent).not.toContain(language.modelProfiles.saveSignatures);
});
