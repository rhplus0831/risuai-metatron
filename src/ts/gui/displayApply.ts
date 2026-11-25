import { updateAnimationSpeed } from "./animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./colorscheme";
import { updateGuisize } from "./guisize";

/** Re-applies display settings after remote UI records, UI recovery drafts, and plugin UI writes. */
export function applyDisplaySettings() {
    updateColorScheme();
    updateTextThemeAndCSS();
    updateAnimationSpeed();
    updateGuisize();
}
