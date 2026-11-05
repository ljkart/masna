#!/usr/bin/env bash
# Tests the Claude Code behaviour Masna depends on, in a throwaway project.
# It makes real model calls, so it's run by hand, not in CI.
#
#   test/spikes/run.sh <agents|exec|serve|serve-sandbox> <empty output folder>
set -u

scenario=${1:?scenario: agents, exec, serve or serve-sandbox}
project=${2:?output folder}
here=$(cd "$(dirname "$0")" && pwd)
chmod +x "$here"/probe-plugin/bin/*

mkdir -p "$project"
cd "$project" || exit 1
git init -q
echo before > edit-me.txt
cat > nb.ipynb <<'JSON'
{"cells":[{"cell_type":"code","execution_count":null,"metadata":{},"outputs":[],"source":["print(0)"]}],"metadata":{},"nbformat":4,"nbformat_minor":5}
JSON

sandbox=false
[ "$scenario" = serve-sandbox ] && sandbox=true

# Passed with --settings because Claude Code ignores a project's allow rules
# until that folder has been trusted, and a throwaway folder never has been.
cat > probe-settings.json <<JSON
{
  "sandbox": { "enabled": $sandbox },
  "permissions": {
    "allow": [
      "Agent",
      "Read",
      "Write",
      "Edit",
      "NotebookEdit",
      "Bash(probe-bin)",
      "Bash(probe-slow)",
      "Bash(probe-serve)",
      "Bash(echo *)",
      "mcp__plugin_probe_probe__echo"
    ]
  }
}
JSON

case "$scenario" in
  agents)
    prompt='Use the Agent tool twice in one message, both with run_in_background true: start agent type probe:worker with model haiku and prompt "Run your checklist.", and start agent type probe:doomed with prompt "Go.". Wait for both to end, then use Write to create main-done.txt saying how each one ended.' ;;
  exec)
    prompt='Use Bash with run_in_background true to run probe-slow. End your turn without waiting or polling. When you are told it has exited, use Write to create woke.txt containing the word woke.' ;;
  serve|serve-sandbox)
    prompt='Use Bash to run probe-serve, then reply with its output.' ;;
  *)
    echo "unknown scenario: $scenario" >&2
    exit 2 ;;
esac

env -u CLAUDECODE ENABLE_CLAUDEAI_MCP_SERVERS=false claude -p "$prompt" \
  --plugin-dir "$here/probe-plugin" \
  --setting-sources project \
  --settings probe-settings.json \
  --permission-mode dontAsk \
  --model sonnet \
  --max-budget-usd 1 \
  --output-format json > result.json 2> stderr.txt
echo "claude exit=$?"
