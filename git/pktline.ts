// pkt-line framing for git smart HTTP (protocol v0 and v2).
//
// A pkt-line is 4 hex length bytes (payload length + 4, the length itself included) then
// the payload. Special lengths: 0000 flush, 0001 delim, 0002 response-end. Max total
// length 65520 (git's LARGE_PACKET_MAX).

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  kind: PktKind;
  /** Present only for 'data' packets. */
  payload: Buffer | null;
}

export const PKT_LINE_MAX = 65520;
/** Largest payload a data pkt-line may carry (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * Encode one pkt-line. `null` encodes the flush packet ("0000").
 * Throws when the payload exceeds the pkt-line maximum.
 */
export function encodePktLine(payload: Buffer | null): Buffer {
  if (payload === null) return Buffer.from('0000', 'ascii');
  if (payload.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${payload.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const header = Buffer.allocUnsafe(4);
  header.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

/** Encode a UTF-8 text line as one pkt-line. */
export function encodePktLineText(text: string): Buffer {
  return encodePktLine(Buffer.from(text, 'utf8'));
}

/** The delim packet ("0001"), which separates sections in protocol v2 requests. */
export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The response-end packet ("0002"). */
export function encodeResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/**
 * Decode packets from the start of `buf`. Stops at the first flush packet and returns the
 * bytes after it as `rest` (a receive-pack body carries its raw packfile there).
 * Throws on a malformed header or a truncated packet.
 */
export function decodePackets(buf: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new Error(`truncated pkt-line header at offset ${offset}`);
    }
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(head)} at offset ${offset}`);
    }
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: null });
      return { packets, rest: buf.subarray(offset + 4) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: null });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: null });
      offset += 4;
      continue;
    }
    if (length === 3) {
      throw new Error('invalid pkt-line length 0003');
    }
    if (length > PKT_LINE_MAX) {
      throw new Error(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`);
    }
    if (offset + length > buf.length) {
      throw new Error(`truncated pkt-line: ${length} announced, ${buf.length - offset} available`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/**
 * Contract API: decode a buffer into its data-packet payloads plus `rest` (the bytes after
 * the first flush packet, if any — e.g. the raw packfile of a receive-pack body).
 * Control packets (delim / response-end) are skipped; a flush ends the packet stream.
 */
export function parsePktLine(buf: Buffer): { lines: Buffer[]; rest: Buffer } {
  const { packets, rest } = decodePackets(buf);
  const lines: Buffer[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data' && packet.payload !== null) lines.push(packet.payload);
  }
  return { lines, rest };
}

/** Encode a sequence of data lines plus a terminating flush packet. */
export function encodePktLines(lines: readonly (Buffer | string)[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    parts.push(typeof line === 'string' ? encodePktLineText(line) : encodePktLine(line));
  }
  parts.push(encodePktLine(null));
  return Buffer.concat(parts);
}

/**
 * Split a buffer of sideband band-1 data into pkt-lines of at most PKT_LINE_MAX bytes
 * each, every payload prefixed with the band byte 1.
 */
export function encodeSideband(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const maxData = PKT_LINE_MAX_PAYLOAD - 1; // one byte is the band number
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(encodePktLine(payload));
  }
  return parts;
}
