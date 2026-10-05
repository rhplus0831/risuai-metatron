import { settings } from "../storage/settingsViews.svelte";

export function updateAnimationSpeed() {
    document.documentElement.style.setProperty("--risu-animation-speed", settings.ui.animationSpeed + "s");
}
