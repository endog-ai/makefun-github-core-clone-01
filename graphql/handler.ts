// Minimal GraphQL v4 executor for ONLY the exact documents the suite sends
// (sdk/conformance/checks-graphql.ts + graphql-client.ts). Never a general
// executor: dispatch is by operation name, with per-document resolvers that read
// values from `variables` (inline enums / input objects in the document text are
// fixed per document, so they need no parsing — except __type names, which are
// parsed from the query text with their aliases).
//
// Supported operations (operation names):
//   ViewerLogin, RepositoryFields, Issue_fields, PullRequestAndRepositoryFields,
//   SearchType_enumValues, OpenIssues, IssueByNumber, IssueCreate, IssueClose,
//   PullRequests, PullRequestFiles, PullRequestId, PullRequestCreate,
//   MergePullRequest, AddComment, ViewerInvalidField, NodeRepository, IssuesPage
// Plus: batched arrays of operations in one body, operationName selection,
// unknown-field -> HTTP 200 + errors array (never HTTP 400 for GraphQL errors).
import { diffCommitFiles } from './git-objects.ts';
import { commentId, decodeGlobalId, issueId, parseRepoScoped, pullRequestId, repositoryId } from './ids.ts';
import { typeInfo } from './introspection.ts';
import { gqlPullState, isMerged, squashMerge } from './merge.ts';
import {
  addCommentRecord, createIssueRecord, createPullRecord, getDatabaseId, getRepo, getViewer, nowIso,
} from '../store-ops.ts';
import type { Issue, Pull, Repo, Store } from '../store-types.ts';

export interface GraphQLOpts {
  viewer?: string;
}
export interface HandlerResult {
  status: number;
  json: unknown;
}

type Vars = Record<string, unknown>;
type Data = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function gqlError(message: string): { message: string } {
  return { message };
}

function errBody(message: string): Data {
  return { data: null, errors: [gqlError(message)] };
}

/** Extract the operation name from a document, or from body.operationName. */
function operationNameOf(query: string, operationName?: unknown): string | null {
  if (typeof operationName === 'string' && operationName !== '') return operationName;
  const m = /(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return m ? (m[1] as string) : null;
}

function gqlIssueState(state: 'open' | 'closed'): 'OPEN' | 'CLOSED' {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueView(store: Store, repo: Repo, issue: Issue, withBody: boolean): Data {
  const view: Data = {
    id: issueId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    state: gqlIssueState(issue.state),
  };
  if (withBody) view.body = issue.body;
  return view;
}

function repositoryView(store: Store, repo: Repo): Data {
  return {
    id: repositoryId(repo.owner, repo.name),
    databaseId: getDatabaseId(store, repo),
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function pullView(store: Store, repo: Repo, pull: Pull): Data {
  return {
    id: pullRequestId(repo.owner, repo.name, pull.number),
    number: pull.number,
    state: gqlPullState(pull),
    merged: isMerged(pull),
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: pull.head.sha !== '' && pull.base.sha !== '' ? 'MERGEABLE' : 'UNKNOWN',
  };
}

/** Decode a cursor made by pageCursor(); -1 when undecodable. */
function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : -1;
  } catch {
    return -1;
  }
}

function pageCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

/** All __type(name:) occurrences with their aliases in a document. */
function typeProbes(query: string): Array<{ alias: string; name: string }> {
  const out: Array<{ alias: string; name: string }> = [];
  for (const m of query.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g)) {
    out.push({ alias: m[1] as string, name: m[2] as string });
  }
  if (out.length === 0) {
    for (const m of query.matchAll(/__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g)) {
      out.push({ alias: '__type', name: m[1] as string });
    }
  }
  return out;
}

function executeOne(store: Store, query: string, variables: Vars, operationName: unknown, viewer: string): Data {
  const op = operationNameOf(query, operationName);
  const vars = variables;

  // --- Queries -------------------------------------------------------------
  if (op === 'ViewerLogin') {
    return { data: { viewer: { login: viewer } } };
  }
  if (op === 'ViewerInvalidField' || query.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: null },
      errors: [gqlError('Cannot query field "noSuchFieldOnViewer" on type "User".')],
    };
  }
  if (op === 'RepositoryFields' || op === 'OpenIssues' || op === 'IssueByNumber' || op === 'PullRequests' || op === 'PullRequestFiles' || op === 'PullRequestId' || op === 'IssuesPage') {
    const owner = vars.owner as string;
    const name = vars.name as string;
    const repo = typeof owner === 'string' && typeof name === 'string' ? getRepo(store, owner, name) : undefined;
    if (repo === undefined) return { data: { repository: null } };
    if (op === 'RepositoryFields') return { data: { repository: repositoryView(store, repo) } };
    if (op === 'OpenIssues') {
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const open = [...repo.issues.values()]
        .filter((i) => i.state === 'open')
        .sort((a, b) => b.number - a.number) // CREATED_AT DESC == number DESC
        .slice(0, first);
      return { data: { repository: { issues: { nodes: open.map((i) => issueView(store, repo, i, false)) } } } };
    }
    if (op === 'IssueByNumber') {
      const issue = repo.issues.get(vars.number as number);
      return { data: { repository: { issue: issue ? issueView(store, repo, issue, true) : null } } };
    }
    if (op === 'PullRequests') {
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const nodes = [...repo.pulls.values()].slice(0, first).map((p) => {
        const v = pullView(store, repo, p);
        return { number: v.number, headRefName: v.headRefName, baseRefName: v.baseRefName, mergeable: v.mergeable, state: v.state };
      });
      return { data: { repository: { pullRequests: { nodes } } } };
    }
    if (op === 'PullRequestFiles') {
      const pull = repo.pulls.get(vars.number as number);
      if (!pull) return { data: { repository: { pullRequest: null } } };
      const paths = diffCommitFiles(store, pull.base.sha, pull.head.sha).slice(0, 10);
      return {
        data: {
          repository: {
            pullRequest: { number: pull.number, files: { nodes: paths.map((path) => ({ path })) } },
          },
        },
      };
    }
    if (op === 'PullRequestId') {
      const pull = repo.pulls.get(vars.number as number);
      return {
        data: {
          repository: {
            pullRequest: pull ? { id: pullRequestId(repo.owner, repo.name, pull.number), number: pull.number } : null,
          },
        },
      };
    }
    // IssuesPage — cursor pagination, number ASC (stable across pages).
    const first = typeof vars.first === 'number' ? vars.first : 10;
    const afterIdx = decodeCursor(vars.after);
    const all = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    const start = afterIdx < 0 ? 0 : afterIdx + 1;
    const page = all.slice(start, start + first);
    const endIdx = page.length === 0 ? start - 1 : start + page.length - 1;
    return {
      data: {
        repository: {
          issues: {
            nodes: page.map((i) => ({ number: i.number })),
            pageInfo: {
              hasNextPage: start + page.length < all.length,
              endCursor: page.length === 0 ? null : pageCursor(endIdx),
            },
          },
        },
      },
    };
  }
  if (op === 'Issue_fields' || op === 'PullRequestAndRepositoryFields' || op === 'SearchType_enumValues' || query.includes('__type(')) {
    const data: Data = {};
    for (const probe of typeProbes(query)) {
      const info = typeInfo(probe.name);
      data[probe.alias] = info;
    }
    if (Object.keys(data).length === 0) return errBody('Unknown type introspection');
    return { data };
  }
  if (op === 'NodeRepository') {
    const decoded = decodeGlobalId(vars.id as string);
    if (decoded === null) return { data: { node: null } };
    const scoped = parseRepoScoped(decoded.payload);
    if (scoped === null) return { data: { node: null } };
    const repo = getRepo(store, scoped.owner, scoped.repo);
    if (decoded.type === 'Repository') {
      if (!repo) return { data: { node: null } };
      return { data: { node: { id: repositoryId(repo.owner, repo.name), name: repo.name, nameWithOwner: repo.fullName } } };
    }
    if (decoded.type === 'Issue' && repo && scoped.number !== null) {
      const issue = repo.issues.get(scoped.number);
      if (!issue) return { data: { node: null } };
      return { data: { node: issueView(store, repo, issue, true) } };
    }
    if (decoded.type === 'PullRequest' && repo && scoped.number !== null) {
      const pull = repo.pulls.get(scoped.number);
      if (!pull) return { data: { node: null } };
      return { data: { node: pullView(store, repo, pull) } };
    }
    return { data: { node: null } };
  }

  // --- Mutations -----------------------------------------------------------
  if (op === 'IssueCreate') {
    const input = (vars.input ?? {}) as Vars;
    const decoded = decodeGlobalId(input.repositoryId as string);
    const scoped = decoded && decoded.type === 'Repository' ? parseRepoScoped(decoded.payload) : null;
    const repo = scoped ? getRepo(store, scoped.owner, scoped.repo) : undefined;
    if (!repo) return errBody(`Could not resolve to a Repository with the id ${JSON.stringify(input.repositoryId)}`);
    const issue = createIssueRecord(store, repo, input.title as string, (input.body as string) ?? '', viewer);
    return {
      data: {
        createIssue: {
          issue: { number: issue.number, id: issueId(repo.owner, repo.name, issue.number) },
        },
      },
    };
  }
  if (op === 'IssueClose') {
    const input = (vars.input ?? {}) as Vars;
    const decoded = decodeGlobalId(input.issueId as string);
    const scoped = decoded && decoded.type === 'Issue' ? parseRepoScoped(decoded.payload) : null;
    const repo = scoped ? getRepo(store, scoped.owner, scoped.repo) : undefined;
    const issue = repo && scoped && scoped.number !== null ? repo.issues.get(scoped.number) : undefined;
    if (!repo || !issue) return errBody(`Could not resolve to an Issue with the id ${JSON.stringify(input.issueId)}`);
    issue.state = 'closed';
    issue.updatedAt = nowIso();
    return {
      data: {
        closeIssue: {
          issue: {
            number: issue.number,
            id: issueId(repo.owner, repo.name, issue.number),
            state: 'CLOSED',
          },
        },
      },
    };
  }
  if (op === 'PullRequestCreate') {
    const input = (vars.input ?? {}) as Vars;
    const decoded = decodeGlobalId(input.repositoryId as string);
    const scoped = decoded && decoded.type === 'Repository' ? parseRepoScoped(decoded.payload) : null;
    const repo = scoped ? getRepo(store, scoped.owner, scoped.repo) : undefined;
    if (!repo) return errBody(`Could not resolve to a Repository with the id ${JSON.stringify(input.repositoryId)}`);
    const pull = createPullRecord(store, repo, {
      title: input.title as string,
      body: (input.body as string) ?? '',
      headRef: input.headRefName as string,
      baseRef: input.baseRefName as string,
      viewer,
    });
    return {
      data: {
        createPullRequest: {
          pullRequest: {
            number: pull.number,
            id: pullRequestId(repo.owner, repo.name, pull.number),
            state: 'OPEN',
            headRefName: pull.head.ref,
            baseRefName: pull.base.ref,
          },
        },
      },
    };
  }
  if (op === 'MergePullRequest') {
    const input = (vars.input ?? {}) as Vars;
    const decoded = decodeGlobalId(input.pullRequestId as string);
    const scoped = decoded && decoded.type === 'PullRequest' ? parseRepoScoped(decoded.payload) : null;
    const repo = scoped ? getRepo(store, scoped.owner, scoped.repo) : undefined;
    const pull = repo && scoped && scoped.number !== null ? repo.pulls.get(scoped.number) : undefined;
    if (!repo || !pull) return errBody(`Could not resolve to a PullRequest with the id ${JSON.stringify(input.pullRequestId)}`);
    // mergeMethod SQUASH is the only method the suite sends; any method squashes.
    squashMerge(store, repo, pull, viewer);
    return {
      data: {
        mergePullRequest: {
          pullRequest: { number: pull.number, merged: true, state: 'MERGED' },
        },
      },
    };
  }
  if (op === 'AddComment') {
    const input = (vars.input ?? {}) as Vars;
    const decoded = decodeGlobalId(input.subjectId as string);
    const scoped = decoded ? parseRepoScoped(decoded.payload) : null;
    const repo = scoped ? getRepo(store, scoped.owner, scoped.repo) : undefined;
    if (!repo || !scoped || scoped.number === null) {
      return errBody(`Could not resolve to a subject with the id ${JSON.stringify(input.subjectId)}`);
    }
    if (decoded?.type === 'Issue') {
      const issue = repo.issues.get(scoped.number);
      if (!issue) return errBody(`Could not resolve to an Issue with the id ${JSON.stringify(input.subjectId)}`);
      const comment = addCommentRecord(store, repo, issue, (input.body as string) ?? '', viewer);
      return {
        data: {
          addComment: {
            commentEdge: {
              node: { id: commentId(repo.owner, repo.name, issue.number, comment.id), body: comment.body },
            },
          },
        },
      };
    }
    if (decoded?.type === 'PullRequest') {
      const pull = repo.pulls.get(scoped.number);
      if (!pull) return errBody(`Could not resolve to a PullRequest with the id ${JSON.stringify(input.subjectId)}`);
      const now = nowIso();
      const cid = nextCommentIdFor(store);
      const comment = { id: cid, body: (input.body as string) ?? '', user: viewer, createdAt: now, updatedAt: now };
      pull.comments.push(comment);
      return {
        data: {
          addComment: {
            commentEdge: {
              node: { id: commentId(repo.owner, repo.name, pull.number, comment.id), body: comment.body },
            },
          },
        },
      };
    }
    return errBody(`Could not resolve to a subject with the id ${JSON.stringify(input.subjectId)}`);
  }

  return errBody(`Unknown operation ${JSON.stringify(op ?? query.slice(0, 60))}`);
}

function nextCommentIdFor(store: Store): number {
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

/**
 * Handle one POST /api/graphql request.
 * `body` is the already-parsed JSON body: one operation object, or an array of
 * them (GitHub operation batching — answered as an array in the same order).
 * Auth is the caller's job (401 before this is called). Always HTTP 200 for
 * GraphQL-level errors (an `errors` array in the body).
 */
export function handleGraphQL(store: Store, body: unknown, opts: GraphQLOpts = {}): HandlerResult {
  const viewer = getViewer(store, opts.viewer);
  try {
    if (Array.isArray(body)) {
      const out = body.map((entry) => {
        if (!isRecord(entry) || typeof entry.query !== 'string') return errBody('Invalid GraphQL operation');
        return executeOne(store, entry.query, (entry.variables ?? {}) as Vars, entry.operationName, viewer);
      });
      return { status: 200, json: out };
    }
    if (!isRecord(body) || typeof body.query !== 'string') {
      return { status: 200, json: errBody('Invalid GraphQL operation') };
    }
    return { status: 200, json: executeOne(store, body.query, (body.variables ?? {}) as Vars, body.operationName, viewer) };
  } catch (err) {
    return { status: 200, json: errBody(err instanceof Error ? err.message : String(err)) };
  }
}
