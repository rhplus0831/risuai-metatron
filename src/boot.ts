import "./ts/storage/database.svelte";
import App from "./App.svelte";
import { loadData } from "./ts/bootstrap";
import { initHotkey } from "./ts/hotkey";
import { mount } from "svelte";

export function boot() {
    mount(App, {
        target: document.getElementById("app"),
    });
    loadData();
    initHotkey();
    document.getElementById("preloading").remove();
}
