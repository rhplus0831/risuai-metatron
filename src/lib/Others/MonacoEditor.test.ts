// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";

// Monaco runs with its textarea input, not Chrome's EditContext (crosscheck row 13,
// `docs/research/pocketrisu-fix-crosscheck.md`): EditContext kept a stale Ctrl after the Ctrl+X popup
// editor opened, and its host is a plain `div`, so typed keys reached the global hotkeys.

const monaco = vi.hoisted(() => ({ options: [] as Record<string, unknown>[] }));
vi.mock("monaco-editor", () => ({
    editor: {
        create: (_container: HTMLElement, options: Record<string, unknown>) => {
            monaco.options.push(options);
            return {
                onDidChangeModelContent: () => {},
                getValue: () => options.value,
                getModel: () => null,
                dispose: () => {},
            };
        },
    },
}));
vi.mock("src/ts/gui/codearea/cbsMonaco", () => ({ registerCBSMonaco: () => {} }));
for (const worker of ["json/json", "css/css", "html/html", "typescript/ts"]) {
    vi.doMock(`monaco-editor/language/${worker}.worker?worker&url`, () => ({ default: "" }));
}
vi.doMock("monaco-editor/editor/editor.worker?worker&url", () => ({ default: "" }));

it("creates the editor with EditContext off", async () => {
    const { default: MonacoEditor } = await import("./MonacoEditor.svelte");
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = mount(MonacoEditor, { target, props: { value: "text" } });
    flushSync();
    try {
        expect(monaco.options).toHaveLength(1);
        expect(monaco.options[0]).toMatchObject({ value: "text", editContext: false });
    } finally {
        await unmount(instance);
    }
});
