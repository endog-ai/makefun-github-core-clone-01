// rest/issues.ts — issue, comment and label-attach routes.
import type { ReqCtx, HandlerResult } from './common.ts';
import {
  bodyObj,
  commentJson,
  err,
  issueJson,
  linkHeaders,
  ok,
  ownedRepo,
  paginate,
  strField,
} from './common.ts';
import { createIssue, nextCommentId, nowIso } from '../store.ts';

function labelsOf(body: Record<string, unknown>): string[] {
  const v = body.labels;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

export function createIssueRoute(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const body = bodyObj(ctx);
  const title = strField(body, 'title');
  if (title === '') return err(422, 'title is required');
  const labels = labelsOf(body);
  for (const name of labels) {
    if (!repo.labels.has(name)) return err(422, `unknown label: ${name}`);
  }
  const issue = createIssue(ctx.store, repo, title, strField(body, 'body'), labels, ctx.viewer.login);
  if (Array.isArray(body.assignees)) {
    issue.assignees = (body.assignees as unknown[]).filter((x): x is string => typeof x === 'string');
  }
  return ok(201, issueJson(ctx.store, repo, issue));
}

export function listIssues(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((i) => i.state === 'open');
  else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
  // state=all (or anything else) keeps everything.
  if (sort === 'created' || sort === 'updated') {
    // Creation order == update order for the checks' purposes (seq is monotonic).
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const { page, link } = paginate(ctx, issues, `/api/v3/repos/${repo.fullName}/issues`);
  return ok(200, page.map((i) => issueJson(ctx.store, repo, i)), linkHeaders(link));
}

export function getIssue(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const issue = repo.issues.get(Number(ctx.params.number));
  if (issue === undefined) return err(404, 'Not Found');
  return ok(200, issueJson(ctx.store, repo, issue));
}

export function patchIssue(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const issue = repo.issues.get(Number(ctx.params.number));
  if (issue === undefined) return err(404, 'Not Found');
  const body = bodyObj(ctx);
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? nowIso() : null;
  }
  if (Array.isArray(body.labels)) {
    const labels = labelsOf(body);
    for (const name of labels) {
      if (!repo.labels.has(name)) return err(422, `unknown label: ${name}`);
    }
    issue.labels = labels;
  }
  if (Array.isArray(body.assignees)) {
    issue.assignees = (body.assignees as unknown[]).filter((x): x is string => typeof x === 'string');
  }
  issue.updatedAt = nowIso();
  return ok(200, issueJson(ctx.store, repo, issue));
}

export function createIssueComment(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const issue = repo.issues.get(Number(ctx.params.number));
  if (issue === undefined) return err(404, 'Not Found');
  const body = bodyObj(ctx);
  const text = strField(body, 'body');
  if (text === '') return err(422, 'body is required');
  const now = nowIso();
  const comment = { id: nextCommentId(ctx.store), body: text, user: ctx.viewer.login, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  return ok(201, commentJson(ctx.store, repo, comment, issue.number, 'issues'));
}

export function listIssueComments(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const issue = repo.issues.get(Number(ctx.params.number));
  if (issue === undefined) return err(404, 'Not Found');
  const { page, link } = paginate(ctx, issue.comments, `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`);
  return ok(200, page.map((c) => commentJson(ctx.store, repo, c, issue.number, 'issues')), linkHeaders(link));
}
