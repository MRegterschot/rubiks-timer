# Rubik's Cube Timer

A zero-dependency solve timer with WCA-style hold-to-start, inspection, scrambles, and stats (best, ao5/12/100, mean). Solves are stored in SQLite via `node:sqlite`.

## Run locally

Requires Node 24+.

```sh
node server.js          # http://localhost:3000
```

Env vars: `PORT` (default 3000), `DB_PATH` (default `./data/solves.db`), `DAILY_TZ` (day boundary for the daily scramble, default `Europe/Amsterdam`).

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

The timer, trainer and BLD tools work without an account; guest solves are kept in memory only (gone on reload). Logging in or signing up from the form saves that visit's solves and the guest's daily attempt to the account. Everyone with an account sees only their own solves. A login stays valid for a year on each device, and is renewed when used.

- Anyone can sign up; no invite code is needed.
- **Account → Password & recovery** changes the password (logs out other devices) and creates a one-time recovery code. With that code, "Forgot password?" on the login screen resets the password without an admin.
- Forgotten password and no recovery code (an admin runs this on the server):
  `docker exec <container> node reset-password.js <username> <new-password>`

## Leaderboard

The **Leaderboard** tab ranks everyone by best single, ao5 and ao12 for 3×3, and by best single, mo3 and success rate for blindfolded. All solves and usernames are public: clicking a name shows that person's full solve history. The data is also available without logging in at `GET /api/leaderboard?mode=333|bld` and `GET /api/users/<name>/solves?mode=333|bld`.

## Features

- **Cube sizes**: 2×2 to 7×7 tabs, each with its own page (`#2x2`, `#4x4`, `#5x5`, `#6x6`, `#7x7`; 3×3 is the default page) and its own solve history (modes `222`, `444`, `555`, `666`, `777`). 2×2 uses a short random-move scramble, 4×4 and up use wide-layer turns (`Rw`, `3Rw`). Inspection and stats work as on 3×3. The move viewer, daily scramble, races and leaderboard are 3×3 only.

- **Sessions**: solves are grouped automatically; a new session starts after an hour without solves. Each session gets its own stats, and the solve list shows dividers.
- **Blindfolded memo check**: `public/cube.js` simulates the cube. It checks your memo against the scramble (Old Pochmann, Speffz, buffers UR (U sticker) and ULB (L sticker); any valid cycle break counts as correct) and can show the solution. Past BLD solves show whether the memo was right.
- **Trainer** tab: 2-look OLL (edges, then corners), 2-look PLL (corners, then edges), full OLL and full PLL drills. You get a face-turn setup, solve the case, and per-case times are tracked. Slow and new cases come up more often. Attempts are stored as solves with mode `oll2`/`pll2`/`oll`/`pll` and a `case_id`. Algs are in `public/algs.js`.
- **Daily scramble**: one shared scramble per day, one attempt each. Others' times show once you've done yours. Guests can play too: their attempt is kept on their device only (not on the leaderboard), via the public `GET /api/daily` (`?done=1` reveals times).
- **Races**: create a race, share the `#race=CODE` link; everyone gets the same scramble.
- **Installable / offline**: PWA manifest + service worker. Offline, the app opens with the last known account and solves, and queues new solves until the server is back.

Challenge API (logged in): `GET /api/daily`, `GET|POST /api/races`, `GET /api/challenges/:code`, `POST /api/challenges/:code/join`, `POST|PATCH /api/challenges/:code/result`.
