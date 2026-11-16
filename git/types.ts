// Shared shapes for the git module — mirrors BUILD-PLAN.md "Shared interfaces" exactly.
// The store itself is owned by builder B (build/store-rest/); this file only declares the
// shapes the git module codes against, so both sides compile against one contract.
//
// Object storage convention (per BUILD-PLAN): store.objects values hold the FULL git object
// bytes (header "type len\0" + content), so SHA-1 = sha1(full bytes). The git module's read
// helpers tolerate content-only storage too (see objects.ts getObject), but writes always
// store full bytes.

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface StoredObject {
  type: ObjType;
  /** Full git object bytes: "<type> <len>\0" + content. */
  data: Buffer;
}

export interface Store {
  objects: Map<string, StoredObject>;
  repos: Map<string, Repo>;
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
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export const ZERO_OID = '0'.repeat(40);

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}
