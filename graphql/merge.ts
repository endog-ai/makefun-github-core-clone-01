// The ONE squash-merge implementation. GraphQL mergePullRequest, MCP
// merge_pull_request, and (by integration) REST POST .../pulls/{n}/merge all call
// this, so every surface produces the same real merge commit on the default
// branch with the same numbering.
//
// Squash rules (matching the REST pulls contract in BUILD-PLAN.md):
//   - new commit: tree = head commit's tree, parent = base sha (single parent —
//     a squash, not a merge commit with two parents)
//   - author/committer = the viewer, timestamp = now
//   - message: "Merge pull request #N from <owner>/<headRef>\n\n<title>\n"
//   - the base ref refs/heads/<baseRef> advances to the new commit
//   - pull.state = 'merged', mergedAt = now, mergeCommitSha = new sha
//   - REST renders state 'merged' as state:'closed' + merged:true; GraphQL/MCP
//     report merged = (state === 'merged').
// If head/base shas or objects are absent, the PR is still marked merged with
// mergeCommitSha null (the suite always has commits by merge time).
import { commitTreeSha, hashObject } from './git-objects.ts';
import type { Pull, Repo, Store } from '../store-types.ts';

export interface SquashResult {
  merged: boolean;
  mergeCommitSha: string | null;
  alreadyMerged: boolean;
}

export function squashMerge(store: Store, repo: Repo, pull: Pull, viewer: string): SquashResult {
  if (pull.state === 'merged') {
    return { merged: true, mergeCommitSha: pull.mergeCommitSha, alreadyMerged: true };
  }
  const now = new Date().toISOString();
  const headSha = pull.head.sha;
  const baseSha = pull.base.sha;
  let mergeCommitSha: string | null = null;
  const headTree = headSha !== '' ? commitTreeSha(store, headSha) : null;
  if (headTree !== null && baseSha !== '') {
    const ts = Math.floor(Date.now() / 1000);
    const ident = `${viewer} <${viewer}@example.invalid> ${ts} +0000`;
    const content = Buffer.from(
      `tree ${headTree}\nparent ${baseSha}\nauthor ${ident}\ncommitter ${ident}\n\nMerge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}\n\n${pull.title}\n`,
      'utf8',
    );
    const { sha, full } = hashObject('commit', content);
    store.objects.set(sha, { type: 'commit', data: full });
    mergeCommitSha = sha;
    repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
  }
  pull.state = 'merged';
  pull.mergedAt = now;
  pull.updatedAt = now;
  pull.mergeCommitSha = mergeCommitSha;
  return { merged: true, mergeCommitSha, alreadyMerged: false };
}

/** REST/GraphQL view helpers: merged is derived from state, never stored. */
export function isMerged(pull: Pull): boolean {
  return pull.state === 'merged';
}

/** The state string the REST v3 view shows for a pull (GitHub: merged reads closed). */
export function restPullState(pull: Pull): 'open' | 'closed' {
  return pull.state === 'open' ? 'open' : 'closed';
}

/** The state enum the GraphQL v4 view shows. */
export function gqlPullState(pull: Pull): 'OPEN' | 'CLOSED' | 'MERGED' {
  return pull.state === 'open' ? 'OPEN' : pull.state === 'closed' ? 'CLOSED' : 'MERGED';
}
