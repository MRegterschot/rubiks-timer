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
