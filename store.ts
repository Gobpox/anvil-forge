// Anvil Forge — shared data model.
//
// One in-memory store backs every surface (REST, GraphQL, MCP and the git smart-HTTP
// protocol), so an object created through one surface is immediately visible through
// all the others. Git objects live in a single content-addressed map per repository;
// refs, issues, pull requests and labels hang off the same Repo record.

import { createHash } from 'node:crypto';

/** The one login the trial scenario authenticates as. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  /** Globally unique id (also the GraphQL databaseId). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  /** Tip of the base branch when the pull request was created (diff/merge anchor). */
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export class Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, PullRequest>();
  /** Issues and pull requests share one per-repo number counter, like GitHub. */
  nextNumber = 1;
  /** Monotonic per-repo sequence driving the deterministic logical clock. */
  seq = 0;
  /** Pack bytes cache keyed by the sorted object-id list they were built from. */
  packCache = new Map<string, Buffer>();
  /** Whole fetch-response cache; keys include the head oid and object count, so any push invalidates it. */
  fetchCache = new Map<string, Buffer>();

  constructor(id: number, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  get fullName(): string {
    return `${VIEWER_LOGIN}/${this.name}`;
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  headOid(): string | null {
    return this.refs.get(this.headRef()) ?? null;
  }
}

/** The whole forge: repositories by name plus id generators. */
export class Forge {
  repos = new Map<string, Repo>();
  nextRepoId = 700001;
  nextIssueId = 900001;
  nextCommentId = 950001;
  nextLabelId = 960001;

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(this.nextRepoId, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | null {
    return this.repos.get(name) ?? null;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }
}

/** SHA-1 over the git object framing `<type> <len>\0<data>`. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Insert an object into the store and return its id (idempotent). */
export function storeObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  /** Author timestamp (seconds since epoch) as recorded in the commit. */
  time: number;
}

/** Parse a raw commit object body. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let time = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = /> (\d+) /.exec(line);
      if (match !== null) time = Number(match[1]);
    }
  }
  return { tree, parents, message, time };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a raw tree object body into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories sort as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize entries into a tree object and store it, returning the tree id. */
export function buildTree(repo: Repo, entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(parts));
}

/** Flatten a tree (recursively) into a path -> blob map. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Rebuild nested trees from a flat path -> blob map; returns the root tree id. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, blob] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      let next = node.dirs.get(segments[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segments[i], next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1], blob);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, blob] of node.files) entries.push({ mode: blob.mode, name, oid: blob.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    return buildTree(repo, entries);
  };
  return emit(root);
}

/** The empty tree's id, computed once (it is a constant of the git format). */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

/** Resolve a commit id to its root tree id. */
export function commitTreeOid(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Base epoch for the deterministic logical clock (overridden by MAKEFUN_TRIAL_NOW). */
export function trialEpochSeconds(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber > 1e12 ? asNumber / 1000 : asNumber);
  }
  return 1760000000;
}

/** Format a logical timestamp (seconds) as an ISO-8601 string. */
export function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Create a commit on top of the given parents with the repo's logical clock.
 * Each commit consumes one sequence tick so identical content still yields
 * distinct commits, and nothing depends on the wall clock.
 */
export function createCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const t = trialEpochSeconds() + repo.seq * 61;
  repo.seq += 1;
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${t} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  return storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** All ancestors of a commit (including itself), via parent walk. */
export function ancestorSet(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  return ancestorSet(repo, descendant).has(ancestor);
}

/** Merge base of two commits: the common ancestor with the greatest logical time. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  let best: string | null = null;
  let bestTime = -1;
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    if (ancestorsOfA.has(oid) && parsed.time > bestTime) {
      best = oid;
      bestTime = parsed.time;
    }
    for (const parent of parsed.parents) queue.push(parent);
  }
  return best;
}
