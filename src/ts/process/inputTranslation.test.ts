import { describe, expect, it, vi } from "vitest";
import {
    createInputTranslation,
    handleMainComposerKeydown,
    handleTranslationComposerKeydown,
    type InputTranslationField,
} from "./inputTranslation.svelte";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

function draft(experimental: boolean) {
    const state = {
        text: { main: "Main draft", translation: "번역 초안" },
        enabled: true,
        chatKey: "character\u0000chat-a",
    };
    const translations: ReturnType<typeof deferred<string>>[] = [];
    const waits: ReturnType<typeof deferred<void>>[] = [];
    const translate = vi.fn((_text: string, _reverse: boolean) => {
        const result = deferred<string>();
        translations.push(result);
        return result.promise;
    });
    const wait = vi.fn((_milliseconds: number) => {
        const result = deferred<void>();
        waits.push(result);
        return result.promise;
    });
    const setText = vi.fn((field: InputTranslationField, text: string) => (state.text[field] = text));
    const runner = createInputTranslation({
        translate,
        wait,
        isExperimental: () => experimental,
        enabled: () => state.enabled,
        getText: (field) => state.text[field],
        setText,
        getChatKey: () => state.chatKey,
    });
    const finishDebounce = async () => {
        const pending = waits.at(-1)!;
        expect(wait).toHaveBeenLastCalledWith(1500);
        pending.resolve();
        await pending.promise;
    };
    return { state, runner, translate, wait, setText, translations, finishDebounce };
}

const translatingModes = [
    { experimental: false, reverse: false },
    { experimental: false, reverse: true },
    { experimental: true, reverse: true },
];

describe("input translation", () => {
    it("drops an older result when a newer overlapping run finishes first", async () => {
        for (const { experimental, reverse } of translatingModes) {
            const h = draft(experimental);
            const destination = reverse ? "main" : "translation";
            const original = h.state.text[destination];
            const a = h.runner.run(reverse);
            if (experimental) await h.finishDebounce();
            const b = h.runner.run(reverse);
            if (experimental) await h.finishDebounce();

            // Repeating a translation may produce the text already in the destination. That must
            // still supersede A, independently of the source/destination equality checks.
            h.translations[1].resolve(original);
            await b;
            expect(h.setText).toHaveBeenCalledExactlyOnceWith(destination, original);
            h.translations[0].resolve("Obsolete result A");
            await a;
            expect(h.state.text[destination]).toBe(original);
            expect(h.setText).toHaveBeenCalledTimes(1);
        }
    });

    type Draft = ReturnType<typeof draft>;
    const dropConditions: {
        reason: string;
        change: (h: Draft, source: InputTranslationField, destination: InputTranslationField) => void;
    }[] = [
        { reason: "the source text changes", change: (h, source) => (h.state.text[source] = "Newer source") },
        { reason: "the source is cleared", change: (h, source) => (h.state.text[source] = "") },
        {
            reason: "a suggestion replaces the destination",
            change: (h, _source, destination) => (h.state.text[destination] = "Copied suggestion"),
        },
        {
            reason: "the destination is cleared",
            change: (h, _source, destination) => (h.state.text[destination] = ""),
        },
        { reason: "the chat changes", change: (h) => (h.state.chatKey = "character\u0000chat-b") },
        { reason: "the runner is invalidated", change: (h) => h.runner.invalidate() },
        { reason: "input translation is turned off", change: (h) => (h.state.enabled = false) },
        {
            reason: "the destination is composing",
            change: (h, _source, destination) => h.runner.compositionStart(destination),
        },
    ];

    it.each(dropConditions)(
        "drops work when $reason, including across the experimental debounce",
        async ({ change }) => {
            const stages = [
                ...translatingModes.map((mode) => ({ ...mode, duringDebounce: false })),
                { experimental: true, reverse: true, duringDebounce: true },
            ];
            for (const { experimental, reverse, duringDebounce } of stages) {
                const h = draft(experimental);
                const source = reverse ? "translation" : "main";
                const destination = reverse ? "main" : "translation";
                const pending = h.runner.run(reverse);
                if (experimental && !duringDebounce) await h.finishDebounce();
                change(h, source, destination);
                const expectedDraft = { ...h.state.text };

                if (duringDebounce) {
                    await h.finishDebounce();
                    expect(h.translate).not.toHaveBeenCalled();
                } else {
                    h.translations[0].resolve("Late translation");
                }
                await pending;
                expect(h.setText).not.toHaveBeenCalled();
                expect(h.state.text).toEqual(expectedDraft);
            }
        },
    );

    it("publishes to the destination of an unchanged draft after composition ends", async () => {
        for (const { experimental, reverse } of translatingModes) {
            const h = draft(experimental);
            const source = reverse ? "translation" : "main";
            const destination = reverse ? "main" : "translation";
            const sourceText = h.state.text[source];
            h.runner.compositionStart(destination);
            h.runner.compositionEnd(destination);
            const pending = h.runner.run(reverse);
            expect(h.setText).not.toHaveBeenCalled();
            if (experimental) {
                expect(h.translate).not.toHaveBeenCalled();
                await h.finishDebounce();
            } else {
                expect(h.wait).not.toHaveBeenCalled();
            }
            expect(h.translate).toHaveBeenCalledExactlyOnceWith(sourceText, reverse);
            h.translations[0].resolve("Current translation");
            await pending;
            expect(h.state.text[source]).toBe(sourceText);
            expect(h.state.text[destination]).toBe("Current translation");
            expect(h.setText).toHaveBeenCalledExactlyOnceWith(destination, "Current translation");
        }
    });

    it("experimental forward input only clears the translation field and preserves an IME draft", async () => {
        const h = draft(true);
        h.runner.compositionStart("translation");
        const composing = h.runner.run(false);
        expect(h.wait).not.toHaveBeenCalled();
        expect(h.translate).not.toHaveBeenCalled();
        await composing;
        expect(h.state.text).toEqual({ main: "Main draft", translation: "번역 초안" });
        expect(h.setText).not.toHaveBeenCalled();
        h.runner.compositionEnd("translation");
        const pending = h.runner.run(false);
        expect(h.wait).not.toHaveBeenCalled();
        expect(h.translate).not.toHaveBeenCalled();
        await pending;
        expect(h.state.text).toEqual({ main: "Main draft", translation: "" });
        expect(h.setText).toHaveBeenCalledExactlyOnceWith("translation", "");
    });
});

describe.each([
    { composer: "main", handle: handleMainComposerKeydown },
    { composer: "translation", handle: handleTranslationComposerKeydown },
])("$composer composer keyboard shortcuts", ({ composer, handle }) => {
    it.each([
        { signal: "isComposing", init: { isComposing: true } },
        { signal: "keyCode 229", init: { keyCode: 229 } },
    ])("ignores send and reroll during $signal without preventing default", ({ init }) => {
        for (const sendWithEnter of [true, false]) {
            for (const shortcut of [{ key: "Enter" }, { key: "Enter", shiftKey: true }, { key: "m", ctrlKey: true }]) {
                const event = new KeyboardEvent("keydown", { ...shortcut, ...init, cancelable: true });
                const preventDefault = vi.spyOn(event, "preventDefault");
                const options = { sendWithEnter, send: vi.fn(), reroll: vi.fn() };
                handle(event, options);
                expect(options.send).not.toHaveBeenCalled();
                expect(options.reroll).not.toHaveBeenCalled();
                expect(preventDefault).not.toHaveBeenCalled();
                expect(event.defaultPrevented).toBe(false);
            }
        }
    });

    it("preserves send settings, Shift handling, and Ctrl+M outside composition", () => {
        for (const sendWithEnter of [true, false]) {
            for (const shiftKey of [false, true]) {
                const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey, cancelable: true });
                const options = { sendWithEnter, send: vi.fn(), reroll: vi.fn() };
                handle(event, options);
                const sends = composer === "main" ? sendWithEnter !== shiftKey : sendWithEnter && !shiftKey;
                expect(options.send).toHaveBeenCalledTimes(sends ? 1 : 0);
                expect(options.reroll).not.toHaveBeenCalled();
                expect(event.defaultPrevented).toBe(sends);
            }
            const event = new KeyboardEvent("keydown", { key: "m", ctrlKey: true, cancelable: true });
            const options = { sendWithEnter, send: vi.fn(), reroll: vi.fn() };
            handle(event, options);
            expect(options.send).not.toHaveBeenCalled();
            expect(options.reroll).toHaveBeenCalledTimes(1);
            expect(event.defaultPrevented).toBe(true);
        }
    });
});
