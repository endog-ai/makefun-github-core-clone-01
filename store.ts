// store.ts — one in-memory store (BUILD-PLAN.md "Shared interfaces", exact shapes).
// Everything in Maps; git objects as FULL git object bytes (header "type len\0" + content),
// so SHA-1 = sha1(full bytes). Never touches the filesystem on hot paths (no fs at all).
// hashObject/parseObject come from ./git/index.ts (the git module interface); the stub
// implements them for real, Builder A's real module provides identical signatures.
import { hashObject, parseObject } from './git/index.ts';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface Store {
  objects: Map<string, { type: ObjType; data: Buffer }>; // sha1 hex -> {type, data = FULL bytes}
  repos: Map<string, Repo>; // "owner/name" -> Repo
  users: Map<string, User>; // login -> User
  viewerLogin: string;
  nextId: number; // global id counter (repos, issues, pulls, comments share GitHub's id space loosely)
  nextCommentId: number;
  seq: number; // monotonic creation ordering (sort stability when timestamps tie)
}

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  refs: Map<string, string>; // "refs/heads/main" -> commit sha
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  pulls: Map<number, Pull>;
  nextPullNumber: number;
  labels: Map<string, Label>;
  // --- extras beyond the contract (internal bookkeeping) ---
  id: number;
  createdAt: string;
  updatedAt: string;
  fileCache: Map<string, Map<string, string>>; // commit sha -> (path -> blob sha)
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  id: number;
  seq: number;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  headRepo: string;
  baseRepo: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  id: number;
  seq: number;
  closedAt: string | null;
  merged: boolean;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export { hashObject, parseObject };

// Seeded users, EXACTLY from wire.ts buildScenario() (SCENARIO_SEED 0x6a09e667f3bcc909).
// viewer = users[0] (adaiversen), teammate = users[1], stranger = users[2].
const SEEDED_USERS: readonly [number, string, string][] = [
  [1000, 'adaiversen', 'ada iversen'],
  [1001, 'quinnkeller', 'quinn keller'],
  [1002, 'olgabauer', 'olga bauer'],
  [1003, 'dmitriquist', 'dmitri quist'],
  [1004, 'adanovak', 'ada novak'],
  [1005, 'zanerossi', 'zane rossi'],
  [1006, 'pavelcosta', 'pavel costa'],
  [1007, 'wrenkeller', 'wren keller'],
  [1008, 'coraquist', 'cora quist'],
  [1009, 'elenaulrich', 'elena ulrich'],
  [1010, 'tesssato', 'tess sato'],
  [1011, 'svenrossi', 'sven rossi'],
];

export function createStore(): Store {
  const users = new Map<string, User>();
  for (const [id, login, name] of SEEDED_USERS) {
    users.set(login, { id, login, name, email: `${login}@example.invalid` });
  }
  return {
    objects: new Map(),
    repos: new Map(),
    users,
    viewerLogin: 'adaiversen',
    nextId: 100000,
    nextCommentId: 1,
    seq: 0,
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getUser(store: Store, login: string): User | undefined {
  return store.users.get(login);
}

export function viewer(store: Store): User {
  return store.users.get(store.viewerLogin) as User;
}

// --------------------------------------------------------------------------- repos

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

export function createRepo(
  store: Store,
  owner: string,
  name: string,
  description: string,
  isPrivate: boolean,
): Repo | null {
  if (store.repos.has(repoKey(owner, name))) return null;
  const now = nowIso();
  const repo: Repo = {
    owner,
    name,
    fullName: repoKey(owner, name),
    description,
    defaultBranch: 'main',
    private: isPrivate,
    refs: new Map(),
    issues: new Map(),
    nextIssueNumber: 1,
    pulls: new Map(),
    nextPullNumber: 1,
    labels: new Map(),
    id: store.nextId++,
    createdAt: now,
    updatedAt: now,
    fileCache: new Map(),
  };
  store.repos.set(repo.fullName, repo);
  return repo;
}

export function deleteRepo(store: Store, owner: string, name: string): boolean {
  return store.repos.delete(repoKey(owner, name));
}

export function refName(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

export function branchOfRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** Resolve a ref to a commit sha: branch name, full ref, or a commit sha itself. Null when unborn/unknown. */
export function resolveRef(repo: Repo, store: Store, ref?: string): string | null {
  if (ref === undefined || ref === '' || ref === 'HEAD') {
    return repo.refs.get(refName(repo.defaultBranch)) ?? null;
  }
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const obj = store.objects.get(ref.toLowerCase());
    return obj !== undefined && obj.type === 'commit' ? ref.toLowerCase() : null;
  }
  const direct = repo.refs.get(ref) ?? repo.refs.get(refName(ref));
  return direct ?? null;
}

export function listBranches(repo: Repo): { name: string; sha: string }[] {
  const out: { name: string; sha: string }[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: branchOfRef(ref), sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

// --------------------------------------------------------------------------- git objects

export function putObject(store: Store, type: ObjType, content: Buffer): { sha: string; full: Buffer } {
  const { sha, full } = hashObject(type, content);
  if (!store.objects.has(sha)) store.objects.set(sha, { type, data: full });
  return { sha, full };
}

export function getObject(store: Store, sha: string): { type: ObjType; data: Buffer } | undefined {
  return store.objects.get(sha.toLowerCase());
}

export function makeBlob(store: Store, content: Buffer): string {
  return putObject(store, 'blob', content).sha;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

export function parseCommit(store: Store, sha: string): CommitInfo | null {
  const obj = getObject(store, sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const { content } = parseObject(obj.data);
  const text = content.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(store: Store, sha: string): TreeEntry[] | null {
  const obj = getObject(store, sha);
  if (obj === undefined || obj.type !== 'tree') return null;
  const { content } = parseObject(obj.data);
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < content.length) {
    const sp = content.indexOf(0x20, off);
    if (sp < 0) return null;
    const nul = content.indexOf(0, sp);
    if (nul < 0 || nul + 21 > content.length) return null;
    const mode = content.subarray(off, sp).toString('ascii');
    const name = content.subarray(sp + 1, nul).toString('utf8');
    const sha = content.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

/** Build a tree object from a flat path -> blob-sha map; returns the root tree sha. */
export function buildTree(store: Store, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>; // name -> blob sha
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, blobSha] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, blobSha);
  }
  const writeNode = (node: Node): string => {
    const entries: { mode: string; name: string; sha: string; sortKey: string }[] = [];
    for (const [name, sha] of node.files) entries.push({ mode: '100644', name, sha, sortKey: name });
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, sha: writeNode(child), sortKey: `${name}/` });
    }
    entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const chunks: Buffer[] = [];
    for (const e of entries) {
      chunks.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      chunks.push(Buffer.from(e.sha, 'hex'));
    }
    return putObject(store, 'tree', Buffer.concat(chunks)).sha;
  };
  return writeNode(root);
}

/** Walk a commit's tree into a flat path -> blob-sha map (cached per commit; commits are immutable). */
export function getCommitFiles(store: Store, repo: Repo, commitSha: string): Map<string, string> {
  const cached = repo.fileCache.get(commitSha);
  if (cached !== undefined) return cached;
  const out = new Map<string, string>();
  const info = parseCommit(store, commitSha);
  if (info !== null) {
    const walk = (treeSha: string, prefix: string): void => {
      const entries = parseTree(store, treeSha);
      if (entries === null) return;
      for (const e of entries) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.sha, path);
        else out.set(path, e.sha);
      }
    };
    walk(info.tree, '');
  }
  repo.fileCache.set(commitSha, out);
  return out;
}

export function getBlobContent(store: Store, blobSha: string): Buffer | null {
  const obj = getObject(store, blobSha);
  if (obj === undefined || obj.type !== 'blob') return null;
  return parseObject(obj.data).content;
}

export function makeCommit(
  store: Store,
  treeSha: string,
  parents: string[],
  message: string,
  authorName: string,
  authorEmail: string,
): string {
  const ts = Math.floor(Date.now() / 1000);
  const ident = `${authorName} <${authorEmail}> ${ts} +0000`;
  const lines = [`tree ${treeSha}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  return putObject(store, 'commit', Buffer.from(lines.join('\n'), 'utf8')).sha;
}

/**
 * Commit a set of file changes onto a branch. `changes`: path -> Buffer (set) or null (delete).
 * Starts from the branch tip's files (empty when unborn). Creates blobs + tree + commit, moves
 * the branch ref. Returns the new commit sha and the blob sha per changed path.
 */
export function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  changes: Map<string, Buffer | null>,
  message: string,
  author: User,
): { commitSha: string; blobShas: Map<string, string> } {
  const tip = repo.refs.get(refName(branch)) ?? null;
  const files = tip === null ? new Map<string, string>() : new Map(getCommitFiles(store, repo, tip));
  const blobShas = new Map<string, string>();
  for (const [path, content] of changes) {
    if (content === null) {
      files.delete(path);
    } else {
      const sha = makeBlob(store, content);
      files.set(path, sha);
      blobShas.set(path, sha);
    }
  }
  const treeSha = buildTree(store, files);
  const commitSha = makeCommit(store, treeSha, tip === null ? [] : [tip], message, author.login, author.email);
  repo.refs.set(refName(branch), commitSha);
  repo.updatedAt = nowIso();
  return { commitSha, blobShas };
}

/** First-parent walk from a tip (newest first). Each entry: sha + parsed commit info. */
export function listCommits(
  store: Store,
  repo: Repo,
  ref?: string,
): { sha: string; info: CommitInfo }[] {
  const tip = resolveRef(repo, store, ref);
  const out: { sha: string; info: CommitInfo }[] = [];
  const seen = new Set<string>();
  let cur: string | null = tip;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const info = parseCommit(store, cur);
    if (info === null) break;
    out.push({ sha: cur, info });
    cur = info.parents[0] ?? null;
  }
  return out;
}

/** All ancestors of a commit (any parent), newest-first BFS. */
export function ancestors(store: Store, tip: string | null): Set<string> {
  const out = new Set<string>();
  const queue: string[] = tip === null ? [] : [tip];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (out.has(sha)) continue;
    out.add(sha);
    const info = parseCommit(store, sha);
    if (info !== null) for (const p of info.parents) queue.push(p);
  }
  return out;
}

export function findMergeBase(store: Store, a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  const bAnc = ancestors(store, b);
  const queue: string[] = [a];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (bAnc.has(sha)) return sha;
    const info = parseCommit(store, sha);
    if (info !== null) for (const p of info.parents) queue.push(p);
  }
  return null;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  oldSha: string | null;
  newSha: string | null;
}

function countLines(buf: Buffer | null): number {
  if (buf === null || buf.length === 0) return 0;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  // A trailing newline does not start a new line.
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Diff two file maps (path -> blob sha). Line counts are per-file totals (additions >= 1 for any real change). */
export function diffFiles(store: Store, base: Map<string, string>, head: Map<string, string>): FileChange[] {
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldSha = base.get(path) ?? null;
    const newSha = head.get(path) ?? null;
    if (oldSha === newSha) continue;
    if (oldSha === null) {
      const additions = countLines(getBlobContent(store, newSha as string));
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, oldSha, newSha });
    } else if (newSha === null) {
      const deletions = countLines(getBlobContent(store, oldSha));
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, oldSha, newSha });
    } else {
      const additions = countLines(getBlobContent(store, newSha));
      const deletions = countLines(getBlobContent(store, oldSha));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, oldSha, newSha });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- issues / pulls

export function createIssue(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labelNames: string[],
  userLogin: string,
): Issue {
  const now = nowIso();
  const issue: Issue = {
    number: repo.nextIssueNumber++,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    assignees: [],
    user: userLogin,
    createdAt: now,
    updatedAt: now,
    comments: [],
    id: store.nextId++,
    seq: store.seq++,
    closedAt: null,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  headSha: string,
  baseRef: string,
  baseSha: string,
  userLogin: string,
): Pull {
  const now = nowIso();
  const pull: Pull = {
    number: repo.nextPullNumber++,
    title,
    body,
    state: 'open',
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    headRepo: repo.fullName,
    baseRepo: repo.fullName,
    user: userLogin,
    createdAt: now,
    updatedAt: now,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
    id: store.nextId++,
    seq: store.seq++,
    closedAt: null,
    merged: false,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function nextCommentId(store: Store): number {
  return store.nextCommentId++;
}
