// Packfile codec: read and write git pack version 2 (and read version 3).
//
// - parsePack: full objects, OBJ_OFS_DELTA and OBJ_REF_DELTA, thin packs (a base the
//   caller already holds, supplied via `resolveBase`), trailer checksum verification.
// - buildPack: plain objects plus OFS_DELTA against an earlier same-type object in the
//   pack when the delta is smaller, and REF_DELTA against `thinAgainst` bases the client
//   already holds. Objects are emitted grouped by type, largest first within a type, so
//   similar revisions sit next to each other and delta well.
// - applyDelta / makeDelta implement git's copy/insert delta instruction stream.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ObjType, Store } from './types.ts';
import { CODE_TYPE, TYPE_CODE, getObject, hashObject, parseObject } from './objects.ts';

export interface PackObject {
  type: ObjType;
  /** Full object bytes (header + content), per the BUILD-PLAN contract. */
  data: Buffer;
}

const MAX_DELTA_OBJECT_BYTES = 512 * 1024;

// -------------------------------------------------------------------------------------------
// delta decode
// -------------------------------------------------------------------------------------------

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// -------------------------------------------------------------------------------------------
// delta encode
// -------------------------------------------------------------------------------------------

function writeDeltaVarint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  for (;;) {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest === 0) {
      bytes.push(byte);
      break;
    }
    bytes.push(byte | 0x80);
  }
  return Buffer.from(bytes);
}

/**
 * Build a git delta turning `base` into `target`: greedy longest-match copy ops against
 * a 4-byte index of the base, literals for the rest. A copy op needs a match of >= 4
 * bytes; matches are capped at 0x10000 (one copy op's maximum).
 */
export function makeDelta(base: Buffer, target: Buffer): Buffer {
  const index = new Map<number, number[]>();
  for (let i = 0; i + 4 <= base.length; i += 1) {
    const key = base.readUInt32LE(i);
    const list = index.get(key);
    if (list) list.push(i);
    else index.set(key, [i]);
  }
  const parts: Buffer[] = [writeDeltaVarint(base.length), writeDeltaVarint(target.length)];
  let pos = 0;
  let litStart = 0;
  const flushLiteral = (end: number): void => {
    let start = litStart;
    while (start < end) {
      const n = Math.min(127, end - start);
      parts.push(Buffer.from([n]));
      parts.push(target.subarray(start, start + n));
      start += n;
    }
  };
  while (pos < target.length) {
    let bestLen = 0;
    let bestOff = 0;
    if (pos + 4 <= target.length) {
      const candidates = index.get(target.readUInt32LE(pos));
      if (candidates) {
        for (const cand of candidates) {
          let len = 0;
          const max = Math.min(0x10000, target.length - pos, base.length - cand);
          while (len < max && target[pos + len] === base[cand + len]) len += 1;
          if (len > bestLen) {
            bestLen = len;
            bestOff = cand;
            if (len >= 0x10000) break;
          }
        }
      }
    }
    if (bestLen >= 4) {
      flushLiteral(pos);
      let op = 0x80;
      const opBytes: number[] = [];
      let off = bestOff;
      for (let bit = 0; bit < 4; bit += 1) {
        const byte = off & 0xff;
        if (byte !== 0) {
          op |= 1 << bit;
          opBytes.push(byte);
        }
        off >>= 8;
      }
      let size = bestLen;
      if (size === 0x10000) size = 0; // encoded as 0, decoded as 0x10000
      for (let bit = 4; bit < 7; bit += 1) {
        const byte = size & 0xff;
        if (byte !== 0) {
          op |= 1 << bit;
          opBytes.push(byte);
        }
        size >>= 8;
      }
      parts.push(Buffer.from([op, ...opBytes]));
      pos += bestLen;
      litStart = pos;
    } else {
      pos += 1;
    }
  }
  flushLiteral(target.length);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// pack read
// -------------------------------------------------------------------------------------------

function readPackSizeHeader(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** A base-object lookup for thin packs: oid -> { type, content }. */
export type PackBaseLookup = (oid: string) => { type: ObjType; content: Buffer } | undefined;

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer; // inflated bytes (for a delta: the delta instructions)
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjType;
  resolved?: Buffer; // resolved content
  oid?: string;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and
 * REF_DELTA. `resolveBase` supplies a base a thin pack leaves out (an object the caller
 * already holds). Every object's SHA-1 is recomputed; the trailer checksum is verified.
 * Returns a map oid -> { type, data } where data is the FULL object bytes.
 */
export function parsePack(
  buf: Buffer,
  resolveBase?: PackBaseLookup,
): Map<string, PackObject> {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) {
    throw new Error(`pack trailer ${trailer} does not match its bytes ${computedTrailer}`);
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackSizeHeader(buf, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buf, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, PackObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawEntry): { type: ObjType; content: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, content: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let content: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      content = applyDelta(base.content, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        content = applyDelta(base.content, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied by the caller`);
        }
        type = external.type;
        content = applyDelta(external.content, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      content = entry.data;
    }
    const { sha, full } = hashObject(type, content);
    entry.resolved = content;
    entry.resolvedType = type;
    entry.oid = sha;
    resolvedByOid.set(sha, entry);
    resolving.delete(entry.offset);
    return { type, content, oid: sha };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) {
      objects.set(resolved.oid, { type: resolved.type, data: hashObject(resolved.type, resolved.content).full });
    }
  }
  return objects;
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Buffer): string {
  if (pack.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

/** True when the pack's trailer matches its bytes. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = packChecksum(pack);
  return { ok: actual === expected, expected, actual };
}

// -------------------------------------------------------------------------------------------
// pack write
// -------------------------------------------------------------------------------------------

/** Encode one object's pack header: the type/size varint. */
function writePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Encode an OFS_DELTA base offset (the distance back from the delta entry to its base).
 * Inverse of the decoder in readOfsDeltaBase / git's offset encoding.
 */
export function encodeOfsDeltaOffset(distance: number): Buffer {
  if (distance <= 0) throw new Error(`ofs-delta distance must be positive, got ${distance}`);
  const bytes: number[] = [];
  bytes.push(distance & 0x7f);
  let rest = Math.floor(distance / 128);
  while (rest > 0) {
    rest -= 1;
    bytes.push(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
  bytes.reverse();
  return Buffer.from(bytes);
}

export interface BuildPackOpts {
  /**
   * Objects the recipient already holds (oid -> full bytes). A same-type object may be
   * delta'd against one of these as a REF_DELTA (thin pack). Only used when the caller
   * knows the recipient holds them (i.e. they were the fetch's haves).
   */
  thinAgainst?: Map<string, Buffer>;
  /** Delta-encode against earlier same-type objects in the pack (default true). */
  deltas?: boolean;
}

const TYPE_ORDER: Readonly<Record<ObjType, number>> = { commit: 0, tree: 1, blob: 2, tag: 3 };

/**
 * Build a packfile (version 2) from the given object ids, read from the store.
 * Every object's SHA-1 recomputes from its bytes; the trailer is SHA-1 over the pack.
 */
export function buildPack(shas: string[], store: Store, opts: BuildPackOpts = {}): Buffer {
  const useDeltas = opts.deltas !== false;
  const resolved: { oid: string; type: ObjType; content: Buffer }[] = [];
  const seen = new Set<string>();
  for (const sha of shas) {
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = getObject(store, sha);
    if (!object) throw new Error(`buildPack: object ${sha} is not in the store`);
    resolved.push({ oid: sha, type: object.type, content: object.content });
  }
  // Group by type, largest first within a type: similar revisions sit next to each other.
  resolved.sort(
    (a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || b.content.length - a.content.length,
  );

  // Thin-pack bases, parsed once, grouped by type.
  let thinByType: Map<ObjType, { oid: string; content: Buffer }[]> | null = null;
  if (opts.thinAgainst && opts.thinAgainst.size > 0) {
    thinByType = new Map();
    for (const [oid, full] of opts.thinAgainst) {
      try {
        const parsed = parseObject(full);
        const list = thinByType.get(parsed.type) ?? [];
        list.push({ oid, content: parsed.content });
        thinByType.set(parsed.type, list);
      } catch {
        // A thin base that does not parse as full bytes is unusable as a delta base.
      }
    }
  }

  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(resolved.length, 8);
  parts.push(header);

  // Last whole object of each type already emitted, usable as an OFS_DELTA base.
  const lastWholeByType = new Map<ObjType, { offset: number; content: Buffer }>();
  let offset = 12;

  for (const object of resolved) {
    let entryHeader: Buffer;
    let payload: Buffer; // bytes to deflate (the object, or its delta instructions)
    const smallEnough =
      object.content.length <= MAX_DELTA_OBJECT_BYTES;

    let ofsBase: { offset: number; content: Buffer } | null = null;
    let refBase: { oid: string; content: Buffer } | null = null;
    let delta: Buffer | null = null;

    if (useDeltas && smallEnough) {
      const prev = lastWholeByType.get(object.type);
      if (prev && prev.content.length <= MAX_DELTA_OBJECT_BYTES) {
        const candidate = makeDelta(prev.content, object.content);
        if (candidate.length < object.content.length) {
          ofsBase = prev;
          delta = candidate;
        }
      }
      if (!delta && thinByType) {
        const candidates = thinByType.get(object.type) ?? [];
        // Bounded: try at most 16 same-type thin bases.
        const tried = candidates.slice(0, 16);
        for (const candidate of tried) {
          if (candidate.content.length > MAX_DELTA_OBJECT_BYTES) continue;
          if (candidate.oid === object.oid) continue;
          const candidateDelta = makeDelta(candidate.content, object.content);
          if (candidateDelta.length < object.content.length && (!delta || candidateDelta.length < delta.length)) {
            refBase = candidate;
            delta = candidateDelta;
          }
        }
      }
    }

    if (delta && ofsBase) {
      entryHeader = Buffer.concat([
        writePackObjectHeader(6, delta.length),
        encodeOfsDeltaOffset(offset - ofsBase.offset),
      ]);
      payload = delta;
    } else if (delta && refBase) {
      entryHeader = Buffer.concat([
        writePackObjectHeader(7, delta.length),
        Buffer.from(refBase.oid, 'hex'),
      ]);
      payload = delta;
    } else {
      entryHeader = writePackObjectHeader(TYPE_CODE[object.type], object.content.length);
      payload = object.content;
    }
    const deflated = deflateSync(payload);
    parts.push(entryHeader, deflated);
    if (!delta) {
      lastWholeByType.set(object.type, { offset, content: object.content });
    }
    offset += entryHeader.length + deflated.length;
  }

  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
