// Anvil Forge — the MCP (Model Context Protocol) surface.
//
// A stateless JSON-RPC 2.0 endpoint at POST /mcp speaking both protocol eras:
// modern clients open with `server/discover`, legacy clients with `initialize`.
// The tools are thin wrappers over the same domain operations the REST and
// GraphQL surfaces use, so an agent driving this forge through MCP sees exactly
// the state a human would see through the API.

import { Forge, type Repo } from './store.ts';
import {
  repoJson, issueJson, pullJson, createIssue, createPull, mergePull,
} from './forgeops.ts';
import { stripOwnerPrefix } from './gql.ts';

const SERVER_INFO = { name: 'anvil-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
}

/** The tool catalogue: constant, pre-built, byte-identical across calls. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'Repository name.' },
      description: { type: 'string', description: 'Optional repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Fetch a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Optional issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'Filter: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      head: { type: 'string', description: 'Head branch name.' },
      base: { type: 'string', description: 'Base branch name.' },
      body: { type: 'string', description: 'Optional pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'integer', description: 'Pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

const TOOLS_LIST_JSON = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

export interface McpReply {
  status: number;
  /** The JSON-RPC payload (object or batch array); null = empty response body. */
  payload: unknown;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

/** Resolve the repo a tool call addresses; creation ignores the owner argument. */
function addressedRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  return forge.getRepo(argString(args, 'repo'));
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      const existing = forge.getRepo(repoName);
      if (existing !== null) return toolOk(repoJson(existing));
      const created = forge.createRepo(
        repoName,
        argString(args, 'description'),
        args.private === true,
      );
      return created === null ? toolError(`repository '${repoName}' already exists`) : toolOk(repoJson(created));
    }
    case 'get_repo': {
      const repo = addressedRepo(forge, args);
      return repo === null ? toolError(`repository '${argString(args, 'repo')}' not found`) : toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = addressedRepo(forge, args);
      if (repo === null) return toolError(`repository '${argString(args, 'repo')}' not found`);
      const labels = Array.isArray(args.labels) ? args.labels.map((x) => String(x)) : [];
      const created = createIssue(forge, repo, {
        title: argString(args, 'title'),
        body: argString(args, 'body'),
        labels,
      });
      return 'error' in created ? toolError(created.error) : toolOk(issueJson(repo, created.issue));
    }
    case 'list_issues': {
      const repo = addressedRepo(forge, args);
      if (repo === null) return toolError(`repository '${argString(args, 'repo')}' not found`);
      const state = argString(args, 'state') || 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return toolOk(list);
    }
    case 'create_pull_request': {
      const repo = addressedRepo(forge, args);
      if (repo === null) return toolError(`repository '${argString(args, 'repo')}' not found`);
      const created = createPull(forge, repo, {
        title: argString(args, 'title'),
        body: argString(args, 'body'),
        head: stripOwnerPrefix(argString(args, 'head')),
        base: stripOwnerPrefix(argString(args, 'base')),
      });
      return 'error' in created ? toolError(created.error) : toolOk(pullJson(repo, created.pull));
    }
    case 'merge_pull_request': {
      const repo = addressedRepo(forge, args);
      if (repo === null) return toolError(`repository '${argString(args, 'repo')}' not found`);
      const number = Number(args.pull_number ?? args.number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`pull request ${number} not found`);
      const outcome = mergePull(repo, pull);
      if (!outcome.merged) {
        return toolError(outcome.reason === 'conflict' ? 'pull request has conflicts and cannot be merged' : 'pull request cannot be merged');
      }
      return toolOk(pullJson(repo, pull));
    }
    default:
      throw new UnknownToolError(name);
  }
}

class UnknownToolError extends Error {
  constructor(name: string) {
    super(`unknown tool: ${name}`);
  }
}

/**
 * Handle one raw MCP request body. Returns the HTTP status and the JSON-RPC
 * payload to send back (null payload = empty body, for notifications).
 * Authentication is the caller's job and happens before this is invoked.
 */
export function handleMcp(forge: Forge, rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      payload: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body is not valid JSON' } },
    };
  }
  if (Array.isArray(parsed)) {
    // JSON-RPC batch: answer each request in order.
    const replies: unknown[] = [];
    for (const item of parsed) {
      const reply = handleOne(forge, item);
      if (reply.payload !== null) replies.push(reply.payload);
    }
    return { status: 200, payload: replies };
  }
  return handleOne(forge, parsed);
}

function handleOne(forge: Forge, message: unknown): McpReply {
  if (typeof message !== 'object' || message === null) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const record = message as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : '';
  const id = record.id;
  const isNotification = id === undefined;
  const params = (typeof record.params === 'object' && record.params !== null ? record.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1];
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_JSON);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
      for (const required of tool.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(id, -32602, `missing required argument: ${required}`);
        }
      }
      try {
        return rpcResult(id, callTool(forge, name, args));
      } catch (error) {
        if (error instanceof UnknownToolError) return rpcError(id, -32602, error.message);
        return rpcResult(id, toolError(error instanceof Error ? error.message : 'tool failed'));
      }
    }
    default:
      if (isNotification) return { status: 202, payload: null };
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
