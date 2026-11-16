// Opaque stable global IDs: base64 of "Type:id", stable across calls.
// The id payload is deterministic from store identity (owner/name/number), never
// a bare database id and never random, so the same object answers the same id
// on every read.

export type GlobalType = 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment' | 'User';

export function encodeGlobalId(type: GlobalType, payload: string): string {
  return Buffer.from(`${type}:${payload}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; payload: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const type = text.slice(0, at);
  const payload = text.slice(at + 1);
  if (type === '' || payload === '') return null;
  // Re-encoding must round-trip, otherwise this was not one of our ids.
  if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
  return { type, payload };
}

export function repositoryId(owner: string, name: string): string {
  return encodeGlobalId('Repository', `${owner}/${name}`);
}

export function issueId(owner: string, repo: string, number: number): string {
  return encodeGlobalId('Issue', `${owner}/${repo}:${number}`);
}

export function pullRequestId(owner: string, repo: string, number: number): string {
  return encodeGlobalId('PullRequest', `${owner}/${repo}:${number}`);
}

export function commentId(owner: string, repo: string, issueNumber: number, commentId: number): string {
  return encodeGlobalId('IssueComment', `${owner}/${repo}:${issueNumber}:${commentId}`);
}

/** Parse "owner/repo:number" (Issue/PullRequest payload) or "owner/repo" (Repository). */
export function parseRepoScoped(payload: string): { owner: string; repo: string; number: number | null } | null {
  const hash = payload.lastIndexOf(':');
  let repoPart = payload;
  let number: number | null = null;
  if (hash >= 0) {
    const n = Number(payload.slice(hash + 1));
    if (!Number.isInteger(n)) return null;
    number = n;
    repoPart = payload.slice(0, hash);
  }
  const slash = repoPart.indexOf('/');
  if (slash <= 0 || slash === repoPart.length - 1) return null;
  return { owner: repoPart.slice(0, slash), repo: repoPart.slice(slash + 1), number };
}
