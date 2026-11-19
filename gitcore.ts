// Anvil Forge — git object transfer: packfiles, pkt-lines and history walks.
//
// Everything here works directly on the in-memory object store from store.ts.
// Packs are written without deltas (full objects only, zlib-deflated), which keeps
// the writer simple and fast; the reader still understands ofs-delta and
// ref-delta entries so pushes produced by other clients unpack correctly.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  type Repo, type GitObject, type GitObjectType, parseCommit, parseTree, storeObject, commitTreeOid, flattenTree, hashObject,
} from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Encode one pkt-line (4-hex length prefix including itself). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktFrame {
  /** 'data' for a normal packet, 'flush' / 'delim' / 'response-end' for the special lengths. */
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a buffer of pkt-lines; returns null when the framing is malformed. */
export function decodePkts(buffer: Buffer): PktFrame[] | null {
  const frames: PktFrame[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) return null;
    const headerText = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(headerText)) return null;
    const length = parseInt(headerText, 16);
    if (length === 0) {
      frames.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      frames.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      frames.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length < 4 || offset + length > buffer.length) {
      return null;
    } else {
      frames.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return frames;
}

/** Encode a packfile from explicit (oid, object) pairs, with the SHA-1 trailer. */
export function writePack(entries: { oid: string; type: GitObjectType; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  chunks.push(header);
  for (const entry of entries) {
    const typeId = TYPE_IDS[entry.type];
    let size = entry.data.length;
    const first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    const sizeBytes: number[] = [];
    if (size === 0) {
      sizeBytes.push(first);
    } else {
      sizeBytes.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size >>= 7;
        sizeBytes.push(size > 0 ? byte | 0x80 : byte);
      }
    }
    chunks.push(Buffer.from(sizeBytes));
    chunks.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (copy/insert instructions) to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size, trusted
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { copyOffset |= delta[offset] << (8 * i); offset += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { copySize |= delta[offset] << (8 * i); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || produced !== resultSize) throw new Error('delta size mismatch');
  return result;
}

export interface ParsedPack {
  objects: { type: GitObjectType; data: Buffer }[];
}

/**
 * Parse a packfile into resolved objects. Deltas are applied against objects
 * from the same pack or, for ref-deltas, from the repository itself.
 */
export function parsePack(repo: Repo, pack: Buffer): ParsedPack {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  let offset = 12;
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer }>();
  const resolved: { type: GitObjectType; data: Buffer }[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // ofs-delta: negative offset to the base entry
      let back = pack[offset];
      offset += 1;
      let baseDelta = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset];
        offset += 1;
        baseDelta = ((baseDelta + 1) << 7) | (back & 0x7f);
      }
      const base = byOffset.get(entryOffset - baseDelta);
      if (base === undefined) throw new Error('ofs-delta base missing');
      const delta = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset);
      const data = applyDelta(base.data, delta);
      const obj = { type: base.type, data };
      byOffset.set(entryOffset, obj);
      resolved.push(obj);
    } else if (typeId === 7) {
      // ref-delta: base named by id, from this pack or the repo
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      let base = resolvedBase(repo, byOffset, baseOid);
      if (base === null) throw new Error('ref-delta base missing');
      const delta = inflateSync(pack.subarray(offset));
      offset += compressedLength(pack, offset);
      const data = applyDelta(base.data, delta);
      const obj = { type: base.type, data };
      byOffset.set(entryOffset, obj);
      resolved.push(obj);
    } else {
      const type = ID_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const data = inflateSync(pack.subarray(offset));
      if (data.length !== size) throw new Error('pack object size mismatch');
      offset += compressedLength(pack, offset);
      const obj = { type, data };
      byOffset.set(entryOffset, obj);
      resolved.push(obj);
    }
  }
  return { objects: resolved };
}

/** Length of the zlib stream starting at `offset` (found by inflating). */
function compressedLength(pack: Buffer, offset: number): number {
  // inflateSync consumes exactly one stream; recover its length by binary search
  // on the smallest prefix that inflates cleanly.
  let lo = 1;
  let hi = pack.length - offset;
  // Fast path: streams in practice are small; grow exponentially then bisect.
  let probe = 1;
  while (probe < hi) {
    try {
      inflateSync(pack.subarray(offset, offset + probe));
      hi = probe;
      break;
    } catch {
      probe *= 2;
    }
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(pack.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Find a delta base: earlier pack entries by their computed id, else the repo. */
function resolvedBase(repo: Repo, byOffset: Map<number, { type: GitObjectType; data: Buffer }>, oid: string): { type: GitObjectType; data: Buffer } | null {
  for (const obj of byOffset.values()) {
    if (hashObject(obj.type, obj.data) === oid) return obj;
  }
  const fromRepo = repo.objects.get(oid);
  return fromRepo === undefined ? null : { type: fromRepo.type, data: fromRepo.data };
}

/** Store every object of a parsed pack into the repo; returns how many were new. */
export function ingestPack(repo: Repo, pack: Buffer): number {
  const parsed = parsePack(repo, pack);
  let added = 0;
  for (const obj of parsed.objects) {
    const before = repo.objects.size;
    storeObject(repo, obj.type, obj.data);
    if (repo.objects.size > before) added += 1;
  }
  return added;
}

/**
 * Full object closure of the given tips: commits plus every tree and blob they
 * reach. When `shallowBoundary` is non-empty, a commit in that set contributes
 * its tree but its parents are not followed (the client already cut history
 * there), mirroring how a shallow client's haves bound the walk.
 */
export function closureOf(repo: Repo, tips: string[], shallowBoundary: Set<string>): Set<string> {
  const out = new Set<string>();
  const pushTree = (treeOid: string): void => {
    const seenTrees = new Set<string>();
    const walk = (oid: string): void => {
      if (seenTrees.has(oid)) return;
      seenTrees.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      out.add(oid);
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') walk(entry.oid);
        else out.add(entry.oid);
      }
    };
    walk(treeOid);
  };
  const commits: string[] = [...tips];
  const seenCommits = new Set<string>();
  while (commits.length > 0) {
    const oid = commits.pop() as string;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      // Annotated tag: include it and follow to its target.
      out.add(oid);
      const target = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'))?.[1];
      if (target !== undefined) commits.push(target);
      continue;
    }
    if (obj.type !== 'commit') continue;
    out.add(oid);
    const parsed = parseCommit(obj.data);
    pushTree(parsed.tree);
    if (shallowBoundary.has(oid)) continue;
    for (const parent of parsed.parents) commits.push(parent);
  }
  return out;
}

export interface DepthClosure {
  objects: Set<string>;
  /** Included commits that sit exactly at the depth cut and still have parents. */
  boundary: string[];
}

/**
 * Depth-limited closure: commits within `depth` generations of the tips
 * (distance 0 = the tips themselves), with their full trees and blobs.
 */
export function depthClosure(repo: Repo, tips: string[], depth: number): DepthClosure {
  const distance = new Map<string, number>();
  let frontier = [...new Set(tips)];
  for (const tip of frontier) distance.set(tip, 0);
  let level = 0;
  while (frontier.length > 0 && level < depth - 1) {
    const next: string[] = [];
    for (const oid of frontier) {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, level + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
    level += 1;
  }
  const included = [...distance.keys()];
  const boundary: string[] = [];
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((p) => !distance.has(p))) boundary.push(oid);
  }
  const objects = closureOf(repo, included, new Set(boundary));
  return { objects, boundary };
}

/**
 * Build (or fetch from cache) the pack bytes carrying exactly `oids`.
 * Commits come first, then trees, then blobs, so a streaming reader meets
 * history before content.
 */
export function packFor(repo: Repo, oids: Set<string>): Buffer {
  const sorted = [...oids].sort();
  const key = sorted.join(',');
  const cached = repo.packCache.get(key);
  if (cached !== undefined) return cached;
  const rank = (type: GitObjectType): number => (type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3);
  const entries = sorted
    .map((oid) => ({ oid, obj: repo.objects.get(oid) }))
    .filter((entry): entry is { oid: string; obj: GitObject } => entry.obj !== undefined)
    .sort((a, b) => rank(a.obj.type) - rank(b.obj.type))
    .map((entry) => ({ oid: entry.oid, type: entry.obj.type, data: entry.obj.data }));
  const pack = writePack(entries);
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(key, pack);
  return pack;
}

/** Wrap pack bytes in side-band-64k packets (band 1 = data). */
export function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515; // 65520 max packet - 4 header bytes - 1 band byte
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, offset + CHUNK);
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return packets;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two commits by their flattened trees. */
export function diffCommits(repo: Repo, fromCommit: string | null, toCommit: string | null): FileChange[] {
  const fromFlat = fromCommit === null ? new Map<string, { oid: string; mode: string }>() : flattenOf(repo, fromCommit);
  const toFlat = toCommit === null ? new Map<string, { oid: string; mode: string }>() : flattenOf(repo, toCommit);
  const changes: FileChange[] = [];
  for (const [path, blob] of toFlat) {
    const before = fromFlat.get(path);
    if (before === undefined) changes.push({ path, status: 'added', oldOid: null, newOid: blob.oid });
    else if (before.oid !== blob.oid) changes.push({ path, status: 'modified', oldOid: before.oid, newOid: blob.oid });
  }
  for (const [path, blob] of fromFlat) {
    if (!toFlat.has(path)) changes.push({ path, status: 'removed', oldOid: blob.oid, newOid: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

function flattenOf(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const tree = commitTreeOid(repo, commitOid);
  if (tree === null) return new Map();
  return flattenTree(repo, tree);
}

/** Count text lines the way diff stats do: newline-terminated lines plus a trailing partial line. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}
