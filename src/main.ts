import "./ts/polyfill";
import "core-js/actual";
import { mount } from "svelte";
import { isNodeServer } from "./ts/platform";
import NodeServerRequired from "./lib/Others/NodeServerRequired.svelte";

/**
 * The client entry (`index.html`). `./ts/polyfill` stays ahead of the other entry imports, `core-js/actual` next: its
 * own dependencies evaluate first, and its globals (`safeStructuredClone`, `Buffer`, and the rest) are in place before
 * the app graph loads. A failed chunk load (`vite:preloadError`) alerts the user to refresh.
 *
 * `isNodeServer` (`src/ts/platform.ts`) picks the path. Served by the self-host server, the app starts through the
 * dynamic `./boot` import. Otherwise only `NodeServerRequired` mounts and `#preloading` is removed: the app graph
 * (`App.svelte`, `src/ts/bootstrap.ts`, the stores, the database) is never imported, so the notice path initializes
 * none of it. Keep every app module behind that dynamic import.
 */

window.addEventListener("vite:preloadError", (event) => {
    console.error("Chunk load error detected:", event);
    alert("The server has been updated or the network connection has been lost. Please refresh the page.");
});

if (isNodeServer) {
    import("./boot").then(({ boot }) => boot());
} else {
    mount(NodeServerRequired, {
        target: document.getElementById("app"),
    });
    document.getElementById("preloading").remove();
}
