# Novel Tracker EPUB Companion

A Windows-first Electron + Vue desktop app for discovering chapters from one novel URL and building a text-first EPUB.

## Run locally

- Install Node.js 24 or later.
- Run `npm install`.
- Run `npx playwright install chromium` to install the browser used for manual verification.
- Run `npm run dev` to open the desktop app.

## Verify

- `npm run typecheck`
- `npm run build`

## Features

Enter a novel table-of-contents URL (or a direct chapter URL), review metadata and chapter order, choose an output folder, and create a text-first EPUB. The NovelFull parser reads all paginated chapter-list pages in order and ignores the “Latest chapters” sidebar. Chapter text is fetched only for selected chapters, with progress shown during discovery and EPUB creation.

The output filename is editable. If an EPUB with the same name already exists in the output folder, it is overwritten. The Library screen lets you configure a local library root, a read-only Novel Tracker CSV, and the EPUB output folder. Tracker rows can be searched and chosen without triggering network requests; discovery remains an explicit action.

Library scans are read-only and run in a worker so EPUB/PDF inspection does not block the app process. A blocking progress dialog prevents other interaction, shows discovered and indexed file counts, and allows cancellation until the index is saved. Scans recursively inspect `Completed`, `Downloaded`, `Sent`, and `Old`. EPUB metadata, covers, and chapter lists are indexed. Individual chapter PDFs use filename evidence; other PDFs are text-inspected for page count and chapter headings where possible. The Library list hides PDFs by default, with an opt-in toggle to include them. Per-novel coverage warnings show supporting files; only extracted or corrected chapter evidence is used by default, while shown individual PDFs can contribute lower-confidence filename evidence. Extracted chapter numbers outside a file's stated filename range are flagged and excluded from gap/overlap calculations until reviewed. Gaps are flagged as possible, not definitive; missing chapters at either end require a known source chapter list. File matching and chapter coverage corrections are stored locally. Rescans reuse unchanged-file results.

Recent EPUB jobs and per-chapter progress are stored locally. Running jobs can be cancelled, paused, and resumed, and unfinished jobs are restored when the app restarts.

Browser-assisted mode opens visible Chromium for JavaScript-heavy sites and manual sign-in, consent, or verification. It does not automate or bypass CAPTCHA or access controls. Browser cookies remain in the local NovelTracker browser profile and are not shared with the HTTP client; browser-assisted discovery and chapter-page fallback use that profile. Use **Clear browser session** on the Prepare EPUB page to remove its cookies and site data.

Automated unit tests are deferred to a later phase; the current verification commands are typecheck and build.
