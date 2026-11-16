// Store operations shared by the GraphQL handler and the MCP tools.
// They touch ONLY the BUILD-PLAN Store shape (store.repos / Repo / Issue / Pull
// fields), so they run unchanged against builder B's real store.
import { commentId, issueId, pullRequestId, repositoryId } from './graphql/ids.ts';
import type { Comment, Issue, Pull, Repo, Store } from './store-types.ts';

/** The token owner's login: opts -> store -> the scenario's fixed viewer. */
export function getViewer(store: Store, optsViewer?: string): string {
  if (optsViewer !== undefined && optsViewer !== '') return optsViewer;
  const s = store as unknown as Record<string, unknown>;
  if (typeof s.viewerLogin === 'string' && s.viewerLogin !== '') return s.viewerLogin;
  const viewer = s.viewer as { login?: unknown } | undefined;
  if (viewer && typeof viewer.login === 'string' && viewer.login !== '') return viewer.login;
  return 'adaiversen'; // wire.ts buildScenario(): users[0], fixed seed 6a09e667f3bcc909
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(`${owner}/${name}`);
}

/**
 * A repo's stable numeric databaseId. Builder B should set `databaseId` at
 * creation; otherwise one is assigned lazily from 5000 and cached on the store,
 * so it is stable across calls within the process.
 */
export function getDatabaseId(store: Store, repo: Repo): number {
  const r = repo as unknown as Record<string, unknown>;
  if (typeof r.databaseId === 'number' && Number.isInteger(r.databaseId)) return r.databaseId;
  if (typeof r.id === 'number' && Number.isInteger(r.id)) return r.id;
  const s = store as unknown as Record<string, unknown>;
  let ids = s._gqlDbIds as Map<string, number> | undefined;
  if (!(ids instanceof Map)) {
    ids = new Map<string, number>();
    s._gqlDbIds = ids;
  }
  let next = s._gqlNextDbId as number | undefined;
  if (typeof next !== 'number') next = 5000;
  const existing = ids.get(repo.fullName);
  if (existing !== undefined) return existing;
  const assigned = next;
  s._gqlNextDbId = next + 1;
  ids.set(repo.fullName, assigned);
  return assigned;
}

/** Next comment id, shared with REST when the real store carries nextCommentId. */
export function nextCommentId(store: Store): number {
  const s = store as unknown as Record<string, unknown>;
  if (typeof s.nextCommentId === 'number') {
    const id = s.nextCommentId as number;
    s.nextCommentId = id + 1;
    return id;
  }
  let next = s._gqlNextCommentId as number | undefined;
  if (typeof next !== 'number') next = 1;
  s._gqlNextCommentId = next + 1;
  return next;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Coordinator integration fix: shared numeric id from the store counter (B's store starts
 * nextId at 100000 and assigns id: store.nextId++ for repos/issues/pulls/comments). C's
 * record creators did not set `id`, so MCP-created issues/pulls had no REST id
 * (suite: mcp.rest-parity). Falls back to 5000 if the store carries no counter.
 */
export function nextSharedId(store: Store): number {
  const s = store as unknown as Record<string, unknown>;
  let next = s.nextId as number | undefined;
  if (typeof next !== 'number') next = 5000;
  s.nextId = next + 1;
  return next;
}

export function createRepoRecord(store: Store, owner: string, name: string, opts: { description?: string; private?: boolean; viewer: string }): Repo {
  const repo: Repo = {
    owner,
    name,
    fullName: `${owner}/${name}`,
    description: opts.description ?? '',
    defaultBranch: 'main',
    private: opts.private ?? false,
    refs: new Map<string, string>(),
    issues: new Map<number, Issue>(),
    nextIssueNumber: 1,
    pulls: new Map<number, Pull>(),
    nextPullNumber: 1,
    labels: new Map(),
  };
  for (const label of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
    repo.labels.set(label, { name: label, color: '000000', description: '' });
  }
  // Coordinator integration fix: REST renders repo.id (B's createRepo sets id: store.nextId++,
  // counter starts at 100000). MCP-created repos had no id/databaseId/createdAt, so REST dropped
  // them (suite: mcp.rest-parity). Assign from the shared store counter.
  const now = new Date().toISOString();
  const s = store as unknown as Record<string, unknown>;
  let next = s.nextId as number | undefined;
  if (typeof next !== 'number') next = 5000;
  s.nextId = next + 1;
  const r = repo as unknown as Record<string, unknown>;
  r.id = next;
  r.databaseId = next;
  r.createdAt = now;
  r.updatedAt = now;
  store.repos.set(repo.fullName, repo);
  return repo;
}

export function createIssueRecord(store: Store, repo: Repo, title: string, body: string, viewer: string): Issue {
  const number = repo.nextIssueNumber;
  repo.nextIssueNumber += 1;
  const now = nowIso();
  const issue: Issue = {
    id: nextSharedId(store),
    number,
    title,
    body: body ?? '',
    state: 'open',
    labels: [],
    assignees: [],
    user: viewer,
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPullRecord(
  store: Store,
  repo: Repo,
  opts: { title: string; body?: string; headRef: string; baseRef: string; viewer: string },
): Pull {
  const number = repo.nextPullNumber;
  repo.nextPullNumber += 1;
  const now = nowIso();
  const headSha = repo.refs.get(`refs/heads/${opts.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${opts.baseRef}`) ?? '';
  const pull: Pull = {
    id: nextSharedId(store),
    number,
    title: opts.title,
    body: opts.body ?? '',
    state: 'open',
    head: { ref: opts.headRef, sha: headSha },
    base: { ref: opts.baseRef, sha: baseSha },
    headRepo: repo.fullName,
    baseRepo: repo.fullName,
    user: opts.viewer,
    createdAt: now,
    updatedAt: now,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
  };
  repo.pulls.set(number, pull);
  return pull;
}

export function addCommentRecord(store: Store, repo: Repo, issue: Issue, body: string, viewer: string): Comment {
  const id = nextCommentId(store);
  const now = nowIso();
  const comment: Comment = { id, body, user: viewer, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  return comment;
}

/** REST-v3-shaped repo object (what MCP tools return and the harness REST shim reuses). */
export function restRepoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: getDatabaseId(store, repo),
    node_id: repositoryId(repo.owner, repo.name),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
  };
}

/** REST-v3-shaped issue object. */
export function restIssueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user },
    labels: issue.labels.map((name) => ({ name })),
    assignees: issue.assignees.map((login) => ({ login })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}

/** REST-v3-shaped pull object (merged reads state closed, GitHub's shape). */
export function restPullObject(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const merged = pull.state === 'merged';
  return {
    id: pullRequestId(repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: merged ? 'closed' : pull.state,
    merged,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    user: { login: pull.user },
    head: { ref: pull.head.ref, sha: pull.head.sha, repo: { full_name: pull.headRepo } },
    base: { ref: pull.base.ref, sha: pull.base.sha, repo: { full_name: pull.baseRepo } },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}
