import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EsaClient } from '../src/esa-client.js';
import { createServer } from '../src/server.js';

test('real server process exposes five tools over stdio', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['scripts/smoke.js'], { timeout: 20_000 });
  assert.match(stdout, /MCP initialize \+ tools\/list: OK/);
  assert.equal(stderr, '');
});

test('MCP validates arguments, returns readable Markdown and structured results', async () => {
  let requests = 0;
  const server = createServer(new EsaClient({ token: 'test-only-placeholder', fetchImpl: async url => {
    requests++;
    if (url.pathname.endsWith('/posts/42')) return Response.json({ number: 42, name: 'Title', category: 'Dev', full_name: 'Dev/Title', body_md: '# Heading\n\n**Full body**', url: 'https://alpha.esa.io/posts/42', updated_at: '2026-09-12' });
    return Response.json({ posts: [], page: 1, next_page: null, prev_page: null, per_page: 20, total_count: 0 });
  } }));
  const client = new Client({ name: 'test', version: '1' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    for (const args of [{}, { query: '' }, { query: 'x', per_page: 101 }, { query: 'x', page: 0 }, { query: 'x', team: '../evil' }, { query: 'x', teams: [] }]) {
      const result = await client.callTool({ name: 'esa_search_posts', arguments: args });
      assert.equal(result.isError, true);
    }
    const conflict = await client.callTool({ name: 'esa_search_posts', arguments: { query: 'x', team: 'alpha', teams: ['beta'] } });
    assert.equal(conflict.isError, true);
    assert.equal(requests, 0);
    const result = await client.callTool({ name: 'esa_get_post', arguments: { team: 'alpha', post_number: 42 } });
    assert.equal(result.structuredContent.body_md, '# Heading\n\n**Full body**');
    assert.match(result.content[0].text, /Team: alpha/);
    assert.ok(result.content[0].text.endsWith('# Heading\n\n**Full body**'));
    const recent = await client.callTool({ name: 'esa_list_recent_posts', arguments: { team: 'alpha' } });
    assert.equal(recent.structuredContent.results[0].next_page, null);
    assert.equal(requests, 2);
  } finally { await client.close(); await server.close(); }
});
