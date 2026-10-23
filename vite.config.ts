import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import strip from "@rollup/plugin-strip";
import tailwindcss from "@tailwindcss/vite";

// The dev server stands in for the self-host server's index route and forwards its API routes to a
// running `pnpm runserver`. Set RISU_DEV_SERVER when the server uses HTTPS or another port.
const devServerTarget = process.env.RISU_DEV_SERVER ?? "http://localhost:6001";
// `pnpm dev:agent` gives its Vite a cache of its own (`util/agentDev.mjs`), so it can optimize
// dependencies beside another dev server; unset keeps Vite's `node_modules/.vite`.
const cacheDir = process.env.RISU_VITE_CACHE_DIR || undefined;

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
    return {
        cacheDir,
        plugins: [
            svelte({
                preprocess: vitePreprocess(),
                onwarn: (warning, handler) => {
                    // disable a11y warnings
                    if (warning.code.startsWith("a11y-")) return;
                    handler(warning);
                },
            }),
            tailwindcss(),
            wasm(),
            command === "build"
                ? strip({
                      include: "**/*.(mjs|js|svelte|ts)",
                  })
                : null,
            {
                name: "risu-node-flag",
                apply: "serve",
                transformIndexHtml: () => [
                    { tag: "script", children: "globalThis.__NODE__ = true", injectTo: "head-prepend" },
                ],
            },
        ],

        server: {
            host: "0.0.0.0", // listen on all addresses
            port: 5174,
            strictPort: true,
            // The server's storage (`save/`, the `pnpm dev:agent` copy `save-agent/`) is no source.
            watch: {
                ignored: [
                    "**/save/**",
                    "**/save-agent/**",
                    "**/save-agent.lock",
                    "**/.save-agent.*/**",
                    "**/save-agent.previous-*/**",
                ],
            },
            // hmr: false,
            proxy: {
                "^/(api|proxy|proxy2|hub-proxy)(/|\\?|$)": {
                    target: devServerTarget,
                    changeOrigin: true,
                    secure: false,
                    ws: true,
                },
            },
        },
        build: {
            target: "baseline-widely-available",
            minify: "oxc",
            chunkSizeWarningLimit: 2000,
        },

        resolve: {
            alias: {
                src: "/src",
            },
        },
        worker: {
            format: "es",
        },
    };
});
