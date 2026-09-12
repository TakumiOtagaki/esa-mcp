import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// No API requests by default. --live explicitly enables a membership request.
const live = process.argv.includes('--live');
if (live && !process.env.ESA_ACCESS_TOKEN?.trim()) {
  throw new Error('Set ESA_ACCESS_TOKEN before running npm run smoke -- --live.');
}
const client = new Client({ name: 'esa-mcp-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
  env: { ESA_ACCESS_TOKEN: live ? process.env.ESA_ACCESS_TOKEN : '' },
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), [
    'esa_list_teams', 'esa_search_posts', 'esa_get_post', 'esa_list_recent_posts', 'esa_list_comments',
  ].sort());
  for (const tool of tools) assert.equal(tool.annotations.readOnlyHint, true);
  console.log('MCP initialize + tools/list: OK');
  console.log(tools.map(t => t.name).join('\n'));
  const result = await client.callTool({ name: 'esa_list_teams', arguments: {} });
  if (live) {
    assert.ok(!result.isError, JSON.stringify(result.content));
    console.log(`Live esa_list_teams: OK (${result.structuredContent.teams.length} teams)`);
  } else {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /missing_token/);
    console.log('tools/call without credentials: expected missing_token error');
  }
} finally {
  await client.close();
  await transport.close();
}
