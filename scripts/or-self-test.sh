#!/usr/bin/env bash
# Self-test for the OR backend, bypassing Telegram.
#
# Spawns the actual nanoclaw-agent container with the same env + mounts
# the orchestrator would, feeds a minimal ContainerInput JSON via stdin,
# captures stdout + stderr. Lets us iterate on the OR integration
# without bothering the user.
#
# Usage:
#   bash scripts/or-self-test.sh                 # default prompt
#   bash scripts/or-self-test.sh "your prompt"
#
# Requires: nanoclaw-agent:latest built, credential proxy on port 3011
# already running (LLM_BACKEND=openrouter in reserve .env).

set -u

PROJECT_ROOT="C:\\Users\\george\\reserve-nanoclaw"
GROUP_FOLDER="telegram_main"
CHAT_JID="tg:434532334"

PROMPT="${1:-Say only the word ok. No tools, no thinking.}"
CONTAINER_NAME="nanoclaw-${GROUP_FOLDER}-selftest-$(date +%s%3N)"
LOG_FILE="data/selftest-$(date +%Y%m%d-%H%M%S).log"

# Build the same ContainerInput agent-runner expects from stdin.
INPUT_JSON=$(cat <<EOF
{
  "prompt": $(printf '%s' "$PROMPT" | node -e "console.log(JSON.stringify(require('fs').readFileSync(0,'utf-8')))"),
  "groupFolder": "${GROUP_FOLDER}",
  "chatJid": "${CHAT_JID}",
  "isMain": true,
  "assistantName": "Andy"
}
EOF
)

echo "=== or-self-test ===" | tee "$LOG_FILE"
echo "container: $CONTAINER_NAME" | tee -a "$LOG_FILE"
echo "prompt:    $PROMPT" | tee -a "$LOG_FILE"
echo "log:       $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# Mirror what container-runner.ts builds for a main-group telegram_main
# turn. Trimmed to what's actually needed for an SDK call.
MSYS_NO_PATHCONV=1 docker run --rm -i \
  --name "$CONTAINER_NAME" \
  -e TZ=Europe/Moscow \
  -e NANOCLAW_TRUST_LEVEL=main \
  -e LLM_BACKEND="${LLM_BACKEND:-openrouter}" \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:3011 \
  -e ANTHROPIC_API_KEY=placeholder \
  -e ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-$(grep -E '^ANTHROPIC_DEFAULT_HAIKU_MODEL=' .env | cut -d= -f2-)}" \
  -e ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-$(grep -E '^ANTHROPIC_DEFAULT_SONNET_MODEL=' .env | cut -d= -f2-)}" \
  -e ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-$(grep -E '^ANTHROPIC_DEFAULT_OPUS_MODEL=' .env | cut -d= -f2-)}" \
  -e CLAUDE_CODE_SUBAGENT_MODEL="${CLAUDE_CODE_SUBAGENT_MODEL:-$(grep -E '^CLAUDE_CODE_SUBAGENT_MODEL=' .env | cut -d= -f2-)}" \
  -e NANOCLAW_MODEL_PRIORITY="${NANOCLAW_MODEL_PRIORITY:-$(grep -E '^NANOCLAW_MODEL_PRIORITY=' .env | cut -d= -f2-)}" \
  -v "${PROJECT_ROOT}:/workspace/project:ro" \
  -v "/dev/null:/workspace/project/.env:ro" \
  -v "${PROJECT_ROOT}\\store:/workspace/project/store" \
  -v "${PROJECT_ROOT}\\groups\\${GROUP_FOLDER}:/workspace/group" \
  -v "${PROJECT_ROOT}\\groups\\global:/workspace/global" \
  -v "${PROJECT_ROOT}\\data\\sessions\\${GROUP_FOLDER}\\.claude:/home/node/.claude" \
  -v "${PROJECT_ROOT}\\data\\ipc\\${GROUP_FOLDER}:/workspace/ipc" \
  -v "${PROJECT_ROOT}\\data\\sessions\\${GROUP_FOLDER}\\agent-runner-src:/app/src" \
  nanoclaw-agent:latest <<< "$INPUT_JSON" 2>&1 | tee -a "$LOG_FILE"

EXIT=${PIPESTATUS[0]}
echo "" | tee -a "$LOG_FILE"
echo "=== container exited with code $EXIT ===" | tee -a "$LOG_FILE"

# Parse the OUTPUT markers for a quick summary.
RESULT=$(grep -A1 NANOCLAW_OUTPUT_START "$LOG_FILE" | head -2 | tail -1)
if [ -n "$RESULT" ]; then
  echo ""
  echo "=== parsed output ==="
  echo "$RESULT" | head -c 600
  echo ""
fi
