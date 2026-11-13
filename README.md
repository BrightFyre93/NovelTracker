# Novel Tracker EPUB Companion

A Windows-first Electron + Vue desktop app for discovering chapters from one novel URL and building a text-first EPUB.

## Run locally

- Install Node.js 24 or later.
- Run `npm install`.
- Run `npx playwright install chromium` to install the browser used for manual verification.
- Run `npm run dev` to open the desktop app.

## Verify

- `npm run typecheck`
- `npm run lint`
- `npm run build`

## Features

Enter a novel table-of-contents URL (or a direct chapter URL), review metadata and chapter order, choose an output folder, and create a text-first EPUB. The NovelFull parser reads all paginated chapter-list pages in order and ignores the “Latest chapters” sidebar. Chapter text is fetched only for selected chapters, with progress shown during discovery and EPUB creation.

The output filename is editable. If an EPUB with the same name already exists in the output folder, it is overwritten. The Configuration page lets you set the local library root, read-only Novel Tracker CSV, EPUB output folder, app theme, download concurrency, chapter-list refresh interval, and EPUB stylesheet. The Library page directs you to Configuration to set the historical library root before scanning. Tracker rows can be searched and chosen without triggering network requests; discovery remains an explicit action.

Library scans are read-only and run in a worker so EPUB inspection does not block the app process. A blocking progress dialog prevents other interaction, shows discovered and indexed file counts, and allows cancellation until the index is saved. In Configuration, **Scan the Old folder** is an opt-in for archived EPUB volumes and defaults off. `Old` is the source archive for EPUBs selected for offline combination, not a workflow state. Scans inspect EPUBs only; PDF support has been removed and would need a separate design if revisited. Each scan walks only the enabled folders to detect additions/removals; the primary saved index is used to reuse extracted metadata for unchanged files (same resolved library root, relative path, size, and modified time). The completion notice reports how many files were reused versus inspected. Use **Rebuild index** to bypass the cache, or **Restore backup** to restore the previous index for the configured library root. Older indexes are reusable when they retain the supported schema and file metadata; restoring a backup is not required for normal reuse.

From a novel's Library view, select two or more existing EPUB files and choose **Create merged EPUB** to combine their saved chapter content offline. A progress panel shows the current source/document, chapter-combining counts, package compression, validation, and output-writing phases, with completed phases marked. The new EPUB is written to the configured output folder; the app does not move it to `Old`. If you want to use it as a source in a later combination, move it there yourself. Canceling the confirmation to replace an existing output is reported as a cancellation, not a merge failure, and leaves that file unchanged. Files are ordered by chapter range; overlapping chapter numbers are included once, preferring the lower-range file. Source EPUBs remain unchanged.

Recent EPUB jobs and per-chapter progress are stored locally. Running jobs can be cancelled, paused, and resumed, and unfinished jobs are restored when the app restarts. Completed chapter content and fetched covers are checkpointed locally so retries can reuse successful work. Failed, partial, or cancelled jobs can be repackaged offline when all selected chapter and cover artifacts are available; this path does not refresh discovery or make network requests.

Before a queued EPUB starts, its chapter list is refreshed when the saved discovery snapshot is older than the configurable interval (24 hours by default; change it in Configuration, from 1 to 720 hours). Chapter selections are matched by URL; newly discovered chapters remain unselected. If a selected chapter disappeared or the selected order changed, the job waits for review instead of fetching from the stale snapshot.

Browser-assisted mode opens visible Chromium for JavaScript-heavy sites and manual sign-in, consent, or verification. It does not automate or bypass CAPTCHA or access controls. Browser cookies remain in the local NovelTracker browser profile and are not shared with the HTTP client; browser-assisted discovery and chapter-page fallback use that profile. Use **Clear browser session** on the Prepare EPUB page to remove its cookies and site data.

Automated unit tests are deferred to a later phase; the current verification commands are typecheck and build.
