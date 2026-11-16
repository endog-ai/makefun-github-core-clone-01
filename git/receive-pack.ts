// receive-pack: unpack a pushed packfile, validate each ref command, apply the
// accepted ones, and report per-ref ok/ng inside sideband-64k (band 1), with the
// report-status lines themselves pkt-line framed — exactly as the kit's
// git-client.ts parses them.
//
// Refusal rules (GitHub-like, as the checks require):
//  - a create (old = zero) fails when the ref already exists ("already exists");
//  - a delete fails when the ref does not exist, or its old value does not match;
//  - an update fails when the current value does not match old ("cannot lock ref ...");
//  - an update to a value that is not a descendant of the current tip is refused
//    with the exact reason "non-fast-forward";
//  - a failed unpack refuses every command and nothing is applied.
// Objects from the pack are stored even when a ref is refused (unpack happens first).

import type { Repo, Store } from './types.ts';
import { ZERO_OID, isOid } from './types.ts';
import { getObject, isFastForward, peelToCommit } from './objects.ts';
import { parsePack } from './pack.ts';
import { encodePktLine, parsePktLine } from './pktline.ts';

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface RefResult {
  ref: string;
  ok: boolean;
  reason: string;
}

function parseCommands(lines: Buffer[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let text = lines[index].toString('utf8');
    if (index === 0) {
      // The first command line may carry capabilities after a NUL.
      const nul = text.indexOf('\u0000');
      if (nul >= 0) text = text.slice(0, nul);
    }
    text = text.replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
    if (!match) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 80))}`);
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  return commands;
}

function applyCommand(repo: Repo, store: Store, command: PushCommand): RefResult {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/')) {
    return { ref, ok: false, reason: 'invalid ref name' };
  }
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) {
      return { ref, ok: false, reason: `cannot lock ref '${ref}': is at ${current} but expected ${oldOid}` };
    }
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ref, ok: false, reason: 'already exists' };
    if (ref.startsWith('refs/heads/') && peelToCommit(store, newOid) === null) {
      return { ref, ok: false, reason: 'new tip does not point to a commit' };
    }
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
  if (current !== oldOid) {
    return { ref, ok: false, reason: `cannot lock ref '${ref}': is at ${current} but expected ${oldOid}` };
  }
  if (newOid === oldOid) return { ref, ok: true, reason: '' };
  if (ref.startsWith('refs/heads/') && peelToCommit(store, newOid) === null) {
    return { ref, ok: false, reason: 'new tip does not point to a commit' };
  }
  if (!isFastForward(store, oldOid, newOid)) {
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}

/**
 * Handle a POST git-receive-pack body: command lines, a flush, then the packfile.
 * Returns the report body: "unpack ok" + one ok/ng line per command, each pkt-line
 * framed inside a sideband band-1 packet, terminated by a flush.
 */
export function handleReceivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const { lines, rest } = parsePktLine(body);
  const commands = parseCommands(lines);
  if (commands.length === 0) throw new Error('receive-pack: no commands');

  // Unpack first: a pack the server cannot read refuses every command.
  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const objects = parsePack(rest, (oid) => {
        const object = getObject(store, oid);
        return object ? { type: object.type, content: object.content } : undefined;
      });
      for (const [oid, object] of objects) {
        store.objects.set(oid, { type: object.type, data: object.data });
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  // Every new tip must resolve to an object the server now holds.
  if (unpackError === null) {
    for (const command of commands) {
      if (command.newOid !== ZERO_OID && !store.objects.has(command.newOid)) {
        unpackError = `missing object ${command.newOid}`;
        break;
      }
    }
  }

  const results: RefResult[] = [];
  if (unpackError !== null) {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    }
  } else {
    for (const command of commands) results.push(applyCommand(repo, store, command));
  }

  const reportLines: string[] = [unpackError !== null ? `unpack ${unpackError}\n` : 'unpack ok\n'];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  // The report travels as ONE inner pkt-line stream inside sideband band 1 — the
  // inner stream is itself terminated by a flush packet, and only then does the
  // outer stream end with a flush. Real git's report parser reads the inner stream
  // to its flush; without it, it hits EOF and dies "the remote end hung up".
  const innerParts: Buffer[] = [];
  for (const line of reportLines) innerParts.push(encodePktLine(Buffer.from(line, 'utf8')));
  innerParts.push(encodePktLine(null)); // inner flush
  const inner = Buffer.concat(innerParts);
  const out: Buffer[] = [];
  const maxData = 65520 - 4 - 1; // pkt-line header + band byte
  for (let offset = 0; offset < inner.length; offset += maxData) {
    const slice = inner.subarray(offset, Math.min(inner.length, offset + maxData));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  out.push(encodePktLine(null)); // outer flush
  return Buffer.concat(out);
}
