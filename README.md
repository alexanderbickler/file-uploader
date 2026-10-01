# File Uploader

A small, private document library that runs on your own PC. Upload documents through a web page, see their **name, upload date, size and type** at a glance, and organise them into folders. Folders you create in the app are **real folders on your disk**, so your files stay in a normal, backup-friendly structure.

- **Local-first** – everything is stored on your machine. No cloud, no account, no telemetry.
- **Real folders** – create, rename, move and delete folders in the app and the same change happens on disk.
- **Local database** – a SQLite index (`data/library.db`) makes listing, sorting and searching instant.
- **Mobile responsive** – tables become cards on a phone; the folder tree becomes a slide-in drawer.
- **Themeable** – all colours and fonts live in one file, [`public/theme.css`](public/theme.css).
- **Zero dependencies** – plain Node.js; nothing to `npm install`.

📖 Project page: `https://<your-account>.github.io/file-uploader/` *(see [Publishing the project page](#publishing-the-project-page))*

## Requirements

- **Node.js 22.5 or newer** (24 recommended). Check with `node --version`.
- Windows, macOS or Linux. (The “Open in Explorer” buttons are Windows-only.)

## Quick start

```bash
git clone https://github.com/<your-account>/file-uploader.git
cd file-uploader
npm start
```

Then open <http://localhost:3000>. On Windows you can instead double-click **`start.bat`**, which also opens your browser.

Your files appear in the `library/` folder next to the app (created on first run).

## Using the app

| I want to… | Do this |
|---|---|
| Upload documents | Click **Upload**, or drag files anywhere onto the page. Multiple files are fine; progress is shown. |
| See name / date / size / type | They are the four columns of the table. Click a column heading to sort. |
| Create a subfolder | Select the parent folder in the left tree, then **New folder**. |
| Rename or move a folder | Select it, then **Rename** or **Move**. The folder is renamed/moved on disk too. |
| Move a document | **Move** on its row, then choose a destination folder. |
| Find a document | Type in the search box. It searches *every* folder by file name. |
| Open the folder in Windows | **Open in Explorer** (folder) or **Show** (file). |
| Pick up files you added in Explorer | **Rescan disk** (also runs automatically at start-up). |

Rules worth knowing:

- **Duplicate names are never overwritten.** Uploading `report.pdf` twice gives `report.pdf` and `report (1).pdf`.
- **Folders must be empty to delete.** This is deliberate protection against accidents.
- **Deleting a document deletes the file from disk** (it does not go to the Recycle Bin).
- File names are cleaned for Windows: characters like `: * ? " < > |` become `_`, and reserved names like `CON` get a `_` prefix.

## Using it from your phone

By default the app only listens on your PC. To use it from a phone on the same Wi-Fi, run **`start-lan.bat`** (or `LAN=1 npm start`) and browse to `http://<your-pc-ip>:3000`.

> ⚠️ **There is no login.** In LAN mode anyone on your network can read, upload and delete files. Only use it on a network you trust, and stop the app when you are done. See [SECURITY.md](SECURITY.md).

## Configuration

Set these as environment variables before starting.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on. |
| `LIBRARY_DIR` | `./library` | Where documents are stored. Point this at e.g. `D:\Documents\Library`. |
| `DATA_DIR` | `./data` | Where the SQLite index lives. |
| `MAX_UPLOAD_MB` | `2048` | Largest single upload. |
| `LAN` | off | Set to `1` to listen on all network interfaces. |

PowerShell example:

```powershell
$env:LIBRARY_DIR = "D:\Documents\Library"; npm start
```

## Changing the look (themes)

Colours and fonts are defined as CSS variables in [`public/theme.css`](public/theme.css). The brand tokens at the top come from a sample corporate theme; the `--app-*` aliases at the bottom are what the app actually uses. To re-skin, change the token values (or the aliases) — you should not need to touch `styles.css`. A dark-mode block follows the operating system setting; delete it to stay light-only.

## How it works

```
Browser (public/)  ──HTTP/JSON──▶  server.js  ──▶  library/   real files and folders
                                       └────────▶  data/library.db   SQLite index
```

- Files are streamed to a temporary file and then atomically moved into place, so an interrupted upload never leaves a half-written document.
- The database stores each document's name, folder, size, type and upload time. The folder tree is stored as parent/child rows; paths are computed, so renaming a folder is one `rename` on disk.
- On start-up (and on **Rescan**) the database is reconciled with the disk: new files are indexed, vanished files are dropped.

### API (for scripting)

| Method & path | Purpose |
|---|---|
| `GET /api/folders` | All folders with file counts |
| `POST /api/folders` `{parentId,name}` | Create folder |
| `PATCH /api/folders/:id` `{name?,parentId?}` | Rename / move folder |
| `DELETE /api/folders/:id` | Delete an empty folder |
| `GET /api/files?folderId=&q=&sort=&dir=` | List or search documents |
| `PUT /api/files?folderId=&name=` (raw body) | Upload one file |
| `PATCH /api/files/:id` `{name?,folderId?}` | Rename / move document |
| `DELETE /api/files/:id` | Delete document |
| `GET /api/files/:id/download[?inline=1]` | Download / view |
| `POST /api/rescan` | Reconcile database with disk |

## Development

```bash
npm test      # boots the real server against a temp folder and checks the main flows
```

Project layout:

```
server.js        HTTP server, SQLite index, file operations
public/          index.html, styles.css, theme.css, app.js (no build step)
test/            smoke tests (node:test)
docs/            GitHub Pages project site
start.bat        Windows launcher (this PC only)
start-lan.bat    Windows launcher (phone/tablet on the same network)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to propose changes.

## Backups

Back up the `library/` folder **and** `data/library.db`. If you lose only the database, run **Rescan disk** – documents are re-indexed from the folders (original upload dates are replaced by file dates).

## Publishing the project page

The `docs/` folder is a ready-made GitHub Pages site. In the GitHub repo go to **Settings → Pages**, choose **Deploy from a branch**, branch `main`, folder `/docs`.

## License

[MIT](LICENSE)
