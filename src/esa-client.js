import { z } from 'zod';

export class EsaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function errorInfo(error) {
  return error instanceof EsaError
    ? { code: error.code, message: error.message, ...error.details }
    : { code: 'internal_error', message: 'Unexpected error while reading esa data.' };
}

export const teamName = z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/).max(63);
const positiveInt = z.number().int().positive().safe();
const teamSchema = z.object({ name: teamName, description: z.string().optional(), privacy: z.string().optional(), url: z.string().optional() });
const postSchema = z.object({
  number: positiveInt, name: z.string(), category: z.string().nullable().optional(),
  full_name: z.string().optional(), updated_at: z.string(), url: z.string(),
  body_md: z.string(), tags: z.array(z.string()).optional(), wip: z.boolean().optional(),
});
const commentSchema = z.object({
  id: positiveInt, body_md: z.string(), url: z.string(),
  created_at: z.string(), updated_at: z.string(),
  created_by: z.object({ name: z.string(), screen_name: z.string() }).optional(),
});

function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) throw new EsaError('invalid_response', 'esa API returned an unexpected response format.');
  return result.data;
}

function parsePage(data, key, itemSchema, requestedPage) {
  const result = parse(z.object({
    [key]: z.array(itemSchema), page: positiveInt, per_page: positiveInt.max(100),
    next_page: positiveInt.nullable(), prev_page: positiveInt.nullable(),
    total_count: z.number().int().nonnegative(),
  }), data);
  if (result.page !== requestedPage || (result.next_page !== null && result.next_page <= result.page)) {
    throw new EsaError('invalid_pagination', 'esa API returned inconsistent pagination.');
  }
  return result;
}

export class EsaClient {
  #token;
  #fetch;
  #now;
  #cache;
  #pendingTeams;
  #blockedUntil = 0;
  #queue = Promise.resolve();

  constructor({ token = process.env.ESA_ACCESS_TOKEN, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.#token = token?.trim();
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  // Serialize requests across concurrent tool calls; never retry automatically.
  async #get(path, params = {}) {
    const previous = this.#queue;
    let release;
    this.#queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (!this.#token) throw new EsaError('missing_token', 'Set ESA_ACCESS_TOKEN in the environment used to launch this server.');
      if (this.#now() < this.#blockedUntil) throw this.#rateError();
      const url = new URL(`https://api.esa.io/v1${path}`);
      for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
      let response;
      try {
        response = await this.#fetch(url, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', 'User-Agent': 'esa-multi-team-mcp/0.1.0' },
        });
      } catch {
        throw new EsaError('network_error', 'esa API request failed or timed out. Try again later.');
      }
      if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0') {
        const retry = response.headers.get('retry-after');
        const seconds = retry === null ? NaN : Number(retry);
        const retryAt = Number.isFinite(seconds) ? this.#now() + seconds * 1000 : Date.parse(retry ?? '');
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        this.#blockedUntil = Math.max(this.#now() + 1000, retryAt || reset || this.#now() + 60_000);
      }
      if (response.status === 429) {
        await response.body?.cancel();
        throw this.#rateError();
      }
      if (!response.ok) {
        await response.body?.cancel();
        const messages = {
          400: 'Invalid esa search or request parameters.',
          401: 'esa authentication failed. Check token validity, scope and team access.',
          403: 'esa access denied. Check team membership and token access policy.',
          404: 'The esa team or post was not found or is not accessible.',
        };
        throw new EsaError('api_error', messages[response.status] ?? 'esa API request failed. Try again later.', { status: response.status });
      }
      try { return await response.json(); }
      catch { throw new EsaError('invalid_response', 'esa API returned invalid JSON.'); }
    } finally { release(); }
  }

  #rateError() {
    return new EsaError('rate_limited', 'esa API rate limit reached. Retry after the indicated delay.', {
      status: 429, retry_after_seconds: Math.max(1, Math.ceil((this.#blockedUntil - this.#now()) / 1000)),
    });
  }

  async listTeams({ refresh = false } = {}) {
    if (this.#pendingTeams) return this.#pendingTeams;
    if (!refresh && this.#cache && this.#cache.expires > this.#now()) return this.#cache.teams;
    this.#pendingTeams = this.#loadTeams();
    try { return await this.#pendingTeams; }
    finally { this.#pendingTeams = undefined; }
  }

  async #loadTeams() {
    const teams = new Map();
    let page = 1;
    do {
      const result = parsePage(await this.#get('/teams', { page, per_page: 100 }), 'teams', teamSchema, page);
      for (const team of result.teams) teams.set(team.name, team);
      page = result.next_page;
    } while (page !== null);
    const result = [...teams.values()];
    this.#cache = { teams: result, expires: this.#now() + 60_000 };
    return result;
  }

  async listPosts({ query, team, teams, page = 1, per_page = 20 }) {
    if (team !== undefined && teams !== undefined) throw new EsaError('invalid_arguments', 'Specify either team or teams, not both.');
    const targets = [...new Set(team ? [team] : teams ?? (await this.listTeams()).map(t => t.name))];
    const results = [];
    for (const name of targets) {
      try {
        teamName.parse(name);
        const result = parsePage(await this.#get(`/teams/${encodeURIComponent(name)}/posts`, {
          q: query, sort: 'updated', order: 'desc', page, per_page,
        }), 'posts', postSchema, page);
        results.push({ team: name, ...result, posts: result.posts.map(post => summarizePost(name, post)) });
      } catch (error) { results.push({ team: name, error: errorInfo(error) }); }
    }
    return { results, partial: results.some(r => r.error), has_more: results.some(r => r.next_page != null) };
  }

  async getPost(team, number) {
    teamName.parse(team);
    positiveInt.parse(number);
    const post = parse(postSchema, await this.#get(`/teams/${encodeURIComponent(team)}/posts/${number}`));
    return { ...summarizePost(team, post), body_md: post.body_md };
  }

  async listComments({ team, post_number, page = 1, per_page = 20 }) {
    teamName.parse(team);
    positiveInt.parse(post_number);
    const result = parsePage(await this.#get(`/teams/${encodeURIComponent(team)}/posts/${post_number}/comments`, { page, per_page }), 'comments', commentSchema, page);
    return { team, post_number, ...result, has_more: result.next_page !== null };
  }
}

function summarizePost(team, post) {
  const text = post.body_md.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  return {
    team, post_number: post.number, title: post.name, category: post.category ?? '',
    full_name: post.full_name ?? post.name, updated_at: post.updated_at, url: post.url,
    excerpt: chars.slice(0, 240).join('') + (chars.length > 240 ? '…' : ''),
    tags: post.tags ?? [], wip: post.wip,
  };
}
