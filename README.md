# Risuai Metatron

<picture>
  <img alt="Risuai" src="public/logo_typo_small.avif" width="400"/>
</picture>

[![Svelte](https://img.shields.io/badge/svelte-5-red?logo=svelte)](https://svelte.dev/) [![Typescript](https://img.shields.io/badge/typescript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/) [![Vite](https://img.shields.io/badge/vite-8-%23646CFF?logo=vite)](https://vite.dev/) [![Tailwind CSS](https://img.shields.io/badge/tailwindcss-4-%2306B6D4?logo=tailwindcss)](https://tailwindcss.com/)

Risuai Metatron is a fork of [Risuai](https://github.com/kwaroran/Risuai), an AI roleplay chat client. It rebuilds Risuai around the self-host server: the browser is a client of a Hono/Node server that stores all data and generates the replies. The built client requires that server; there is no standalone static, desktop, or mobile build.

## How it differs from Risuai

- **Server only**: The static web build, the Tauri desktop app, and the Capacitor mobile app are gone. Every device uses the server through a browser, and the app can be installed as a PWA.
- **Replies are generated on the server**: Prompt assembly, the lorebook, regex scripts, triggers, Lua, memory, and the provider request run in a server job. The reply streams into the tab, and the job keeps running (for up to 30 minutes) when the tab closes or the connection drops. Only a step that needs a tab, such as a plugin's model provider, waits for one.
- **Data lives on the server**: Characters, chats, and settings are records in SQLite databases under `save/`, and assets are files in `save/assets/`. Several tabs and devices can use one server at the same time. A change reaches the other open tabs over a WebSocket feed, and a tab whose write loses to a newer one reloads that record and says so.
- **Snapshots, backups, and checkpoints**: The server snapshots its database every ten minutes when something changed and keeps the newest 20; restore one from Settings → Storage. Settings → Backups saves and loads a full backup file. A chat can save checkpoints, by hand or automatically, and load one later.
- **Unsent work is recovered**: The browser journals composer text and edits the server has not confirmed yet, and offers them back after a crash, a reload, or an outage.
- **API keys stay on the server**: A key is write-only: the browser sends it once and afterwards sees only whether it is set. Keys are named and shared between Connections (a model with its key, URL, and options), and a Model Preset picks the Connection for the main and auxiliary models, and optionally separate ones for memory, translation, emotion, and other auxiliary requests. The full backup leaves keys out.
- **Structured memory**: A long-term memory that keeps a chat's events, pages, and open threads as records. The server updates them after each reply and adds the relevant ones to the prompt.
- **Request history**: The server records its LLM requests with credentials redacted, so a failed reply can be traced to the request that failed. A setting stops it from storing request content.
- **Notifications**: Web Push tells you when a reply finished while the app was in the background.
- **Plugins**: Only API 3.0 plugins run. Plugins written for older API versions stay listed as unsupported.
- **No Risu Account**: Account login and cloud sync are removed. RisuRealm remains for browsing and downloading characters.
- **Metatron theme**: A new interface theme, next to the ones Risuai has.

## Features

- **Model providers**: OpenAI, Anthropic, Google (Gemini and Vertex AI), AWS Bedrock, MistralAI, Cohere, DeepSeek, DeepInfra, NovelAI, OpenRouter, NanoGPT, Ollama, Ooba, Kobold, Horde, and any OpenAI-compatible endpoint.
- **Emotion images**: Shows the character's image for the expression of the current reply.
- **Group chats**: Several characters in one chat.
- **Lorebook**: Keyword-activated context, also known as world info or a memory book.
- **Prompting**: Prompt presets with a freely ordered prompt, conditions, and variables.
- **Regex scripts, triggers, and Lua**: Change the model's output or build a custom GUI.
- **Plugins**: Add model providers, hooks, UI, MCP tools, and storage from a sandboxed iframe. See [plugins.md](plugins.md).
- **MCP**: Connect remote MCP servers (streamable HTTP or SSE, with OAuth) or use the built-in tools.
- **Translation**: Google, DeepL, DeepLX, or an LLM translate input and output. A message keeps its translation, and the chat can show both texts.
- **Long-term memory**: SupaMemory, HypaMemory V2 and V3, HanuraiMemory, and Structured memory.
- **TTS**: ElevenLabs, Web Speech, VOICEVOX, OpenAI, NovelAI, Huggingface, VITS, GPT-SoVITS, and fish-speech.
- **Image generation**: Stable Diffusion WebUI, NovelAI, Dall-E, Stability API, Fal.ai, ComfyUI, Imagen, WaveSpeedAI, and OpenAI-compatible endpoints.
- **Additional assets**: Embed images, audio, and video in a character and show them in the chat or as its background.
- **Themes**: Metatron, Standard Risu, Waifulike, Mobile Chat, CardBoard, and Custom HTML.
- **Languages**: English, Deutsch, Español, 한국어, 中文 (simplified and traditional), and Tiếng Việt.

## Installation

Risuai Metatron runs only through its self-host server: the built client stores its data on the server and shows a notice when it is opened any other way (for example from static hosting).

### Prerequisites

- Node.js 24+
- pnpm 10 (the version pinned in `package.json` `packageManager`)

### Running from source

```
pnpm install
pnpm build
pnpm run server
```

Then open `http://localhost:6001/`. The server listens on `PORT` (default 6001) and switches to HTTPS when `server/ssl/certificate/server.key` and `server.crt` exist.

The first browser to open the server sets its password. To choose the password before the first start, set `RISU_PASSWORD_SHA256` to its SHA-256 hex digest (`printf '%s' '<password>' | sha256sum`). The server listens on every network interface unless `RISU_HOST` names an address, and keeps its data in `save/` unless `RISU_SAVE_DIR` names another directory.

To use the server from another device, serve it over HTTPS, either with the certificate files above or behind a reverse proxy (set `TRUST_PROXY` for the proxy). Signing in and notifications use browser features that work only on HTTPS or `localhost`.

The AI disclosure (the warning on an empty chat, the request-info disclaimer, and the model button on every reply) is off by default. Set `RISU_AI_DISCLOSURE=1` for the server (for example `RISU_AI_DISCLOSURE=1 pnpm run server`) to show it; changing it needs a server restart and a page reload. The dev server below reads the same variable from its shell.

### Headless host

From a development checkout with dependencies installed, a built client, and system Chrome, start the server and then, in another terminal, the host:

```sh
pnpm run server
pnpm host:headless
```

Set the server's password from a person's browser first. On the host's first start, provide `RISU_HEADLESS_HOST_PASSWORD` in its environment; later starts reuse the login in `host-profile/`. That folder is a login: keep it private. Stop with Ctrl-C or SIGTERM so Chrome writes the profile. It also runs on Windows (set variables in PowerShell with `$env:RISU_HEADLESS_HOST_PASSWORD = "..."` before `pnpm host:headless`) and macOS, where it finds an installed Google Chrome by itself.

Give the plugins their standing grants first from Settings → Plugins on another device. The host dismisses every dialog with Escape and logs it; a permission prompt is denied until a person gives a standing grant. It appears as **Headless host** for other devices to send through. It connects only over loopback; settings, including a different Chrome binary, name, profile, port or how much of the page's console it logs, are in the [headless host guide](docs/structure/build-test-platforms.md#headless-host).

### Development

Run the self-host server and the Vite dev server side by side:

```
pnpm run server
pnpm dev
```

Open `http://localhost:5174/`. The dev server injects the server flag and forwards `/api`, `/proxy`, `/proxy2`, and `/hub-proxy` to `http://localhost:6001`. Set `RISU_DEV_SERVER` (for example `RISU_DEV_SERVER=https://localhost:6001 pnpm dev`) when the server uses HTTPS or another port. The dev origin keeps its own login key, so you sign in once there as well.

`pnpm dev:human` starts both at once on `127.0.0.1` (server 6001, Vite 5174) and restarts the server when its source changes. `pnpm dev:agent` is the same for coding agents: ports 6419/6418 on loopback, no login, and a throwaway copy of `save/` in `save-agent/`.

### Docker Installation

You can also run Risuai Metatron using Docker. This method is particularly useful for web hosting.

1. Build the image from the repository root:

   ```
   docker build -t risuai \
     --build-arg RISU_BUILD_COMMIT=$(git rev-parse HEAD) \
     --build-arg RISU_BUILD_DATE=$(git log -1 --format=%cs) \
     --build-arg RISU_BUILD_DIRTY=$(test -z "$(git status --porcelain)" || echo true) .
   ```

   The build arguments give the version shown in the app (the image has no `.git`); without them it shows `unknown`.

2. Run the container, keeping saved data in the `risuai-save` volume:

   ```
   docker run -d --name risuai --restart always -p 6001:6001 -v risuai-save:/app/save risuai
   ```

   Add `-e RISU_AI_DISCLOSURE=1` to show the AI disclosure (see [Running from source](#running-from-source)).

3. Access Risuai Metatron at `http://localhost:6001` in your web browser.

The server makes every provider request itself, so inside the container `localhost` is the container, not your machine. To reach a provider running on the host (for example Ollama or a local OpenAI-compatible server), use `http://host.docker.internal:<port>` and add `--add-host host.docker.internal:host-gateway` to `docker run` on Linux, or use the host's LAN address.

## Coming from Risuai

- **Import**: Settings → Backups → Load Backup Locally accepts a backup file (`.bin`) saved by Risuai. Risu Account data is not imported, and a backup encrypted with a Risu Account is refused. Plugins older than API 3.0 are imported but do not run.
- **Export**: The RisuAI-compatible backup button in the same place saves a file that Risuai's Load Backup reads. It asks whether to include API keys, and reports what Risuai has no place for, such as stored translations, reroll candidates, inlays, and plugin storage.
- **Files**: Character cards (`.png`, `.charx`, `.json`), modules (`.risum`), and prompt presets (`.risup`) use Risuai's formats.

## Documentation

- [STRUCTURE.md](STRUCTURE.md): The index of the architecture guides, for contributors and coding agents.
- [plugins.md](plugins.md): The plugin author guide.
- [docs/backlog/upstream-ledger.md](docs/backlog/upstream-ledger.md): Which Risuai changes this fork has taken.

## Upstream and license

Risuai Metatron is based on [Risuai](https://github.com/kwaroran/Risuai) by Kwaroran and keeps its license, [GPL-3.0](LICENSE). The version in `version.json` is the Risuai release this fork is compatible with. The home menu shows the fork's own build ID (commit date and hash) above it.
