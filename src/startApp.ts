import "./ts/storage/database.svelte";
import App from "./App.svelte";
import { loadData } from "./ts/bootstrap";
import { initHotkey } from "./ts/hotkey";
import { mount } from "svelte";

/**
 * Starts the app (from `src/boot.ts`, after the diagnostics collector); `./ts/storage/database.svelte` is imported for
 * its side effects. The root mounts before the boot starts, and `loadData()` (`src/ts/bootstrap.ts`) is not awaited,
 * so `initHotkey()` and the `#preloading` removal do not wait for the boot.
 */
export function startApp() {
    mount(App, {
        target: document.getElementById("app"),
    });
    loadData();
    initHotkey();
    document.getElementById("preloading").remove();
}
