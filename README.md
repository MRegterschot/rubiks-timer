# Rubik's Cube Timer

A zero-dependency solve timer with WCA-style hold-to-start, inspection, scrambles, and stats (best, ao5/12/100, mean). Solves are stored in SQLite via `node:sqlite`.

## Run locally

Requires Node 24+.

```sh
node server.js          # http://localhost:3000
```

Env vars: `PORT` (default 3000), `DB_PATH` (default `./data/solves.db`).

## Docker

```sh
docker compose up -d --build
```

The service only `expose`s port 3000 (no host port); put a reverse proxy in front. Data lives in the `rubiks-data` volume.

## API

`GET /api/solves`, `POST /api/solves`, `PATCH /api/solves/:id`, `DELETE /api/solves/:id`, `DELETE /api/solves`, `GET /health`.

## Deployment

Pushes to `main` auto-deploy via a GitHub webhook to Coolify, served at https://rubiks.dikkeboktor.nl.

## Accounts

Everyone has their own account and sees only their own solves. A login stays valid for a year on each device, and is renewed when used.

- Signing up requires an invite: either a personal invite link, or the shared `INVITE_CODE` env var (in Coolify). If `INVITE_CODE` is empty and no invite is given, anyone can sign up.
- Logged-in users create personal invite links via **Account → Invite friends**. Each link works once and expires after 7 days. A user can have at most 5 unused invites.
- Forgotten password (an admin runs this on the server):
  `docker exec <container> node reset-password.js <username> <new-password>`

## Leaderboard

The **Leaderboard** tab ranks everyone by best single, ao5 and ao12 for 3×3, and by best single, mo3 and success rate for blindfolded. All solves and usernames are public: clicking a name shows that person's full solve history. The data is also available without logging in at `GET /api/leaderboard?mode=333|bld` and `GET /api/users/<name>/solves?mode=333|bld`.
