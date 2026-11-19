// Anvil Forge — the GraphQL surface.
//
// A small, dependency-free GraphQL implementation covering the document shapes
// a GitHub client actually sends here: named operations, variables, aliases,
// inline and named fragments, list/object/enum literals, batching (a JSON
// array body answers with an array of results), connection pagination with
// opaque cursors, the mutations the REST surface mirrors, and the slice of
// introspection schema browsers ask for.

import { Forge, type Repo, type Issue, type PullRequest, VIEWER_LOGIN, VIEWER_ID } from './store.ts';
import {
  nodeId, decodeNodeId, createIssue, createPull, mergePull, computeConflict, branchTip,
} from './forgeops.ts';
import { diffCommits } from './gitcore.ts';

// ---------------------------------------------------------------------------
// Lexer / parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  varDefaults: Map<string, ValueNode>;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (/\s|,/.test(ch)) {
      i += 1;
    } else if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
    } else if ('{}()[]:$@!=|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
    } else if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GqlSyntaxError('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
      } else {
        let j = i + 1;
        let value = '';
        while (j < source.length && source[j] !== '"') {
          if (source[j] === '\\') {
            const esc = source[j + 1];
            value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
            j += 2;
          } else {
            value += source[j];
            j += 1;
          }
        }
        if (j >= source.length) throw new GqlSyntaxError('unterminated string');
        tokens.push(`"${value}"`);
        i = j + 1;
      }
    } else if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
    } else {
      throw new GqlSyntaxError(`unexpected character ${ch}`);
    }
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlSyntaxError(`expected ${token}, got ${got}`);
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek() !== null) {
      const head = this.peek() as string;
      if (head === '{') {
        doc.operations.push({ type: 'query', name: null, varDefaults: new Map(), selections: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== null && this.peek() !== '(' && this.peek() !== '{' && this.peek() !== '@') name = this.next();
        const varDefaults = new Map<string, ValueNode>();
        if (this.peek() === '(') this.parseVariableDefinitions(varDefaults);
        this.skipDirectives();
        doc.operations.push({ type: head === 'mutation' ? 'mutation' : 'query', name, varDefaults, selections: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        this.next(); // type condition
        this.skipDirectives();
        doc.fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new GqlSyntaxError(`unexpected token ${head}`);
      }
    }
    return doc;
  }

  private parseVariableDefinitions(defaults: Map<string, ValueNode>): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      const name = this.next();
      this.expect(':');
      this.parseType();
      if (this.peek() === '=') {
        this.next();
        defaults.set(name, this.parseValue());
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          this.next();
          this.expect(':');
          this.parseValue();
        }
        this.expect(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.peek() === '{') {
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
      } else {
        selections.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    this.skipDirectives();
    const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, ValueNode>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d/.test(token)) return { kind: 'number', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

/** Resolve a value node against the operation's variables. */
function resolveValue(node: ValueNode, vars: Map<string, unknown>): unknown {
  switch (node.kind) {
    case 'var': return vars.get(node.name);
    case 'string': return node.value;
    case 'number': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = resolveValue(value, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema: tagged values and field resolvers
// ---------------------------------------------------------------------------

type Tagged =
  | { __type: 'User' }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __type: 'Ref'; name: string }
  | { __type: 'ChangedFile'; path: string }
  | { __type: 'Comment'; id: number; body: string }
  | { __type: 'Label'; name: string; color: string }
  | { __type: '__Type'; name: string }
  | { __type: '__Schema' };

interface Ctx {
  forge: Forge;
  vars: Map<string, unknown>;
  doc: DocumentNode;
  errors: { message: string }[];
}

type Resolver = (value: Tagged, args: Map<string, unknown>, ctx: Ctx) => unknown;

const userValue: Tagged = { __type: 'User' };

function issueState(issue: Issue): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function connection<T>(items: T[], first: unknown, after: unknown): Record<string, unknown> {
  const start = typeof after === 'string' ? decodeCursor(after) : 0;
  const limit = typeof first === 'number' && first > 0 ? Math.floor(first) : items.length;
  const slice = items.slice(start, start + limit);
  const hasNext = start + slice.length < items.length;
  return {
    nodes: slice,
    edges: slice.map((node) => ({ node, cursor: encodeCursor(start + slice.indexOf(node) + 1) })),
    pageInfo: {
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(start + 1) : null,
      endCursor: slice.length > 0 ? encodeCursor(start + slice.length) : null,
    },
    totalCount: items.length,
  };
}

function encodeCursor(position: number): string {
  return Buffer.from(`cursor:${position}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'isPrivate', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments',
    'repository', 'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt',
    'mergedAt', 'mergeCommit', 'additions', 'deletions', 'changedFiles',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  Permission: ['ADMIN', 'WRITE', 'READ', 'NONE'],
  OrderDirection: ['ASC', 'DESC'],
};

const resolvers: Record<string, Record<string, Resolver>> = {
  User: {
    id: () => nodeId('User', String(VIEWER_ID)),
    login: () => VIEWER_LOGIN,
    name: () => 'ada iversen',
    email: () => 'adaiversen@example.invalid',
    databaseId: () => VIEWER_ID,
  },
  Ref: {
    id: (value) => nodeId('Ref', (value as { name: string }).name),
    name: (value) => (value as { name: string }).name,
    prefix: () => 'refs/heads/',
  },
  Repository: {
    id: (value) => nodeId('Repository', String((value as { repo: Repo }).repo.id)),
    databaseId: (value) => (value as { repo: Repo }).repo.id,
    name: (value) => (value as { repo: Repo }).repo.name,
    nameWithOwner: (value) => (value as { repo: Repo }).repo.fullName,
    owner: () => userValue,
    description: (value) => (value as { repo: Repo }).repo.description,
    isPrivate: (value) => (value as { repo: Repo }).repo.isPrivate,
    defaultBranchRef: (value) => {
      const repo = (value as { repo: Repo }).repo;
      return repo.headOid() === null ? null : { __type: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (value, args) => {
      const repo = (value as { repo: Repo }).repo;
      const issue = repo.issues.get(Number(args.get('number')));
      return issue === undefined ? null : { __type: 'Issue', repo, issue };
    },
    issues: (value, args) => {
      const repo = (value as { repo: Repo }).repo;
      let list = [...repo.issues.values()];
      const states = args.get('states');
      if (Array.isArray(states)) {
        const wanted = new Set(states.map((s) => String(s).toUpperCase()));
        list = list.filter((issue) => wanted.has(issueState(issue)));
      }
      const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
      const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'ASC';
      list.sort((a, b) => a.number - b.number);
      if (direction === 'DESC') list.reverse();
      return connection(list.map((issue) => ({ __type: 'Issue', repo, issue })), args.get('first'), args.get('after'));
    },
    pullRequest: (value, args) => {
      const repo = (value as { repo: Repo }).repo;
      const pull = repo.pulls.get(Number(args.get('number')));
      return pull === undefined ? null : { __type: 'PullRequest', repo, pull };
    },
    pullRequests: (value, args) => {
      const repo = (value as { repo: Repo }).repo;
      let list = [...repo.pulls.values()];
      const states = args.get('states');
      if (Array.isArray(states)) {
        const wanted = new Set(states.map((s) => String(s).toUpperCase()));
        list = list.filter((pull) => wanted.has(pullState(pull)));
      }
      list.sort((a, b) => b.number - a.number);
      return connection(list.map((pull) => ({ __type: 'PullRequest', repo, pull })), args.get('first'), args.get('after'));
    },
  },
  Issue: {
    id: (value) => nodeId('Issue', String((value as { issue: Issue }).issue.id)),
    databaseId: (value) => (value as { issue: Issue }).issue.id,
    number: (value) => (value as { issue: Issue }).issue.number,
    title: (value) => (value as { issue: Issue }).issue.title,
    body: (value) => (value as { issue: Issue }).issue.body,
    state: (value) => issueState((value as { issue: Issue }).issue),
    author: () => userValue,
    repository: (value) => ({ __type: 'Repository', repo: (value as { repo: Repo }).repo }),
    labels: (value) => {
      const { repo, issue } = value as { repo: Repo; issue: Issue };
      return {
        nodes: issue.labels.map((name) => ({ __type: 'Label', name, color: repo.labels.get(name)?.color ?? '000000' })),
      };
    },
    comments: (value, args) => {
      const { issue } = value as { issue: Issue };
      return connection(
        issue.comments.map((comment) => ({ __type: 'Comment', id: comment.id, body: comment.body })),
        args.get('first'),
        args.get('after'),
      );
    },
  },
  PullRequest: {
    id: (value) => nodeId('PullRequest', String((value as { pull: PullRequest }).pull.id)),
    databaseId: (value) => (value as { pull: PullRequest }).pull.id,
    number: (value) => (value as { pull: PullRequest }).pull.number,
    title: (value) => (value as { pull: PullRequest }).pull.title,
    body: (value) => (value as { pull: PullRequest }).pull.body,
    state: (value) => pullState((value as { pull: PullRequest }).pull),
    merged: (value) => (value as { pull: PullRequest }).pull.merged,
    mergeable: (value) => {
      const { repo, pull } = value as { repo: Repo; pull: PullRequest };
      if (pull.merged) return 'UNKNOWN';
      return computeConflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (value) => (value as { pull: PullRequest }).pull.head,
    baseRefName: (value) => (value as { pull: PullRequest }).pull.base,
    headRef: (value) => ({ __type: 'Ref', name: (value as { pull: PullRequest }).pull.head }),
    baseRef: (value) => ({ __type: 'Ref', name: (value as { pull: PullRequest }).pull.base }),
    author: () => userValue,
    repository: (value) => ({ __type: 'Repository', repo: (value as { repo: Repo }).repo }),
    mergedAt: (value) => (value as { pull: PullRequest }).pull.mergedAt,
    files: (value, args) => {
      const { repo, pull } = value as { repo: Repo; pull: PullRequest };
      const headTip = branchTip(repo, pull.head);
      const changes = headTip === null ? [] : diffCommits(repo, pull.baseShaAtCreate, headTip);
      return connection(
        changes.map((change) => ({ __type: 'ChangedFile', path: change.path })),
        args.get('first'),
        args.get('after'),
      );
    },
  },
  ChangedFile: {
    path: (value) => (value as { path: string }).path,
  },
  Comment: {
    id: (value) => nodeId('IssueComment', String((value as { id: number }).id)),
    databaseId: (value) => (value as { id: number }).id,
    body: (value) => (value as { body: string }).body,
    author: () => userValue,
  },
  Label: {
    id: (value) => nodeId('Label', (value as { name: string }).name),
    name: (value) => (value as { name: string }).name,
    color: (value) => (value as { color: string }).color,
  },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function isTagged(value: unknown): value is Tagged {
  return typeof value === 'object' && value !== null && '__type' in value;
}

function executeSelections(value: unknown, typeName: string, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(value, typeName, selection.selections, ctx));
      }
    } else if (selection.kind === 'spread') {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelections(value, typeName, fragment, ctx));
    } else {
      const field = selection.field;
      const key = field.alias ?? field.name;
      out[key] = executeField(value, typeName, field, ctx);
    }
  }
  return out;
}

function executeField(value: unknown, typeName: string, field: FieldNode, ctx: Ctx): unknown {
  if (field.name === '__typename') return typeName;
  if (field.name === '__type' && typeName === 'Query') {
    const name = String(resolveValue(field.args.get('name') as ValueNode, ctx.vars) ?? '');
    return executeSelections({ __type: '__Type', name }, '__Type', field.selections, ctx);
  }
  if (field.name === '__schema' && typeName === 'Query') {
    const schemaValue: Tagged = { __type: '__Schema' };
    return executeSelections(schemaValue, '__Schema', field.selections, ctx);
  }
  const args = new Map<string, unknown>();
  for (const [argName, argNode] of field.args) args.set(argName, resolveValue(argNode, ctx.vars));

  const typeResolvers = resolvers[typeName];
  const resolver = typeResolvers?.[field.name];
  if (resolver !== undefined && isTagged(value)) {
    const resolved = resolver(value, args, ctx);
    return completeValue(resolved, field, ctx);
  }
  // Plain-object values (connections, pageInfo, introspection rows): read properties.
  if (typeof value === 'object' && value !== null && !isTagged(value)) {
    const record = value as Record<string, unknown>;
    if (field.name in record) return completeValue(record[field.name], field, ctx);
  }
  if (typeResolvers !== undefined || TYPE_FIELDS[typeName] !== undefined) {
    ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  return null;
}

/** Apply a field's sub-selections to a resolved value. */
function completeValue(resolved: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (field.selections.length === 0) return resolved;
  if (Array.isArray(resolved)) {
    return resolved.map((item) => completeValue(item, field, ctx));
  }
  if (isTagged(resolved)) {
    return executeSelections(resolved, resolved.__type, field.selections, ctx);
  }
  if (typeof resolved === 'object') {
    // Infer a display type for plain objects so unknown-field errors name something sane.
    const record = resolved as Record<string, unknown>;
    const inferred = 'pageInfo' in record || 'nodes' in record ? 'Connection' : 'Object';
    return executeSelections(record, inferred, field.selections, ctx);
  }
  return resolved;
}

// Introspection pseudo-types resolve through plain objects.
resolvers['__Type'] = {
  name: (value) => (value as { name: string }).name,
  kind: (value) => {
    const name = (value as { name: string }).name;
    if (ENUM_TYPES[name] !== undefined) return 'ENUM';
    if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID') return 'SCALAR';
    return 'OBJECT';
  },
  fields: (value) => {
    const name = (value as { name: string }).name;
    const fields = TYPE_FIELDS[name];
    if (fields === undefined) return null;
    return fields.map((fieldName) => ({ name: fieldName, description: null }));
  },
  enumValues: (value) => {
    const name = (value as { name: string }).name;
    const values = ENUM_TYPES[name];
    if (values === undefined) return null;
    return values.map((valueName) => ({ name: valueName, description: null }));
  },
  description: () => null,
  possibleTypes: () => null,
  inputFields: () => null,
  ofType: () => null,
  specifiedByURL: () => null,
};
resolvers['__Schema'] = {
  types: () => [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_TYPES)].map((name) => ({ __type: '__Type', name })),
  queryType: () => ({ __type: '__Type', name: 'Query' }),
  mutationType: () => ({ __type: '__Type', name: 'Mutation' }),
  subscriptionType: () => null,
  directives: () => [],
};

/** Resolve a node id (or a bare numeric repository id) to a tagged value. */
function nodeById(forge: Forge, id: string): Tagged | null {
  const decoded = decodeNodeId(id);
  if (decoded === null) {
    const numeric = Number(id);
    if (Number.isInteger(numeric)) {
      for (const repo of forge.listRepos()) if (repo.id === numeric) return { __type: 'Repository', repo };
    }
    return null;
  }
  if (decoded.type === 'Repository') {
    for (const repo of forge.listRepos()) if (repo.id === Number(decoded.key)) return { __type: 'Repository', repo };
    return null;
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const globalId = Number(decoded.key);
    for (const repo of forge.listRepos()) {
      for (const issue of repo.issues.values()) if (issue.id === globalId) return { __type: 'Issue', repo, issue };
      for (const pull of repo.pulls.values()) if (pull.id === globalId) return { __type: 'PullRequest', repo, pull };
    }
    return null;
  }
  if (decoded.type === 'User') return userValue;
  return null;
}

/** Execute one GraphQL request body; returns the response payload object. */
export function executeGraphQL(forge: Forge, body: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  let doc: DocumentNode;
  try {
    doc = new Parser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'syntax error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = doc.operations.find((op) => operationName === null || op.name === operationName) ?? doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };

  const vars = new Map<string, unknown>();
  for (const [name, node] of operation.varDefaults) vars.set(name, resolveValue(node, new Map()));
  if (typeof body.variables === 'object' && body.variables !== null) {
    for (const [name, value] of Object.entries(body.variables as Record<string, unknown>)) vars.set(name, value);
  }
  const ctx: Ctx = { forge, vars, doc, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeRoot(rootType, operation.selections, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

function executeRoot(rootType: string, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const { forge } = ctx;
  const rootResolvers: Record<string, (field: FieldNode) => unknown> = {
    viewer: (field) => completeValue(userValue, field, ctx),
    repository: (field) => {
      const owner = String(resolveArg(field, 'owner', ctx) ?? '');
      const name = String(resolveArg(field, 'name', ctx) ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = forge.getRepo(name);
      return repo === null ? null : completeValue({ __type: 'Repository', repo }, field, ctx);
    },
    node: (field) => {
      const id = String(resolveArg(field, 'id', ctx) ?? '');
      const node = nodeById(forge, id);
      return node === null ? null : completeValue(node, field, ctx);
    },
  };
  const mutationResolvers: Record<string, (field: FieldNode) => unknown> = {
    createIssue: (field) => mutationPayload(field, ctx, (input) => {
      const repo = repoFromInput(forge, input);
      if (repo === null) return null;
      const created = createIssue(forge, repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' });
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return null;
      }
      return { issue: { __type: 'Issue', repo, issue: created.issue } };
    }),
    closeIssue: (field) => mutationPayload(field, ctx, (input) => {
      const node = typeof input.issueId === 'string' ? nodeById(forge, input.issueId) : null;
      if (node === null || node.__type !== 'Issue') return null;
      node.issue.state = 'closed';
      return { issue: node };
    }),
    createPullRequest: (field) => mutationPayload(field, ctx, (input) => {
      const repo = repoFromInput(forge, input);
      if (repo === null) return null;
      const created = createPull(forge, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: stripOwnerPrefix(String(input.headRefName ?? '')),
        base: stripOwnerPrefix(String(input.baseRefName ?? '')),
      });
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return null;
      }
      return { pullRequest: { __type: 'PullRequest', repo, pull: created.pull } };
    }),
    mergePullRequest: (field) => mutationPayload(field, ctx, (input) => {
      const node = typeof input.pullRequestId === 'string' ? nodeById(forge, input.pullRequestId) : null;
      if (node === null || node.__type !== 'PullRequest') return null;
      const outcome = mergePull(node.repo, node.pull);
      if (!outcome.merged && outcome.reason === 'conflict') {
        ctx.errors.push({ message: 'Pull request is not mergeable: conflicts must be resolved first' });
        return null;
      }
      return { pullRequest: node };
    }),
    addComment: (field) => mutationPayload(field, ctx, (input) => {
      const node = typeof input.subjectId === 'string' ? nodeById(forge, input.subjectId) : null;
      if (node === null || node.__type !== 'Issue') return null;
      const comment = { id: ctx.forge.nextCommentId, body: String(input.body ?? ''), createdSeq: node.repo.seq };
      ctx.forge.nextCommentId += 1;
      node.repo.seq += 1;
      node.issue.comments.push(comment);
      const tagged: Tagged = { __type: 'Comment', id: comment.id, body: comment.body };
      return { commentEdge: { node: tagged }, subject: node };
    }),
  };

  const out: Record<string, unknown> = {};
  const walk = (sels: SelectionNode[]): void => {
    for (const selection of sels) {
      if (selection.kind === 'inline') {
        if (selection.typeCondition === null || selection.typeCondition === rootType) walk(selection.selections);
      } else if (selection.kind === 'spread') {
        const fragment = ctx.doc.fragments.get(selection.name);
        if (fragment !== undefined) walk(fragment);
      } else {
        const field = selection.field;
        const key = field.alias ?? field.name;
        if (field.name === '__typename') {
          out[key] = rootType;
        } else if (field.name === '__type' || field.name === '__schema') {
          out[key] = executeField(null, 'Query', field, ctx);
        } else if (rootType === 'Query' && rootResolvers[field.name] !== undefined) {
          out[key] = rootResolvers[field.name](field);
        } else if (rootType === 'Mutation' && mutationResolvers[field.name] !== undefined) {
          out[key] = mutationResolvers[field.name](field);
        } else {
          ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${rootType}'` });
          out[key] = null;
        }
      }
    }
  };
  walk(selections);
  return out;
}

function resolveArg(field: FieldNode, name: string, ctx: Ctx): unknown {
  const node = field.args.get(name);
  return node === undefined ? undefined : resolveValue(node, ctx.vars);
}

/** Run a mutation field: pull `input` out of the args, run, apply selections. */
function mutationPayload(
  field: FieldNode,
  ctx: Ctx,
  run: (input: Record<string, unknown>) => Record<string, unknown> | null,
): unknown {
  const inputNode = field.args.get('input');
  const input = (inputNode === undefined ? {} : resolveValue(inputNode, ctx.vars)) as Record<string, unknown>;
  const payload = run(input);
  if (payload === null) return null;
  const completed: Record<string, unknown> = {};
  const walk = (sels: SelectionNode[]): void => {
    for (const selection of sels) {
      if (selection.kind === 'field') {
        const sub = selection.field;
        const key = sub.alias ?? sub.name;
        if (sub.name === 'clientMutationId') completed[key] = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        else if (sub.name in payload) completed[key] = completeValue(payload[sub.name], sub, ctx);
        else {
          ctx.errors.push({ message: `Field '${sub.name}' doesn't exist on type '${field.name}Payload'` });
          completed[key] = null;
        }
      } else if (selection.kind === 'inline') {
        walk(selection.selections);
      } else {
        const fragment = ctx.doc.fragments.get(selection.name);
        if (fragment !== undefined) walk(fragment);
      }
    }
  };
  walk(field.selections);
  return completed;
}

function repoFromInput(forge: Forge, input: Record<string, unknown>): Repo | null {
  const id = typeof input.repositoryId === 'string' ? input.repositoryId : '';
  const node = nodeById(forge, id);
  return node !== null && node.__type === 'Repository' ? node.repo : null;
}

/** `owner:branch` or bare branch -> bare branch. */
export function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}
