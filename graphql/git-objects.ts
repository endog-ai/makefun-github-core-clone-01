// Minimal git object helpers for the GraphQL/MCP layer only:
// SHA-1 object ids, commit/tree parsing, and tree diffs for pullRequest.files.
// The git module (builder A) owns the full pack codec; this file only reads objects
// already in store.objects and creates the single squash-merge commit object.
// Commits received from clients are NEVER re-serialised — only the merge commit
// built here is new, and its bytes are stored verbatim once hashed.
import { createHash } from 'node:crypto';
import type { ObjType, Store } from '../store-types.ts';

export function hashObject(type: ObjType, content: Buffer): { sha: string; full: Buffer } {
  const header = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  const full = Buffer.concat([header, content]);
  const sha = createHash('sha1').update(full).digest('hex');
  return { sha, full };
}

/** Split full object bytes ("type len\0" + content) into type and content. */
export function parseObject(full: Buffer): { type: ObjType; content: Buffer } | null {
  const nul = full.indexOf(0);
  if (nul < 0) return null;
  const header = full.subarray(0, nul).toString('utf8');
  const space = header.indexOf(' ');
  if (space < 0) return null;
  const type = header.slice(0, space) as ObjType;
  if (type !== 'blob' && type !== 'tree' && type !== 'commit' && type !== 'tag') return null;
  return { type, content: full.subarray(nul + 1) };
}

/** The tree sha of a commit object, or null. */
export function commitTreeSha(store: Store, commitSha: string): string | null {
  const obj = store.objects.get(commitSha);
  if (!obj) return null;
  const parsed = parseObject(obj.data);
  if (!parsed || parsed.type !== 'commit') return null;
  const text = parsed.content.toString('utf8');
  const m = /^tree ([0-9a-f]{40})$/m.exec(text);
  return m ? (m[1] as string) : null;
}

/** The parent shas of a commit object (may be empty). */
export function commitParents(store: Store, commitSha: string): string[] {
  const obj = store.objects.get(commitSha);
  if (!obj) return [];
  const parsed = parseObject(obj.data);
  if (!parsed || parsed.type !== 'commit') return [];
  const text = parsed.content.toString('utf8');
  const parents: string[] = [];
  for (const m of text.matchAll(/^parent ([0-9a-f]{40})$/gm)) parents.push(m[1] as string);
  return parents;
}

interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse one tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const content = parseObject(data)?.content ?? data;
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < content.length) {
    const space = content.indexOf(0x20, off);
    if (space < 0) break;
    const nul = content.indexOf(0, space);
    if (nul < 0 || nul + 21 > content.length) break;
    const mode = content.subarray(off, space).toString('utf8');
    const name = content.subarray(space + 1, nul).toString('utf8');
    const sha = content.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

/** Recursively collect path -> blob sha for a tree (blobs only, sorted insertion). */
export function collectTreePaths(store: Store, treeSha: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const obj = store.objects.get(treeSha);
  if (!obj) return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      collectTreePaths(store, entry.sha, path, out);
    } else {
      out.set(path, entry.sha);
    }
  }
  return out;
}

/**
 * Changed file paths between base and head commits: paths whose blob sha differs
 * or that exist only on the head side. Sorted. Empty when either side is unknown
 * except: unknown base + known head lists every head path.
 */
export function diffCommitFiles(store: Store, baseSha: string, headSha: string): string[] {
  const headTree = headSha !== '' ? commitTreeSha(store, headSha) : null;
  if (headTree === null) return [];
  const headPaths = collectTreePaths(store, headTree);
  const baseTree = baseSha !== '' ? commitTreeSha(store, baseSha) : null;
  if (baseTree === null) return [...headPaths.keys()].sort();
  const basePaths = collectTreePaths(store, baseTree);
  const changed: string[] = [];
  for (const [path, sha] of headPaths) {
    if (basePaths.get(path) !== sha) changed.push(path);
  }
  return changed.sort();
}
