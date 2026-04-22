## Sportsbook Feed

Local odds viewer and feed playground for sportsbook market data.

## What It Does

- Fetches source data with `fetch-odds.js`
- Builds a provider-style feed in `lib/provider-feed.js`
- Serves the UI from `server.js`
- Streams updates to the browser with Server-Sent Events
- Persists the latest warm snapshot to `odds.json`

## Run The Server

Start the local server:

```powershell
node .\server.js
```

Use another port:

```powershell
node .\server.js --port 8080
```

Set the port via environment variable:

```powershell
$env:PORT=8080
node .\server.js
```

Adjust the refresh interval in seconds:

```powershell
node .\server.js --interval 60
```

The server serves `sportsbook.html` at the local URL it prints on startup.

## Common Fetch Examples

Fetch one league into a JSON snapshot:

```powershell
node .\fetch-odds.js --source p4578 --p4578-sport-id 29 --p4578-league-code brazil-serie-a --out .\odds.json
```

Fetch expanded p4578 events:

```powershell
node .\server.js --source p4578 --p4578-fetch-events --p4578-max-leagues 12
```

Fetch a specific event:

```powershell
node .\fetch-odds.js --source p4578 --p4578-event-id 123456 --out .\odds.json
```

Show all CLI options:

```powershell
node .\fetch-odds.js --help
```

## Useful Endpoints

- `GET /` serves the UI
- `GET /snapshot` returns the latest cached snapshot
- `GET /events` streams live updates over SSE
- `POST /refresh` triggers an immediate refresh
- `GET /debug` returns a source summary for inspection
- `GET /manual-odds`, `GET /feed-settings`, and `GET /market-state` expose local state files

## Notes

- The server defaults to `p4578` unless you explicitly pass another source.
- Tipsport is currently muted in `fetch-odds.js`.
- `odds.json` is used as a warm cache written by the server, not as the primary live transport to the browser.
- Open the app through the local server rather than directly from disk.
