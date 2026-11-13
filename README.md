# Novel Tracker EPUB Companion

A Windows-first Electron + Vue desktop app for discovering chapters from one novel URL and building a text-first EPUB.

## Run locally

- Install Node.js 24 or later.
- Run `npm install`.
- Run `npx playwright install chromium` to install the browser used for manual verification.
- Run `npm run dev` to open the desktop app.

## Package for Windows

- Run `npm run package:win` on Windows to build the app and create an unsigned NSIS setup installer in `release/`.
- The packaging command installs the matching Playwright Chromium build into a temporary local folder and bundles it, so users do not need Node.js or a separate browser install. The first run requires internet access to download Chromium.
- The installer is per-user by default, creates Start Menu and desktop shortcuts, lets the user choose the install folder, and preserves local app data when uninstalled. Code signing is not configured.

## Verify

- `npm run typecheck`
- `npm run lint`
- `npm run build`

## Features

Enter a novel table-of-contents URL (or a direct chapter URL), review metadata and chapter order, choose an output folder, and create a text-first EPUB. The NovelFull parser reads all paginated chapter-list pages in order and ignores the “Latest chapters” sidebar. Chapter text is fetched only for selected chapters, with progress shown during discovery and EPUB creation.

The output filename is editable. If an EPUB with the same name already exists in the output folder, it is overwritten. The Configuration page lets you set the local library root, read-only Novel Tracker CSV, EPUB output folder, app theme, download concurrency, chapter-list refresh interval, and EPUB stylesheet. The Library page directs you to Configuration to set the historical library root before scanning. Tracker rows can be searched and chosen without triggering network requests; discovery remains an explicit action.

Library scans are read-only and run in a worker so EPUB inspection does not block the app process. A blocking progress dialog prevents other interaction, shows discovered and indexed file counts, and allows cancellation until the index is saved. In Configuration, **Scan the Old folder** and **Scan the Old Completed folder** are separate opt-ins and default off. The app scans `Old` for archived EPUB volumes selected for offline combination and scans the sibling `Old Completed` folder for previously completed EPUBs; neither folder is a workflow state. Scans inspect EPUB metadata and chapter lists; AZW3 files are indexed by filename and file metadata only, without reading their contents or chapters. PDF support has been removed and would need a separate design if revisited. Each scan walks only the enabled folders to detect additions/removals; the primary saved index is used to reuse extracted metadata for unchanged files (same resolved library root, relative path, size, and modified time). The completion notice reports how many files were reused versus inspected. Use **Rebuild index** to bypass the cache, or **Restore backup** to restore the previous index for the configured library root. Older indexes are reusable when they retain the supported schema and file metadata; restoring a backup is not required for normal reuse.

From a novel's Library view, select two or more existing EPUB files and choose **Create merged EPUB** to combine their saved chapter content offline. A progress panel shows the current source/document, chapter-combining counts, package compression, validation, and output-writing phases, with completed phases marked. The new EPUB is written to the configured output folder; the app does not move it to `Old`. If you want to use it as a source in a later combination, move it there yourself. Canceling the confirmation to replace an existing output is reported as a cancellation, not a merge failure, and leaves that file unchanged. Files are ordered by chapter range; overlapping chapter numbers are included once, preferring the lower-range file. Source EPUBs remain unchanged.

EPUBs created from downloads or merged from existing volumes convert WebP images to JPEG before packaging, since Kindle Previewer does not support WebP book images. Covers below Kindle's 625×1000-pixel minimum are enlarged onto a 1000×1600-pixel canvas; this meets the size check but cannot restore detail missing from the source image.

Select an indexed EPUB in the Library to **Check / repair** it without a file picker. A repaired copy is saved beside the source with `-repaired` added to its filename. The repair checks ZIP structure and the EPUB container/package, converts embedded WebP images to JPEG, enlarges undersized covers onto a 1000×1600-pixel canvas, updates image references and cover metadata, and writes the EPUB mimetype entry first and uncompressed. Small covers may look soft after enlargement. The original file is left unchanged. This repairs those known issues but cannot guarantee that every EPUB will be accepted by Kindle Previewer or Amazon.

The Library page can convert an indexed or just-merged EPUB to AZW3 for local sideloading; completed EPUB jobs also have a conversion action in recent job history. To convert back, select an indexed AZW3 in the Library and choose **Convert to EPUB**; the result is saved beside it with the same base filename and `.epub` extension. These optional features require Calibre installed with `ebook-convert` available on `PATH` (or in the standard Windows Calibre installation folder). Conversions run locally and preserve the source. EPUB-to-AZW3 lets you choose its output destination; AZW3-to-EPUB saves beside its source. Existing sibling outputs require confirmation before replacement, and newly created files appear in the index after a rescan. Calibre may alter formatting, so review converted books in Kindle Previewer; EPUB structural validation and successful conversion do not guarantee Amazon Send-to-Kindle acceptance. Merge and conversion status and recent history remain visible across app pages and are saved locally, including failures and operations interrupted by closing the app.

Recent EPUB jobs and per-chapter progress are stored locally. On the Queue page, filter jobs by one or more statuses or group them by status; these view preferences are saved and restored when the app reopens. Running jobs can be cancelled, paused, and resumed, and unfinished jobs are restored when the app restarts. Completed chapter content and fetched covers are checkpointed locally so retries can reuse successful work. Failed, partial, or cancelled jobs can be repackaged offline when all selected chapter and cover artifacts are available; this path does not refresh discovery or make network requests.

The main process writes structured JSON-line logs locally under the Electron user-data directory in `logs/novel-tracker.log`, rotating up to three older log files at 5 MB each. Authorization, cookie, token, password, and API-key values are redacted before output or file logging. Logs are not uploaded.

Before a queued EPUB starts, its chapter list is refreshed when the saved discovery snapshot is older than the configurable interval (24 hours by default; change it in Configuration, from 1 to 720 hours). Chapter selections are matched by URL; newly discovered chapters remain unselected. If a selected chapter disappeared or the selected order changed, the job waits for review instead of fetching from the stale snapshot.

Browser-assisted mode opens visible Chromium for JavaScript-heavy sites and manual sign-in, consent, or verification. It does not automate or bypass CAPTCHA or access controls. Browser cookies remain in the local NovelTracker browser profile and are not shared with the HTTP client; browser-assisted discovery and chapter-page fallback use that profile. Use **Clear browser session** on the Prepare EPUB page to remove its cookies and site data.

Automated unit tests are deferred to a later phase; the current verification commands are typecheck and build.
