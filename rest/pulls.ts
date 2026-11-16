// rest/pulls.ts — pull-request routes, incl. SQUASH merge producing a REAL merge commit.
import type { ReqCtx, HandlerResult } from './common.ts';
import {
  bodyObj,
  commentJson,
  err,
  linkHeaders,
  ok,
  ownedRepo,
  paginate,
  pullJson,
  strField,
} from './common.ts';
import {
  buildTree,
  createPull,
  diffFiles,
  findMergeBase,
  getCommitFiles,
  makeCommit,
  nextCommentId,
  nowIso,
  refName,
  resolveRef,
} from '../store.ts';

function pullFiles(ctx: ReqCtx, repoOwner: string, repoName: string, number: number) {
  const repo = ownedRepo(ctx, repoOwner, repoName);
  if (repo === null) return null;
  const pull = repo.pulls.get(number);
  if (pull === undefined) return null;
  return { repo, pull };
}

export function createPullRoute(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const body = bodyObj(ctx);
  const title = strField(body, 'title');
  const headRef = strField(body, 'head');
  const baseRef = strField(body, 'base') || repo.defaultBranch;
  if (title === '' || headRef === '') return err(422, 'title and head are required');
  const headSha = resolveRef(repo, ctx.store, headRef);
  const baseSha = resolveRef(repo, ctx.store, baseRef);
  if (headSha === null || baseSha === null) return err(422, 'head or base branch does not exist');
  const pull = createPull(ctx.store, repo, title, strField(body, 'body'), headRef, headSha, baseRef, baseSha, ctx.viewer.login);
  return ok(201, pullJson(ctx.store, repo, pull));
}

export function listPulls(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((p) => p.state !== 'open');
  // state=all keeps everything.
  pulls.sort((a, b) => b.seq - a.seq);
  const { page, link } = paginate(ctx, pulls, `/api/v3/repos/${repo.fullName}/pulls`);
  return ok(200, page.map((p) => pullJson(ctx.store, repo, p)), linkHeaders(link));
}

export function getPull(ctx: ReqCtx): HandlerResult {
  const found = pullFiles(ctx, ctx.params.owner ?? '', ctx.params.name ?? '', Number(ctx.params.number));
  if (found === null) return err(404, 'Not Found');
  return ok(200, pullJson(ctx.store, found.repo, found.pull));
}

export function listPullFiles(ctx: ReqCtx): HandlerResult {
  const found = pullFiles(ctx, ctx.params.owner ?? '', ctx.params.name ?? '', Number(ctx.params.number));
  if (found === null) return err(404, 'Not Found');
  const { repo, pull } = found;
  const baseFiles = getCommitFiles(ctx.store, repo, pull.base.sha);
  const headFiles = getCommitFiles(ctx.store, repo, pull.head.sha);
  const changes = diffFiles(ctx.store, baseFiles, headFiles);
  return ok(
    200,
    changes.map((c) => ({
      filename: c.filename,
      status: c.status,
      additions: c.additions,
      deletions: c.deletions,
      changes: c.changes,
      blob_url: `https://example.invalid/${repo.fullName}/blob/${pull.head.sha}/${c.filename}`,
      raw_url: `https://example.invalid/${repo.fullName}/raw/${pull.head.sha}/${c.filename}`,
      contents_url: `/api/v3/repos/${repo.fullName}/contents/${c.filename}?ref=${pull.head.sha}`,
    })),
  );
}

export function mergePull(ctx: ReqCtx): HandlerResult {
  const found = pullFiles(ctx, ctx.params.owner ?? '', ctx.params.name ?? '', Number(ctx.params.number));
  if (found === null) return err(404, 'Not Found');
  const { repo, pull } = found;
  if (pull.state !== 'open') return err(405, 'Pull request is already merged or closed');
  const body = bodyObj(ctx);
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  if (method !== 'squash') return err(405, 'Only squash merges are supported');
  const baseTip = resolveRef(repo, ctx.store, pull.base.ref);
  if (baseTip === null) return err(404, 'Not Found');
  const headTip = resolveRef(repo, ctx.store, pull.head.ref);
  if (headTip === null) return err(422, 'head branch no longer exists');
  // Conflict check: a path changed on BOTH sides of the merge-base with different results.
  const mergeBase = findMergeBase(ctx.store, headTip, baseTip);
  const baseFiles = getCommitFiles(ctx.store, repo, baseTip);
  const headFiles = getCommitFiles(ctx.store, repo, headTip);
  if (mergeBase !== null) {
    const ancestorFiles = getCommitFiles(ctx.store, repo, mergeBase);
    const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const a = ancestorFiles.get(path) ?? null;
      const b = baseFiles.get(path) ?? null;
      const h = headFiles.get(path) ?? null;
      if (h !== a && b !== a && h !== b) {
        return err(405, `Merge conflict: ${path} changed on both branches`);
      }
    }
  }
  // Squash: apply the merge-base -> head diff onto the base tip's files.
  const mergedFiles = new Map(baseFiles);
  if (mergeBase !== null) {
    const ancestorFiles = getCommitFiles(ctx.store, repo, mergeBase);
    for (const change of diffFiles(ctx.store, ancestorFiles, headFiles)) {
      if (change.status === 'removed') mergedFiles.delete(change.filename);
      else if (change.newSha !== null) mergedFiles.set(change.filename, change.newSha);
    }
  } else {
    for (const [path, sha] of headFiles) mergedFiles.set(path, sha);
  }
  // Rebuild tree + commit from the merged file map (blobs already exist in the store).
  const treeSha = buildTree(ctx.store, mergedFiles);
  const message = `Squash merge #${pull.number}: ${pull.title}`;
  const mergeSha = makeCommit(ctx.store, treeSha, [baseTip], message, ctx.viewer.login, ctx.viewer.email);
  repo.refs.set(refName(pull.base.ref), mergeSha);
  repo.updatedAt = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  // Keep the stored head/base shas as they were at creation (checks assert them).
  return ok(200, { merged: true, sha: mergeSha, message: 'Pull request successfully merged' });
}

export function createPullComment(ctx: ReqCtx): HandlerResult {
  const found = pullFiles(ctx, ctx.params.owner ?? '', ctx.params.name ?? '', Number(ctx.params.number));
  if (found === null) return err(404, 'Not Found');
  const { repo, pull } = found;
  const body = bodyObj(ctx);
  const text = strField(body, 'body');
  if (text === '') return err(422, 'body is required');
  const now = nowIso();
  const comment = { id: nextCommentId(ctx.store), body: text, user: ctx.viewer.login, createdAt: now, updatedAt: now };
  pull.comments.push(comment);
  return ok(201, commentJson(ctx.store, repo, comment, pull.number, 'pulls'));
}

export function listPullComments(ctx: ReqCtx): HandlerResult {
  const found = pullFiles(ctx, ctx.params.owner ?? '', ctx.params.name ?? '', Number(ctx.params.number));
  if (found === null) return err(404, 'Not Found');
  const { repo, pull } = found;
  const { page, link } = paginate(ctx, pull.comments, `/api/v3/repos/${repo.fullName}/pulls/${pull.number}/comments`);
  return ok(200, page.map((c) => commentJson(ctx.store, repo, c, pull.number, 'pulls')), linkHeaders(link));
}
