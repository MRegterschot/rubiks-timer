# CLAUDE.md

Rubik's cube timer web app: Node server (`server.js`) serving a static frontend in `public/` (`app.js`, `cube.js`, `algs.js`, `sw.js`).

## Workflow

- When an issue is solved, commit and push to the current branch, then open a PR against `main` with `gh pr create`.
- Reference the issue in the PR body (e.g. `Closes #N`).
- Only merge (`gh pr merge`) or close issues when the user explicitly asks.

## Checks

- Run `node --check <file>` on any JavaScript file you change.
