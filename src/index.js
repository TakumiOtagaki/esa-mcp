import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

try {
  await createServer().connect(new StdioServerTransport());
} catch {
  console.error('Failed to start esa MCP server.');
  process.exitCode = 1;
}
