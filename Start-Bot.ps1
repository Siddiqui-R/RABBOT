param(
    [switch]$Ladder,
    [string]$TournamentId = '3'
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:BOT_NAME = 'RABBOT'
$env:RABBOT_TELEMETRY = '0'
$env:RABBOT_AUTO_TOURNAMENT = '0'
$env:RABBOT_NO_LADDER = if ($Ladder) { '0' } else { '1' }
if ($TournamentId) { $env:TOURNAMENT_ID = $TournamentId }
if (-not (Test-Path -LiteralPath 'node_modules/tsx')) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
}
if (-not $env:BOT_TOKEN -and -not $env:BOT_NONCE -and -not (Test-Path -LiteralPath ".token-$($env:BOT_NAME)")) {
    throw 'Set BOT_TOKEN to your team bot token, or BOT_NONCE to a new credential nonce, then run again.'
}
& npm.cmd start
exit $LASTEXITCODE
