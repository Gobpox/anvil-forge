// Anvil Forge — domain operations shared by the REST, GraphQL and MCP surfaces.
//
// Each operation works on the Forge store and returns plain data; the surfaces
// only translate between their wire format and these calls. Keeping the logic
// in one place is what makes cross-surface parity hold: an issue created over
// MCP is the same record the REST API lists and GraphQL queries.

import {
  Forge, type Repo, type Issue, type PullRequest, VIEWER_LOGIN, VIEWER_ID,
  parseCommit, flattenTree, buildTreeFromFlat, commitTreeOid, createCommit,
  isAncestor, mergeBase, isoOf, trialEpochSeconds,
} from './store.ts';
import { diffCommits } from './gitcore.ts';

/** Creation timestamp of a record, from its logical sequence number. */
export function createdIso(repo: Repo, seq: number): string {
  return isoOf(trialEpochSeconds() + seq * 61);
}

/** The REST shape of a repository. */
export function repoJson(repo: Repo): Record<string, unknown> {
  const created = createdIso(repo, 0);
  return {
    id: repo.id,
    node_id: nodeId('Repository', String(repo.id)),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: created,
    updated_at: created,
    html_url: `https://forge.invalid/${repo.fullName}`,
    clone_url: `https://forge.invalid/${repo.fullName}.git`,
  };
}

/** The REST shape of a label. */
export function labelJson(repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (label === undefined) return null;
  return {
    id: label.id,
    node_id: nodeId('Label', String(label.id)),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `https://forge.invalid/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
  };
}

/** The REST shape of an issue. */
export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const created = createdIso(repo, issue.createdSeq);
  return {
    id: issue.id,
    node_id: nodeId('Issue', String(issue.id)),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)).filter((x) => x !== null),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: created,
    updated_at: created,
    closed_at: issue.state === 'closed' ? created : null,
    html_url: `https://forge.invalid/${repo.fullName}/issues/${issue.number}`,
  };
}

/** The REST shape of a comment. */
export function commentJson(repo: Repo, comment: { id: number; body: string; createdSeq: number }): Record<string, unknown> {
  const created = createdIso(repo, comment.createdSeq);
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', String(comment.id)),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: created,
    updated_at: created,
    html_url: `https://forge.invalid/${repo.fullName}/issues`,
  };
}

/** Tip of a branch, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** The REST shape of a pull request; head/base shas are the live branch tips. */
export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const created = createdIso(repo, pull.createdSeq);
  const headSha = branchTip(repo, pull.head) ?? '';
  const baseSha = branchTip(repo, pull.base) ?? pull.baseShaAtCreate;
  const state = pull.merged ? 'closed' : pull.state;
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', String(pull.id)),
    number: pull.number,
    state,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { label: `${VIEWER_LOGIN}:${pull.head}`, ref: pull.head, sha: headSha },
    base: { label: `${VIEWER_LOGIN}:${pull.base}`, ref: pull.base, sha: baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? null : computeConflict(repo, pull) === null,
    mergeable_state: pull.merged ? 'clean' : computeConflict(repo, pull) === null ? 'clean' : 'dirty',
    created_at: created,
    updated_at: created,
    html_url: `https://forge.invalid/${repo.fullName}/pull/${pull.number}`,
  };
}

/** Opaque, stable GraphQL node ids: base64url of `v1:<Type>:<key>`. */
export function nodeId(type: string, key: string): string {
  return Buffer.from(`v1:${type}:${key}`, 'utf8').toString('base64url');
}

/** Decode a node id back to its type and key; null when it is not one of ours. */
export function decodeNodeId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^v1:([A-Za-z]+):(.+)$/.exec(text);
    if (match === null) return null;
    return { type: match[1], key: match[2] };
  } catch {
    return null;
  }
}

/** Create an issue; returns null plus a reason when a named label is unknown. */
export function createIssue(
  forge: Forge,
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): { issue: Issue } | { error: string } {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `Validation Failed: label '${name}' does not exist` };
  }
  const issue: Issue = {
    id: forge.nextIssueId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: repo.seq,
  };
  forge.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.seq += 1;
  repo.issues.set(issue.number, issue);
  return { issue };
}

/** Create a pull request between two existing branches. */
export function createPull(
  forge: Forge,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): { pull: PullRequest } | { error: string } {
  const headTip = branchTip(repo, input.head);
  const baseTip = branchTip(repo, input.base);
  if (headTip === null) return { error: `Validation Failed: head branch '${input.head}' does not exist` };
  if (baseTip === null) return { error: `Validation Failed: base branch '${input.base}' does not exist` };
  const pull: PullRequest = {
    id: forge.nextIssueId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    head: input.head,
    base: input.base,
    baseShaAtCreate: baseTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: repo.seq,
  };
  forge.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.seq += 1;
  repo.pulls.set(pull.number, pull);
  return { pull };
}

/**
 * Would merging this pull conflict? Returns the conflicting path, or null.
 * The head's changes and the base's changes are both measured against their
 * merge base; a path changed on both sides to different content conflicts.
 */
export function computeConflict(repo: Repo, pull: PullRequest): string | null {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return null;
  if (isAncestor(repo, headTip, baseTip)) return null; // nothing new to merge
  const ancestor = mergeBase(repo, headTip, baseTip);
  const headChanges = diffCommits(repo, ancestor, headTip);
  const baseChanges = diffCommits(repo, ancestor, baseTip);
  const baseByPath = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const baseChange = baseByPath.get(change.path);
    if (baseChange !== undefined && baseChange.newOid !== change.newOid) return change.path;
  }
  return null;
}

export type MergeOutcome =
  | { merged: true; sha: string }
  | { merged: false; reason: 'conflict' | 'already' | 'missing' };

/**
 * Squash-merge a pull request: one new commit on the current base tip whose
 * tree is the base tree with the head's changes (relative to the merge base)
 * applied. The pull is then closed and marked merged.
 */
export function mergePull(repo: Repo, pull: PullRequest): MergeOutcome {
  if (pull.merged) return { merged: false, reason: 'already' };
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return { merged: false, reason: 'missing' };
  const conflict = computeConflict(repo, pull);
  if (conflict !== null) return { merged: false, reason: 'conflict' };
  const ancestor = mergeBase(repo, headTip, baseTip);
  const headChanges = diffCommits(repo, ancestor, headTip);
  const baseTree = commitTreeOid(repo, baseTip);
  const flat = baseTree === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo, baseTree);
  for (const change of headChanges) {
    if (change.newOid === null) flat.delete(change.path);
    else flat.set(change.path, { oid: change.newOid, mode: '100644' });
  }
  const tree = buildTreeFromFlat(repo, flat);
  const message = `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}`;
  const sha = createCommit(repo, tree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = createdIso(repo, repo.seq);
  pull.mergeCommitSha = sha;
  return { merged: true, sha };
}

/** Walk a branch's history newest-first (all ancestors, time descending). */
export function historyOf(repo: Repo, tip: string): { sha: string; parsed: ReturnType<typeof parseCommit> }[] {
  const seen = new Set<string>();
  const out: { sha: string; parsed: ReturnType<typeof parseCommit> }[] = [];
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    out.push({ sha: oid, parsed });
    for (const parent of parsed.parents) stack.push(parent);
  }
  out.sort((a, b) => b.parsed.time - a.parsed.time);
  return out;
}
