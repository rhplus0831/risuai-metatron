import "./ts/polyfill";
import "core-js/actual";
import { mount } from "svelte";
import { isNodeServer } from "./ts/platform";
import NodeServerRequired from "./lib/Others/NodeServerRequired.svelte";

window.addEventListener("vite:preloadError", (event) => {
    console.error("Chunk load error detected:", event);
    alert("The server has been updated or the network connection has been lost. Please refresh the page.");
});

if (isNodeServer) {
    // The app is imported only when served by the self-host server, so an unsupported host initializes none of it.
    import("./boot").then(({ boot }) => boot());
} else {
    mount(NodeServerRequired, {
        target: document.getElementById("app"),
    });
    document.getElementById("preloading").remove();
}
