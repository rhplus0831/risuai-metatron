import { isImeComposing } from "../ime";
import { sleep } from "../util";

export type InputTranslationField = "main" | "translation";

type InputTranslationDependencies = {
    translate: (text: string, reverse: boolean) => Promise<string | null | undefined>;
    isExperimental: () => boolean;
    enabled: () => boolean;
    wait?: (milliseconds: number) => Promise<unknown>;
    getText: (field: InputTranslationField) => string;
    setText: (field: InputTranslationField, text: string) => void;
    getChatKey: () => string | null;
};

/** Publishes a translation only while its source, destination draft, and chat still belong to the run. */
export function createInputTranslation(deps: InputTranslationDependencies) {
    let token = 0;
    const composing: Record<InputTranslationField, boolean> = { main: false, translation: false };
    const wait = deps.wait ?? sleep;

    function invalidate() {
        token++;
    }

    function compositionStart(field: InputTranslationField) {
        composing[field] = true;
    }

    function compositionEnd(field: InputTranslationField) {
        composing[field] = false;
    }

    async function run(reverse: boolean) {
        const runToken = ++token;
        if (!deps.enabled()) {
            return;
        }
        const sourceField = reverse ? "translation" : "main";
        const destinationField = reverse ? "main" : "translation";
        const source = deps.getText(sourceField);
        const destination = deps.getText(destinationField);
        const chatKey = deps.getChatKey();
        const experimental = deps.isExperimental();
        const ownsDraft = () =>
            runToken === token &&
            deps.enabled() &&
            deps.getText(sourceField) === source &&
            deps.getText(destinationField) === destination &&
            deps.getChatKey() === chatKey &&
            !composing[destinationField];

        if ((experimental && !reverse) || source === "") {
            if (!composing[destinationField]) {
                deps.setText(destinationField, "");
            }
            return;
        }
        if (experimental) {
            await wait(1500);
            if (!ownsDraft()) {
                return;
            }
        }
        const translated = await deps.translate(source, reverse);
        if (translated && ownsDraft()) {
            deps.setText(destinationField, translated);
        }
    }

    return { run, invalidate, compositionStart, compositionEnd };
}

type ComposerKeydownOptions = {
    sendWithEnter: boolean;
    send: () => unknown;
    reroll: () => unknown;
};

/**
 * The main composer's keys: Enter sends with `sendWithEnter` (Shift+Enter is a new line), Shift+Enter
 * sends without it, and Ctrl+M rerolls. Skipped while an IME composes (`isImeComposing`), with no
 * `preventDefault`, so the IME keeps the key.
 */
export function handleMainComposerKeydown(event: KeyboardEvent, options: ComposerKeydownOptions) {
    if (isImeComposing(event)) {
        return;
    }
    if (event.key.toLocaleLowerCase() === "enter") {
        if (options.sendWithEnter && !event.shiftKey) {
            options.send();
            event.preventDefault();
        } else if (!options.sendWithEnter && event.shiftKey) {
            options.send();
            event.preventDefault();
        }
    }
    if (event.key.toLocaleLowerCase() === "m" && event.ctrlKey) {
        options.reroll();
        event.preventDefault();
    }
}

/**
 * The translation composer's keys: Enter without Shift sends only with `sendWithEnter` (no Shift+Enter
 * send without it), and Ctrl+M rerolls. Skipped while an IME composes, as `handleMainComposerKeydown` is.
 */
export function handleTranslationComposerKeydown(event: KeyboardEvent, options: ComposerKeydownOptions) {
    if (isImeComposing(event)) {
        return;
    }
    if (event.key.toLocaleLowerCase() === "enter" && !event.shiftKey && options.sendWithEnter) {
        options.send();
        event.preventDefault();
    }
    if (event.key.toLocaleLowerCase() === "m" && event.ctrlKey) {
        options.reroll();
        event.preventDefault();
    }
}
