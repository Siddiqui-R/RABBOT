# Rabee-RackForge

ScrabbleBot entry: bot 343, team 337. Registered for tournament 2.

## Run

Requires Node.js 22.5 or newer.

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Bot.ps1
```

The default launcher waits for tournaments. Keep the computer awake and online.
Run only one process for this bot. Credentials stay in `.token-Rabee-RackForge`.

The launcher sets `BOT_NAME=Rabee-RackForge` and `TOURNAMENT_ID=2`, then runs `npm start`.

Credentials and the local opponent-history database are not included in this repository.
For a fresh installation, obtain your own bot token from the ScrabbleBot team page
and set `BOT_TOKEN` locally before starting. Set `BOT_NAME` to your registered bot
name and `TOURNAMENT_ID` to the intended tournament when using `npm start` directly.

```powershell
npm ci
$env:BOT_NAME = 'YourRegisteredBotName'
$env:TOURNAMENT_ID = '2'
# Set BOT_TOKEN locally to your own token, then:
npm start
```

To fit opponent models from recent public matches:

```powershell
npm run mine -- --recent 1000 --no-backend
```

For ladder play, add `-Ladder`. For a specific tournament, add `-TournamentId 2`.

## Check

```powershell
npm run typecheck
npm test
```
