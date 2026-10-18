# Sidebar Chat Status Plan

Status: slice 1 (status sources) implemented on 2026-10-18; slices 2 and 3 remain. Written against `eb4ee3d99`.
Reference implementation: the `risuai-fastify` checkout's `PinnedChatsRail.svelte`,
`Sidebar.svelte`, `GenerationIndicator.svelte`, `UnreadIndicator.svelte`,
`sidebarMultitasking.ts` and `chatUnread.svelte.ts` (`/home/codex/risuai-fastify/src/lib/SideBars/`,
`src/ts/process/`). Those files are a design reference only: metatron's send path is a
server job followed by the tab (`serverCommands.ts`), so the status sources differ.

## Goal

The sidebar shows, per pinned chat and per character, what its chats are doing while
the user looks elsewhere:

- **generating**: a reply is being produced in that chat;
- **needs recovery**: the tab lost its connection to a job of that chat (a reattach that
  ran out, or a chat load that kept failing) and the chat must be opened to see its real
  state;
- **unseen reply**: a job finished a reply in that chat while another chat was shown.

A collapsed character folder shows the aggregate of its members. Opening the chat
clears its unseen and recovery marks; a reply that completes in the chat being viewed
is never marked unseen. When states overlap, one badge shows the highest:
needs recovery → generating → unseen reply. Badges change nothing about how a row
opens (click, Enter) and add no tab stop.

Example: a send starts in chat A; the user moves to chat B; A's rail item and its
character show _generating_. The reply completes: A shows _unseen reply_. The user opens
A: the badge is gone.

## Current code (what the plan builds on)

- `src/ts/process/serverCommands.ts`: `followedJobs` (a `writable<ReadonlyMap<jobId, chatKey>>`,
  `chatKey = ${chaId}\u0000${chatId}`) holds every job this tab follows, from the moment
  its chat is known until the follow ends (`finally`). `followJobToEnd` is the one
  lifecycle per job: it returns the terminal event or `"lost"`, and `reportEnd` alerts a
  lost job ("reload the chat"). `followOnce` reattaches up to `MAX_ATTACHES` times; a
  `discover` of `"gone"` (the server does not know the job) is not a loss.
- `src/ts/network/generationJobs.ts` `applyGenerationEvent`: `accepted`/`chunk` lock and
  stream the reply through the chat module; `done`/`error` release the job.
  `GenerationTerminalEvent` (`shared/jobs.ts`): a `done` of a send/continue/reroll/group
  carries `messageId` (the last reply, `server/src/prompt/runner.ts`); a preview's `done`
  carries `result` and no `messageId`; a command job without a reply has neither.
- `src/ts/storage/chatStore.svelte.ts`: `serverGenerations` (message locks, keyed by
  `chaId\u0000chatId\u0000messageId`), `lockState.version` (reactive bump),
  `isChatGenerating(ref)`, `isCharacterGenerating(chaId)`, `endServerJob`. Locks also
  come from other tabs' jobs through job chat events (`hydrateChat`'s `job`) for loaded
  chats. A lost job's chat is marked stale for the idle refresh when it still holds a lock.
- `src/ts/storage/selection.svelte.ts`: `selection.characterId`, `selection.chatOpen`;
  `chatStore` `currentChatRef()`, `selectedChatId(chaId)`. `PlaygroundStore`
  (`stores.svelte.ts`) is 0 on the chat screen.
- `src/lib/SideBars/Sidebar.svelte`: character rows and folder rows (`charImages`,
  `openFolders`), each a `role="button" tabindex="0"` div wrapping `LazyCharImage` →
  `SidebarAvatar` (`use:tooltipRight={name}`); the folder toggle is `SidebarAvatar`'s
  `onClick`. `PinnedChatsRail` is rendered in both hamburger placements with
  `selectedChaId`/`selectedChatId`.
- `src/lib/SideBars/PinnedChatsRail.svelte` / `pinnedChats.ts`: `PinnedChatItem`
  (`chaId`, `chatId`, names, image); each row is a `role="button"` with `aria-label`
  `language.openPinnedChat(...)`, `aria-current`, and `data-risu-pinned-chat`.
  `src/lib/UI/MainMenu.svelte` renders home cards from the same collector.
- `src/ts/bootstrap.ts` starts `resumeServerJobs()` after boot: a resumed job is followed
  through the same lifecycle, so its end reaches the same hooks.
- Strings: `src/lang/en.ts` has `pinnedChats`, `unnamedPinnedChat`, `openPinnedChat`,
  `chatGenerating`, `newMessage`; no "generating"/"connection lost" badge strings.

## Design

### Status sources (per tab, in memory)

A new module `src/ts/process/chatStatus.svelte.ts` (owner: chat-pipeline) exports:

- `generatingChatKeys(): ReadonlySet<string>` — derived from `$followedJobs` values plus
  the chat keys of `serverGenerations` (a new reactive `lockedChatKeys()` in `chatStore`,
  reading `lockState.version`). The followed set covers this tab's jobs from creation,
  before any lock; the lock set covers a resumed job's stream and other tabs' jobs on
  loaded chats.
- `recoveryChatKeys` — a `writable<ReadonlyMap<chatKey, jobId>>`. `followJobToEnd` adds
  the entry when `end === "lost"` and the chat was discovered (both the exhausted
  `followOnce` and the failed `loadJobChat`); `"gone"` adds nothing. Removed when the
  chat becomes visible (below), when `followedJobs` gains that key again (a new job on
  the chat), or when the chat or its character no longer exists (`chatEntry` check at
  collection time keeps the sidebar honest; the store itself is pruned on `followedJobs`
  changes).
- `unseenChatKeys` — a `writable<ReadonlySet<string>>`, bounded (drop the oldest beyond
  256, as the reference does). `followJobToEnd` adds the key when the terminal is `done`
  with a `messageId` and the chat is not visible at that moment. A `done` without
  `messageId` (preview, previewPrompt, a command job that wrote no reply), an `error`, or
  a lost follow adds nothing. A `stopped` done with a `messageId` counts: partial text is
  a change the user has not seen. Removed when the chat becomes visible.
- `visibleChatKey(): string | null` — `currentChatRef()` as a key when
  `selection.chatOpen` (or the character is `§playground`) and `$PlaygroundStore` is `0`
  (`2` for the playground chat); otherwise `null`.
- `watchChatVisibility()` — an `$effect.root` started from `bootstrap.ts` next to
  `resumeServerJobs`: whenever `visibleChatKey()` changes to a key, that key is removed
  from `unseenChatKeys` and `recoveryChatKeys`. Returns the disposer (tests).
- `resetChatStatusForTests()`.

Hooks in `serverCommands.ts`: two calls in `followJobToEnd`, after `reportEnd` decides
the end: `noteJobLost(target, jobId)` and `noteJobDone(target, end)`. Keep the module
free of UI imports; `serverCommands.ts` imports it, not the reverse.

### Resolution and aggregation (pure, UI side)

`src/lib/SideBars/chatStatus.ts` (owner: ui-theming):

- `type ChatStatus = "recovery" | "generating" | "unseen"`, with
  `CHAT_STATUS_PRIORITY = ["recovery", "generating", "unseen"]`.
- `resolveChatStatus(sets, chatKey): ChatStatus | null` — the first set in priority
  order that holds the key.
- `collectCharacterStatuses(sets): ReadonlyMap<chaId, ChatStatus>` — one pass over the
  three sets, splitting each key on `\u0000` and keeping the highest status per
  character. Built once per change in a `$derived` in `Sidebar.svelte`; rows read a Map,
  never scan the sets.
- `folderStatus(statuses, chaIds): ChatStatus | null` — the highest over a folder's
  members.
- `chatStatusLabel(status, name, language)` — the badge's text, from `language.chatStatus`.

### Badge component

`src/lib/SideBars/ChatStatusBadge.svelte`: `status: ChatStatus`, `label: string`.
Absolute, top-right of its relative parent, `pointer-events-none`, `role="status"`,
`aria-label={label}`, `data-risu-chat-status={status}`. Theme tokens only (U1):
`recovery` `bg-danger-500` with `TriangleAlertIcon`, `generating` `bg-primary-500` with
`LoaderCircleIcon` and `animate-spin motion-reduce:animate-none`, `unseen`
`bg-success-500` with `MailIcon`; a `border-2 border-bgcolor` ring. Because the badge
takes no pointer events, a click on it reaches the row's existing handler (the character's
`changeChar`, the folder avatar's toggle, the pin row's `onOpen`); it is never focusable,
so keyboard order is unchanged. The status text is also appended to the row's accessible
name (the pin row's `aria-label`, the avatar's tooltip `name`), so screen readers and
hover get it without a second control.

### Wiring

- `PinnedChatsRail.svelte`: new prop `statuses: ReadonlyMap<string, ChatStatus>` keyed by
  chat key (default empty). Each row renders the badge for its status and adds the status
  to `aria-label` and a `data-risu-chat-status` attribute on the row. `Sidebar.svelte`
  passes a `$derived` built by `resolveChatStatus` over the pinned items.
- `Sidebar.svelte`: `const characterStatuses = $derived(collectCharacterStatuses(...))`.
  Normal rows (top level and inside an open folder) render the badge for
  `characterStatuses.get(chaId)`; a folder row renders `folderStatus(...)` only while
  collapsed (`!openFolders.includes(char.id)`), as the reference does. The badge sits
  inside the existing `role="button"` div (the `group relative` wrapper), after the
  `LazyCharImage`.
- `MainMenu.svelte` home cards (optional, slice 3): same badge inside the card button,
  same `aria-label` suffix.

### Decisions

1. **Unseen means a reply landed.** Only a `done` with `messageId` marks a chat. An
   `error` already alerts and leaves no new text to read; previews write nothing.
2. **Recovery means a lost follow.** `error` terminals are not "needs recovery": the alert
   covers them. The mark clears on viewing or when a new job of the chat is followed; the
   idle refresh already reloads a stale chat (`endServerJob` → `staleChats`), so viewing
   is the recovery step. Slice 1 verifies that an opened lost chat does refresh; if it
   does not, the visibility watcher asks for a reload of that chat.
3. **Visible is the open chat of this tab.** Overlays (settings, modals) and the browser
   tab's focus do not count: a reply finishing under an open settings page is not marked.
4. **Per tab, in memory.** A reload drops unseen and recovery marks. Resumed jobs mark
   again at their end; nothing is persisted (no new field, no `shared/sections.ts` change).
5. **Other tabs' jobs** show as generating only through locks on loaded chats. A chat
   generating in another tab that this tab has not loaded shows nothing (leftover).
6. **Chat list rows** (`SideChatList.svelte`) are out of scope; the request names pins and
   characters. A follow-up can reuse `resolveChatStatus` there.

## Slices

One slice is one session and one commit. Each ends with `pnpm check`,
`pnpm --silent test:agent`, prettier on changed files, and the owning guide updated.

### 1. Status sources (_small_, `chat-pipeline.md`, `persistence.md` for the chatStore helper)

Files: `src/ts/process/chatStatus.svelte.ts` (new), `src/ts/process/serverCommands.ts`
(the two hooks, the `followedJobs` prune), `src/ts/storage/chatStore.svelte.ts`
(`lockedChatKeys()`), `src/ts/bootstrap.ts` (`watchChatVisibility()`).

Tests: `src/ts/process/chatStatus.test.ts` (new; `selection`, `PlaygroundStore` and the
chat module driven directly, as `serverCommands.test.ts` does): generating follows
`followedJobs` plus locks; a done with `messageId` on a non-visible chat marks unseen,
on the visible chat marks nothing; a preview done, an error, and a lost end mark nothing
unseen; a lost end marks recovery, a `gone` discovery does not; viewing clears both
marks; a new follow of the chat clears recovery; the 256 bound; the watcher's disposer.
`serverCommands.test.ts`: one case per hook through the real `followJobToEnd` (the
existing lost-after-reattaches and done fixtures), asserting the stores.

Done when the stores change as specified and the existing `serverCommands` cases pass.

### 2. Sidebar and rail badges (_small_, `ui-theming.md`, `settings-i18n.md` for strings)

Files: `src/lib/SideBars/chatStatus.ts` (new), `ChatStatusBadge.svelte` (new),
`PinnedChatsRail.svelte`, `Sidebar.svelte`, `src/lang/en.ts` (`chatStatus.generating`,
`chatStatus.needsRecovery`, `chatStatus.unseenReply`, each a function of the chat or
character name), `src/lang/ko.ts` overrides.

Tests: `src/lib/SideBars/chatStatus.test.ts` (priority, per-character aggregation from
mixed keys, folder aggregation, empty sets), `PinnedChatsRail.test.ts` (badge per status,
one badge when states overlap with the priority order, `aria-label` suffix, no badge
element focusable and the same tab order, click and Enter still call `onOpen`).
`Sidebar.svelte` has no unit test; its wiring is checked in slice 3 and by hand:
collapsed folder shows the aggregate, open folder shows member badges only, badge click
still opens the character / toggles the folder.

Done when the rail and the character rail show the three badges with the right priority
and the existing rail tests still pass unchanged in behavior.

### 3. Browser check and docs (_small_, `build-test-platforms.md`)

Files: `util/playwright/checkSidebarChatStatus.mjs` (new, patterned on
`checkServerSend.mjs`: seed two bound chats, start a send in A, open B, assert
`[data-risu-chat-status="generating"]` on A's pin row and character; let the job finish,
assert `unseen`; open A, assert none; a reply finishing in the open chat shows no badge).
The lost case needs the stack stopped mid-job; record it as a manual check in the guide's
Tests section rather than scripting it. Optional in the same slice: the home cards in
`MainMenu.svelte` with the same badge and `MainMenu` test coverage if one exists.

Update `docs/structure/ui-theming.md` (Sidebar, PinnedChatsRail, new files, tests),
`docs/structure/chat-pipeline.md` (State: the status stores; Flows: the two hooks),
`docs/structure/persistence.md` (the `lockedChatKeys` read). Move this plan to the
archive README when all slices land.

## Leftovers to record at the end

- Unseen/recovery marks are per tab and dropped by a reload (decision 4).
- A chat generating in another tab and not loaded here shows nothing (decision 5).
- `SideChatList.svelte` rows and the home cards (if not done in slice 3) have no badge.
- The badge's `title` tooltip does not show because it takes no pointer events; the
  status is in the row's name instead.
