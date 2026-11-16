// rest/repos.ts — repository, branch, commit, contents and label routes.
import type { ReqCtx, HandlerResult } from './common.ts';
import {
  b64decodeLoose,
  bodyObj,
  boolField,
  commitJson,
  dirListing,
  err,
  linkHeaders,
  ok,
  ownedRepo,
  paginate,
  repoJson,
  strField,
  labelJson,
} from './common.ts';
import {
  commitFiles,
  createRepo,
  deleteRepo,
  getBlobContent,
  getCommitFiles,
  listBranches,
  listCommits,
  refName,
  resolveRef,
  viewer,
} from '../store.ts';

// --------------------------------------------------------------------------- repos

export function createUserRepo(ctx: ReqCtx): HandlerResult {
  const body = bodyObj(ctx);
  const name = strField(body, 'name');
  if (name === '') return err(422, 'name is required');  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) return err(422, 'invalid repository name');
  const repo = createRepo(ctx.store, ctx.viewer.login, name, strField(body, 'description'), boolField(body, 'private', false));
  if (repo === null) return err(422, 'Repository already exists');
  return ok(201, repoJson(ctx.store, repo));
}

export function listUserRepos(ctx: ReqCtx): HandlerResult {
  const repos = [...ctx.store.repos.values()]
    .filter((r) => r.owner === ctx.viewer.login)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const { page, link } = paginate(ctx, repos, '/api/v3/user/repos');
  return ok(200, page.map((r) => repoJson(ctx.store, r)), linkHeaders(link));
}

export function getRepo(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  return ok(200, repoJson(ctx.store, repo));
}

export function patchRepo(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const body = bodyObj(ctx);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  if (typeof body.default_branch === 'string' && repo.refs.has(refName(body.default_branch))) {
    repo.defaultBranch = body.default_branch;
  }
  repo.updatedAt = new Date().toISOString();
  return ok(200, repoJson(ctx.store, repo));
}

export function deleteRepoRoute(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  deleteRepo(ctx.store, repo.owner, repo.name);
  return { status: 204 };
}

// --------------------------------------------------------------------------- branches / refs

export function listBranchesRoute(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const branches = listBranches(repo).map((b) => ({
    name: b.name,
    commit: { sha: b.sha, url: `/api/v3/repos/${repo.fullName}/commits/${b.sha}` },
    protected: false,
  }));
  return ok(200, branches);
}

export function createRef(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const body = bodyObj(ctx);
  const ref = strField(body, 'ref');
  const sha = strField(body, 'sha').toLowerCase();
  if (ref === '' || sha === '') return err(422, 'ref and sha are required');
  if (!/^[0-9a-f]{40}$/.test(sha)) return err(422, 'invalid sha');
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  const obj = ctx.store.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return err(422, 'unknown commit sha');
  repo.refs.set(ref, sha);
  return ok(201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
}

export function getRef(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const ref = ctx.params.ref ?? '';
  const sha = repo.refs.get(ref) ?? repo.refs.get(refName(ref));
  if (sha === undefined) return err(404, 'Not Found');
  return ok(200, { ref: ref.startsWith('refs/') ? ref : refName(ref), object: { sha, type: 'commit' } });
}

// --------------------------------------------------------------------------- commits

export function listCommitsRoute(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const ref = ctx.query.get('sha') ?? undefined;
  const commits = listCommits(ctx.store, repo, ref);
  const { page, link } = paginate(ctx, commits, `/api/v3/repos/${repo.fullName}/commits`);
  const out: unknown[] = [];
  for (const c of page) {
    const j = commitJson(ctx.store, repo, c.sha);
    if (j !== null) out.push(j);
  }
  return ok(200, out, linkHeaders(link));
}

export function getCommit(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const j = commitJson(ctx.store, repo, ctx.params.sha ?? '');
  if (j === null) return err(404, 'Not Found');
  return ok(200, j);
}

// --------------------------------------------------------------------------- contents

function fileJson(ctx: ReqCtx, repoName: string, path: string, blobSha: string, content: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name,
    path,
    content: content.toString('base64'),
    sha: blobSha,
    url: `/api/v3/repos/${repoName}/contents/${path}`,
    html_url: `https://example.invalid/${repoName}/blob/HEAD/${path}`,
    git_url: `/api/v3/repos/${repoName}/git/blobs/${blobSha}`,
    download_url: `https://example.invalid/${repoName}/raw/HEAD/${path}`,
  };
}

export function getContents(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const path = ctx.params.path ?? '';
  const tip = resolveRef(repo, ctx.store, ctx.query.get('ref') ?? undefined);
  if (tip === null) return err(404, 'Not Found');
  const files = getCommitFiles(ctx.store, repo, tip);
  if (path === '') {
    const listing = dirListing(ctx.store, repo, tip, '') ?? [];
    return ok(200, listing.map((e) => ({ ...e, url: `/api/v3/repos/${repo.fullName}/contents/${e.path}` })));
  }
  const blobSha = files.get(path);
  if (blobSha !== undefined) {
    const content = getBlobContent(ctx.store, blobSha);
    if (content === null) return err(404, 'Not Found');
    return ok(200, fileJson(ctx, repo.fullName, path, blobSha, content));
  }
  // Directory?
  const listing = dirListing(ctx.store, repo, tip, path);
  if (listing === null) return err(404, 'Not Found');
  return ok(200, listing.map((e) => ({ ...e, url: `/api/v3/repos/${repo.fullName}/contents/${e.path}` })));
}

export function putContents(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const path = ctx.params.path ?? '';
  if (path === '') return err(422, 'path is required');
  const body = bodyObj(ctx);
  const message = strField(body, 'message') || `Update ${path}`;
  const contentB64 = strField(body, 'content');
  if (contentB64 === '') return err(422, 'content is required');
  const content = b64decodeLoose(contentB64);
  if (content === null) return err(400, 'content is not valid base64');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = repo.refs.get(refName(branch));
  const files = tip === undefined ? new Map<string, string>() : getCommitFiles(ctx.store, repo, tip);
  const existingSha = files.get(path) ?? null;
  const givenSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
  const isUpdate = existingSha !== null;
  if (isUpdate) {
    if (givenSha === null) return err(409, 'sha is required to update a file');
    if (givenSha !== existingSha) return err(409, 'sha does not match the current file (stale sha)');
  } else if (givenSha !== null) {
    return err(409, 'sha does not match: file does not exist at this ref');
  }
  if (tip === undefined && branch !== repo.defaultBranch) return err(404, 'Not Found');
  const { commitSha, blobShas } = commitFiles(ctx.store, repo, branch, new Map([[path, content]]), message, viewer(ctx.store));
  const blobSha = blobShas.get(path) as string;
  return ok(isUpdate ? 200 : 201, {
    content: { ...fileJson(ctx, repo.fullName, path, blobSha, content), encoding: 'base64' },
    commit: { sha: commitSha, message },
  });
}

export function deleteContents(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const path = ctx.params.path ?? '';
  const body = bodyObj(ctx);
  const message = strField(body, 'message') || `Delete ${path}`;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = repo.refs.get(refName(branch));
  if (tip === undefined) return err(404, 'Not Found');
  const files = getCommitFiles(ctx.store, repo, tip);
  const existingSha = files.get(path);
  if (existingSha === undefined) return err(404, 'Not Found');
  const givenSha = typeof body.sha === 'string' ? body.sha.toLowerCase() : null;
  if (givenSha !== null && givenSha !== existingSha) return err(409, 'sha does not match the current file (stale sha)');
  const { commitSha } = commitFiles(ctx.store, repo, branch, new Map([[path, null]]), message, viewer(ctx.store));
  return ok(200, { content: null, commit: { sha: commitSha, message } });
}

// --------------------------------------------------------------------------- labels

export function listLabels(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  return ok(200, [...repo.labels.values()].map(labelJson));
}

export function createLabel(ctx: ReqCtx): HandlerResult {
  const repo = ownedRepo(ctx, ctx.params.owner ?? '', ctx.params.name ?? '');
  if (repo === null) return err(404, 'Not Found');
  const body = bodyObj(ctx);
  const name = strField(body, 'name');
  if (name === '') return err(422, 'name is required');
  const existing = repo.labels.get(name);
  if (existing !== undefined) return ok(201, labelJson(existing));
  const label = {
    name,
    color: typeof body.color === 'string' && body.color !== '' ? body.color.replace(/^#/, '') : 'ededed',
    description: typeof body.description === 'string' ? body.description : '',
  };
  repo.labels.set(name, label);
  return ok(201, labelJson(label));
}
