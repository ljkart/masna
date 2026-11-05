// Records each hook call, then blocks the probe's forbidden actions with exit 2.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const command = input.tool_input?.command ?? '';
const blockedTool = input.tool_name === 'NotebookEdit' || input.tool_name?.startsWith('mcp__');
const blocked = input.hook_event_name === 'PreToolUse' && (blockedTool || command.includes('BLOCKME'));

const entry = {
  at: new Date().toISOString(),
  event: input.hook_event_name,
  session_id: input.session_id,
  agent_id: input.agent_id,
  agent_type: input.agent_type,
  tool_name: input.tool_name,
  agent_transcript_path: input.agent_transcript_path,
  blocked,
};
appendFileSync(join(process.env.CLAUDE_PROJECT_DIR, 'hook-log.jsonl'), `${JSON.stringify(entry)}\n`);

if (blocked) {
  console.error('Blocked by the probe guard.');
  process.exit(2);
}
