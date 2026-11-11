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

The output filename is editable. Existing files are never overwritten; a numbered copy is created if the name is already in use. CSV import, archive/PDF indexing, images, browser-assisted fetching, queue persistence, and restart recovery are not included yet.

Automated unit tests are deferred to a later phase; the current verification commands are typecheck and build.
