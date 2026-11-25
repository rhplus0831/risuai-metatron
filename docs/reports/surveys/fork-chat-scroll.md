# Chat transcript scrolling: four forks, and two symptoms in metatron

Survey date 2026-11-18. Two parts:

1. A read-only comparison of how HaejeokRisuai, PocketRisu, RisuBard and RisuNest keep the chat transcript's scroll
   position (sections 1 to 3).
2. A diagnosis of two symptoms the owner reported in metatron, reproduced in a real browser and checked by a separate
   verifier (sections 4 to 7).

The survey and the diagnosis changed nothing in `src/`; the fixes that followed the same day are section 10, and
sections 4 to 6 describe the transcript before them. The owner's report was:

- **Symptom 1.** When a scroll event occurs while loading, the scroll stops in the middle of a message.
- **Symptom 2.** When a plugin modifies the chat, the message goes down to the very bottom.

| Prefix | Checkout                    | HEAD        | Date       |
| ------ | --------------------------- | ----------- | ---------- |
| **HR** | `/home/codex/HaejeokRisuai` | `a34d74f8f` | 2026-11-11 |
| **PR** | `/home/codex/PocketRisu`    | `40851fc9`  | 2026-11-01 |
| **RB** | `/home/codex/RisuBard`      | `3199c8d`   | 2026-11-15 |
| **RN** | `/home/codex/RisuNest`      | `6c5a16ec8` | 2026-11-15 |
| **MT** | metatron, this repository   | `3b5d7ce6f` | 2026-11-18 |

How it was made: eight Luna workers read the forks (two questions per fork: how the scroller follows messages, and
how the position survives content changes). "Verified" below means the session read the cited lines itself; the rest
is a worker's reading. No fork was run: what a fork does in a browser is inferred from its code and its own tests.
The metatron part was run: every number in sections 5 and 6 comes from
[`probeChatScroll.mjs`](fork-chat-scroll/probeChatScroll.mjs) in Chrome.

## 1. Summary

- All five use the same base: a reversed scroller (`flex-col-reverse`, `scrollTop` 0 is the bottom) with rows mounted by
  hand.
- HR and PR keep upstream's rule and nothing else: on a new character message, if the newest row is within 100 px of
  the bottom, scroll to its start 700 ms later. Neither restores a reading position.
- RB and RN each built a reader anchor, in opposite ways. RB turns the browser's scroll anchoring off and restores a
  remembered paragraph itself on every resize or mutation. RN keeps the browser's anchoring on for height changes and
  corrects only when the set of rows changes.
- Both RB and RN also stopped replacing a row's DOM when its text changes. That, more than the anchor, is what the
  two metatron symptoms turn on.
- In metatron, symptom 2 and the streaming form of symptom 1 are one defect: a row's `Chat` is remounted when its text
  changes, the row collapses for a frame, and the browser's scroll anchoring carries the reader to the bottom, where
  it stays. The opening form of symptom 1 is a second, smaller defect: input before the newest row's first render
  releases the anchor for good.

## 2. Comparison

| Fork | A row whose text changed                                       | Reading-position correction                                                              | The reader's scroll input                                             |
| ---- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| HR   | Keyed by `chatId`; a changed render signature remounts the row | None (one path excepted: page growth in "read from the beginning" mode)                  | Not observed by code                                                  |
| PR   | The row's hash includes the text: an edited row is remounted   | None; inlay images get a reserved box instead                                            | Not observed by code                                                  |
| RB   | Text is left out of the hash: the row stays, HTML is patched   | Own anchor (message, paragraph, offset), restored by `ResizeObserver`/`MutationObserver` | Cancels a pending correction, captures a new anchor on the next frame |
| RN   | Stable keys; the row and its component stay                    | Row key and offset on structural changes; the browser's anchoring for height changes     | Bumps a generation that voids pending corrections and jumps           |
| MT   | The row element stays, its `Chat` component is remounted       | A follow anchor for the newest message only; none for a reader who scrolled              | Releases the follow anchor; holds rows above the view while scrolling |

Following a new reply is the same rule in all four forks (verified in HR `src/lib/ChatScreens/Chats.svelte:263-299`
and PR `src/lib/ChatScreens/Chats.svelte:249-270`): the message count grew, the last message is the character's, and
the reader is near the bottom or `alwaysScrollToNewMessage` is on. The jump is a 700 ms timer that is never
cancelled in HR, PR and RB; RN cancels it on input unless `alwaysScrollToNewMessage` is on. A write that keeps the
message count therefore never scrolls a fork's transcript by code.

## 3. The forks one by one

### HaejeokRisuai

- Upstream's structure. Rows are keyed by `chatId` and compared by a render signature that includes the text
  (verified, HR `Chats.svelte:83-100`); a mismatch remounts the row.
- No anchor, no observer, no `overflow-anchor` rule. Two special paths wait and correct: the jump to a message waits
  for images up to 4 s and scrolls twice, and page growth in "read from the beginning" mode adjusts `scrollTop` by the
  edge row's movement (HR `src/lib/ChatScreens/DefaultChatScreen.svelte:1031-1045`).
- History: smooth scrolling was replaced by instant "due to bug" (`6c56de461`); an image wait before the auto-scroll
  was added (`5416a43f5`) and replaced by the 700 ms timer (`fb63ac908`).

### PocketRisu

- The same follow rule. The row hash includes `message.data` except for the streaming row (verified, PR
  `Chats.svelte:136-142`), so an edit remounts the row.
- It reduced the causes of movement instead of correcting it: inlay images get a 100 px minimum box and their stored
  dimensions (`53699f47`, `a6c00ed4`), and the edit box saves and restores its ancestors' `scrollTop` around its
  resize (`a38759da`). The message of `53699f47` says a wider scroll-anchoring rework was not adopted.
- `scrollWithinContainer` (PR `src/lib/ChatScreens/scrollWithin.ts`) replaces `scrollIntoView`, which also scrolled
  the page root (`f4eb26c4`). Metatron's `applyAnchor` measures for the same reason.

### RisuBard

Verified by reading RB `src/lib/ChatScreens/observeChatScroll.ts` and `chatScrollAnchor.ts` in full (272 lines).

- Setting `preserveChatScrollPosition`, default on. With it on, the row hash leaves the text out, so a row stays
  mounted across text and receipt updates (RB `Chats.svelte:137-146`, comment "Keep the reading DOM alive through
  final text and receipt updates"), and `retainedChatHtml.ts` patches changed nodes in place.
- The anchor: the message that crosses the view's top, the paragraph, list item or image inside it (`readingBlock`:
  element, child-index path, tag, the first 64 characters or `src`), and its offset from the view's top.
- Restoring: a `ResizeObserver` on the container and every `[data-chat-index]` row corrects at once (before paint); a
  `MutationObserver` (child list, character data, subtree) queues a correction for the next frame. The correction is
  `scrollTo({ top: scrollTop + delta, behavior: "instant" })`. The container gets `overflow-anchor: none`.
- Input: `wheel`, `touchstart`, `touchmove`, `pointerdown` and the scroll keys cancel a pending correction and
  capture again one frame later. A `scroll` event captures too, unless its `scrollTop` is the one the observer just
  set (`ownScrollTop`), which keeps the clamped position of a collapsing reload from replacing the anchor.
- A new reply while the reader is at the newest message swaps the anchor for a "follow the end" anchor
  (`3caaaa2`, 2026-10-15: "keep the chat from jumping up while a reply arrives").
- Limits: the anchor names a message by index, so an insert or delete before it shifts it; there is no `scrollend`
  wait, so a correction can land during momentum or a smooth scroll; the 700 ms timer remains; history is paged
  (30 per page) instead of loaded on scroll. Tests use mocked geometry (`chatScrollAnchor.test.ts`,
  `observeChatScroll.test.ts`).

### RisuNest

Verified by reading RN `src/lib/ChatScreens/Chats.svelte:845-910`, `2440-2475`, `2540-2616` and `src/styles.css:1-19`.

- A virtual viewport: 64 mounted rows (40 in low-spec mode), eight rows of overscan, gap elements for the rest at an
  estimated 256 px per row, measured heights kept per index.
- The anchor is a row key, an index hint and the row's offset from the view's top (`captureDomAnchor`).
  `correctDomAnchor` restores it with an instant `scrollBy` after a reconciliation, a source handoff, or a jump.
- A height change alone gets no correction by the app: RN leaves it to the browser's scroll anchoring. Commit
  `97aa799d4` (2026-10-14, "keep native scroll anchoring during updates") removed the `overflow-anchor: none` an
  earlier fix (`4884f2f3c`) had put on the scroller during updates. Only a row whose height is still pending is
  `visibility: hidden; overflow-anchor: none`.
- Row DOM survives edits and display reloads (its `Chats.test.ts` asserts the same elements and component instances),
  and `ChatBody` keeps the shown HTML until the replacement parse is ready.
- Images with known dimensions reserve their box (`contain: size; contain-intrinsic-size`), and measured dimensions
  are stored.
- Opening pins `scrollTop = 0` (`initialLatestFollow`) until the reader's intent: a wheel with a nonzero `deltaY`,
  a touch move, a press on the scroller, or a scroll key. A `scroll` event alone is not intent, because layout and
  the browser's anchoring emit them too. Intent bumps `positionGeneration`, which voids pending corrections and
  jumps, and cancels the 700 ms timer.
- An in-memory map keeps one anchor per chat (32 entries) for coming back to a chat.
- Not established by its tests: that the browser's anchoring behaves the same in every WebView it ships to.

### Plugin writes in the forks

None of the four has a per-message plugin write: a plugin replaces a chat or a character (`setChatToIndex`,
`setChar`). None scrolls on such a write, since the follow rule needs a longer message list. What differs is whether
the changed row's DOM survives: HR and PR remount it, RB and RN keep it.

## 4. Metatron today

`src/lib/ChatScreens/Chats.svelte` is the transcript. Compared with the forks it has more machinery for opening and
loading, and less for a reader who has scrolled:

- A follow anchor (`ScrollAnchor`): `start` keeps the newest row's top at the view's top, `end` keeps the bottom.
  A `ResizeObserver` on the scroller and the row list reapplies it. A wheel, a touch move, a press on the scrollbar
  or a scroll key releases it (`anchor = null`).
- An opening hides its rows (`chat-row-pending`), sets `scrollTop = 0`, anchors `start`, and reveals rows as they
  render (`startReveal`). Rows added above the view are held out of the layout until rendered and the reader is not
  scrolling.
- Once the anchor is released, nothing by the app holds the reader's position. The browser's scroll anchoring is
  left on (no `overflow-anchor` rule anywhere in `src/`), and section 5 shows it does most of that work.
- A row is keyed by chat and `Message.chatId`. Its element stays across a text change, but its `Chat` component does
  not: `createRow`'s effect compares `mountKey.text` (the text, or `null` while the row streams) and on a difference
  calls `unmount` and `mount`.

The guide already records the missing reader anchor as a limitation with a deferred decision
([UI and theming](../../structure/ui-theming.md#limitations), commit `0aad24ce5`).

## 5. Reproduction

[`probeChatScroll.mjs`](fork-chat-scroll/probeChatScroll.mjs) seeds one character per scenario with a chat of 14
text messages (each about 1,300 px tall in a 1280 x 800 window), opens it through the UI, and prints the reader's
position at each step. `newest top` is the newest row's top minus the view's top: 0 means the newest message is
shown from its start. `reading` is the first marked paragraph at the view's top (`m14-p07` is message 14,
paragraph 7 of 0 to 19).

A chat write is `applyChatResult(captureChatBaseline(ref), result)` called in the page, the call the plugin API's
`setChatToIndex` ends in; no plugin was installed.

### 5.1 A chat write (symptom 2)

| Reader before the write                                                   | What the write changed                      | After                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| No input since opening (`start` anchor)                                   | Newest message's text, id kept              | Same place; the bottom is shown for two to three frames  |
| No input since opening                                                    | Newest message came back without its id     | **Bottom** (`scrollTop` 0, reading `m14-p07`)            |
| No input since opening                                                    | Every message came back without its id      | Same place (the opening runs again)                      |
| Scrolled up 500 px (newest top 500)                                       | Newest message's text, id kept, same height | **Bottom** (`scrollTop` 0, reading `m14-p07`)            |
| Scrolled up 300 px (newest top -200)                                      | Newest message's text, id kept, same height | **Bottom** (the verifier's run)                          |
| Scrolled up 500 px                                                        | Newest message got ten more paragraphs      | **Bottom** (reading `m14-p17`)                           |
| Scrolled up 500 px                                                        | Newest message came back without its id     | Same place; the bottom is shown for one frame            |
| Scrolled up 400 px in a two-message chat                                  | Newest message's text, id kept              | **Bottom**                                               |
| Scrolled up 5,000 px (reading `m10-p02`)                                  | Newest message's text, id kept              | Same paragraph, same offset                              |
| Scrolled up 5,000 px                                                      | Newest message got ten more paragraphs      | Same paragraph, same offset (`scrollTop` -5573 to -6148) |
| Scrolled up 5,000 px                                                      | Oldest message's text, id kept              | Same paragraph, same offset                              |
| Scrolled up 5,000 px                                                      | Every message came back without its id      | **Newest message's start** (reading `m14-p00`)           |
| Scrolled up 500 px, `overflow-anchor: none` set on the scroller (control) | Newest message's text, id kept              | Same place (`scrollTop` -1073 throughout)                |

"Scrolled up 500 px" leaves the reader on the end of the previous message with the newest one starting 500 px
below the view's top; "300 px" leaves them inside the newest message.

The frame trace of the fourth row: `scrollTop` -1073 with the newest row 1,313 px tall; 15 ms later the row is
176 px (this fixture's shell: avatar, name, controls) and `scrollTop` is 0.5; 17 ms after that the row is 1,313 px
again and `scrollTop` is still 0.5. The verifier instrumented `scrollTop` writes for this case and recorded none
from JavaScript.

The two-message row has a second cause: with the newest row collapsed the content is no taller than the view, the
scroll range is gone, and the browser clamps `scrollTop` to 0 whatever `overflow-anchor` says (the verifier's
control for that chat still ends at 0).

### 5.2 Input while a chat opens (symptom 1, opening)

| Scenario                                                                                      | Final position                                           |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| No input                                                                                      | Newest top 0 (the message's start)                       |
| Wheel up 120 px after everything settled (reference)                                          | Newest top 120                                           |
| One real wheel up 120 px as soon as the mask is seen, CPU 1x and 4x                           | Newest top 120: it arrived after the first render        |
| Two images per message answered 3 s late; wheel at 0.4 s (masked) or 1.8 s (shown)            | Newest top 120: the browser's anchoring held it          |
| Wheel event dispatched by the page when the mask first appears (rows are shells)              | **`scrollTop` 0, newest top -573, reading `m14-p07`**    |
| The same with late images                                                                     | **Newest top -1850, reading `m14-p10`**                  |
| The same event 50 ms later                                                                    | Newest top 0: the row had rendered on this machine       |
| Real wheel notches of 1 px every 4 ms while opening; 2 of 147 arrived before the first render | **`scrollTop` -146, newest top -427, reading `m14-p05`** |

### 5.3 Input while a reply streams (symptom 1, streaming)

A mock provider streams 30 paragraphs over six seconds; the input comes 2.5 s in.

| Scenario                                           | While it streams                                 | After the stream ends                                  |
| -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| No input                                           | Follows the bottom                               | Reply's start (newest top 0)                           |
| Wheel up 100 px                                    | Stays on its paragraph (`s00` at 106 px)         | **Bottom of the reply** (`scrollTop` 0, reading `s18`) |
| Wheel up 3 px                                      | Follows the bottom                               | Reply's start (within the 4 px "at bottom" tolerance)  |
| Wheel up 4 px (the verifier's run)                 | Follows the bottom, 4 px above it                | Stays 4 px above the reply's bottom                    |
| Wheel up 5,000 px (the verifier's run)             | Stays on its paragraph                           | Same paragraph, same offset                            |
| Wheel down, or a wheel event that scrolls nothing  | Follows the bottom                               | Reply's start                                          |
| Wheel up 100 px, `overflow-anchor: none` (control) | The text moves under the reader (`s00` to `s17`) | No jump (`scrollTop` -100 throughout)                  |

The frame trace of the second row at the end of the stream: `scrollTop` -1173 with the row 1,926 px tall; next
frame the row is 176 px and `scrollTop` is 0.5; it stays there when the row is 1,926 px again.

## 6. Causes

### M1. A remounted row collapses, and the browser's anchoring leaves the reader at the bottom

Covers symptom 2 with ids kept, and the streaming form of symptom 1. Keeping the ids does not avoid it.

1. A message's text changes, or its stream ends. `createRow`'s effect sees a different `mountKey.text` and unmounts
   and mounts the row's `Chat` (`src/lib/ChatScreens/Chats.svelte`, the `untrack` block that ends in
   `mount(Chat, ...)`). The same remount follows the reader's own edit save, a candidate switch that changes the
   text, a reload-pointer bump from a trigger or Lua, and a text change received from another tab (section 7).
2. Until the new component has parsed and rendered its body, the row is only its shell (176 px in the fixture, which
   lost about 1,137 px).
3. Chrome's scroll anchoring keeps what the reader sees in place by moving `scrollTop` towards 0 by the lost height.
   A reader farther from the bottom than that height is carried there and back (the rows at 5,000 px in 5.1). A
   reader closer than that is clamped at 0.
4. At 0 the browser's anchoring does nothing more, and the app's anchor was released by the reader's scroll, so when
   the row regrows the reader stays at the bottom.

How near the bottom "closer" is depends on the row's height, so there is no fixed pixel threshold. At the end of a
stream a second rule decides: a reader within 4 px of the bottom gets the `start` anchor again (`checkIfAtBottom`),
so they see the reply's start; one farther up does not.

The controls show step 3 is the browser's anchoring: with `overflow-anchor: none` the same write and the same
stream end leave `scrollTop` untouched. The stream control also shows why turning the anchoring off is not a fix by
itself: without it the text moves under a reader who scrolled up during a stream.

With the `start` anchor still held, the same collapse shows the bottom for two to three frames before
`applyAnchor` puts the row's start back.

### M2. Input before the newest row's first render releases the opening's anchor

Covers the opening form of symptom 1.

`startReveal` sets `scrollTop = 0` and the effect anchors `start`, but `applyAnchor` has nothing to align until
the row has rendered. A wheel or touch move in that window sets `anchor = null` (a `scroll` event alone does not
release the anchor). Nothing anchors again: the rows
render, the view stays at `scrollTop` 0, which for a message taller than the view is its end, and later notches
scroll up from there. Input after the first render does not have this effect: the anchor has already aligned the
row, and the browser's anchoring holds the reader while images arrive.

On the test machine the window was under 50 ms for text rows. It is as long as the first stage's rows take to mount
and parse, so it grows with slower devices and heavier rows; that was not measured.

### M3. A replaced newest row turns the `start` anchor into `end`

`applyAnchor` treats a disconnected anchor element as a removed row (a reroll's or a deletion's) and falls to
`mode: "end"`. A write that returns the newest message without its `chatId` gets a new id in `applyChatResult`, so
the row is removed and a new one added: the reader, who was at the message's start, is put at the bottom.

### M4. A write that renews every id is taken for an opening

`updateChatBody` calls a diff an opening when none of its row keys is mounted. A write that returns every message
without its id satisfies that: the reveal runs and the reader is put at the newest message's start.

### What the owner's two sentences map to

- Symptom 2 is M1 for a plugin that keeps message ids (the ordinary read, modify, write), and M3 or M4 for one that
  rebuilds message objects.
- Symptom 1 had two candidates that both reproduce: M1 at the end of a stream after scrolling up, and M2 while a chat
  opens. Asked which, the owner said it was while a chat was first being loaded: M2. The stream-end form of M1 stays a
  reproduced defect nobody reported.

## 7. Verification

A separate verifier (one Sol agent, told to break the diagnosis, not allowed to change the repository) read the
code, reran 18 scenarios of its own in Chrome with `scrollTop` writes instrumented and row identity checked, and
answered a list of claims. The causes above already carry its corrections.

| Claim                                          | Verdict   | What it added                                                                                     |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| M1 for a chat write                            | Partly    | Holds for long chats, with no JavaScript scroll write; the two-message case is range clamping     |
| M1 at the end of a stream                      | Partly    | Holds at 100 px; "4 px or more" was too strong: 4 px stays put, 5,000 px keeps its paragraph      |
| M3                                             | Confirmed | Recorded `applyAnchor` writing 0                                                                  |
| M4                                             | Confirmed | Recorded the reveal's reset and the `start` alignment                                             |
| M2                                             | Confirmed | A plain `scroll` event in the same window does not release the anchor                             |
| The page call stands in for the plugin path    | Confirmed | For an accepted write on the same baseline; permissions and the sandbox were not exercised        |
| No other `scrollTop` writer explains the jumps | Confirmed | The app's writers (`applyAnchor`, `startReveal`, jumps, screenshots) were absent from the M1 runs |

Every plugin write reaches the same reconciliation, so each can reach M1, M3 and M4 for the open chat:
`setChatToIndex`, `setChar`, `setCharacter`, `setCharacterToIndex`, and `setDatabase` / `setDatabaseLite` when the
supplied characters carry a changed chat. `getChatFromIndex` and `getCharacter` hand a plugin the message ids, so an
ordinary read, modify, write keeps them.

Which other events remount a mounted row's `Chat` (the verifier's reading of the code; two were run):

| Event                                       | Remounts `Chat`                                   | Run                                       |
| ------------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| The reader's edit save                      | Yes, when the text changes                        | Yes: same row element, new `Chat`, 176 px |
| A reroll or candidate switch                | Yes, when the text or the streaming state changes | Yes: `scrollTop` -373 to the bottom       |
| A reload-pointer bump from a trigger or Lua | Yes                                               | No                                        |
| A text change received from another tab     | Yes                                               | No                                        |
| A translation                               | No                                                | No                                        |
| The regex editor's reload                   | Normally no (it remounts `ChatBody`)              | No                                        |
| The display transform's correction          | No (the mounted body is parsed again)             | No                                        |

The verifier also saw the reader already near the bottom when the edit box opened, before the save. That was not
isolated and is not counted as a finding.

Limits of the probe it pointed out: `where()` does not skip hidden paragraphs, so `reading` can mislead while rows
are masked (the tables use settled positions); a position read just before a real wheel is not the position when
the wheel is delivered (the page's own early-event capture is the evidence for M2); results are for these fixtures in
headless Chrome.

## 8. What the forks suggest

Not a plan. Each line names the mechanism and what a fork does about it.

- **M1, the collapse itself.** RB and RN do not replace a row's DOM for a text change. RB updates the mounted row
  and patches its HTML; RN keeps the shown HTML until the new parse is ready. Metatron's streaming path already
  updates a mounted row in place (`updateRow`); the remount is only taken when the text of a row that is not
  streaming changes, and when a stream ends.
- **M1 and the recorded limitation, a reader anchor.** RB restores a remembered paragraph on every resize and
  mutation with the browser's anchoring off. RN restores a row and offset on structural changes with the browser's
  anchoring on. The guide's deferred note asks for the RN shape plus a wait for `scrollend`.
- **M2.** RN has the same kind of release (intent ends `initialLatestFollow`), with one difference: a wheel whose
  `deltaY` is 0 is not intent. RB does not hold an anchor through the opening at all: it scrolls to the newest row
  once one has mounted and lets its observers take over.
- **M3 and M4.** RN's anchor falls back to a neighbouring row when its row is deleted, and its keys do not depend on
  ids a write may drop. RB's index-based anchor is the weaker choice here.
- **Reserved image boxes** (PR, RN) remove a cause of movement instead of correcting it. In the runs above the
  browser's anchoring already held the reader through late images once the row had rendered.

## 9. Not verified

- No fork was run. In particular, whether HR and PR show M1 (they also remount an edited row) is an inference.
- Chrome only, headless, on a desktop viewport. Safari, Firefox, a phone and touch input were not run; the
  browser's anchoring is the moving part in M1, and browsers differ in it.
- A wheel sent through the debugging protocol does not animate, so the smooth-scroll case of the recorded limitation
  was not exercised.
- The plugin path was exercised at `applyChatResult`, not through an installed plugin.
- The other events that remount a row (an edit save, a reroll, a translation, a reload pointer) were read in the
  code, not run, except as the verification section and the review of the fixes say.

## 10. Fixes

The owner asked for M2, M1 and M3 to be fixed and left M4. All three are in `src/lib/ChatScreens/Chats.svelte`.

- **M2.** Scroll input keeps the anchor while an opening still hides its newest row (`release`,
  `revealBatch?.next === 0`). The reveal ends at its 1,200 ms deadline at the latest. Input during that mask no longer
  takes the view over: a reader who scrolls while the rows are hidden ends at the newest message's start.
- **M1.** A row whose `Chat` is mounted again keeps its height (`min-height`) until the new instance has rendered
  (`keepRowHeight`, `settleRowHeight`), so there is no collapse for the browser's anchoring to answer. When the new
  text is longer or shorter, the row's top is put back by the height difference, unless the app's anchor holds the
  view, the row is above the view, the reader gave scroll input since, or the offset changed.
- **M3.** A `start` anchor whose row left the DOM falls to `latestAnchor()`: the start of the row that is newest now
  (the owner's choice for a deleted newest message), or the bottom while that row streams or waits.
- A sideways wheel (`deltaY` 0) no longer counts as scroll input.

After the fixes, the scenarios of section 5 that ended in the wrong place:

| Scenario                                                        | Before                         | After                                         |
| --------------------------------------------------------------- | ------------------------------ | --------------------------------------------- |
| Scrolled up 500 px, newest message's text changed, id kept      | Bottom                         | Same place                                    |
| The same, the newest message got ten more paragraphs            | Bottom                         | Same paragraph, same offset                   |
| Two-message chat, scrolled up 400 px, newest text changed       | Bottom                         | Same place                                    |
| No input since opening, newest message came back without its id | Bottom                         | Message's start (the bottom for three frames) |
| No input since opening, newest text changed                     | Bottom for two to three frames | No movement                                   |
| Scrolled up 5,000 px, newest text changed                       | Away and back within a frame   | No movement                                   |
| Wheel event when the opening's mask first appears               | Bottom of the newest message   | Message's start                               |
| The same with late images                                       | Middle of the newest message   | Message's start                               |
| Real wheel notches of 1 px while opening                        | Middle of the newest message   | Message's start plus the 146 px scrolled      |
| Wheel up 100 px during a stream, at its end                     | Bottom of the reply            | Same paragraph, same offset                   |
| Scrolled up 5,000 px, every message came back without its id    | Newest message's start         | Unchanged: M4 was left                        |

### Review of the fixes

One Sol reviewer, three rounds, each with its own browser runs. What it found and what was done:

| Round | Finding                                                                                                    | Outcome                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1     | The height was measured at the remount, after a reload pointer or an edit save had already emptied the row | Fixed: heights come from a per-row `ResizeObserver`, the offset from scroll events                 |
| 1     | A `min-height` stayed on a row remounted again after it had moved far from the view                        | Fixed: the kept height lives on the row and the newest instance's render clears it                 |
| 1     | A test's negative assertions had become vacuous under the new guard                                        | Fixed                                                                                              |
| 2     | A correction's offset, remembered globally, let a later unrelated correction override the reader           | Fixed: a correction updates only the rows still waiting from the same offset; scroll input cancels |
| 2     | A row that changes size in the same window as another row's remount is corrected only in part              | Left: the reproduction needed an image `load` handler that edits another message                   |
| 2     | A scroll written by other code in the task of a remount skips the correction                               | Reduced: the transcript's own writes update the remembered offset; other writers reach it by event |
| 3     | A sideways wheel cancelled a correction                                                                    | Fixed                                                                                              |

It confirmed in the browser: a reload of every row, the UI's re-render, an edit save, a candidate switch, a reroll
(streamed and whole), a deletion of the newest message, and a remount during a real wheel scroll.

### Left open

- M4, by the owner's choice.
- The two "left" and "reduced" rows above, recorded as a limitation in the
  [UI guide](../../structure/ui-theming.md#limitations).
- Opening the inline editor moved the view before any save, and closing it did not give the place back. Fixed on
  2026-11-22: the body is replaced by a shorter text area, so the row shrinks and the browser's anchoring answers; the
  transcript now remembers the row's place at the open and restores it at the close
  ([UI guide](../../structure/ui-theming.md#transcript-scrolling)). [`probeEditorOpen.mjs`](fork-chat-scroll/probeEditorOpen.mjs)
  checks it.
- A render that takes seconds (a slow display transform) followed by the reader's own scrolling gets no correction, as
  before the fixes.
- Still Chrome only: Safari, Firefox, a phone and touch input were not run.

## Files

- [`fork-chat-scroll/probeChatScroll.mjs`](fork-chat-scroll/probeChatScroll.mjs): the probe. It asserts nothing and
  prints one JSON line per scenario.
- [`fork-chat-scroll/probeEditorOpen.mjs`](fork-chat-scroll/probeEditorOpen.mjs): the inline editor's scenarios
  (open, cancel, save, the reader scrolling meanwhile, two editors). It asserts, and exits 1 on a failed expectation.
- The runs behind the tables, the workers' answers and the verifier's brief are kept outside the repository in
  `/home/codex/review-reports/chat-scroll-2026-11-18/`.
