# Novel Tracker EPUB Companion

A Windows-first Electron + Vue desktop app for discovering chapters from one novel URL and building a text-first EPUB.

## Run locally

- Install Node.js 24 or later.
- Run `npm install`.
- Run `npm run dev` to open the desktop app.

## Verify

- `npm run typecheck`
- `npm run build`

## Features

Enter a novel table-of-contents URL (or a direct chapter URL), review metadata and chapter order, choose an output folder, and create a text-first EPUB. The NovelFull parser reads all paginated chapter-list pages in order and ignores the “Latest chapters” sidebar. Chapter text is fetched only for selected chapters, with progress shown during discovery and EPUB creation.

The output filename is editable. If an EPUB with the same name already exists in the output folder, it is overwritten. The Library screen lets you configure a local library root, a read-only Novel Tracker CSV, and the EPUB output folder. Tracker rows can be searched and chosen without triggering network requests; discovery remains an explicit action.

Library scans are read-only and run in a worker so EPUB/PDF inspection does not block the app process. A blocking progress dialog prevents other interaction, shows discovered and indexed file counts, and allows cancellation until the index is saved. Scans recursively inspect `Completed`, `Downloaded`, `Sent`, and `Old`. EPUB metadata, covers, and chapter lists are indexed. Individual chapter PDFs use filename evidence; other PDFs are text-inspected for page count and chapter headings where possible. File matching and chapter coverage corrections are stored locally. Rescans reuse unchanged-file results.

Recent EPUB jobs and per-chapter progress are stored locally. A running job can be cancelled, and unfinished jobs are marked interrupted if the app closes. Pause and resume are not implemented yet.

Automated unit tests are deferred to a later phase; the current verification commands are typecheck and build.
