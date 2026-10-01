# Contributing

Thanks for helping improve File Uploader! This is a small project; the aim is to keep it simple, dependency-free and easy to read.

## Set up

1. Install Node.js 22.5+ (`node --version`).
2. Fork and clone the repo.
3. `npm start` and open <http://localhost:3000>.
4. `npm test` before every commit.

There is no build step and no `npm install` – please keep it that way unless a dependency is clearly worth it.

## Guidelines

- **Server** (`server.js`): all paths on disk must be derived from database folder rows plus a name passed through `cleanName()`. Never join raw request input into a path.
- **Front end** (`public/`): build DOM with the `h()` helper or `textContent`; never insert file or folder names with `innerHTML`.
- **Styling**: colours and fonts come from `public/theme.css` tokens. Do not hard-code colours in `styles.css`.
- **Responsive**: check changes at ~375 px width (phone) and desktop.
- **Tests**: add a case to `test/smoke.test.mjs` for new API behaviour.
- **Commits**: short imperative subject line (“Add folder size column”), one logical change each.

## Pull requests

1. Branch from `main`.
2. Describe *what* changed and *why*, and how you tested it (screenshots help for UI changes).
3. Make sure `npm test` passes – CI runs it on every pull request.

## Reporting bugs / requesting features

Open a GitHub issue with your Node version, OS, steps to reproduce, and what you expected. For security problems see [SECURITY.md](SECURITY.md).
