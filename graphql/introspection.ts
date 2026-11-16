// __type introspection data for the exact probes gh sends (checks-graphql.ts):
//   Issue: __type(name: "Issue")           -> fields must include id, number, title, state, body
//   PullRequest: __type(name: "PullRequest") -> must include id, number, headRefName,
//        baseRefName, mergeable, state, merged, files
//   Repository: __type(name: "Repository")  -> must include id, databaseId, name,
//        nameWithOwner, owner, defaultBranchRef, viewerPermission, hasIssuesEnabled,
//        issue, issues, pullRequests, pullRequest
//   SearchType: __type(name: "SearchType")  -> enumValues must include ISSUE
// includeDeprecated is accepted and ignored (all fields listed either way).
// Unknown type names answer __type: null, no errors (GraphQL-correct).

const FIELDS: Record<string, string[]> = {
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyHTML', 'bodyText', 'state',
    'author', 'assignees', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt',
    'url', 'resourcePath', 'locked', 'milestone', 'reactions', 'timelineItems',
    'participants', 'repository', 'viewerCanUpdate', 'isPinned',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyHTML', 'bodyText', 'state',
    'merged', 'mergeable', 'mergeStateStatus', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'headRepository', 'baseRepository', 'files',
    'commits', 'reviews', 'author', 'assignees', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'url',
    'resourcePath', 'additions', 'deletions', 'changedFiles', 'isDraft',
    'viewerCanUpdate', 'repository',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
    'pullRequests', 'pullRequest', 'isPrivate', 'isFork', 'createdAt', 'updatedAt',
    'url', 'resourcePath', 'homepageUrl', 'stargazerCount', 'forkCount',
    'primaryLanguage', 'languages', 'licenseInfo', 'topics', 'refs', 'ref',
    'object', 'releases', 'watchers', 'diskUsage', 'isArchived', 'isDisabled',
    'viewerCanAdminister', 'viewerHasStarred', 'mentionableUsers', 'assignableUsers',
  ],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', 'bio', 'company', 'location', 'createdAt', 'updatedAt', 'repositories', 'issues', 'pullRequests'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyHTML', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', 'resourcePath', 'reactions', 'issue', 'repository'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Label: ['id', 'name', 'color', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

/** The __type result for `name`, or null when the schema has no such type. */
export function typeInfo(name: string): Record<string, unknown> | null {
  if (Object.prototype.hasOwnProperty.call(FIELDS, name)) {
    return {
      kind: 'OBJECT',
      name,
      fields: (FIELDS[name] as string[]).map((f) => ({ name: f })),
    };
  }
  if (Object.prototype.hasOwnProperty.call(ENUM_VALUES, name)) {
    return {
      kind: 'ENUM',
      name,
      enumValues: (ENUM_VALUES[name] as string[]).map((v) => ({ name: v })),
    };
  }
  return null;
}
