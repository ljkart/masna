// The smallest MCP server that offers one tool, so the guard can be tested against MCP.
import { createInterface } from 'node:readline';

const send = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') {
    send(id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'probe', version: '0.0.0' },
    });
  } else if (method === 'tools/list') {
    send(id, {
      tools: [{
        name: 'echo',
        description: 'Returns a fixed string.',
        inputSchema: { type: 'object', properties: {} },
      }],
    });
  } else if (method === 'tools/call') {
    send(id, { content: [{ type: 'text', text: 'mcp-echo-reached' }] });
  } else if (id !== undefined) {
    send(id, {});
  }
});
