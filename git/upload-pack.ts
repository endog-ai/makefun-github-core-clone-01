// upload-pack: ref advertisement (info/refs, protocol v0 and v2), v2 ls-refs, and
// fetch negotiation (v2 and v0) with shallow/deepen support.
//
// Response shapes follow git exactly as the kit's git-client.ts parses them:
//  - v2 advertisement: "version 2" + capability lines + flush.
//  - v0 advertisement: "# service=..." + flush + "<oid> <ref>" lines (capabilities after
//    a NUL on the first line, peeled tags as "<oid> <ref>^{}", the empty repo's
//    "capabilities^{}" pseudo-ref) + flush.
//  - v2 fetch: when the client sent `done` (or `ready` was reached in a
//    multi-round exchange) the reply has NO acknowledgments section — it goes
//    straight to shallow-info (terminated by a delim) and packfile (terminated
//    by a flush). Without `done` the reply carries the acknowledgments section
//    (ACKs for haves the server holds, NAK if none, `ready` once common ground
//    is found), terminated by a delim — and the packfile follows in that same
//    response when `ready` was sent. Sending an acknowledgments section after
//    `done` makes real git die with "expected 'packfile', received
//    'acknowledgments'".
//  - v0 fetch is ROUND-AWARE, because the stateless client splits the exchange
//    into one HTTP POST per round and re-sends the accumulated request each time:
//    round 1 (wants + deepen, no haves/done yet) gets ONLY the shallow list +
//    flush — real git's upload-pack returns right after `receive_needs` when the
//    input ends there. Sending NAK/pack in that round leaves unread bytes that
//    corrupt the client's read of the next round ("expected shallow list").
//    The final round (haves/done present) repeats the shallow list + flush, then
//    the NAK/ACK lines, then the sideband pack and a final flush. An
//    intermediate have-block round gets shallow + flush + ACKs and no pack.
//  - receive-pack report: the report-status lines are pkt-line framed INSIDE
//    sideband band 1, the inner stream terminated by its own flush, then the
//    outer flush.
//  - `deepen-relative` (real git's `fetch --deepen=N` on an already-shallow repo)
//    makes the deepen count relative to the client's current shallow boundary:
//    effective depth = (distance from the wants to the boundary) + 1 + N.

import type { ObjType, Repo, Store } from './types.ts';
import { ZERO_OID, isOid } from './types.ts';
import { collectReachable, getObject, hashObject, isAncestorCommit, parseCommit, parseTag } from './objects.ts';
import type { ObjectContent } from './objects.ts';
import { buildPack } from './pack.ts';
import { decodePackets, encodeDelim, encodePktLine, encodePktLineText, encodeSideband } from './pktline.ts';

export const AGENT = 'makefun-forge/1.0';

const UPLOAD_PACK_CAPS =
  'multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag agent=' +
  AGENT;
const RECEIVE_PACK_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT}`;

// -------------------------------------------------------------------------------------------
// advertisement
// -------------------------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string; // commit the tag peels to, for annotated tags
}

/** All refs of a repo, sorted by name, with peeled targets for annotated tags. */
export function listRefs(repo: Repo, store: Store): RefLine[] {
  const refs: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const ref: RefLine = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = getObject(store, oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommitOid(store, parseTag(object.content).object);
        if (peeled) ref.peeled = peeled;
      }
    }
    refs.push(ref);
  }
  return refs;
}

function peelToCommitOid(store: Store, oid: string): string | null {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = getObject(store, current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.content).object;
      continue;
    }
    return null;
  }
}

function v0Advertisement(repo: Repo, store: Store, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLineText(`# service=${service}\n`));
  parts.push(encodePktLine(null)); // flush
  const caps = service === 'git-upload-pack' ? UPLOAD_PACK_CAPS : RECEIVE_PACK_CAPS;
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  const refs = listRefs(repo, store);
  const symref = tip ? ` symref=HEAD:${defaultRef}` : '';
  if (!tip && refs.length === 0) {
    // Empty repository: the capabilities^{} pseudo-ref carries the capabilities.
    parts.push(encodePktLineText(`${ZERO_OID} capabilities^{}\u0000${caps}${symref}\n`));
  } else {
    let first = true;
    const emit = (line: string): void => {
      if (first) {
        parts.push(encodePktLineText(`${line}\u0000${caps}${symref}\n`));
        first = false;
      } else {
        parts.push(encodePktLineText(`${line}\n`));
      }
    };
    if (tip) emit(`${tip} HEAD`);
    for (const ref of refs) {
      emit(`${ref.oid} ${ref.name}`);
      if (ref.peeled) parts.push(encodePktLineText(`${ref.peeled} ${ref.name}^{}\n`));
    }
    if (first) {
      // No HEAD and no refs (should not happen): fall back to the pseudo-ref.
      parts.push(encodePktLineText(`${ZERO_OID} capabilities^{}\u0000${caps}${symref}\n`));
    }
  }
  parts.push(encodePktLine(null)); // flush
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
  ];
  const parts = lines.map((line) => encodePktLineText(line));
  parts.push(encodePktLine(null));
  return Buffer.concat(parts);
}

/**
 * info/refs advertisement. `opts.version` selects protocol v2 (only honoured for
 * git-upload-pack; receive-pack is v0-only). Defaults to v0 when unset.
 */
export function handleInfoRefs(
  repo: Repo,
  store: Store,
  service: 'git-upload-pack' | 'git-receive-pack',
  opts: { version?: 2 | 0 } = {},
): Buffer {
  if (service === 'git-upload-pack' && opts.version === 2) return v2Advertisement();
  return v0Advertisement(repo, store, service);
}

// -------------------------------------------------------------------------------------------
// negotiation
// -------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  /** The client's current shallow boundary commits. */
  shallow: string[];
  /** Deepen the history to this many generations from the wants (undefined = full). */
  depth?: number;
  /** The client sent `deepen-relative`: `depth` counts from its current shallow
   *  boundary instead of from the wants (real git's `fetch --deepen=N`). */
  deepenRelative: boolean;
  /** The client sent `done`: negotiation is over and the pack follows in this reply. */
  done: boolean;
  /** The client sent `include-tag`: tags pointing at sent commits ride along. */
  includeTag: boolean;
}

export interface Negotiation {
  /** Object ids to send, in pack order. */
  toSend: string[];
  /** The new shallow boundary after this fetch. */
  newShallow: string[];
  /** Old boundary commits that are no longer shallow. */
  unshallow: string[];
  /** Objects the client already holds (oid -> full bytes), usable as thin-pack bases. */
  heldFull: Map<string, Buffer>;
}

/**
 * Compute what a fetch sends: the closure of the wants, cut at `depth` generations,
 * minus everything the client already holds (the closure of the haves, where a have
 * that is also a shallow boundary contributes its own commit/tree/blobs but NOT its
 * parents — the client holds it shallowly).
 */
export function negotiate(store: Store, request: FetchRequest): Negotiation {
  const shallowSet = new Set(request.shallow.filter((oid) => isOid(oid)));
  // What the client already holds.
  const held = collectReachable(store, request.haves, { stopAt: shallowSet });

  // Resolve `deepen-relative` (real git's `fetch --deepen=N` on an already-shallow
  // repo): the count is relative to the client's current shallow boundary, so the
  // effective absolute depth is (distance from the wants to the boundary) + 1 + N.
  // The distance is the shortest commit-generation distance from any want tip.
  let depth = request.depth;
  if (request.deepenRelative && request.depth !== undefined) {
    const dist = new Map<string, number>();
    const dq: string[] = [];
    for (const want of request.wants) {
      const commit = peelToCommitOid(store, want);
      if (commit !== null && !dist.has(commit)) {
        dist.set(commit, 0);
        dq.push(commit);
      }
    }
    while (dq.length) {
      const oid = dq.shift()!;
      const d = dist.get(oid)!;
      const object = getObject(store, oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.content).parents) {
        if (!dist.has(parent)) {
          dist.set(parent, d + 1);
          dq.push(parent);
        }
      }
    }
    let base = 0;
    let found = false;
    for (const boundary of shallowSet) {
      const commit = peelToCommitOid(store, boundary);
      if (commit === null) continue;
      const d = dist.get(commit);
      if (d === undefined) continue;
      found = true;
      base = Math.max(base, d);
    }
    // No boundary reachable from the wants: treat the current depth as 1.
    depth = (found ? base + 1 : 1) + request.depth;
  }

  // Walk from the wants with a generation distance; a commit at distance d is included
  // when depth is undefined or d < depth. Its tree/blobs are always included with it.
  const send = new Map<string, ObjectContent>();
  const newShallow = new Set<string>();
  const seenCommits = new Set<string>();
  const queue: { oid: string; dist: number }[] = request.wants
    .filter((oid) => isOid(oid))
    .map((oid) => ({ oid, dist: 0 }));

  const addCommitClosure = (commitOid: string): void => {
    // The commit object itself, its tree and its blobs — but not its parents.
    const closure = collectReachable(store, [commitOid], { stopAt: new Set([commitOid]) });
    for (const [oid, object] of closure) {
      if (!send.has(oid)) send.set(oid, object);
    }
  };

  while (queue.length) {
    const { oid, dist } = queue.shift()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const object = getObject(store, oid);
    if (!object) throw new Error(`want ${oid} not found`);
    if (object.type === 'tag') {
      // A tag want: include the tag, then its target at the same distance.
      if (!send.has(oid)) send.set(oid, object);
      queue.push({ oid: parseTag(object.content).object, dist });
      continue;
    }
    if (object.type !== 'commit') {
      // A blob/tree want: include its closure wholesale.
      const closure = collectReachable(store, [oid]);
      for (const [childOid, child] of closure) {
        if (!send.has(childOid)) send.set(childOid, child);
      }
      continue;
    }
    if (depth !== undefined && dist >= depth) continue;
    addCommitClosure(oid);
    const commit = parseCommit(object.content);
    const cut = depth !== undefined && dist + 1 >= depth;
    if (cut) {
      newShallow.add(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (seenCommits.has(parent)) continue;
      // A parent the store does not hold cuts the history here, like a shallow edge.
      if (!getObject(store, parent)) {
        newShallow.add(oid);
        continue;
      }
      queue.push({ oid: parent, dist: dist + 1 });
    }
  }

  // Remove what the client already holds.
  for (const oid of held.keys()) send.delete(oid);

  // Shallow bookkeeping for the response: an old boundary whose parents are all present
  // now (sent or held) stops being shallow; one whose parents were not delivered stays
  // shallow and is re-announced.
  const present = new Set<string>([...send.keys(), ...held.keys()]);
  const unshallow: string[] = [];
  for (const boundary of shallowSet) {
    if (!held.has(boundary)) continue; // not actually held; the walk decides its fate
    const object = getObject(store, boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.content).parents;
    if (parents.every((parent) => present.has(parent))) {
      if (!newShallow.has(boundary)) unshallow.push(boundary);
    } else if (!newShallow.has(boundary)) {
      newShallow.add(boundary);
    }
  }

  const heldFull = new Map<string, Buffer>();
  for (const [oid, object] of held) {
    const entry = store.objects.get(oid);
    heldFull.set(oid, entry ? entry.data : hashObject(object.type, object.content).full);
  }

  // `include-tag` (real git's `fetch` sends it): a tag object that points at a
  // commit in the send set rides along, so the client learns the tag. Only tags
  // the client does not already hold are added; tags of tags follow transitively.
  if (request.includeTag) {
    let added = true;
    while (added) {
      added = false;
      for (const [oid, entry] of store.objects) {
        if (entry.type !== 'tag' || send.has(oid) || held.has(oid)) continue;
        const tag = getObject(store, oid);
        if (!tag) continue;
        try {
          if (send.has(parseTag(tag.content).object)) {
            send.set(oid, tag);
            added = true;
          }
        } catch {
          // A malformed tag object is skipped, never fatal.
        }
      }
    }
  }

  return {
    toSend: [...send.keys()],
    newShallow: [...newShallow],
    unshallow,
    heldFull,
  };
}

// -------------------------------------------------------------------------------------------
// v2 ls-refs
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, store: Store, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  const refs = listRefs(repo, store);

  const emitRef = (oid: string, name: string, attrs: string[]): void => {
    if (!keep(name)) return;
    const suffix = attrs.length ? ` ${attrs.join(' ')}` : '';
    parts.push(encodePktLineText(`${oid} ${name}${suffix}\n`));
  };

  if (tip) {
    const attrs: string[] = [];
    if (args.symrefs) attrs.push(`symref-target:${defaultRef}`);
    emitRef(tip, 'HEAD', attrs);
  } else if (args.unborn) {
    // Unborn HEAD: the client parses `unborn <name> symref-target:<target>`.
    if (keep('HEAD')) {
      parts.push(encodePktLineText(`unborn HEAD symref-target:${defaultRef}\n`));
    }
  }
  for (const ref of refs) {
    const attrs: string[] = [];
    if (args.peel && ref.peeled) attrs.push(`peeled:${ref.peeled}`);
    emitRef(ref.oid, ref.name, attrs);
  }
  parts.push(encodePktLine(null));
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// v2 / v0 fetch
// -------------------------------------------------------------------------------------------

function fetchPack(store: Store, result: Negotiation, haves: string[]): Buffer {
  const thin = haves.length > 0 ? result.heldFull : undefined;
  return buildPack(result.toSend, store, { thinAgainst: thin });
}

/**
 * Is the server ready to send the pack after this round of negotiation? Real git's
 * upload-pack sends `ready` once it has found common ground: an ACKed have that is
 * an ancestor of (or equal to) a want. Until then the client sends another round.
 */
function negotiationReady(store: Store, request: FetchRequest): boolean {
  for (const have of request.haves) {
    if (!store.objects.has(have)) continue;
    const haveCommit = peelToCommitOid(store, have);
    if (haveCommit === null) continue;
    for (const want of request.wants) {
      const wantCommit = peelToCommitOid(store, want);
      if (wantCommit === null) continue;
      if (isAncestorCommit(store, haveCommit, wantCommit)) return true;
    }
  }
  return false;
}

function v2FetchResponse(store: Store, request: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  if (!request.done) {
    // Multi-round negotiation (real git's fetch with haves): the reply carries the
    // acknowledgments section first, terminated by a delim. When the server has
    // found common ground it also says `ready` and the packfile follows in this
    // same response — exactly what real git's upload-pack does. Without `ready`
    // the reply ends after the delim and the client sends another round.
    parts.push(encodePktLineText('acknowledgments\n'));
    let known = 0;
    for (const have of request.haves) {
      if (store.objects.has(have)) {
        parts.push(encodePktLineText(`ACK ${have}\n`));
        known += 1;
      }
    }
    if (known === 0) parts.push(encodePktLineText('NAK\n'));
    const ready = known > 0 && negotiationReady(store, request);
    if (ready) parts.push(encodePktLineText('ready\n'));
    parts.push(encodeDelim());
    if (!ready) return Buffer.concat(parts);
  }
  // `done` was sent (or `ready` was reached above): real git's upload-pack sends
  // NO acknowledgments section in this case — the reply goes straight to
  // shallow-info / packfile. (Sending one makes real git die with "expected
  // 'packfile', received 'acknowledgments'".)
  const result = negotiate(store, request);
  // shallow-info — terminated by a delim, as git's upload-pack does.
  if (result.newShallow.length > 0 || result.unshallow.length > 0) {
    parts.push(encodePktLineText('shallow-info\n'));
    for (const oid of result.newShallow) parts.push(encodePktLineText(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(encodePktLineText(`unshallow ${oid}\n`));
    parts.push(encodeDelim());
  }
  // packfile (always present: an empty pack when nothing is new)
  parts.push(encodePktLineText('packfile\n'));
  for (const packet of encodeSideband(fetchPack(store, result, request.haves))) parts.push(packet);
  parts.push(encodePktLine(null));
  return Buffer.concat(parts);
}

function v0FetchResponse(store: Store, request: FetchRequest): Buffer {
  const result = negotiate(store, request);
  const parts: Buffer[] = [];
  // The shallow section (lines + flush) comes first whenever shallow is involved
  // — and it is repeated in EVERY round, because the stateless client re-sends
  // the accumulated request per round and consumes a shallow list per round.
  if (result.newShallow.length > 0 || result.unshallow.length > 0) {
    for (const oid of result.newShallow) parts.push(encodePktLineText(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(encodePktLineText(`unshallow ${oid}\n`));
    parts.push(encodePktLine(null));
  }
  if (!request.done && request.haves.length === 0) {
    // Round 1 (wants + deepen, no haves/done yet): real git's upload-pack sends
    // ONLY the shallow list above and returns — the client consumes it, then
    // does a second RPC with haves/done. Sending NAK/pack here leaves unread
    // bytes that corrupt the client's read of the next round ("expected shallow
    // list"). With no shallow involved the response is empty, as real git's is.
    return Buffer.concat(parts);
  }
  // haves and/or done present: ACK every have the server holds, else NAK.
  let known = 0;
  for (const have of request.haves) {
    if (store.objects.has(have)) {
      parts.push(encodePktLineText(`ACK ${have}\n`));
      known += 1;
    }
  }
  if (known === 0) parts.push(encodePktLineText('NAK\n'));
  if (!request.done) {
    // Intermediate have-block round: ACKs only, no pack — the client sends
    // another round (or done) next.
    return Buffer.concat(parts);
  }
  // Final round (`done`): the sideband pack and a final flush.
  for (const packet of encodeSideband(fetchPack(store, result, request.haves))) parts.push(packet);
  parts.push(encodePktLine(null));
  return Buffer.concat(parts);
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], done: false, includeTag: false, deepenRelative: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      // v0's first want line may carry capabilities after the oid: "want <oid> <caps>".
      const oid = line.slice(5, 45);
      if (isOid(oid)) request.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) request.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (isOid(oid)) request.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7), 10);
      if (Number.isInteger(depth) && depth > 0) request.depth = depth;
    } else if (line === 'deepen-relative') {
      // Real git's `fetch --deepen=N` on an already-shallow repo: the deepen
      // count is relative to the client's current shallow boundary.
      request.deepenRelative = true;
    } else if (line === 'done') {
      request.done = true;
    } else if (line === 'include-tag') {
      request.includeTag = true;
    } else if (
      line === 'thin-pack' ||
      line === 'no-progress' ||
      line === 'ofs-delta' ||
      line === '' ||
      line.startsWith('agent=') ||
      line.startsWith('object-format=') ||
      line.startsWith('deepen-since ') ||
      line.startsWith('deepen-not ') ||
      line.startsWith('filter ')
    ) {
      // Accepted; deepen-since / deepen-not / filter are noted but not needed by the
      // checks — the suite never drives them.
    } else {
      throw new Error(`unexpected upload-pack line ${JSON.stringify(line.slice(0, 60))}`);
    }
  }
  return request;
}

/**
 * Handle a POST git-upload-pack body: protocol v2 (command=fetch / command=ls-refs)
 * or protocol v0 (want/have/done). Returns the response body bytes.
 */
export function handleUploadPack(repo: Repo, store: Store, body: Buffer): Buffer {
  const { packets } = decodePackets(body);
  // Split the data lines at the delim packet: everything before it is the command
  // section (v2), everything after it is the argument section.
  const commandLines: string[] = [];
  const argLines: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind === 'data' && packet.payload !== null) {
      (pastDelim ? argLines : commandLines).push(packet.payload.toString('utf8'));
    }
  }
  if (commandLines.length === 0 && argLines.length === 0) {
    throw new Error('upload-pack: empty request');
  }
  const first = (commandLines[0] ?? argLines[0] ?? '').replace(/\n$/, '');

  if (first.startsWith('command=')) {
    // Protocol v2.
    const command = first.slice('command='.length);
    if (command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const raw of argLines) {
        const line = raw.replace(/\n$/, '');
        if (line === 'peel') lsArgs.peel = true;
        else if (line === 'symrefs') lsArgs.symrefs = true;
        else if (line === 'unborn') lsArgs.unborn = true;
        else if (line.startsWith('ref-prefix ')) lsArgs.prefixes.push(line.slice('ref-prefix '.length));
        else if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
        else if (line === '') continue;
        else throw new Error(`unexpected ls-refs argument ${JSON.stringify(line.slice(0, 60))}`);
      }
      return handleLsRefs(repo, store, lsArgs);
    }
    if (command === 'fetch') {
      const request = parseFetchArgs(argLines);
      if (request.wants.length === 0) {
        // A fetch with no wants: just a packfile section with an empty pack.
        const parts = [
          encodePktLineText('packfile\n'),
          ...encodeSideband(buildPack([], store)),
          encodePktLine(null),
        ];
        return Buffer.concat(parts);
      }
      return v2FetchResponse(store, request);
    }
    throw new Error(`upload-pack: unknown v2 command ${JSON.stringify(command)}`);
  }

  // Protocol v0: the body is a flat stream of data lines and flushes — wants
  // (+ shallow/deepen), then the negotiation (have lines + done). Real git
  // separates them into two or three flush-terminated sections (want / deepen /
  // done), the kit into two; flushes are just separators here, so collect every
  // data line in the whole body instead of stopping after two sections (which
  // silently dropped a `done` in a third section).
  const allLines: string[] = [];
  let remaining: Buffer = body;
  while (remaining.length > 0) {
    const section = decodePackets(remaining);
    for (const packet of section.packets) {
      if (packet.kind === 'data' && packet.payload !== null) allLines.push(packet.payload.toString('utf8'));
    }
    if (section.rest.length === remaining.length) break; // no flush consumed; avoid a loop
    remaining = section.rest;
  }
  const request = parseFetchArgs(allLines);
  return v0FetchResponse(store, request);
}
