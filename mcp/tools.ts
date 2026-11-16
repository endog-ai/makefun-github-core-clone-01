// MCP tools: the 6 required tools, byte-identical tools/list.
// The TOOLS array is frozen and returned by reference — the handler never
// mutates it, so two tools/list answers are byte-identical.
// Schemas use the property names the suite maps its documented arguments onto
// (checks-mcp.ts ARGUMENT_SYNONYMS): owner/repo/title/body/head/base/
// pull_number/name/description/private/state. `required` holds ONLY properties
// the suite can fill — a required property it cannot fill fails the check.
import { squashMerge } from '../graphql/merge.ts';
import {
  createIssueRecord, createPullRecord, createRepoRecord, getRepo, getViewer,
  restIssueObject, restPullObject, restRepoObject,
} from '../store-ops.ts';
import type { Store } from '../store-types.ts';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function textResult(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], structuredContent: { error: message }, isError: true };
}

export const SERVER_NAME = 'github-core-clone-forge';
export const SERVER_VERSION = '1.0.0';
/** Revisions server/discover advertises (current first). */
export const SUPPORTED_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05',
]);
export const PREFERRED_VERSION = '2026-07-28';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

function tool(name: string, description: string, properties: Record<string, Record<string, unknown>>, required: string[]): ToolDef {
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze(properties),
      required: Object.freeze(required),
      additionalProperties: false,
    }),
  });
}

export const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repository', 'Create a new repository owned by the authenticated user.', {
    name: { type: 'string', description: 'Repository name.' },
    description: { type: 'string', description: 'Repository description.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
    owner: { type: 'string', description: 'Owner login (defaults to the authenticated user).' },
  }, ['name']),
  tool('get_repository', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    title: { type: 'string', description: 'Issue title.' },
    body: { type: 'string', description: 'Issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    state: { type: 'string', description: 'Issue state filter: open, closed, or all.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    title: { type: 'string', description: 'Pull request title.' },
    body: { type: 'string', description: 'Pull request body.' },
    head: { type: 'string', description: 'Head branch name.' },
    base: { type: 'string', description: 'Base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash-merge a pull request.', {
    owner: { type: 'string', description: 'Repository owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    pull_number: { type: 'integer', description: 'Pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
]);

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/** Required properties of a tool (for the missing-arguments -32602 path). */
export function requiredOf(name: string): string[] {
  const t = TOOLS.find((x) => x.name === name);
  return t ? [...t.inputSchema.required] : [];
}

/** Missing required arguments (absent, null, or empty-string for strings). */
export function missingArgs(name: string, args: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const prop of requiredOf(name)) {
    const v = args[prop];
    if (v === undefined || v === null || v === '') missing.push(prop);
  }
  return missing;
}

function asRepoArg(args: Record<string, unknown>): { owner: string; repo: string } {
  const owner = typeof args.owner === 'string' ? args.owner : (typeof args.owner_login === 'string' ? args.owner_login : '');
  let repo = typeof args.repo === 'string' ? args.repo : (typeof args.repository === 'string' ? args.repository : '');
  if (repo === '' && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) repo = parts[1] as string;
  }
  return { owner, repo };
}

/**
 * Execute one tool. Returns a ToolResult; domain failures (unknown repo/issue/
 * pull) are isError results, never thrown and never HTTP 500.
 */
export function callTool(store: Store, name: string, args: Record<string, unknown>, viewer: string): ToolResult {
  switch (name) {
    case 'create_repository': {
      const repoName = args.name as string;
      const owner = viewer;
      if (getRepo(store, owner, repoName)) return errorResult(`Repository ${owner}/${repoName} already exists`);
      const repo = createRepoRecord(store, owner, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
        viewer,
      });
      return textResult(restRepoObject(store, repo));
    }
    case 'get_repository': {
      const { owner, repo: repoName } = asRepoArg(args);
      const repo = getRepo(store, owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      return textResult(restRepoObject(store, repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = asRepoArg(args);
      const repo = getRepo(store, owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const issue = createIssueRecord(store, repo, args.title as string, typeof args.body === 'string' ? args.body : '', viewer);
      const obj = restIssueObject(store, repo, issue);
      return textResult({ ...obj, number: issue.number, state: 'open' });
    }
    case 'list_issues': {
      const { owner, repo: repoName } = asRepoArg(args);
      const repo = getRepo(store, owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => a.number - b.number)
        .map((i) => restIssueObject(store, repo, i));
      return textResult(list);
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = asRepoArg(args);
      const repo = getRepo(store, owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const pull = createPullRecord(store, repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        headRef: args.head as string,
        baseRef: args.base as string,
        viewer,
      });
      return textResult({ ...restPullObject(store, repo, pull), number: pull.number, state: 'open', merged: false });
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = asRepoArg(args);
      const repo = getRepo(store, owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const num = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(num);
      if (!pull) return errorResult(`Pull request #${String(args.pull_number)} not found`);
      if (pull.state === 'closed') return errorResult(`Pull request #${num} is closed`);
      const res = squashMerge(store, repo, pull, viewer);
      return textResult({ ...restPullObject(store, repo, pull), number: pull.number, state: 'closed', merged: true, merge_commit_sha: res.mergeCommitSha });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

export function getViewerFor(store: Store, optsViewer?: string): string {
  return getViewer(store, optsViewer);
}
