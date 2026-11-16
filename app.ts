// app.ts — the HTTP server: router, auth, JSON discipline, smart HTTP routes.
// REST routes live in rest/ (repos/issues/pulls); the git object store in store.ts;
// the smart-HTTP git module in git/index.ts (STUB until Builder A's module lands).
//
// Auth: any non-empty Bearer token authenticates as the seeded viewer (adaiversen).
// Every surface except GET /healthz requires it -> 401 JSON otherwise.
// JSON discipline: every REST reply is application/json, carries a non-empty
// X-GitHub-Request-Id, unknown routes are JSON 404s, malformed JSON bodies are 400s.
// Smart HTTP routes answer git content types (not JSON) but still carry the request id.
//
// Integration hooks: createApp accepts an optional store (default: a fresh one, kept as
// the module singleton so GraphQL/MCP handlers can share it via getStore()) and optional
// graphqlHandler / mcpHandler (Builder C). Without them /api/graphql and /mcp answer 404.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createStore, viewer, type Store, type User } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git/index.ts';
import type { HandlerResult, ReqCtx } from './rest/common.ts';
import * as repos from './rest/repos.ts';
import * as issues from './rest/issues.ts';
import * as pulls from './rest/pulls.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let sharedStore: Store | null = null;

/** The store this server uses (the singleton, shared with GraphQL/MCP at integration). */
export function getStore(): Store {
  if (sharedStore === null) sharedStore = createStore();
  return sharedStore;
}

export interface AppOptions {
  store?: Store;
  /** (ctx, rawBody) => result; Builder C mounts the GraphQL executor here. */
  graphqlHandler?: (ctx: ReqCtx, rawBody: Buffer) => Promise<HandlerResult> | HandlerResult;
  /** (ctx, rawBody) => result; Builder C mounts the MCP endpoint here. */
  mcpHandler?: (ctx: ReqCtx, rawBody: Buffer) => Promise<HandlerResult> | HandlerResult;
}

type Handler = (ctx: ReqCtx, rawBody: Buffer) => Promise<HandlerResult> | HandlerResult;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  rawBody?: boolean; // do not JSON-parse the body (git smart HTTP)
}

function route(method: string, path: string, handler: Handler, rawBody = false): Route {
  const keys: string[] = [];
  // ":name" -> one segment; ":path*" -> rest of path (may contain '/').
  // A param may carry a literal suffix, e.g. ":repo.git" -> key "repo", pattern "([^/]+)\.git".
  const src = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        const m = /^:([A-Za-z_][A-Za-z0-9_]*)(\*?)(.*)$/.exec(seg);
        if (m === null) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const name = m[1] as string;
        const star = m[2] === '*';
        const suffix = m[3] ?? '';
        keys.push(name);
        return (star ? '(.+)' : '([^/]+)') + suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { method, pattern: new RegExp(`^${src}$`), keys, handler, rawBody };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'content-type': JSON_TYPE, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, raw: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': raw.length, ...headers });
  res.end(raw);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return null;
  const m = /^(?:Bearer|token)\s+(.+)$/i.exec(auth.trim());
  return m !== null && (m[1] as string).trim() !== '' ? (m[1] as string).trim() : null;
}

function decodeParam(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(options: AppOptions = {}): Server {
  const store = options.store ?? getStore();
  const viewerUser: User = viewer(store);

  const gitRepo = (ctx: ReqCtx): { owner: string; name: string } | null => {
    const owner = ctx.params.owner ?? '';
    const name = ctx.params.repo ?? '';
    if (owner === '' || name === '') return null;
    return { owner, name };
  };

  const routes: Route[] = [
    // --- health + API root/meta (REST, JSON) ---
    route('GET', '/healthz', () => ({ status: 200, body: { ok: true } })),
    route('GET', '/api/v3', () => ({
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    })),
    route('GET', '/api/v3/', () => ({
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    })),
    route('GET', '/api/v3/meta', () => ({ status: 200, body: { installed_version: '1.0.0' } })),
    route('GET', '/api/v3/rate_limit', () => ({
      status: 200,
      body: {
        resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 } },
        rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600, used: 1 },
      },
    })),
    route('GET', '/api/v3/user', (ctx) => ({
      status: 200,
      body: { login: ctx.viewer.login, id: ctx.viewer.id, type: 'User', name: ctx.viewer.name, email: ctx.viewer.email },
    })),
    // --- repos ---
    route('POST', '/api/v3/user/repos', repos.createUserRepo),
    route('GET', '/api/v3/user/repos', repos.listUserRepos),
    route('GET', '/api/v3/repos/:owner/:name', repos.getRepo),
    route('PATCH', '/api/v3/repos/:owner/:name', repos.patchRepo),
    route('DELETE', '/api/v3/repos/:owner/:name', repos.deleteRepoRoute),
    route('GET', '/api/v3/repos/:owner/:name/branches', repos.listBranchesRoute),
    route('POST', '/api/v3/repos/:owner/:name/git/refs', repos.createRef),
    route('GET', '/api/v3/repos/:owner/:name/git/refs/:ref*', repos.getRef),
    route('GET', '/api/v3/repos/:owner/:name/commits', repos.listCommitsRoute),
    route('GET', '/api/v3/repos/:owner/:name/commits/:sha', repos.getCommit),
    route('GET', '/api/v3/repos/:owner/:name/contents', repos.getContents),
    route('GET', '/api/v3/repos/:owner/:name/contents/:path*', repos.getContents),
    route('PUT', '/api/v3/repos/:owner/:name/contents/:path*', repos.putContents),
    route('DELETE', '/api/v3/repos/:owner/:name/contents/:path*', repos.deleteContents),
    route('GET', '/api/v3/repos/:owner/:name/labels', repos.listLabels),
    route('POST', '/api/v3/repos/:owner/:name/labels', repos.createLabel),
    // --- issues ---
    route('POST', '/api/v3/repos/:owner/:name/issues', issues.createIssueRoute),
    route('GET', '/api/v3/repos/:owner/:name/issues', issues.listIssues),
    route('GET', '/api/v3/repos/:owner/:name/issues/:number', issues.getIssue),
    route('PATCH', '/api/v3/repos/:owner/:name/issues/:number', issues.patchIssue),
    route('POST', '/api/v3/repos/:owner/:name/issues/:number/comments', issues.createIssueComment),
    route('GET', '/api/v3/repos/:owner/:name/issues/:number/comments', issues.listIssueComments),
    // --- pulls ---
    route('POST', '/api/v3/repos/:owner/:name/pulls', pulls.createPullRoute),
    route('GET', '/api/v3/repos/:owner/:name/pulls', pulls.listPulls),
    route('GET', '/api/v3/repos/:owner/:name/pulls/:number', pulls.getPull),
    route('GET', '/api/v3/repos/:owner/:name/pulls/:number/files', pulls.listPullFiles),
    route('PUT', '/api/v3/repos/:owner/:name/pulls/:number/merge', pulls.mergePull),
    route('POST', '/api/v3/repos/:owner/:name/pulls/:number/comments', pulls.createPullComment),
    route('GET', '/api/v3/repos/:owner/:name/pulls/:number/comments', pulls.listPullComments),
    // --- smart HTTP (raw bodies; repo name carries the .git suffix) ---
    route('GET', '/:owner/:repo.git/info/refs', smartInfoRefs, true),
    route('POST', '/:owner/:repo.git/git-upload-pack', smartUploadPack, true),
    route('POST', '/:owner/:repo.git/git-receive-pack', smartReceivePack, true),
    // --- GraphQL / MCP (Builder C hooks; 404 until mounted) ---
    route('POST', '/api/graphql', graphqlRoute, true),
    route('POST', '/mcp', mcpRoute, true),
  ];

  function ownedSmartRepo(ctx: ReqCtx) {
    const g = gitRepo(ctx);
    if (g === null) return null;
    if (g.owner !== viewerUser.login) return null;
    return store.repos.get(`${g.owner}/${g.name}`) ?? null;
  }

  function smartInfoRefs(ctx: ReqCtx): HandlerResult {
    const repo = ownedSmartRepo(ctx);
    if (repo === null) return { status: 404, body: { message: 'Not Found' } };
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      return { status: 400, body: { message: 'service parameter is required' } };
    }
    // Coordinator integration fix: the kit client requests protocol v2 with the
    // `Git-Protocol: version=2` header (git-client.ts). Builder A's handleInfoRefs
    // honours opts.version, but B's route never forwarded the header, so every
    // advertisement answered v0 (git.advertise-v2, ls-refs, ls-refs-prefix failed).
    const version = ctx.headers['git-protocol'] === 'version=2' ? 2 : 0;
    const body = handleInfoRefs(repo, store, service, { version });
    const ct =
      service === 'git-upload-pack'
        ? 'application/x-git-upload-pack-advertisement'
        : 'application/x-git-receive-pack-advertisement';
    return { status: 200, raw: body, contentType: ct };
  }

  function smartUploadPack(ctx: ReqCtx, rawBody: Buffer): HandlerResult {
    const repo = ownedSmartRepo(ctx);
    if (repo === null) return { status: 404, body: { message: 'Not Found' } };
    const body = handleUploadPack(repo, store, rawBody);
    return { status: 200, raw: body, contentType: 'application/x-git-upload-pack-result' };
  }

  function smartReceivePack(ctx: ReqCtx, rawBody: Buffer): HandlerResult {
    const repo = ownedSmartRepo(ctx);
    if (repo === null) return { status: 404, body: { message: 'Not Found' } };
    const body = handleReceivePack(repo, store, rawBody);
    return { status: 200, raw: body, contentType: 'application/x-git-receive-pack-result' };
  }

  function graphqlRoute(ctx: ReqCtx, rawBody: Buffer): Promise<HandlerResult> | HandlerResult {
    if (options.graphqlHandler !== undefined) return options.graphqlHandler(ctx, rawBody);
    return { status: 404, body: { message: 'Not Found' } };
  }

  function mcpRoute(ctx: ReqCtx, rawBody: Buffer): Promise<HandlerResult> | HandlerResult {
    if (options.mcpHandler !== undefined) return options.mcpHandler(ctx, rawBody);
    return { status: 404, body: { message: 'Not Found' } };
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = randomUUID();
      const baseHeaders: Record<string, string> = { 'x-github-request-id': requestId };
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        let path = url.pathname;
        if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
        const method = req.method ?? 'GET';
        const isHealthz = method === 'GET' && path === '/healthz';

        // Auth: everything except /healthz needs a Bearer token.
        const token = bearerToken(req);
        if (!isHealthz && token === null) {
          sendJson(res, 401, { message: 'Requires authentication' }, baseHeaders);
          return;
        }

        // Route match.
        let matched: Route | null = null;
        let params: Record<string, string> = {};
        for (const r of routes) {
          if (r.method !== method) continue;
          const m = r.pattern.exec(path);
          if (m === null) continue;
          params = {};
          let bad = false;
          r.keys.forEach((key, i) => {
            const raw = m[i + 1] ?? '';
            const decoded = decodeParam(raw);
            if (decoded === null) bad = true;
            else params[key] = decoded;
          });
          if (bad) continue;
          matched = r;
          break;
        }
        if (matched === null) {
          sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
          return;
        }

        const rawBody = await readBody(req);
        // JSON discipline: malformed JSON on a /api/v3 route with a body is a 400.
        let body: unknown;
        if (!matched.rawBody && rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON in request body' }, baseHeaders);
            return;
          }
        }

        const ctx: ReqCtx = {
          store,
          viewer: viewerUser,
          method,
          path,
          query: url.searchParams,
          body,
          host: req.headers.host ?? 'localhost',
          headers: req.headers,
          params,
        };
        const result = await matched.handler(ctx, rawBody);
        const headers = { ...baseHeaders, ...(result.headers ?? {}) };
        if (result.raw !== undefined) {
          sendRaw(res, result.status, result.raw, result.contentType ?? 'application/octet-stream', headers);
        } else {
          sendJson(res, result.status, result.body ?? {}, headers);
        }
      } catch (err) {
        // Never leak a stack or an HTML error page; never HTTP 500 on a JSON surface
        // without a JSON body.
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, baseHeaders);
      }
    })();
  });
}
