import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import strip from "@rollup/plugin-strip";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolveBuildInfo } from "./server/src/buildInfo.ts";

// The dev server stands in for the self-host server's index route and forwards its API routes to a
// running `pnpm server`. Set RISU_DEV_SERVER when the server uses HTTPS or another port;
// `util/agentDev.mjs` sets it under `pnpm dev:agent` and `pnpm dev:human`.
const devServerTarget = process.env.RISU_DEV_SERVER ?? "http://localhost:6001";
// `pnpm dev:agent` gives its Vite a cache of its own (`util/agentDev.mjs`), so it can optimize
// dependencies beside another dev server; unset keeps Vite's `node_modules/.vite`.
const cacheDir = process.env.RISU_VITE_CACHE_DIR || undefined;

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
    // The build id the menu and the diagnostics show (`shared/buildInfo.ts`), resolved once per start.
    const buildInfo = resolveBuildInfo(fileURLToPath(new URL(".", import.meta.url)));
    return {
        cacheDir,
        // The only define; `src/ts/buildInfo.ts` reads it.
        define: {
            __RISU_BUILD__: JSON.stringify(buildInfo),
        },
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
                // The server reads it to report the build it serves (`server/src/buildInfo.ts`).
                name: "risu-build-info",
                apply: "build",
                generateBundle() {
                    this.emitFile({
                        type: "asset",
                        fileName: "build-info.json",
                        source: `${JSON.stringify(buildInfo)}\n`,
                    });
                },
            },
            {
                // Dev only (`apply: "serve"`), so `dist/index.html` never carries the flag: in production
                // the self-host server injects it (`server/src/http/staticCache.ts` `serveCachedIndex`).
                // `src/ts/platform.ts` `isNodeServer` reads it.
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
