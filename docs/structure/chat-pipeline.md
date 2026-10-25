# Chat Pipeline: Send → Prompt → Request → Reply

## Scope

- Owns:
  - the tab's side of a send: the input box to the server job (`sendChat` is the job client) and the reply as the job's events and records bring it,
  - the prompt editor's helpers (`prompt.ts`, the templates, `templateCheck`), the lorebook codecs and the DevTool lore preview,
  - group membership (`group.ts`),
  - reroll,
  - slash commands,
  - inlays,
  - the message-search request contract and client coordinator.
- Paths:
  - `src/ts/process/index.svelte.ts`, `src/ts/process/serverGeneration.ts`
  - `src/ts/process/{prompt,stringlize,group,prereroll,command,infunctions,inlayScreen}.ts`
  - `src/ts/process/lorebook.svelte.ts`, `shared/lore/{activation,overrides}.ts`
  - `src/ts/process/templates/*`, `shared/prompt/{chatTemplate,templateCheck}.ts`
  - `src/ts/process/files/{inlays,multisend}.ts`
  - `src/ts/messageSearch.svelte.ts`, `shared/messageSearch.ts`
  - The send handlers in `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Not here:
  - Prompt assembly, token trimming, the request, streaming, and the post-processing tail run in the server job → `self-host-server.md` (`runPromptJob`, `assemblePrompt`).
  - Memory algorithms → `memory.md`.
  - `requestChatData` internals → `llm-requests.md`.
  - Token counting (`shared/tokenizerChoice.ts`, `shared/prompt/{chatTokens,imageTokens}.ts`, `src/ts/tokenizer.ts`, `src/ts/tokenCountField.ts`) → `llm-requests.md`.
  - Message-search panel presentation → `ui-theming.md`; endpoint implementation details → `self-host-server.md`.
  - PDF conversion used by MCP filesystem tools → `plugins-mcp.md`.
  - Regex and trigger internals → `scripts-triggers.md`.
  - Rendering → `cbs-rendering.md`.
  - TTS and image generation → `media-aux.md`.

## Files

- `index.svelte.ts`: the send's job client (the browser assembly path was removed).
  - Exports `sendChat(chatProcessIndex, arg)` (`arg`: `serverGeneration.ts` `ServerSendArg` plus `onServerRefused`; `chatProcessIndex` is kept for the plugin API's signature and not read), `previewChat(kind, target?)` (a `preview` or `previewPrompt` job in the target, default the selected chat, admitted and held as `sendChat` is; returns the formatted messages or the request body, null when it did not run or ended without them), and the `OpenAIChat`/`MultiModal` types (declared in `shared/openai.ts`).
- `localSends.ts`: the local send registry, the sends this tab runs, one per chat (`svelte/store`, no runes, type-only imports, so the hand-written mocks of `index.svelte` do not reach its readers). `localSends` maps a chat key (`${chaId}\u0000${chatId}`) to its chat, and a send without a chat holds the tab entry (`""` → null), which fences no chat; `beginLocalSend(ref)` takes an entry before the send's first await and returns its release (idempotent), or null when that chat already has one; `isLocalSend(ref, current?)` (pass `$localSends` or a `fromStore(localSends)` view's `.current` to read it reactively); `anyLocalSend` (derived: a `localSends` subscriber may read it one update late, so admission reads the Map).
- `jobStages.ts`: the latest presentation stage per followed job (`svelte/store`, no runes, type-only imports); `setJobStage`, `dropJobStage`, `chatStageOf`, and the read-only `jobStages` Map.
- `serverGeneration.ts` `sendChatOnServer(arg)`: the send as a server job (below).
- `src/ts/process/chatStatus.svelte.ts`: per-tab, in-memory generating, recovery, and unseen reply sources, with `chatStatusKey`, `isChatBusy(ref)` (a local send, a followed job, or a lock in that chat: the per-chat busy check used by `/multisend`, the DevTool preview and autopilot, the PO file run, the `previewRequest` hotkey, and the plugin `sendChat`; the helper's local busy check and `sendChat`/`previewChat`'s local registry admission are per chat; shared resource flush (`GenerationBlockedError`), binding, and server refusals still apply; the plugin also refuses while any job channel callback runs), the terminal hooks, and the visibility watcher.
- `prompt.ts`: `tokenizePreset` and legacy-preset conversion; re-exports the prompt types declared in `shared/prompt.ts`.
  - Types: `PromptItem` (discriminated union), `PromptSettings`, `PromptRole`.
  - `tokenizePreset`.
  - Legacy import: `detectPromptJSONType`, `stChatConvert`, `promptConvertion`.
- `shared/lore/activation.ts` `activateLore(input, host)`: lore activation, shared with the server. It merges three sources: character `globalLore` with the chat's `loreOverrides` applied (`mergeOwnerLore`), chat `localLore`, and the module lore the caller resolved; matches keys, regex keys (`/pattern/flags`: the last `/` ends the pattern, empty flags allowed), and decorators over the scanned messages; recurses; applies the token budget and `@@inject_lore`; and returns `{ actives, matchLog }`. `LoreHost` supplies the clone, the speaker names, the chat variables (the keep and don't-activate-after-match flags), CBS, the token count, and the regex test (on the server, the script worker's).
- `shared/lore/overrides.ts`: chat overrides of the owner's lore (`Chat.loreOverrides`, `ChatLoreOverride`: a frozen full copy linked by `entry.id`, and `off`). `mergeOwnerLore(ownerLore, overrides)` returns `{ lore, orphans }`: an override matches the first owner entry with its non-empty id, a non-off one replaces that entry in place, an off one removes it, later owner entries with the same id stay, the first override of an id applies and later ones are ignored, and an override that matches no owner entry is an orphan, returned and not inserted. An off override of an owner folder (`mode: "folder"`) also removes every entry inside it, whatever their own overrides (those are not orphans): membership follows the owner's current non-empty string folder keys, never the frozen copy's, a removed nested folder adds its key until nothing changes, and a keyless folder collects no ungrouped entry. `findOrphanedOverrides` and `offOverrideIds(ownerLore, overrides)` follow the same rule; the off ids are the first-per-id off overrides' ids (orphans included) plus the non-empty owner ids of every entry an off folder removes. It returns references and never clones (the client passes live `$state` proxies); callers that mutate copy first. `orphanedOverrideEntries` projects the orphans to `{ id, name }` for server and client refusals, naming each by its trimmed non-empty string `comment`, then `key`, then id.
- `src/ts/process/loreOverrides.ts`: `chatOrphanedOverrideEntries(ref)` checks the loaded chat against its owner's `globalLore`; `chatLoreOverrideRefusalText(entries)` names the orphans and their fixes in the same localized alert for local and server refusals.
- `lorebook.svelte.ts`: the client wrapper of lore activation and the lorebook codecs.
  - `loadLoreBookV3Prompt(chatRef?)` runs `activateLore` for the chat with `getModuleLorebooks(ref)`, `loreBookDepth`, `loreBookToken`, and `getUserName(ref)` (the bound persona's name), and the client host.
  - Also `addLorebook`, `addLorebookFolder`, `importLoreBook`, `exportLoreBook`, `convertExternalLorebook`. Lorebook file import/export supports character (`"global"`) and chat (`"local"`) lore; persisted global lore pages have no editor or file-codec mode. Local export refuses an unloaded chat with `localLoreExportNotLoaded`.
- `shared/prompt/chatTemplate.ts`: `renderChatTemplate(messages, { type, jinjaTemplate, characterName, userName })` (Hugging Face Jinja), `chatTemplates` (built-in Llama/Gemma/Mistral/...), `templateEffect`. `templates/chatTemplate.ts` re-exports `chatTemplates` and `templateEffect` (not `renderChatTemplate`), and its `applyChatTemplate(messages, { type?, custom? })` supplies the selected model preset's `instructChatTemplate`/`JinjaTemplate`, the selected character, and the user's name.
- `templates/templates.ts`: re-exports `prebuiltPresets` and `prebuiltNAIpresets` from `shared/presetTemplates.ts` (templates carry no id; a use goes through `normalizePreset`).
- `shared/prompt/templateCheck.ts` `templateCheck({ promptTemplate })`: prompt-template warnings (`templates/templateCheck.ts` re-exports it).
- `shared/messageSearch.ts` defines `POST /api/chats/search` query, hit, and page shapes (`all`, character, or chat scope; cursor paging). `messageSearch.svelte.ts` builds requests and owns the pending message-jump coordinator. `server/src/routes/messageSearch.ts` registers the endpoint; scan and limit details are in [self-host server](self-host-server.md). The panel and jump presentation are in [UI theming](ui-theming.md).
- `stringlize.ts`: serializers for non-chat-completion backends and stop strings.
  - `stringlizeChat`, `stringlizeAINChat`, `unstringlizeChat`, `getStopStrings`.
  - `stringlizeChatOba` is unreferenced. `multiChatReplacer` is empty.
- `group.ts`: `groupOrder` (name mentions, then shuffle and talkativeness), `addGroupChar`, `rmCharFromGroup`.
- `prereroll.ts`: `Prereroll`, `PreUnreroll`, `addRerolls`. In-memory swipe history keyed by `generationId`, with the chat and message the reply was generated in. A swipe first stores the reply's current text into the candidate on display (an edit is what swiping back brings), and works only while the selected chat is that chat (a copied chat keeps the reply's ids and generation but not its candidates); an empty candidate (an emptied reply or an empty alternative) is shown like any other, since the screen applies every candidate that is not null.
- `rerollHistory.ts` `createRerollHistory`: the screen's per-chat bundle history (`record`, `begin`, `canForward`, `forward`, `back`, `clear`), up to 16 chats by last use; owned copies with an anchor message id and a cursor, swapped through `editChatSync` only while the anchor and current tail ids still match. The bundle at the cursor is refreshed from the chat's current tail when `begin` keeps the slot and before `move` swaps it away, so an edit of a recorded reply is kept.
- `sendDraft.ts` `createSendDrafts`: the screen's per-chat send drafts (`idFor`, `settle`, `takeUnplaced`); failed sends keep their text and `userMessageId` until restored, and keep the id after restoration for a safe retry.
- `sendAborts.svelte.ts` `createSendAborts`: the screen's own sends by chat, each with the `AbortController` its Stop aborts (`begin` returns the signal and a release that removes the entry only while it is still that send's, `has` (reactive), `abort`); Stop in one chat never aborts another chat's send.
- `command.ts` `processMultiCommand(line, ref?)`: the chat input's slash commands (`/send`, `/sendas`, `/cut`, `/del`, `/multisend`, `/trigger`, variables, TTS, `?` help). `/trigger` runs on the server (`runServerManualTrigger`, `scripts-triggers.md`); a trigger's `v2Command` runs the server's command executor. `runMultisend` (`/multisend`, and a command job's `done.followUps`) checks its chat (`isChatBusy`) before each part's clear and append and stops at a part refused so or whose send returns false (refused, failed, lost, or stopped). These local busy/admission checks are per chat; shared resource flush (`GenerationBlockedError`), binding, and server refusals still apply. DevTool autopilot, the PO file run, and plugin `sendChat` check their chat the same way.
  - Pipes are `|`.
  - Unknown commands return `false` and fall through as ordinary text.
- `infunctions.ts` `calcString`: calculator for the CBS calc function.
- `inlayScreen.ts`:
  - `runInlayScreen`: turns image/emotion commands in the output into `{{inlay::id}}` via `generateAIImage(..., 'inlay')` and `writeInlayImage`.
  - `updateInlayScreen`.
- `files/inlays.ts`: inlays on the server. Metadata is the `inlays` resource (id = inlay id, `InlayResource` in `shared/resources.ts`); media bytes are assets named by content hash (`assets/inlay_<sha256>.<ext>`), so the same bytes are stored once; a signature keeps its JSON in the metadata `text`.
  - `writeInlayImage`: normalizes to PNG and caps the size at 1024² pixels.
  - `postInlayAsset`, `setInlayAsset` (Blob or data URI), `saveInlayedSignature`, `getInlayAsset` (base64 data URI), `getInlayAssetBlob` (Blob), `listInlayAssets` (metadata only, read fresh; replaces the cached view), `removeInlayAsset` (metadata only; the blob stays because retained snapshots may reference it), `getInlayMetadata`, `verifyInlay` and `repairInlayMedia` (the browser-local import), `invalidateInlayCaches`.
  - Caches: metadata seeded at boot (`seedInlays`) plus a GET on a miss, a negative cache for unknown ids that expires after 30 s, a 64 MiB blob cache (content-addressed, so never stale), and in-flight de-duplication. Metadata is only as fresh as this tab's own writes plus `invalidateInlayCaches`, which `bootstrap.ts` runs whenever the save adapter brought another tab's records into the mirror (`onRemoteRecordApplied`). Every public write to one id (preparation, upload, and metadata) runs after the previous one; a conflict with another tab re-reads once and writes over it (last writer wins, as before).
  - `supportsInlayImage`.
  - Rendering ([CBS rendering](cbs-rendering.md) `parseInlayAssets`): `getInlayMedia` gives the media type and asset key. Images use `getFileSrc`. Audio and video use the direct `/api/asset/<hex>` URL when a capable worker controls the page (`getDirectAssetSrc`), and otherwise `getInlayObjectUrl`, a typed object URL per asset key (`mediaObjectUrls`) kept for the page and never revoked, since rendered and cached HTML holds it. The `<source>` type comes from `shared/assetMime.ts` for the key's extension.
- `files/multisend.ts` `postChatFile`: file attachments (PO, TXT, XML retrieval, media → inlays). The PDF branch is unreachable from the picker. The PO run sends each entry in the chat selected at its start and stops, downloading nothing, when that chat is gone or busy (`isChatBusy`) before an entry or an entry's send does not run.

## Flows

Send, in `DefaultChatScreen.svelte`:

1. `send`/`sendContinue` → `sendMain`:
   1. Capture the selected chat. If it has work of its own (`chatStatus.svelte.ts` `isChatBusy`: a send of this tab, a followed job, or a lock), alert `chatGenerating` and stop before the text, translation draft, attachments, or reroll history are consumed. Other chats' sends, jobs, and locks are not checked: different chats of the tab send at the same time, and switching chats or characters mid-send is allowed.
   2. `processMultiCommand`; a line that is not a command checks the chat again after it, as in step 1.
   3. An incomplete binding (`chatBinding(ref)`, [chat bindings](persistence.md)) opens the chat's binding dialog (`chatBindingDialog`) and stops before anything is consumed (also for Continue): the text, the translation draft, and the attachments stay. The send button reads "Set up this chat" meanwhile (it keeps `button-icon-send`, so the send hotkey opens the setup too).
   4. Orphaned lore overrides refuse locally with an alert naming the entries and fixes, before anything is consumed (also for Continue).
   5. Append queued `{{inlayed::id}}` tags.
   6. A nonempty input becomes the job's input with a new `userMessageId` (the job runs the input trigger, `editinput`, and appends the user message); an empty input appends "_says nothing_" when `useSayNothing` is on and the last message is not the user's (a continue from an empty input does it too).
   7. `sendChatMain`, with no await between consuming the input and the send's admission.
2. `sendChatMain` rechecks the captured chat's busy state, creates that chat's Stop controller, and calls `sendChat` with the captured target and input ids. The local send entry is taken synchronously, so each chat has one send per tab while different chats can run together. Stop aborts the selected chat's controller and followed jobs. Auto mode stays with its starting chat and ends on Stop, an unsuccessful round (`ok` false: refused, failed, or stopped), toggling it off, or leaving/closing that chat. Failed input drafts return only to an empty composer for their chat and keep the same `userMessageId` for a safe retry.
3. `reroll`/`unReroll` refuse while the selected chat is busy. Swipe candidates are tried first, then the per-chat bundle history. A history swap uses `editChatSync` only while its anchor and tail message ids still match; edits to a displayed bundle are retained. A new reroll refuses orphaned lore overrides with the same alert before removing the captured tail; otherwise it removes the tail and sends in the captured chat. A pre-save refusal may restore the removed tail only while the matching removal still owns the end of the save queue; after an ambiguous response that restoration is provisional ([persistence](persistence.md)). A new user send clears that chat's bundle history.

### Job client and reply

`sendChat` in `index.svelte.ts` refuses a deleted target and takes the target's local send entry before its first await; the entry is released when the send ends. Each chat admits one send from this tab, so sends in different chats can run concurrently. `serverGeneration.ts` builds the job request and `serverCommands.ts` flushes pending resource writes, creates the server job, follows it through its terminal, and maps its outcome to the caller. The job guard checks the chat binding; server-side admission and job lifecycle are documented in [self-host server](self-host-server.md).

The tab follows jobs by id in `followedJobs` and records each job's latest `stage` event in `jobStages`. Creation and `accepted` seed `preparing` only when that job has no stage yet, so the spinner shows it before the first stage event; a later `accepted` never resets a known stage. Streaming chunks update the locked reply; the terminal supplies reroll alternatives, preview results, or an error. Stop aborts the selected chat's own send and followed jobs. A create response without a job answer is ambiguous, so it does not prove that no job ran.

The server owns prompt assembly and the reply tail. Before a completed send ends, it can hand off the replies and input for detached translation ([media and auxiliary work](media-aux.md)); plugin providers and chat callbacks use job-channel callbacks. Their barrier reads a chat whole once when an allowed local edit raised its acknowledged floor above the remembered job copy, admitting it with still-valid streaming metadata before running the hook ([persistence](persistence.md)). See [self-host server](self-host-server.md) for the job event and callback contract. HypaV3 selection, blocking summaries, gap questions, progress, stop control, and background task hand-off are documented in [memory](memory.md).

A failed terminal is shown through `alertJobError` with copyable checked debug fields and a request-history link ([diagnostics](diagnostics.md)). `followJobToEnd` records a lost follow or a completed unseen reply in `chatStatus.svelte.ts`; opening a lost chat relies on the lock release and idle refresh to reconcile its stored state.

Not in `sendChat`:

- Input auto-translation happens in `DefaultChatScreen.updateInputTransateMessage`.
- Display translation happens in `ChatBody.svelte`.
- Suggestions come from `Suggestion.svelte`, which calls `requestChatData` directly. It follows the local send registry per chat: an entry taken for a chat cancels and clears only that chat's suggestions; other chats keep theirs visible. An entry's release requests suggestions if that chat is selected (or the send had no chat), else queues its chat key for a request when selected and loaded (only if suggestions are empty). Opened while no send runs, it requests for the selected chat. Other selection changes request nothing; a new send or deletion drops the queued key.
- `writeInlayImage` rejects when the image has no pixels or fails to load; its per-id queue moves on to the next write, so a caller handles the rejection.
- A continue on a group runs the group speaker loop like a send (`continueSend` false): the continue target is not passed to each speaker.
- The chat screen renders a window over the selected chat's loaded messages (`chatLoadInitialPages`, `chatLoadAdditionalPages`); paging never fetches, and selecting a chat that is not loaded shows the loading state (or the error with a retry) until it is.

## State

- `src/ts/process/chatStatus.svelte.ts` holds three per-tab sources keyed by `${chaId}\u0000${chatId}`: reactive `generatingChatKeys()` unions `followedJobs` values with `chatStore.svelte.ts` `lockedChatKeys()`, `recoveryChatKeys` maps a lost chat to its job id, and `unseenChatKeys` holds up to 256 chats whose `done` carried a reply `messageId` while that chat was not visible (oldest dropped). `watchChatVisibility`, started once from `bootstrap.ts`, tracks visibility and both mark stores, clearing recovery and unseen for the open chat (screen 0, or 2 for `§playground`) even when a lost follow adds a mark without a visibility change; new follows clear that chat's recovery, and followed-job changes prune recovery for deleted chats. The writable inputs use lazy `fromStore` views for reactive reads without permanent mirror subscriptions; `resetChatStatusForTests` clears the marks and those views.
- `OpenAIChat` has `role`, `content`, `memo`, `removable`, `attr`, `multimodals`, `thoughts`, and `cachePoint`.
  - `memo` values `supaMemory`/`hypaMemory` mark memory cards.
- `PromptItem` types: `plain|jailbreak|cot`, `chatML`, typed `persona|description|lorebook|postEverything|memory`, `authornote`, `chat` (with a range), and `cache`.
- Reactive singletons: the records (through `settingsViews.svelte.ts` and `characterStore.svelte.ts`), `selection`, `localSends` (`localSends.ts`: this tab's sends per chat, entries owned by `sendChat`; `anyLocalSend` is its tab-wide view for plugin reload deferral and translator cache-only mode; screen controls and suggestions follow the selected chat's own work), `followedJobs` (`serverCommands.ts`: the jobs this tab follows, job id → `${chaId}\u0000${chatId}`; `followedJobsOf` selects a chat's job ids), `jobStages` (`jobStages.ts`: the latest stage of each job this tab follows, job id → { chat key, stage }; seeded as `preparing` at creation or accept until a stage is known, then set by `applyGenerationEvent`, removed with the job's `followedJobs` entry at its follow's end; `chatStageOf` picks a chat's newest staged job), `CharEmotion`.
- The tab never mutates the chat in place: the chats are held by `src/ts/storage/chatStore.svelte.ts` (the screen reads `selectedChat()` and the lists `chatList()`), and every write goes through it (see `persistence.md`), addressed by chat and message id. Autosave does not see chats.
- Chats load on demand. The chat screen renders nothing chat-dependent while the selected chat loads (`selectedChatLoad()`: a loading state, or the error with a retry). A server job's target chat is pinned and loaded before the job is created (`runServerJob`; `followJobToEnd` for a resumed or followed job, through every reconnect and the terminal's hydration; a command job's `/multisend` follow-ups), and a send's chat stays pinned until `sendChatOnServer` has read the reply's alternatives; a target that cannot be loaded runs nothing. A typed command line (`processMultiCommand`), an auxiliary LLM request (`requestServer`: its chat and its parse chat, until its event stream ends), `editChat`, and a group output listener's speaker (`chatOutput`: its chats, before each listener) pin and load what they read. The synchronous chat readers (`chatVar`, `getModules(ref)`, the CBS host, `transformClient`'s context, the MCP tool records) read loaded chats only; their chat is the selected one, a pinned job or request target, or a plugin context that awaited its load, and an unloaded chat reads as gone, never as another chat. The bound persona (`checkPersonaBinded`, `capturePluginContext`) is read from the chat's list entry, so it holds while the chat is not loaded.
- Streaming display: a server job's message is locked while it streams (`isMessageLocked`); `Chat.svelte` disables its controls and renders it without the server transform until the lock ends. The display optimization (`streamingDisplayOptimizationMode`) follows the stream: `applyServerGeneration` sets its chat's streaming entry (`streamingEntry(ref)`) on the generation's first stream update with the configured mode, and that generation's lock release clears only that entry (`persistence.md`); each chat has its own entry, so jobs in two chats each keep their message shown as streaming. `Chats.svelte` keeps the streaming row mounted in every mode while it streams (rows are keyed by message id; `Chat.updateRow` passes the text in) and mounts it again when it ends, `off` parses it like any message, and `strong` renders that text raw, without markdown (`util/playwright/checkStreamingModes.mjs`). Whatever the mode, the chat module writes the streamed text into the mirror at most once per frame (`persistence.md`), so a streaming row parses once per frame, not once per chunk.

## Coupling

- `sendChat` imports `serverGeneration.ts` (and through it `serverCommands.ts`, the job channel) and the chat module.
- Callers: `DefaultChatScreen.svelte`, `command.ts` (`/send`, `/multisend`), `files/multisend.ts`, `hotkey.ts`, `DevTool.svelte` (preview, autopilot), `plugins/apiV3` (`sendChat` permission).

## Invariants

- `chatId` is the address of every message write. Never address a message by index after an await; resolve the id again.
- A send captures its target chat before any await and passes it to the job; the job's prompt and model presets and persona are the chat's binding, fixed at its creation (a plugin's `sendChat` inside a hook passes `pluginContext`, so the job acts on the hook's chat and preset). Nothing falls back to the tab's selection: a chat whose binding is incomplete is not sent, and the server refuses it independently ([chat bindings](persistence.md)).
- Every context builder takes its ids from the captured chat, never from the views: a job or chat request from `chatBinding(ref)` (`runPinnedServerJob`, `requestChatDataServer`), a render or plugin context from `chatDisplayIds(ref)` (`captureTransform`, `capturePluginContext`). The tab's chat LLM requests have the same guard (`requestChatData` before its hooks and tools, again at `requestChatDataMain`; a request inside a job callback is compared with the job's targets). A request without a chat is not a send: it carries no `chatRef`, is never refused by a binding, and runs on the settings views, read once before any await.
- The reply being generated is locked by its server job: the tab's writes to it are refused by the server and skipped by the chat module.
- The server refuses every generation job for a chat with orphaned lore overrides at admission with 409 `chatLoreOverrideOrphaned` and `entries: [{ id, name }]`. The DevTool lore preview and token counting do not refuse; activation drops orphans silently.
- Script modes (run by the server since the cutover):

  | Mode          | Stage                       |
  | ------------- | --------------------------- |
  | `editinput`   | user input                  |
  | `editprocess` | prompt history and greeting |
  | `editoutput`  | model output                |
  | `editdisplay` | render                      |

  Lua edit triggers skip `editprocess`. The `request` trigger runs on the server job's requests only; the tab's own requests (translation, suggestions, the HypaV3 modal, plugins) go out without it.

- A new `PromptItem` type needs handling in both template switches of the server's `assemblePrompt`, plus `tokenizePreset`, `templateCheck`, import conversion, `PromptDataItem.svelte`, and `normalizePromptTemplate` (`shared/presets.ts`).
- Lore matching (`shared/lore/activation.ts`):
  - Only the last `scanDepth` messages are scanned.
  - Keys starting with `/` are regex.
  - Supports selective secondary keys, negative keys, and all-key mode.
  - Recursion is controlled by `recursiveScanning` and `@@recursive`/`@@unrecursive`/`@@no_recursive_search`, with no explicit depth counter.
  - Decorators are parsed with `CCardLib.decorator.parse`.
  - Overrides apply to the chat owner's `globalLore` only (a group chat's: the group's own), never to module lore. Activation drops orphans silently; the merged view is for chat-scoped readers, while editors, token estimates, and import/export read the raw character lore.
  - A `child` entry ("Always active in this chat") activates from the first earlier entry with its id when that entry did not activate, copying its `comment` and `content` and taking its `insertorder` as order and priority (`@@priority` in the content still wins). A child whose id is turned off by the chat's overrides (`offOverrideIds`, which includes the entries inside an off folder) never activates, even when another entry shares the id or its content has `@@activate`.
  - `@@keep_activate_after_match` and `@@dont_activate_after_match` are per entry: an activated entry writes `__internal_ka_<id>`/`__internal_da_<id>` (its `id`, else `pickHashRand(5555, content)`) only for its own decorator. On later runs a set `__internal_ka_` activates the entry without a key match, and a set `__internal_da_` keeps it off.
- Inlays are not stored in chat text. Removing an inlay (`removeInlayAsset`, the Inlay Explorer) breaks the `{{inlay::id}}` tags that name it; deleting messages never removes inlays.
- Images become `MultiModal` input only when the model has `LLMFlags.hasImageInput`. Otherwise the job captions them (`captionImage`, `memory.md`).
- Built-in Jinja templates enforce role rules: Gemma has no system role, and Mistral requires alternating roles.
- A suggestion result is applied only while its request token and the captured character and chat ids still match (`Suggestion.svelte`), never by the old chat index.

## Recipes

- Add a prompt card type: `shared/prompt.ts` (`PromptItem`), both template switches in `server/src/prompt/assemble.ts`, `tokenizePreset`, `templateCheck`, `PromptDataItem.svelte`, `normalizePromptTemplate` (`shared/presets.ts`). Verify the prompt preview (DevTool), token counts, and a preset reload.
- Change input processing: `DefaultChatScreen.sendMain` and the job's input stage (`server/src/prompt/runner.ts`). Verify character and group chats and slash-command fallthrough.
- Add a response command or inlay: the job's tail (`server/src/prompt/postProcess.ts` `runInlayScreen`) and `files/inlays.ts` or the parser.
- Change lore activation: `shared/lore/activation.ts` (search, decorators, budget) and the position mapping in `assemblePrompt`.
- Add a slash command: `command.ts:processCommand`, plus its `?` help text.
- Change backend prompt serialization: `shared/prompt/chatTemplate.ts` or the server's request layer (`llm-requests.md`).

## Tests

- Send-job and prompt contracts: `server/src/tests/promptRunner.test.ts`, `assemble.test.ts`, and `promptTail.test.ts`; server implementation details are in [self-host server](self-host-server.md). Memory job and task contracts are in [memory](memory.md).
- Send admission and tab state: `src/ts/process/{localSends,serverGeneration,jobStages,chatStatus}.test.ts`, `index.test.ts`, and `sendAborts.svelte.test.ts` cover per-chat admission, stage tracking, terminal/lost status, and Stop controllers. `e2e/perChatSends.spec.ts` covers two chats running at once, per-chat Stop and suggestions, and auto mode across a chat switch.
- Lore activation and chat overrides: `server/src/tests/lore.test.ts` ("chat lore overrides": first-match merge, orphans, overridden content, off folders by the owner's current keys, off beating `child` links (off-folder members included), child insert order); `cbs.test.ts` (`{{lorebook}}` with overrides and an off folder). Override persistence: `chats.test.ts` (validation, first override per id), `chatCheckpoints.test.ts` (capture and load), `transform.test.ts` (cache key), `upstreamExport.test.ts` and `upstreamImportCharacters.test.ts` (strip and repair).
- Caller workflows: `src/ts/process/command.test.ts` covers slash commands and per-chat `/multisend`; `rerollHistory.test.ts` and `sendDraft.test.ts` cover chat-scoped reroll bundles and draft recovery; `src/ts/process/request/tests/{requestChat,transport}.test.ts` covers pinned chat context and cancellation after target replacement.
- Files and media: `src/ts/process/files/tests/multisend.test.ts` covers TXT/XML retrieval and PO sends; `inlays.test.ts` covers metadata, media caching, ordered writes, conflict recovery, and cancellation. The chat module's save paths are in [persistence](persistence.md).
- Message search: `src/ts/messageSearch.test.ts` covers request scopes, paging, errors, and jump state; panel behavior is covered in [UI theming](ui-theming.md). The server scan is covered in [self-host server](self-host-server.md).
- Browser checks: `util/playwright/checkServerSend.mjs`, `checkServerJobMatrix.mjs`, and `checkSidebarChatStatus.mjs` exercise send/recovery, reroll/group, and sidebar status.
- Not covered: in-tab Jinja rendering; mounted screen wiring for per-chat reroll/draft recovery and auto mode closing the chat; Stop on a resumed job beside another chat's send. The DevTool preview and autopilot are checked by hand.

## Known Hazards

- Accepted limits of sends in different chats at once (kept, not fixed; each chat has one local send and one server job, and different chats of a tab run together):
  - Two chats of one character write the character record without a character lock. Field patches keep unrelated fields, but the same field (`lastInteraction`, a field a trigger or Lua writes) is last writer wins. A group chat's job and a job in one of its members' own chats can patch that member the same way.
  - `CharEmotion` (`stores.svelte.ts`) is keyed by character, so two chats of one character share its emotion history; `stopTTS()` (`tts.ts`) stops every chat's speech; `alertWait`'s single status slot and the legacy `progress` overlay (`jobChannel.ts` `progressJobId`) show the newest job.
  - Plugin hooks and providers of one tab stay serialized by the server's per-client channel lane (`self-host-server.md`): a slow provider in one chat delays the other chat's hooks. A queued callback's deadline starts at its dispatch, so the wait does not time it out.
  - The composer (`messageInput`, `messageInputTranslate`, `fileInput`) is one `DefaultChatScreen` state for every chat: a write after an await (`processMultiCommand`, input translation, an image paste, the file button) lands in whichever chat is selected then.
- A command job's `/multisend` follow-ups normally find the chat free because the server publishes the end frame (`streaming: []`) before the terminal and adopting the terminal's whole chat copy drops older feed locks (`dropFeedLocksOf`); if a feed frame arrives behind the terminal while local work prevents adopting that copy, a stale feed lock can make `isChatBusy` silently drop the follow-ups.
- Stop stays visible between a followed job's `done` and its socket close, when aborting the ended job does nothing. A boot resume that discovers its chat but cannot load it shows Stop during the load retries, until the follow ends as lost.
- `disable_ui_prompt` lore decorators are collected into `disabledUIPrompts`, but that array is never consumed.
- The server's `refreshChat` (`server/src/jobs/jobScope.ts`) reloads the stored chat after job writes and callbacks that may write. An unrelated edit made to that chat while the job runs can therefore enter a later prompt stage, as in the former live `chatNow()` path.
- `renderChatTemplate` calls Jinja's `Template.render` synchronously with no work or time limit; a costly custom template occupies its caller's thread.
- `prereroll.ts` history is in memory only; the per-chat history and drafts live in `DefaultChatScreen`'s module instances and a remount loses them. Send recovery restores no translation draft, and does not restore a draft whose job ended `done` (`ok`) after a script removed its user message.
- A plugin's whole-chat setter (`setChatToIndex`, and a character setter's `chats` through `reconcileCharacterChats`) diffs the plugin's copy against the chat at call time: `captureChatBaseline` runs right before `applyChatResult`, not when the plugin read the chat. Wherever the copy differs from the chat then, the copy wins, so a change another writer made after the plugin's read is overwritten: a changed message field or chat field is set back to the copy's value, a message added meanwhile is removed. When that diff would change or remove a message being generated (`assertUnlocked`), the whole chat update is skipped with a console warning instead; a reorder of unchanged messages while the chat is generating drops only the order change (with a warning), the rest applies. `editChat`/`editChatSync` (`src/ts/storage/chatEdits.ts`) capture the baseline before their edit works on its copy, so they keep another writer's change to a field the edit left alone; where both changed the same field, the edit's value wins.
- `DevTool.svelte`'s autopilot sends each line as a job in the chat selected when it started; a group's speakers are chosen by the server (the browser path used the loop index).
- Group prompt assembly names a speaker it cannot resolve (`host.findCharacter`) `Unknown Character` in the group wrapper.
- Group lore activation takes the group as the character: its own `globalLore`, the chat's, and the modules'; the members' `globalLore` is not included, even with the group's `useCharacterLore`.
- Lore keys keep the inherited grammar: every key is split on commas before the `/pattern/flags` parse, so `/a{1,2}/` becomes two malformed keys; the last slash closes a pattern, and a bare or unclosed slash, an invalid flag, or a malformed later entry ends that key search instead of being skipped.
