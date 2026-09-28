import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import wasm from "vite-plugin-wasm";
import strip from "@rollup/plugin-strip";
import tailwindcss from "@tailwindcss/vite";

// The dev server stands in for the self-host server's index route and forwards its API routes to a
// running `pnpm runserver`. Set RISU_DEV_SERVER when the server uses HTTPS or another port.
const devServerTarget = process.env.RISU_DEV_SERVER ?? "http://localhost:6001";

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
    return {
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
            // hmr: false,
            proxy: {
                "^/(api|proxy|proxy2|hub-proxy|proxy-stream-jobs)(/|\\?|$)": {
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

        optimizeDeps: {
            exclude: ["@browsermt/bergamot-translator"],
            needsInterop: ["@mlc-ai/web-tokenizers"],
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
