#!/usr/bin/env bash
# Run RackForge (bot + miner) around the clock in tmux, as an alternative to the
# systemd units in deploy/.
#
#   scripts/rackforge.sh start      tmux session 'rackforge': window 'bot' and window 'miner'
#   scripts/rackforge.sh stop       graceful stop (SIGINT to both), then close the session
#   scripts/rackforge.sh restart
#   scripts/rackforge.sh status     what's running + npm run status
#   scripts/rackforge.sh logs [bot|miner|decisions]   follow a log
#   scripts/rackforge.sh attach     tmux attach -t rackforge
#
# Each window runs a restart loop with exponential backoff (2 s doubling to
# 5 min; reset after a run that lasted 10+ minutes). The bot exiting with 78
# means bad or missing credentials: the loop stops instead of hammering.
#
# Env passed through to the bot (RACKFORGE_* are named after the strategy's
# internal id, 'rackforge'): BOT_NAME BOT_TOKEN BOT_NONCE TOURNAMENT_ID
# STDB_HOST STDB_DB RACKFORGE_MARGIN_MS RACKFORGE_LOG_DIR RACKFORGE_BOT_NAME, plus
# RACKFORGE_BOT_ARGS (extra flags for npm run bot, e.g. "--agent starter") and
# RACKFORGE_MINER_ARGS (default "--follow"). They go through a mode-600 file
# (logs/.rackforge-env) that each restart sources, never through a command
# line, so a token can't show up in `ps`.

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION=rackforge
LOGS="${RACKFORGE_LOG_DIR:-$ROOT/logs}"
STOP_FILE="$LOGS/.rackforge-stop"
ENV_FILE="$LOGS/.rackforge-env"
PASS_VARS=(BOT_NAME BOT_TOKEN BOT_NONCE TOURNAMENT_ID STDB_HOST STDB_DB RACKFORGE_MARGIN_MS RACKFORGE_LOG_DIR RACKFORGE_BOT_NAME RACKFORGE_BOT_ARGS RACKFORGE_MINER_ARGS)

mkdir -p "$LOGS"

running() { tmux has-session -t "$SESSION" 2>/dev/null; }

# Snapshot this shell's settings for the windows: a tmux server started
# earlier would otherwise hand them its own, older environment.
write_env() {
  local v
  (umask 077; : > "$ENV_FILE")
  for v in "${PASS_VARS[@]}"; do
    if [ -n "${!v:-}" ]; then printf 'export %s=%q\n' "$v" "${!v}" >> "$ENV_FILE"; fi
  done
}

# loop <name> <command...>: run until the stop file appears.
loop() {
  local name="$1"; shift
  local delay=2 started rc
  local log="$LOGS/$name-stdout.log"
  while [ ! -e "$STOP_FILE" ]; do
    # shellcheck disable=SC1090
    [ -f "$ENV_FILE" ] && . "$ENV_FILE"
    started=$(date +%s)
    echo "=== $(date -u +%FT%TZ) starting $name: $*" | tee -a "$log"
    # tee ignores the ctrl-c meant for the bot, so its last lines still land.
    "$@" 2>&1 | tee -ai "$log"
    rc=${PIPESTATUS[0]}
    echo "=== $(date -u +%FT%TZ) $name exited with $rc" | tee -a "$log"
    [ -e "$STOP_FILE" ] && break
    if [ "$name" = bot ] && [ "$rc" -eq 78 ]; then
      echo "=== $name: credentials missing or rejected; not restarting (fix BOT_TOKEN/BOT_NONCE, then: scripts/rackforge.sh restart)" | tee -a "$log"
      break
    fi
    if [ $(( $(date +%s) - started )) -ge 600 ]; then delay=2; fi
    echo "=== restarting $name in ${delay}s" | tee -a "$log"
    sleep "$delay"
    delay=$(( delay * 2 )); [ "$delay" -gt 300 ] && delay=300
  done
  echo "=== $name loop finished; window stays open (ctrl-d to close)"
  exec bash
}

cmd_start() {
  if running; then echo "already running (tmux session '$SESSION'); try: $0 status"; return 0; fi
  rm -f "$STOP_FILE"
  write_env
  tmux new-session -d -s "$SESSION" -n bot -c "$ROOT" "bash '$ROOT/scripts/rackforge.sh' _loop-bot"
  tmux new-window -t "$SESSION" -n miner -c "$ROOT" "bash '$ROOT/scripts/rackforge.sh' _loop-miner"
  echo "started tmux session '$SESSION' (windows: bot, miner). Attach: tmux attach -t $SESSION"
}

cmd_stop() {
  if ! running; then echo "not running"; rm -f "$STOP_FILE"; return 0; fi
  touch "$STOP_FILE"
  local w
  for w in bot miner; do tmux send-keys -t "$SESSION:$w" C-c 2>/dev/null || true; done
  # The bot flushes its logs and disconnects on SIGINT; give it a moment.
  for _ in $(seq 1 20); do
    sleep 0.5
    if ! pgrep -f "src/bot.ts" >/dev/null && ! pgrep -f "src/memory/mine.ts" >/dev/null; then break; fi
  done
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -f "$STOP_FILE"
  echo "stopped"
}

cmd_status() {
  if running; then
    echo "tmux session '$SESSION' is running:"
    tmux list-windows -t "$SESSION" -F '  #{window_name}: #{pane_current_command} (pid #{pane_pid})'
  else
    echo "tmux session '$SESSION' is not running"
  fi
  echo
  (cd "$ROOT" && npm run --silent status)
}

cmd_logs() {
  case "${1:-bot}" in
    bot|miner) tail -n 100 -F "$LOGS/${1:-bot}-stdout.log" ;;
    decisions) tail -n 20 -F "$LOGS/decisions-$(date -u +%F).jsonl" ;;
    *) echo "usage: $0 logs [bot|miner|decisions]"; exit 2 ;;
  esac
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) cmd_logs "${2:-bot}" ;;
  attach) exec tmux attach -t "$SESSION" ;;
  _loop-bot)
    # shellcheck disable=SC1090
    [ -f "$ENV_FILE" ] && . "$ENV_FILE"
    # shellcheck disable=SC2086
    cd "$ROOT" && loop bot npm run --silent bot -- ${RACKFORGE_BOT_ARGS:-} ;;
  _loop-miner)
    # shellcheck disable=SC1090
    [ -f "$ENV_FILE" ] && . "$ENV_FILE"
    # shellcheck disable=SC2086
    cd "$ROOT" && loop miner npm run --silent mine -- ${RACKFORGE_MINER_ARGS:---follow} ;;
  *) sed -n '2,23p' "$0"; exit 2 ;;
esac
