// rest/common.ts — shared serializers, pagination, and the handler context for REST routes.
// Serializers emit the GitHub v3 field names the conformance checks assert (snake_case
// where GitHub uses it: default_branch, created_at, merge_commit_sha, ...).
import type { Comment, Issue, Label, Pull, Repo, Store, User } from '../store.ts';
import { getBlobContent, parseCommit, parseTree } from '../store.ts';

export interface ReqCtx {
  store: Store;
  viewer: User;
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown; // parsed JSON body, or undefined when no body was sent
  host: string; // request Host header (for absolute pagination URLs)
  headers: Record<string, string | string[] | undefined>; // raw request headers (lowercased by Node)
  params: Record<string, string>;
}

export interface HandlerResult {
  status: number;
  body?: unknown; // JSON body; omit for 204
  headers?: Record<string, string>;
  raw?: Buffer; // raw bytes reply (smart HTTP); when set, body is ignored
  contentType?: string;
}

export function ok(status: number, body: unknown, headers?: Record<string, string>): HandlerResult {
  return { status, body, headers };
}

export function err(status: number, message: string): HandlerResult {
  return { status, body: { message } };
}

export function userJson(u: User): Record<string, unknown> {
  return { login: u.login, id: u.id, type: 'User', name: u.name, email: u.email };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(store.users.get(repo.owner) as User),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://example.invalid/${repo.fullName}.git`,
    git_url: `git://example.invalid/${repo.fullName}.git`,
    ssh_url: `git@example.invalid:${repo.fullName}.git`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    size: 0,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function labelJson(l: Label): Record<string, unknown> {
  return { name: l.name, color: l.color, description: l.description, url: `/api/v3/labels/${encodeURIComponent(l.name)}`, default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l !== undefined ? labelJson(l) : { name, color: 'ededed', description: '' };
    }),
    user: userJson(store.users.get(issue.user) as User),
    assignee: null,
    assignees: issue.assignees,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

export function commentJson(store: Store, repo: Repo, comment: Comment, parentNumber: number, kind: 'issues' | 'pulls'): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(store.users.get(comment.user) as User),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}/${kind}/${parentNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.fullName}/${kind}/${parentNumber}/comments/${comment.id}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const state = pull.state === 'merged' ? 'closed' : pull.state;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state,
    merged: pull.state === 'merged' || pull.merged === true,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      label: `${repo.owner}:${pull.head.ref}`,
      ref: pull.head.ref,
      sha: pull.head.sha,
      repo: { full_name: pull.headRepo },
    },
    base: {
      label: `${repo.owner}:${pull.base.ref}`,
      ref: pull.base.ref,
      sha: pull.base.sha,
      repo: { full_name: pull.baseRepo },
    },
    user: userJson(store.users.get(pull.user) as User),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    draft: false,
    comments: pull.comments.length,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

export function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const info = parseCommit(store, sha);
  if (info === null) return null;
  const authorLogin = store.viewerLogin;
  const dateOf = (ident: string): string => {
    const m = / (\d+) [+-]\d{4}$/.exec(ident);
    return m !== null ? new Date(Number(m[1]) * 1000).toISOString() : nowIsoFallback();
  };
  const nameOf = (ident: string): string => ident.split(' <')[0] ?? authorLogin;
  const emailOf = (ident: string): string => {
    const m = /<([^>]*)>/.exec(ident);
    return m !== null ? (m[1] as string) : '';
  };
  return {
    sha,
    commit: {
      message: info.message,
      author: { name: nameOf(info.author), email: emailOf(info.author), date: dateOf(info.author) },
      committer: { name: nameOf(info.committer), email: emailOf(info.committer), date: dateOf(info.committer) },
      tree: { sha: info.tree },
    },
    author: userJson(store.users.get(authorLogin) as User),
    committer: userJson(store.users.get(authorLogin) as User),
    parents: info.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `https://example.invalid/${repo.fullName}/commit/${sha}`,
  };
}

function nowIsoFallback(): string {
  return new Date().toISOString();
}

/** Look up a repo the viewer owns; any other owner (or a missing repo) is a 404, never 403. */
export function ownedRepo(ctx: ReqCtx, owner: string, name: string): Repo | null {
  if (owner !== ctx.viewer.login) return null;
  return ctx.store.repos.get(`${owner}/${name}`) ?? null;
}

export function bodyObj(ctx: ReqCtx): Record<string, unknown> {
  if (ctx.body !== undefined && ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body)) {
    return ctx.body as Record<string, unknown>;
  }
  return {};
}

export function strField(body: Record<string, unknown>, field: string): string {
  const v = body[field];
  return typeof v === 'string' ? v : '';
}

export function boolField(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const v = body[field];
  return typeof v === 'boolean' ? v : fallback;
}

/** Pagination: page (default 1), per_page (default 30, clamped 1..100). Returns the page slice + Link header. */
export function paginate<T>(ctx: ReqCtx, items: readonly T[], basePath: string): { page: T[]; link: string | null } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const pageNum = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  if (pageNum < totalPages) {
    const origin = `http://${ctx.host}`;
    const next = `${origin}${basePath}?page=${pageNum + 1}&per_page=${perPage}`;
    const last = `${origin}${basePath}?page=${totalPages}&per_page=${perPage}`;
    link = `<${next}>; rel="next", <${last}>; rel="last"`;
    if (pageNum > 1) {
      const first = `${origin}${basePath}?page=1&per_page=${perPage}`;
      const prev = `${origin}${basePath}?page=${pageNum - 1}&per_page=${perPage}`;
      link += `, <${first}>; rel="first", <${prev}>; rel="prev"`;
    }
  }
  return { page, link };
}

export function linkHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

/** Base64 that tolerates GitHub's line-wrapped content. Returns null on invalid input. */
export function b64decodeLoose(s: string): Buffer | null {
  const clean = s.replace(/[\r\n\t ]+/g, '');
  if (clean === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  return Buffer.from(clean, 'base64');
}

/** Directory listing entries for `dir` ('' = root) at a commit. Dir entries carry the real tree sha. */
export function dirListing(
  store: Store,
  repo: Repo,
  commitSha: string,
  dir: string,
): { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }[] | null {
  const info = parseCommit(store, commitSha);
  if (info === null) return null;
  // Walk down to the requested directory's tree.
  let treeSha = info.tree;
  if (dir !== '') {
    for (const part of dir.split('/')) {
      const entries = parseTree(store, treeSha);
      if (entries === null) return null;
      const found = entries.find((e) => e.name === part && e.mode === '40000');
      if (found === undefined) return null;
      treeSha = found.sha;
    }
  }
  const entries = parseTree(store, treeSha);
  if (entries === null) return null;
  const out: { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }[] = [];
  for (const e of entries) {
    const path = dir === '' ? e.name : `${dir}/${e.name}`;
    if (e.mode === '40000') {
      out.push({ type: 'dir', name: e.name, path, sha: e.sha, size: 0 });
    } else {
      const content = getBlobContent(store, e.sha);
      out.push({ type: 'file', name: e.name, path, sha: e.sha, size: content === null ? 0 : content.length });
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}
