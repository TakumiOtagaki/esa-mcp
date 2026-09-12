import test from 'node:test';
import assert from 'node:assert/strict';
import { EsaClient, errorInfo } from '../src/esa-client.js';

const post = (number = 1) => ({ number, name: '設計', category: '開発', full_name: '開発/設計', body_md: '# 本文\n\n日本語 😀', updated_at: '2026-09-12T00:00:00Z', url: `https://alpha.esa.io/posts/${number}` });
const page = (key, items, current = 1, next = null) => ({ [key]: items, page: current, next_page: next, prev_page: current > 1 ? current - 1 : null, per_page: 20, total_count: items.length });
function fixture(handler, extra = {}) {
  const calls = [];
  const client = new EsaClient({ token: 'test-only-placeholder', fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(url.origin, 'https://api.esa.io');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-only-placeholder');
    const result = await handler(url, calls.length);
    return result instanceof Response ? result : Response.json(result);
  }, ...extra });
  return { client, calls };
}

test('membership pagination, single-flight cache, TTL and explicit refresh', async () => {
  let now = 0;
  const { client, calls } = fixture(url => {
    const n = Number(url.searchParams.get('page'));
    assert.equal(url.searchParams.get('per_page'), '100');
    return page('teams', [{ name: n === 1 ? 'alpha' : 'beta' }], n, n === 1 ? 3 : null);
  }, { now: () => now });
  const result = await Promise.all([client.listTeams(), client.listTeams()]);
  assert.deepEqual(result[0].map(t => t.name), ['alpha', 'beta']);
  assert.equal(calls.length, 2);
  await client.listTeams();
  assert.equal(calls.length, 2);
  now = 60_001;
  await client.listTeams();
  assert.equal(calls.length, 4);
  await client.listTeams({ refresh: true });
  assert.equal(calls.length, 6);
});

test('all-team search, query encoding, summaries and per-team continuation without N+1 fetches', async () => {
  const query = '日本語 category:開発 & #tag';
  const { client, calls } = fixture(url => {
    if (url.pathname === '/v1/teams') return page('teams', [{ name: 'alpha' }, { name: 'beta' }]);
    assert.equal(url.searchParams.get('q'), query);
    assert.equal(url.searchParams.get('sort'), 'updated');
    assert.equal(url.searchParams.get('order'), 'desc');
    return page('posts', [post()], 1, url.pathname.includes('alpha') ? 2 : null);
  });
  const result = await client.listPosts({ query });
  assert.equal(calls.length, 3);
  assert.equal(result.has_more, true);
  assert.equal(result.partial, false);
  assert.deepEqual(result.results.map(r => r.posts[0].team), ['alpha', 'beta']);
  assert.equal(result.results[0].posts[0].title, '設計');
  assert.equal(result.results[0].posts[0].category, '開発');
  assert.equal(result.results[0].posts[0].excerpt, '# 本文 日本語 😀');
  assert.equal(result.results[0].posts[0].body_md, undefined);
  assert.equal(result.results[1].next_page, null);
});

test('explicit teams deduplicated; continuation honors page and per_page without listing memberships', async () => {
  const { client, calls } = fixture(url => {
    assert.equal(url.pathname, '/v1/teams/alpha/posts');
    assert.equal(url.searchParams.get('page'), '3');
    assert.equal(url.searchParams.get('per_page'), '50');
    assert.equal(url.searchParams.has('q'), false);
    return { ...page('posts', [], 3), per_page: 50 };
  });
  await client.listPosts({ teams: ['alpha', 'alpha'], page: 3, per_page: 50 });
  assert.equal(calls.length, 1);
  await assert.rejects(client.listPosts({ team: 'alpha', teams: ['beta'] }), /either team or teams/);
  assert.equal(calls.length, 1);
});

test('partial failures preserve successful team results and suppress API error bodies', async () => {
  const { client } = fixture(url => url.pathname.includes('alpha')
    ? new Response('test-only-placeholder private upstream body', { status: 403 })
    : page('posts', [post()]));
  const result = await client.listPosts({ teams: ['alpha', 'beta'] });
  assert.equal(result.partial, true);
  assert.equal(result.results[0].error.status, 403);
  assert.equal(result.results[1].posts.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /test-only-placeholder|private upstream/);
});

test('full post keeps Markdown intact, comments have independent pagination', async () => {
  const body = '# Code\n\n```js\nconst x = 1;\n```\n' + '長い本文'.repeat(1000);
  const { client, calls } = fixture(url => url.pathname.endsWith('/comments')
    ? page('comments', [{ id: 12, body_md: 'コメント\n\n**全文**', url: 'https://alpha.esa.io/posts/1#comment-12', created_at: '2026-09-01', updated_at: '2026-09-12' }], 2, 3)
    : { ...post(), body_md: body });
  assert.equal((await client.getPost('alpha', 1)).body_md, body);
  const comments = await client.listComments({ team: 'alpha', post_number: 1, page: 2 });
  assert.equal(comments.next_page, 3);
  assert.equal(comments.comments[0].body_md, 'コメント\n\n**全文**');
  assert.equal(calls.length, 2);
});

test('rate limit cooldown prevents further requests until reset; no automatic retries', async () => {
  let now = 1_000;
  const { client, calls } = fixture((url, count) => count === 1
    ? new Response('', { status: 429, headers: { 'retry-after': '30' } })
    : page('posts', []), { now: () => now });
  const result = await client.listPosts({ teams: ['alpha', 'beta'] });
  assert.equal(calls.length, 1);
  assert.equal(result.results[1].error.retry_after_seconds, 30);
  now = 31_001;
  assert.equal((await client.listPosts({ team: 'alpha' })).partial, false);
  assert.equal(calls.length, 2);
});

test('remaining=0 on success respects reset for next request', async () => {
  const { client, calls } = fixture(() => Response.json(page('posts', []), {
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '90' },
  }), { now: () => 10_000 });
  const result = await client.listPosts({ teams: ['alpha', 'beta'] });
  assert.equal(result.results[1].error.retry_after_seconds, 80);
  assert.equal(calls.length, 1);
});

test('malformed and cyclic pagination fail instead of silently truncating or looping', async () => {
  const { client, calls } = fixture(() => page('teams', [{ name: 'alpha' }], 1, 1));
  await assert.rejects(client.listTeams(), { code: 'invalid_pagination' });
  assert.equal(calls.length, 1);
  const broken = fixture(() => ({ teams: [] }));
  await assert.rejects(broken.client.listTeams(), { code: 'invalid_response' });
});

test('missing token and network failures do not expose credentials or raw exceptions', async () => {
  let calls = 0;
  const client = new EsaClient({ token: '', fetchImpl: () => { calls++; } });
  await assert.rejects(client.listTeams(), { code: 'missing_token' });
  assert.equal(calls, 0);
  const broken = new EsaClient({ token: 'test-only-placeholder', fetchImpl: () => { throw new Error('test-only-placeholder'); } });
  await assert.rejects(broken.listTeams(), error => {
    assert.equal(error.code, 'network_error');
    assert.doesNotMatch(JSON.stringify(errorInfo(error)), /test-only-placeholder/);
    return true;
  });
});

test('empty memberships yield complete empty results with no post requests', async () => {
  const { client, calls } = fixture(() => page('teams', []));
  assert.deepEqual(await client.listPosts({ query: 'anything' }), { results: [], partial: false, has_more: false });
  assert.equal(calls.length, 1);
});
