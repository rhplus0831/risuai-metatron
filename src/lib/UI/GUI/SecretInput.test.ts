// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maskLlmSecrets, type SecretPath } from "../../../../shared/llmSecrets.ts";
import { llmSecretState, setMaskedSecrets } from "src/ts/storage/llmSecrets.svelte";
import { reactiveProps } from "../tests/reactiveProps.svelte";

// Phase 5 slice 7b (`request-layer-and-llm-secrets.md`): the credential input. It shows the stored
// key's status (set, with its hint; not set; saving) and never its value; a draft replaces the key
// once, on Enter or the button (no blur submit), and is emptied when queued; an empty draft submits
// nothing; the draft belongs to its path and is dropped when the input is moved to another target;
// clearing queues a clear and never the draft.

vi.mock("src/lang", () => ({
    language: {
        secretSet: "Set",
        secretNotSet: "Not set",
        secretSaving: "saving",
        secretReplace: "Replace",
        secretClear: "Clear",
    },
}));

import SecretInput from "./SecretInput.svelte";

const presetPath = (id: string): SecretPath => ({ kind: "entry", field: "presets", id });
const queued = () => llmSecretState.queue.map((op) => op.request);

let target: HTMLElement;
const mounted: ReturnType<typeof mount>[] = [];

function render(props: { path: SecretPath; onchange?: () => void }) {
    const instance = mount(SecretInput, { target, props });
    mounted.push(instance);
    flushSync();
    const input = () => target.querySelector("input") as HTMLInputElement;
    const buttons = () => [...target.querySelectorAll("button")] as HTMLButtonElement[];
    const button = (label: string) => buttons().find((b) => b.textContent?.trim() === label) ?? null;
    const status = () => target.querySelector("span")!.textContent!.replace(/\s+/g, " ").trim();
    const type = (value: string) => {
        input().value = value;
        input().dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    };
    const enter = () => {
        target.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        flushSync();
    };
    return { input, button, status, type, enter };
}

beforeEach(() => {
    llmSecretState.queue.splice(0);
    setMaskedSecrets(maskLlmSecrets({ openAIKey: "sk-stored-SENTINEL-AAAA", presets: { a: { proxyKey: "pk-a" } } }));
    target = document.createElement("div");
    document.body.appendChild(target);
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

describe("SecretInput", () => {
    it("shows the status without the value, submits a draft once on Enter or the button, and submits nothing empty", () => {
        const onchange = vi.fn();
        const { input, button, status, type, enter } = render({ path: { kind: "flat", field: "openAIKey" }, onchange });
        expect(status()).toBe("Set (…AAAA)");
        expect(target.innerHTML).not.toContain("sk-stored");
        expect(input().value).toBe("");
        expect(button("Clear")).not.toBeNull();

        // Enter with an empty draft, and the button with an empty draft: nothing.
        enter();
        button("Replace")!.click();
        flushSync();
        expect(queued()).toEqual([]);
        expect(onchange).not.toHaveBeenCalled();

        type("sk-typed-VALUE");
        enter();
        expect(queued()).toEqual([
            { kind: "put", path: { kind: "flat", field: "openAIKey" }, value: "sk-typed-VALUE" },
        ]);
        expect(onchange).toHaveBeenCalledTimes(1);
        // The draft is consumed: the field is empty, and a blur or a second Enter queues nothing more.
        expect(input().value).toBe("");
        input().dispatchEvent(new Event("blur", { bubbles: true }));
        input().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        enter();
        flushSync();
        expect(queued()).toHaveLength(1);
        expect(status()).toBe("Set · saving");
        expect(target.innerHTML).not.toContain("sk-typed");

        // The button submits the next draft, once.
        type("sk-second");
        button("Replace")!.click();
        flushSync();
        expect(queued().map((request) => (request as { value: string }).value)).toEqual([
            "sk-typed-VALUE",
            "sk-second",
        ]);
        expect(input().value).toBe("");
    });

    it("drops the draft when the input is moved to another path, and a clear queues a clear and never the draft", () => {
        const props = reactiveProps({ path: presetPath("a") as SecretPath });
        const { input, button, status, type } = render(props);
        expect(status()).toBe("Set");
        type("draft-for-a");
        props.path = presetPath("b");
        flushSync();
        expect(input().value).toBe("");
        expect(status()).toBe("Not set");
        expect(button("Clear")).toBeNull();
        expect(queued()).toEqual([]);

        props.path = presetPath("a");
        flushSync();
        type("draft-never-sent");
        button("Clear")!.click();
        flushSync();
        expect(queued()).toEqual([{ kind: "put", path: presetPath("a"), value: "" }]);
        expect(input().value).toBe("");
        expect(status()).toBe("Not set · saving");
        // Acknowledged by the server (the queue emptied, the masked record replaced): not set, no button.
        llmSecretState.queue.splice(0);
        setMaskedSecrets(maskLlmSecrets({ openAIKey: "sk-stored-SENTINEL-AAAA", presets: {} }));
        flushSync();
        expect(status()).toBe("Not set");
        expect(button("Clear")).toBeNull();
    });
});
