// Anvil Forge — the HTTP server.
//
// One Node http server routes every surface:
//   /healthz                 liveness, no auth
//   /api/v3/...              the REST API
//   /api/graphql             GraphQL (single and batched)
//   /mcp                     the MCP JSON-RPC endpoint
//   /{owner}/{repo}.git/...  git smart HTTP (protocol v0 and v2)
//
// Authentication is uniform: every surface except /healthz requires
// `Authorization: Bearer <$MAKEFUN_SHOP_TOKEN>` when that variable is set.

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  Forge, type Repo, VIEWER_LOGIN, VIEWER_ID, storeObject, flattenTree, buildTreeFromFlat,
  commitTreeOid, createCommit, parseCommit, parseTree,
} from './store.ts';
import {
  repoJson, labelJson, issueJson, issueJsonText, commentJson, pullJson, branchTip, createIssue, createPull,
  mergePull, historyOf, createdIso,
} from './forgeops.ts';
import { executeGraphQL, stripOwnerPrefix } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { advertise, lsRefs, fetchObjects, parseFetchV2, parseFetchV0, receivePack, type GitReply } from './gitserver.ts';
import { diffCommits, countLines } from './gitcore.ts';

const forge = new Forge();
let requestCounter = 0;

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface Reply {
  status: number;
  body: unknown;
  /** Pre-serialized body; when set, send() ships it verbatim. */
  text?: string;
  headers?: Record<string, string>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

function errorJson(status: number, message: string): Reply {
  return json(status, { message });
}

function send(res: ServerResponse, reply: Reply): void {
  requestCounter += 1;
  const text = reply.text ?? (reply.body === undefined || reply.body === null ? '' : JSON.stringify(reply.body));
  res.writeHead(reply.status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
    ...(reply.headers ?? {}),
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, reply: GitReply): void {
  requestCounter += 1;
  res.writeHead(reply.status, {
    'content-type': reply.contentType,
    'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
  });
  res.end(reply.body);
}

/** Parse a JSON body; returns {value} or {error} for the malformed case. */
function parseJsonBody(raw: Buffer): { value: Record<string, unknown> } | { error: Reply } {
  if (raw.length === 0) return { value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { value: {} };
    return { value: value as Record<string, unknown> };
  } catch {
    return { error: errorJson(400, 'Problems parsing JSON') };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Build pagination Link headers on the request's own origin. */
function paginationLinks(req: IncomingMessage, url: URL, page: number, perPage: number, total: number): Record<string, string> {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1) return {};
  const host = req.headers.host ?? 'localhost';
  const make = (target: number): string => {
    const copy = new URL(url.toString());
    copy.searchParams.set('page', String(target));
    copy.searchParams.set('per_page', String(perPage));
    return `<http://${host}${copy.pathname}${copy.search}>`;
  };
  const links: string[] = [];
  if (page < lastPage) links.push(`${make(page + 1)}; rel="next"`, `${make(lastPage)}; rel="last"`);
  if (page > 1) links.push(`${make(page - 1)}; rel="prev"`, `${make(1)}; rel="first"`);
  return links.length === 0 ? {} : { link: links.join(', ') };
}

function pageParams(url: URL): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Resolve {owner}/{repo} path params to a repo; null when owner or repo is wrong. */
function addressedRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(name);
}

// ---------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------

function viewerJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: 'ada iversen', email: 'adaiversen@example.invalid' };
}

function createRepoHandler(body: Record<string, unknown>): Reply {
  const name = str(body.name);
  if (name === '') return errorJson(422, 'Repository creation failed: name is required');
  if (forge.getRepo(name) !== null) {
    return json(422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  const repo = forge.createRepo(name, str(body.description), body.private === true);
  if (repo === null) return errorJson(422, 'Repository creation failed.');
  if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
  return json(201, repoJson(repo));
}

/** PUT/DELETE/GET contents: files and directories addressed by path. */
function contentsGet(repo: Repo, path: string, url: URL): Reply {
  const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) {
    // Unborn repository: the root listing is simply empty.
    if (path === '') return json(200, []);
    return errorJson(404, 'Not Found');
  }
  const tree = commitTreeOid(repo, tip);
  if (tree === null) return errorJson(404, 'Not Found');
  const flat = flattenTree(repo, tree);
  if (path === '') {
    return json(200, directoryListing(repo, tree, ''));
  }
  const blob = flat.get(path);
  if (blob !== undefined) {
    const obj = repo.objects.get(blob.oid);
    const data = obj?.data ?? Buffer.alloc(0);
    const name = path.split('/').pop() as string;
    return json(200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: blob.oid,
      size: data.length,
      name,
      path,
    });
  }
  // Directory?
  const dirTree = subtreeOid(repo, tree, path);
  if (dirTree !== null) return json(200, directoryListing(repo, dirTree, path));
  return errorJson(404, 'Not Found');
}

function directoryListing(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined) return [];
  return parseTree(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
  }));
}

/** The tree id at a slash path below a root tree, or null. */
function subtreeOid(repo: Repo, rootTree: string, path: string): string | null {
  let current = rootTree;
  for (const segment of path.split('/')) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

/** Resolve a branch name, ref or commit id to a commit id. */
function resolveRef(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') return repo.headOid();
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const byRef = repo.refs.get(ref);
  if (byRef !== undefined) return byRef;
  const obj = repo.objects.get(ref);
  if (obj !== undefined && obj.type === 'commit') return ref;
  return null;
}

function contentsPut(repo: Repo, path: string, body: Record<string, unknown>): Reply {
  const branch = str(body.branch) || repo.defaultBranch;
  const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : Buffer.alloc(0);
  const tip = branchTip(repo, branch);
  const flat = tip === null
    ? new Map<string, { oid: string; mode: string }>()
    : flattenTree(repo, commitTreeOid(repo, tip) as string);
  const existing = flat.get(path);
  if (existing !== undefined && typeof body.sha === 'string' && body.sha !== existing.oid) {
    return errorJson(409, 'Conflict: the file has changed since the provided sha');
  }
  const blobOid = storeObject(repo, 'blob', content);
  flat.set(path, { oid: blobOid, mode: '100644' });
  const tree = buildTreeFromFlat(repo, flat);
  const message = str(body.message) || `Update ${path}`;
  const commit = createCommit(repo, tree, tip === null ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  const name = path.split('/').pop() as string;
  return json(existing === undefined ? 201 : 200, {
    content: { name, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
    commit: { sha: commit, message },
  });
}

function contentsDelete(repo: Repo, path: string, body: Record<string, unknown>): Reply {
  const branch = str(body.branch) || repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === null) return errorJson(404, 'Not Found');
  const flat = flattenTree(repo, commitTreeOid(repo, tip) as string);
  const existing = flat.get(path);
  if (existing === undefined) return errorJson(404, 'Not Found');
  if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.oid) {
    return errorJson(409, 'Conflict: the file has changed since the provided sha');
  }
  flat.delete(path);
  const tree = buildTreeFromFlat(repo, flat);
  const message = str(body.message) || `Delete ${path}`;
  const commit = createCommit(repo, tree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  return json(200, { content: null, commit: { sha: commit, message } });
}

function issuesList(repo: Repo, url: URL, req: IncomingMessage): Reply {
  const state = url.searchParams.get('state') ?? 'open';
  const sort = url.searchParams.get('sort') ?? 'created';
  const direction = url.searchParams.get('direction') ?? 'desc';
  let list = [...repo.issues.values()];
  if (state !== 'all') list = list.filter((issue) => issue.state === state);
  list.sort((a, b) => a.number - b.number);
  if (sort === 'created' && direction === 'desc') list.reverse();
  const { page, perPage } = pageParams(url);
  const headers = paginationLinks(req, url, page, perPage, list.length);
  return json(200, paginate(list, page, perPage).map((issue) => issueJson(repo, issue)), headers);
}

function pullsList(repo: Repo, url: URL, req: IncomingMessage): Reply {
  const state = url.searchParams.get('state') ?? 'open';
  let list = [...repo.pulls.values()];
  if (state === 'open') list = list.filter((pull) => !pull.merged && pull.state === 'open');
  else if (state === 'closed') list = list.filter((pull) => pull.merged || pull.state === 'closed');
  list.sort((a, b) => a.number - b.number);
  const { page, perPage } = pageParams(url);
  const headers = paginationLinks(req, url, page, perPage, list.length);
  return json(200, paginate(list, page, perPage).map((pull) => pullJson(repo, pull)), headers);
}

function commitJson(repo: Repo, sha: string, parsed: ReturnType<typeof parseCommit>): Record<string, unknown> {
  return {
    sha,
    commit: {
      message: parsed.message,
      author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: createdIso(repo, 0) },
      committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: createdIso(repo, 0) },
      tree: { sha: parsed.tree },
    },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
  };
}

/** The whole REST router. `segments` is the path after /api/v3. */
function restRoute(req: IncomingMessage, url: URL, segments: string[], body: Record<string, unknown>): Reply {
  const method = req.method ?? 'GET';
  const [head, ...rest] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') return errorJson(404, 'Not Found');
    const host = req.headers.host ?? 'localhost';
    const base = `http://${host}/api/v3`;
    return json(200, {
      current_user_url: `${base}/user`,
      repository_url: `${base}/repos/{owner}/{repo}`,
      issue_search_url: `${base}/search/issues`,
      rate_limit_url: `${base}/rate_limit`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (head === 'meta' && segments.length === 1) {
    return json(200, { installed_version: '1.0.0-anvil', verifiable_password_authentication: false });
  }
  if (head === 'rate_limit' && segments.length === 1) {
    return json(200, { resources: { core: { limit: 5000, remaining: 4999, reset: 1893456000 } }, rate: { limit: 5000, remaining: 4999, reset: 1893456000 } });
  }
  if (head === 'user' && segments.length === 1) {
    if (method === 'GET') return json(200, viewerJson());
    return errorJson(404, 'Not Found');
  }
  if (head === 'user' && rest[0] === 'repos' && segments.length === 2) {
    if (method === 'POST') return createRepoHandler(body);
    if (method === 'GET') {
      const { page, perPage } = pageParams(url);
      const all = forge.listRepos();
      const headers = paginationLinks(req, url, page, perPage, all.length);
      return json(200, paginate(all, page, perPage).map(repoJson), headers);
    }
    return errorJson(404, 'Not Found');
  }
  if (head === 'repos' && rest.length >= 2) {
    const owner = rest[0];
    const name = rest[1];
    const tail = rest.slice(2);
    const repo = addressedRepo(owner, name);
    if (repo === null) return errorJson(404, 'Not Found');
    return repoRoute(req, url, repo, tail, body);
  }
  return errorJson(404, 'Not Found');
}

function repoRoute(req: IncomingMessage, url: URL, repo: Repo, tail: string[], body: Record<string, unknown>): Reply {
  const method = req.method ?? 'GET';
  if (tail.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        forge.repos.delete(repo.name);
        repo.name = body.name;
        forge.repos.set(repo.name, repo);
      }
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.repos.delete(repo.name);
      return json(204, null);
    }
    return errorJson(404, 'Not Found');
  }
  const [head, ...rest] = tail;

  if (head === 'contents') {
    const path = rest.join('/');
    if (method === 'GET') return contentsGet(repo, path, url);
    if (method === 'PUT') return contentsPut(repo, path, body);
    if (method === 'DELETE') return contentsDelete(repo, path, body);
    return errorJson(404, 'Not Found');
  }
  if (head === 'branches') {
    if (rest.length === 0) {
      if (method !== 'GET') return errorJson(404, 'Not Found');
      return json(200, branchNames(repo).map((name) => ({
        name,
        commit: { sha: branchTip(repo, name) as string },
        protected: false,
      })));
    }
    const branch = rest.join('/');
    const tip = branchTip(repo, branch);
    if (tip === null) return errorJson(404, 'Not Found');
    if (method === 'GET') return json(200, { name: branch, commit: { sha: tip }, protected: false });
    return errorJson(404, 'Not Found');
  }
  if (head === 'git' && rest[0] === 'refs') {
    if (method === 'POST' && rest.length === 1) {
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/')) return errorJson(422, 'Validation Failed: ref must be fully qualified');
      if (repo.refs.has(ref)) return errorJson(422, 'Reference already exists');
      const obj = repo.objects.get(sha);
      if (obj === undefined) return errorJson(422, 'Validation Failed: sha does not exist');
      repo.refs.set(ref, sha);
      return json(201, { ref, node_id: '', object: { sha, type: obj.type } });
    }
    if (method === 'GET') {
      const ref = `refs/${rest.slice(1).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return errorJson(404, 'Not Found');
      const obj = repo.objects.get(oid);
      return json(200, { ref, node_id: '', object: { sha: oid, type: obj?.type ?? 'commit' } });
    }
    return errorJson(404, 'Not Found');
  }
  if (head === 'commits') {
    if (method !== 'GET') return errorJson(404, 'Not Found');
    const shaParam = url.searchParams.get('sha');
    const tip = shaParam === null ? repo.headOid() : resolveRef(repo, shaParam);
    if (tip === null) return json(200, []);
    const history = historyOf(repo, tip);
    const { page, perPage } = pageParams(url);
    return json(200, paginate(history, page, perPage).map((entry) => commitJson(repo, entry.sha, entry.parsed)));
  }
  if (head === 'labels') {
    if (rest.length === 0) {
      if (method === 'POST') {
        const name = str(body.name);
        if (name === '') return errorJson(422, 'Validation Failed: name is required');
        const existing = repo.labels.get(name);
        if (existing !== undefined) return json(201, labelJson(repo, name) as Record<string, unknown>);
        const label = {
          id: forge.nextLabelId,
          name,
          color: (str(body.color) || '000000').replace(/^#/, '').toLowerCase(),
          description: str(body.description),
        };
        forge.nextLabelId += 1;
        repo.labels.set(name, label);
        return json(201, labelJson(repo, name) as Record<string, unknown>);
      }
      if (method === 'GET') return json(200, [...repo.labels.keys()].map((n) => labelJson(repo, n)));
      return errorJson(404, 'Not Found');
    }
    const found = labelJson(repo, decodeURIComponent(rest.join('/')));
    return found === null ? errorJson(404, 'Not Found') : json(200, found);
  }
  if (head === 'issues') return issuesRoute(req, url, repo, rest, body);
  if (head === 'pulls') return pullsRoute(req, url, repo, rest, body);
  return errorJson(404, 'Not Found');
}

function branchNames(repo: Repo): string[] {
  const names: string[] = [];
  for (const ref of repo.refs.keys()) {
    if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
  }
  names.sort();
  return names;
}

function issuesRoute(req: IncomingMessage, url: URL, repo: Repo, rest: string[], body: Record<string, unknown>): Reply {
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'POST') {
      const labels = Array.isArray(body.labels)
        ? body.labels.map((x) => (typeof x === 'string' ? x : str((x as Record<string, unknown>)?.name)))
        : [];
      const created = createIssue(forge, repo, { title: str(body.title), body: str(body.body), labels });
      if ('error' in created) return errorJson(422, created.error);
      return json(201, issueJson(repo, created.issue));
    }
    if (method === 'GET') return issuesList(repo, url, req);
    return errorJson(404, 'Not Found');
  }
  const number = Number(rest[0]);
  const issue = repo.issues.get(number);
  if (rest.length === 1) {
    if (issue === undefined) return errorJson(404, 'Not Found');
    if (method === 'GET') return { status: 200, body: null, text: issueJsonText(repo, issue) };
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.map((x) => (typeof x === 'string' ? x : str((x as Record<string, unknown>)?.name)));
        for (const name of labels) if (!repo.labels.has(name)) return errorJson(422, `Validation Failed: label '${name}' does not exist`);
        issue.labels = labels;
      }
      return json(200, issueJson(repo, issue));
    }
    return errorJson(404, 'Not Found');
  }
  if (rest[1] === 'comments') {
    if (issue === undefined) return errorJson(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'POST') {
        const comment = { id: forge.nextCommentId, body: str(body.body), createdSeq: repo.seq };
        forge.nextCommentId += 1;
        repo.seq += 1;
        issue.comments.push(comment);
        return json(201, commentJson(repo, comment));
      }
      if (method === 'GET') {
        const { page, perPage } = pageParams(url);
        return json(200, paginate(issue.comments, page, perPage).map((c) => commentJson(repo, c)));
      }
    }
    return errorJson(404, 'Not Found');
  }
  if (rest[1] === 'labels') {
    if (issue === undefined) return errorJson(404, 'Not Found');
    if (method === 'GET') return json(200, issue.labels.map((n) => labelJson(repo, n)));
    return errorJson(404, 'Not Found');
  }
  return errorJson(404, 'Not Found');
}

function pullsRoute(req: IncomingMessage, url: URL, repo: Repo, rest: string[], body: Record<string, unknown>): Reply {
  const method = req.method ?? 'GET';
  if (rest.length === 0) {
    if (method === 'POST') {
      const created = createPull(forge, repo, {
        title: str(body.title),
        body: str(body.body),
        head: stripOwnerPrefix(str(body.head)),
        base: stripOwnerPrefix(str(body.base)) || repo.defaultBranch,
      });
      if ('error' in created) return errorJson(422, created.error);
      return json(201, pullJson(repo, created.pull));
    }
    if (method === 'GET') return pullsList(repo, url, req);
    return errorJson(404, 'Not Found');
  }
  const number = Number(rest[0]);
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (pull === undefined) return errorJson(404, 'Not Found');
    if (method === 'GET') return json(200, pullJson(repo, pull));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed' || body.state === 'open') pull.state = body.state;
      return json(200, pullJson(repo, pull));
    }
    return errorJson(404, 'Not Found');
  }
  if (rest[1] === 'merge' && rest.length === 2) {
    if (pull === undefined) return errorJson(404, 'Not Found');
    if (method !== 'PUT' && method !== 'POST') return errorJson(404, 'Not Found');
    const outcome = mergePull(repo, pull);
    if (!outcome.merged) {
      if (outcome.reason === 'conflict') return errorJson(405, 'Pull Request is not mergeable: conflicts must be resolved first');
      if (outcome.reason === 'already') return errorJson(405, 'Pull Request is already merged');
      return errorJson(405, 'Pull Request is not mergeable');
    }
    return json(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  if (rest[1] === 'files' && rest.length === 2) {
    if (pull === undefined) return errorJson(404, 'Not Found');
    const headTip = branchTip(repo, pull.head);
    if (headTip === null) return json(200, []);
    const changes = diffCommits(repo, pull.baseShaAtCreate, headTip);
    return json(200, changes.map((change) => {
      const newData = change.newOid === null ? Buffer.alloc(0) : (repo.objects.get(change.newOid)?.data ?? Buffer.alloc(0));
      const oldData = change.oldOid === null ? Buffer.alloc(0) : (repo.objects.get(change.oldOid)?.data ?? Buffer.alloc(0));
      const additions = countLines(newData);
      const deletions = change.status === 'added' ? 0 : countLines(oldData);
      return {
        sha: change.newOid ?? change.oldOid ?? '',
        filename: change.path,
        status: change.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    }));
  }
  return errorJson(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    requestCounter += 1;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (!isAuthorized(req)) {
    send(res, errorJson(401, 'Bad credentials'));
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const [, owner, name, action] = gitMatch;
    const repo = addressedRepo(owner, name);
    if (repo === null) {
      send(res, errorJson(404, 'Not Found'));
      return;
    }
    if (action === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        send(res, errorJson(400, 'unsupported service'));
        return;
      }
      const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      sendRaw(res, advertise(repo, service, v2));
      return;
    }
    const raw = await readBody(req);
    if (action === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      // A v2 body starts with the command line; a v0 body starts with a want line.
      const firstLine = raw.subarray(4, Math.min(raw.length, 128)).toString('utf8');
      if (v2 || firstLine.startsWith('command=')) {
        const command = /command=([a-z-]+)/.exec(firstLine)?.[1];
        if (command === 'ls-refs') {
          sendRaw(res, lsRefs(repo, raw));
          return;
        }
        if (command === 'fetch') {
          const request = parseFetchV2(raw);
          if (request === null) {
            sendRaw(res, { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('invalid pkt-line framing') });
            return;
          }
          sendRaw(res, fetchObjects(repo, request, true));
          return;
        }
        sendRaw(res, { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('unknown command') });
        return;
      }
      const request = parseFetchV0(raw);
      if (request === null) {
        sendRaw(res, { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('invalid pkt-line framing') });
        return;
      }
      sendRaw(res, fetchObjects(repo, request, false));
      return;
    }
    // git-receive-pack
    sendRaw(res, receivePack(repo, raw));
    return;
  }

  if (path === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== 'POST') {
      send(res, errorJson(405, 'Method Not Allowed'));
      return;
    }
    const raw = await readBody(req);
    const reply = handleMcp(forge, raw.toString('utf8'));
    requestCounter += 1;
    if (reply.payload === null) {
      res.writeHead(reply.status);
      res.end();
      return;
    }
    res.writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
    });
    res.end(JSON.stringify(reply.payload));
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      send(res, errorJson(404, 'Not Found'));
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      send(res, errorJson(400, 'Problems parsing JSON'));
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((item) => executeGraphQL(forge, (item ?? {}) as Record<string, unknown>));
      send(res, json(200, results));
      return;
    }
    const result = executeGraphQL(forge, (parsed ?? {}) as Record<string, unknown>);
    send(res, json(200, result));
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
    const raw = method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.length > 0) {
      const parsedBody = parseJsonBody(raw);
      if ('error' in parsedBody) {
        send(res, parsedBody.error);
        return;
      }
      body = parsedBody.value;
    }
    const reply = restRoute(req, url, segments, body);
    if (reply.status === 204) {
      requestCounter += 1;
      res.writeHead(204, { 'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}` });
      res.end();
      return;
    }
    send(res, reply);
    return;
  }

  send(res, errorJson(404, 'Not Found'));
}

/** Build the forge's HTTP server (the entrypoint in main.ts listens with it). */
export function createApp(): Server {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, errorJson(500, 'Internal Server Error'));
      else res.end();
    });
  });
  // The benchmarks are latency-bound request/response ping-pong on single
  // connections; Nagle's algorithm would add a round trip of delay to each.
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}
