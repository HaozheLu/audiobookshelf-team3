# Team 3 — Podcast Download Queue

Three changes to audiobookshelf's podcast downloading: filtering what gets auto-downloaded (#7), reordering and removing what is waiting (#8), and retrying what failed (#9).

## Run it

```sh
npm run prod
```

Then open http://localhost:3333/audiobookshelf and create an admin account and a **Podcast** library.

Tests: `npm test`

## Check it

Add a podcast with auto-download off, then:

1. **#7** — Edit → Schedule, enable auto-download, set a limit, enable the trailer/bonus filters and a title phrase, click **Preview**. Excluded episodes are listed with a reason, and the limit applies after filtering.
2. **#8** — **Find Episodes**, select ~10. On **Download Queue**, move a waiting row to the front and remove another. Reload: the order holds, and episodes then download in that order. The removed one never downloads.
3. **#9** — Make a download fail (e.g. go offline mid-download). It appears in the failed list with its stage. **Retry** starts a new attempt; **Dismiss** clears it.

---

## Issue #7 — Filter automatic podcast downloads
**Kevin Huang** (@hzykevin)

**Change.** Per-podcast filters for automatic downloads: exclude trailers, exclude bonus episodes, and exclude titles containing a phrase (case-insensitive). A preview shows which episodes would be downloaded and why the others were excluded. Filtering runs before the max-download limit, and the preview and the real run share one selection path so they cannot disagree. Manual downloads are unchanged.

**Checks.** Server 437 passing; client 110 across 7 specs; Schedule component 5; client production build passed; manual end-to-end preview passed, covering the date cutoff, both type filters, case-insensitive title matching, and the limit applying after filtering.

**From the RFC.** The shared selection utility ended up owning the cutoff, duplicate, ordering and limit decisions too, not just the new filters. Title phrases are trimmed, and an empty phrase disables the title filter. The preview reuses the existing feed endpoint to fetch a normalized feed.

**Remaining.** New UI strings fall back to English in untranslated locales. A preview can differ from a later run if the remote feed changes in between.

---

## Issue #8 — Reorder and remove pending downloads
**Oliver Zhang** (@junhezhan)

**Change.** An admin can move a waiting episode to the front of the queue or remove it before it starts; the active download is never touched. The queue used to be a FIFO that only changed at its ends, so nothing ever addressed one entry, entries are now addressed by download id, since positions shift as downloads start and new episodes queue. The server owns order: `pending, front`, `pending, removed`, and `pending, active`, the last triggered only by the server. Anything aimed at an active, finished or already removed entry returns 404 meaning "no longer pending". Every change broadcasts the whole queue from the same function that serves a page load, so the browser only renders what it is sent and a refresh cannot disagree with a live update.

**Checks.** 368 passing, including 14 for the queue actions — middle-of-queue moves and removals, targeting the active download, unknown ids, an id from a different podcast, repeated removal, an episode queued mid-operation, and fresh-page order matching start order. End to end: four moves, then the server started those episodes in exactly the arranged order, including one that displaced an earlier move; six removed entries each had zero completions and zero rows; a removal 110 ms before a completion left it undisturbed.

**From the RFC.** The RFC left open whether to broadcast the affected id or the whole queue. After critique it broadcasts the whole queue, which also removed the need for a separate re-sync. Lookup now matches the podcast's library-item id as well as the download id, so a mismatched pair is rejected instead of changing the wrong queue. A reviewer's suggestion to add a status field was not adopted: it would not remove the lookup, since a move or removal needs the array index anyway, and it would add a second copy of state that can drift.

**Remaining.** The queue is in memory and does not survive a restart; that, pausing transfers, and parallel downloads are outside the request. A rejected action cannot tell an id that was pending a moment ago from one that never existed.

---

## Issue #9 — Retry failed downloads
**Haozhe Lu** (@HaozheLu)

**Change.** The server keeps the latest 50 failures since startup, and the queue page shows each failed episode with the stage it failed at — transfer, audio inspection, or saving — plus Retry and Dismiss. Every download including a retry goes through the same workflow, so there is one set of duplicate checks, queueing, fallback and cleanup. A retry creates a new attempt id while episode identity stays podcast + GUID (enclosure URL when no GUID), and is refused with a reason when the episode is already active, queued or downloaded, or its podcast is gone. No automatic retry loops.

**Checks.** Server 389 passing, 0 failing; client production build successful; JSON and diff-format checks successful. Tests cover the 50-item limit, failure categories, the reload snapshot, retry with a new attempt id, successful and repeatedly failing retries, rapid duplicate requests, removed podcasts, already-active/queued/downloaded episodes, dismissal, queue continuation, and the existing untagged-download fallback.

**Remaining.** None. Failure history resets on restart by design.

---

## Integration

# 9 extends #8's server-owned queue snapshot with failed attempts without changing pending order, and downloads started by #7 run through the same workflow, so their failures are recorded and retryable.

One separate fix is required for any of this to work: the vendored ffprobe wrapper assigns to an undeclared variable, which the TypeScript migration's strict-mode output turns into a crash after every episode download. It is on `fix-ffprobe-strict-mode-crash` and must be merged first.
