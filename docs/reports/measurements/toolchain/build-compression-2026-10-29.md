# Build compression cost — 2026-10-29

What was measured: the cost of the compression step that `pnpm build` runs after Vite
(`util/compressDist.mjs`, which writes the `.br` and `.gz` siblings into `dist/`), in build time
and in image size.

How: `pnpm build` at `4a95f84bf` plus the step, on a WSL2 host, and the same step in a Docker build
(commit `761d41c52` added the step and reported these numbers).

Build time:

- The step adds about 12 s to the build: Vite 17–18 s; `[compress-dist]` 12.0–12.4 s with the
  largest files first.
- Quality 11 on the 21.6 MB ONNX Runtime `.wasm` alone took 47 s, which is why files over 16 MiB use
  quality 9.
- In Docker the `pnpm build` step went from 18.6 s to 32.4 s.

Size:

- The siblings add 21.8 MB to `dist/` (135 files: identity 49.05 MB, br 9.17 MB, gz 12.66 MB).
- The runtime image grows by that much (`/app/dist` 141.1 MB → 162.9 MB).
- The boot-critical `lib-*.js` goes from 6.02 MB to 1.43 MB (br) or 2.13 MB (gzip).
