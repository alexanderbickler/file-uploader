# Security

File Uploader is designed as a **single-user tool for a trusted PC**. Read this before exposing it to anything else.

## What it protects against

- **Network exposure by default** – it listens on `127.0.0.1` only, and rejects requests whose `Host` is not `localhost`/`127.0.0.1`/`[::1]` (blocks DNS-rebinding).
- **Cross-site requests** – state-changing requests with a foreign `Origin` or `Sec-Fetch-Site` are rejected.
- **Path traversal** – file and folder names are sanitised (`../`, drive letters, reserved Windows names, control characters); every path is built from database folder rows, never from raw user input.
- **Hostile uploads** – downloads are sent with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`; only PDFs, common images and `.txt` may be displayed in the browser, everything else (including HTML and SVG) is forced to download.
- **Half-written files** – uploads are streamed to a temp file and moved into place atomically.

## What it does *not* provide

- **No authentication or accounts.** Anyone who can reach the port can read, upload, rename and delete everything. This is why `LAN=1` / `start-lan.bat` is opt-in and should only be used on a trusted network.
- **No encryption** – traffic is plain HTTP and files are stored unencrypted on disk.
- **No virus scanning** of uploaded files.
- **No Recycle Bin / undo** – deleting a document deletes it from disk.
- **No audit log** of who did what.

## Recommendations

- Keep it on `localhost` unless you need phone access, and stop it when you are done.
- Do not port-forward it or put it on the public internet. If you need remote access, put it behind a VPN or an authenticating reverse proxy.
- Keep the `library/` folder in your normal backup routine.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (**Security → Report a vulnerability**) rather than a public issue.
