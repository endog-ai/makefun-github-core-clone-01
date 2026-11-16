// The SHA-1 object model: blob / tree / commit / tag.
//
// An object's id is SHA-1 over its FULL bytes: "<type> <size>\0" + content. Commit objects
// are NEVER re-serialised: they are stored and returned as the exact bytes received, so a
// clone round-trips them byte-exactly (the `clone-commit-bytes` check).

import { createHash } from 'node:crypto';
import type { ObjType, Store } from './types.ts';
import { isOid } from './types.ts';

export const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface ObjectContent {
  type: ObjType;
  /** Raw content WITHOUT the git header. */
  content: Buffer;
}

/** The loose-object header "<type> <size>\0". */
export function objectHeader(type: ObjType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/**
 * Hash an object: SHA-1 over the full bytes. Returns the id and the full bytes
 * (header + content) — the form stored in Store.objects.
 */
export function hashObject(type: ObjType, content: Buffer): { sha: string; full: Buffer } {
  const header = objectHeader(type, content.length);
  const full = Buffer.concat([header, content]);
  const sha = createHash('sha1').update(full).digest('hex');
  return { sha, full };
}

/** Split full object bytes into their type and content. Throws on a malformed header. */
export function parseObject(full: Buffer): ObjectContent {
  const nul = full.indexOf(0x00);
  if (nul < 0) throw new Error('object has no header terminator');
  const header = full.subarray(0, nul).toString('ascii');
  const space = header.indexOf(' ');
  if (space < 0) throw new Error(`object header ${JSON.stringify(header)} has no size`);
  const type = header.slice(0, space);
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`object header names unknown type ${JSON.stringify(type)}`);
  }
  const size = Number(header.slice(space + 1));
  if (!Number.isInteger(size) || size < 0 || size !== full.length - nul - 1) {
    throw new Error(`object header size ${header.slice(space + 1)} does not match its bytes`);
  }
  return { type: type as ObjType, content: full.subarray(nul + 1) };
}

/**
 * Read an object from the store as { type, content }. The store holds full bytes per the
 * contract; content-only storage is tolerated (a header that does not parse, or whose
 * declared size does not match, means the bytes ARE the content).
 */
export function getObject(store: Store, sha: string): ObjectContent | undefined {
  const entry = store.objects.get(sha);
  if (!entry) return undefined;
  try {
    const parsed = parseObject(entry.data);
    if (parsed.type === entry.type) return parsed;
  } catch {
    // Not full bytes — fall through and treat the stored bytes as the content.
  }
  return { type: entry.type, content: entry.data };
}

/** Store an object (content bytes) under its SHA-1; returns the id. */
export function putObject(store: Store, type: ObjType, content: Buffer): string {
  const { sha, full } = hashObject(type, content);
  store.objects.set(sha, { type, data: full });
  return sha;
}

// -------------------------------------------------------------------------------------------
// commit / tree / tag parsing (headers are parsed, message bytes are never touched)
// -------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(content: Buffer): CommitView {
  const blank = content.indexOf('\n\n');
  const headerEnd = blank < 0 ? content.length : blank;
  const headerText = content.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : content.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    // Any other header (gpgsig, encoding, mergetag, ...) is preserved verbatim in the
    // stored bytes; it is not modelled and never re-serialised.
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) {
    if (!isOid(parent)) throw new Error('commit has a bad parent id');
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = content.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > content.length) throw new Error('tree entry has a truncated object id');
    const mode = content.subarray(offset, space).toString('ascii');
    const name = content.subarray(space + 1, nul).toString('utf8');
    const oid = content.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(content: Buffer): TagView {
  const blank = content.indexOf('\n\n');
  const headerEnd = blank < 0 ? content.length : blank;
  const headers = new Map<string, string>();
  for (const line of content.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isOid(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : content.subarray(blank + 2).toString('utf8'),
  };
}

// -------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------

export interface ReachOptions {
  /**
   * Commits in this set are included with their tree and blobs, but their parents are NOT
   * followed — they are the client's shallow boundary (the client already holds them
   * shallowly, so their history is not "held" by the client).
   */
  stopAt?: ReadonlySet<string>;
}

/**
 * Every object reachable from `roots`, as a map oid -> { type, content }.
 * Throws on a missing object, except for a missing parent of a boundary commit (see
 * `collectReachable` callers) — a missing root itself always throws.
 */
export function collectReachable(
  store: Store,
  roots: Iterable<string>,
  options: ReachOptions = {},
): Map<string, ObjectContent> {
  const seen = new Map<string, ObjectContent>();
  const queue: string[] = [];
  for (const root of roots) {
    if (isOid(root)) queue.push(root);
  }
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = getObject(store, oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.content);
      queue.push(commit.tree);
      if (!options.stopAt?.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.content).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.content)) {
        if (entry.mode === '160000') continue; // gitlink: a commit the repo does not hold
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Follow tag objects to the commit they point at; null when the oid is not a commit. */
export function peelToCommit(store: Store, oid: string): string | null {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    if (seen.has(current)) return null; // tag cycle
    seen.add(current);
    const object = getObject(store, current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.content).object;
      continue;
    }
    return null;
  }
}

/** True when `ancestor` is reachable from `descendant` by following commit parents. */
export function isAncestorCommit(store: Store, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = getObject(store, oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.content).parents) queue.push(parent);
  }
  return false;
}

/**
 * Fast-forward test for a ref update old -> new, peeling tags to their commits first.
 * Identical values are a fast-forward; non-commit objects only fast-forward to themselves.
 */
export function isFastForward(store: Store, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const oldCommit = peelToCommit(store, oldOid);
  const newCommit = peelToCommit(store, newOid);
  if (oldCommit !== null && newCommit !== null) {
    return isAncestorCommit(store, oldCommit, newCommit);
  }
  return false;
}
