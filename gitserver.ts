// Anvil Forge — the git smart-HTTP protocol (protocol v0 and v2).
//
// info/refs advertisements, ls-refs, fetch (with shallow/deepen support) and
// receive-pack with fast-forward enforcement and per-ref status reports, all
// served straight from the in-memory object store.

import { type Repo, parseCommit } from './store.ts';
import {
  ZERO_OID, pktLine, PKT_FLUSH, decodePkts, ingestPack, closureOf, depthClosure, packFor,
  sidebandPackets,
} from './gitcore.ts';
import { isAncestor } from './store.ts';

const AGENT = 'anvil-forge/1.0.0';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function textReply(status: number, text: string): GitReply {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

/** All refs in advertisement order: heads (sorted) then tags (sorted). */
function sortedRefs(repo: Repo): [string, string][] {
  const heads: [string, string][] = [];
  const tags: [string, string][] = [];
  for (const [ref, oid] of repo.refs) {
    if (ref.startsWith('refs/heads/')) heads.push([ref, oid]);
    else if (ref.startsWith('refs/tags/')) tags.push([ref, oid]);
  }
  heads.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  tags.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return [...heads, ...tags];
}

/** Peeled target of an annotated tag object, or null for lightweight refs. */
function peeledOf(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const match = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
  return match === null ? null : match[1];
}

/** GET info/refs: the advertisement for upload-pack or receive-pack. */
export function advertise(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): GitReply {
  if (service === 'git-upload-pack' && protocolV2) {
    const lines = [
      pktLine('version 2'),
      pktLine(`agent=${AGENT}`),
      pktLine('ls-refs=unborn'),
      pktLine('fetch=shallow wait-for-done'),
      pktLine('object-format=sha1'),
      PKT_FLUSH,
    ];
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(lines) };
  }
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
    : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.headOid();
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: Buffer.concat(parts),
  };
}

/** Protocol v2 ls-refs command. */
export function lsRefs(repo: Repo, body: Buffer): GitReply {
  const frames = decodePkts(body);
  if (frames === null) return textReply(400, 'invalid pkt-line framing');
  const args: string[] = [];
  let pastDelim = false;
  for (const frame of frames) {
    if (frame.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (frame.kind === 'flush') break;
    if (pastDelim) args.push(frame.payload.toString('utf8').replace(/\n$/, ''));
  }
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const lines: Buffer[] = [];
  const headOid = repo.headOid();
  if (matches('HEAD')) {
    if (headOid !== null) {
      lines.push(pktLine(`${headOid} HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else if (wantUnborn) {
      lines.push(pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (wantPeel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(lines) };
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  depth: number | null;
  deepen: number | null;
  done: boolean;
}

/** Run a fetch: compute the object set and frame the v2 or v0 response. */
export function fetchObjects(repo: Repo, request: FetchRequest, version2: boolean): GitReply {
  const cacheKey = [
    version2 ? 'v2' : 'v0',
    request.wants.join(','),
    request.haves.join(','),
    request.shallowLines.join(','),
    String(request.deepen ?? request.depth ?? ''),
    repo.headOid() ?? '',
    String(repo.objects.size),
  ].join('|');
  const cachedBody = repo.fetchCache.get(cacheKey);
  if (cachedBody !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cachedBody };
  }
  const reply = computeFetch(repo, request, version2);
  if (repo.fetchCache.size > 128) repo.fetchCache.clear();
  repo.fetchCache.set(cacheKey, reply.body);
  return reply;
}

function computeFetch(repo: Repo, request: FetchRequest, version2: boolean): GitReply {
  const haveBoundary = new Set(request.shallowLines);
  const haveObjects = request.haves.length === 0
    ? new Set<string>()
    : closureOf(repo, request.haves.filter((oid) => repo.objects.has(oid)), haveBoundary);

  let send: Set<string>;
  let shallowSend: string[] = [];
  let unshallowSend: string[] = [];
  const depth = request.deepen ?? request.depth;
  if (depth !== null && depth > 0) {
    const { objects, boundary } = depthClosure(repo, request.wants.filter((oid) => repo.objects.has(oid)), depth);
    send = new Set([...objects].filter((oid) => !haveObjects.has(oid)));
    shallowSend = boundary.filter((oid) => send.has(oid) || distanceIncluded(repo, oid, request.wants, depth));
    unshallowSend = request.shallowLines.filter((oid) => objects.has(oid) && !shallowSend.includes(oid));
  } else {
    const wantObjects = closureOf(repo, request.wants.filter((oid) => repo.objects.has(oid)), new Set());
    send = new Set([...wantObjects].filter((oid) => !haveObjects.has(oid)));
  }

  const ackLines: string[] = [];
  if (request.haves.length > 0) {
    let acked = false;
    for (const have of request.haves) {
      if (repo.objects.has(have)) {
        ackLines.push(`ACK ${have}`);
        acked = true;
      }
    }
    if (!acked) ackLines.push('NAK');
  }

  if (!version2) {
    const parts: Buffer[] = [];
    for (const oid of shallowSend) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallowSend) parts.push(pktLine(`unshallow ${oid}\n`));
    if (ackLines.length === 0) parts.push(pktLine('NAK\n'));
    else for (const line of ackLines) parts.push(pktLine(`${line}\n`));
    if (send.size > 0) parts.push(...sidebandPackets(packFor(repo, send)));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }

  const sections: Buffer[] = [];
  if (ackLines.length > 0) {
    const lines = [pktLine('acknowledgments\n')];
    for (const line of ackLines) lines.push(pktLine(`${line}\n`));
    if (send.size === 0) lines.push(pktLine('ready\n'));
    lines.push(PKT_FLUSH);
    sections.push(Buffer.concat(lines));
  }
  if (shallowSend.length > 0 || unshallowSend.length > 0) {
    const lines = [pktLine('shallow-info\n')];
    for (const oid of shallowSend) lines.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallowSend) lines.push(pktLine(`unshallow ${oid}\n`));
    lines.push(PKT_FLUSH);
    sections.push(Buffer.concat(lines));
  }
  if (send.size > 0) {
    const lines = [pktLine('packfile\n'), ...sidebandPackets(packFor(repo, send)), PKT_FLUSH];
    sections.push(Buffer.concat(lines));
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(sections) };
}

/** True when `oid` is within `depth` generations of any want. */
function distanceIncluded(repo: Repo, oid: string, wants: string[], depth: number): boolean {
  const seen = new Map<string, number>();
  let frontier = [...wants];
  for (const want of frontier) seen.set(want, 0);
  for (let level = 0; level < depth; level += 1) {
    if (seen.has(oid)) return true;
    const next: string[] = [];
    for (const current of frontier) {
      const obj = repo.objects.get(current);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!seen.has(parent)) {
          seen.set(parent, level + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return seen.has(oid);
}

/** Parse a v2 fetch command body into a FetchRequest. */
export function parseFetchV2(body: Buffer): FetchRequest | null {
  const frames = decodePkts(body);
  if (frames === null) return null;
  const request: FetchRequest = { wants: [], haves: [], shallowLines: [], depth: null, deepen: null, done: false };
  let pastDelim = false;
  for (const frame of frames) {
    if (frame.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (frame.kind === 'flush') break;
    if (!pastDelim) continue;
    const line = frame.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7).trim());
    else if (line === 'done') request.done = true;
    // deepen-since / deepen-not / filter / feature lines are accepted and ignored.
  }
  return request;
}

/** Parse a v0 upload-pack body: wants up to the first flush, then haves and done. */
export function parseFetchV0(body: Buffer): FetchRequest | null {
  const frames = decodePkts(body);
  if (frames === null) return null;
  const request: FetchRequest = { wants: [], haves: [], shallowLines: [], depth: null, deepen: null, done: false };
  let phase: 'want' | 'have' = 'want';
  for (const frame of frames) {
    if (frame.kind === 'flush') {
      if (phase === 'want') phase = 'have';
      continue;
    }
    if (frame.kind !== 'data') continue;
    const line = frame.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5);
      const oid = rest.split(' ')[0];
      request.wants.push(oid);
      const shallowMatch = /shallow (\d+)/.exec(rest);
      if (shallowMatch !== null) request.depth = Number(shallowMatch[1]);
    } else if (line.startsWith('have ')) {
      request.haves.push(line.slice(5).trim());
    } else if (line === 'done') {
      request.done = true;
    }
  }
  return request;
}

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string;
}

/** POST git-receive-pack: apply a push and answer with the status report. */
export function receivePack(repo: Repo, body: Buffer): GitReply {
  // Commands are pkt-lines up to the first flush; the rest is the packfile.
  let offset = 0;
  const commands: RefCommand[] = [];
  let framingOk = true;
  while (offset + 4 <= body.length) {
    const headerText = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) {
      framingOk = false;
      break;
    }
    const length = parseInt(headerText, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) {
      framingOk = false;
      break;
    }
    const payload = body.toString('utf8', offset + 4, offset + length).replace(/\n$/, '');
    const nul = payload.indexOf('\0');
    const commandText = nul === -1 ? payload : payload.slice(0, nul);
    const caps = nul === -1 ? '' : payload.slice(nul + 1);
    const parts = commandText.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2], caps });
    offset += length;
  }
  if (!framingOk) return textReply(400, 'invalid pkt-line framing');
  const pack = body.subarray(offset);

  const reportStatus = commands.some((c) => c.caps.split(' ').includes('report-status'));
  const sideband = commands.some((c) => c.caps.split(' ').includes('side-band-64k'));

  let unpackLine = 'unpack ok';
  if (pack.length > 0) {
    try {
      ingestPack(repo, pack);
    } catch (error) {
      unpackLine = `unpack ${error instanceof Error ? error.message : 'failed'}`;
    }
  }

  const results: string[] = [];
  if (unpackLine === 'unpack ok') {
    for (const command of commands) results.push(applyRefUpdate(repo, command));
  } else {
    for (const command of commands) results.push(`ng ${command.ref} ${unpackLine}`);
  }

  if (!reportStatus) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const reportLines = [pktLine(`${unpackLine}\n`), ...results.map((line) => pktLine(`${line}\n`)), PKT_FLUSH];
  const reportStream = Buffer.concat(reportLines);
  if (sideband) {
    const packets: Buffer[] = [];
    const CHUNK = 65515;
    for (let at = 0; at < reportStream.length; at += CHUNK) {
      packets.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(at, at + CHUNK)])));
    }
    packets.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(packets) };
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: reportStream };
}

/** Validate and apply one ref update; returns its `ok`/`ng` report line. */
function applyRefUpdate(repo: Repo, command: RefCommand): string {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return `ng ${ref} invalid ref`;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // Delete: the ref must be exactly where the client thinks it is.
    if (current === ZERO_OID) return `ng ${ref} reference not found`;
    if (current !== oldOid) return `ng ${ref} stale ref`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const target = repo.objects.get(newOid);
  if (target === undefined) return `ng ${ref} unknown object`;
  if (ref.startsWith('refs/heads/') && target.type !== 'commit') return `ng ${ref} not a commit`;
  if (ref.startsWith('refs/tags/') && target.type !== 'commit' && target.type !== 'tag') return `ng ${ref} not a commit or tag`;
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return `ng ${ref} reference already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (current !== oldOid) return `ng ${ref} stale ref`;
  if (current === newOid) return `ok ${ref}`;
  if (target.type === 'commit' && !isAncestor(repo, oldOid, newOid)) return `ng ${ref} non-fast-forward`;
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}
