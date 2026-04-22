## Odds UI

Generate the data file:

```powershell
node .\fetch-odds.js --p4578-sport-id 29 --p4578-league-code brazil-serie-a --out .\odds.json
```

Start the local server in this folder:

```powershell
node .\server.js
```

Use another port if needed:

```powershell
node .\server.js --port 8080
```

Or via environment variable:

```powershell
$env:PORT=8080
node .\server.js
```

Regenerate `odds.json` automatically every 60 seconds:

```powershell
node .\auto-refresh-odds.js --interval 60 --p4578-sport-id 29 --p4578-fetch-events --p4578-max-leagues 12 --out .\odds.json
```

Open the local URL shown by the server.

Notes:

- Tipsport is read from the HAR by default.
- `p4578` is fetched live.
- The page reads `./odds.json`, so it should be served over HTTP instead of opened directly from disk.
