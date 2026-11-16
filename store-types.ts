// Store shapes — copied verbatim from BUILD-PLAN.md "Shared interfaces".
// The coordinator re-points this import at the real store.ts (identical shape);
// this file exists so Builder C's modules compile and test standalone.
export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface Store {
  objects: Map<string, { type: ObjType; data: Buffer }>;
  repos: Map<string, Repo>;
  // Optional extras the real store may carry; handlers read them defensively.
  viewerLogin?: string;
  viewer?: { login: string };
}

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  refs: Map<string, string>;
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
