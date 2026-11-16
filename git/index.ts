// git/ — the git smart-HTTP protocol module (builder A).
//
// Pure Node 22 stdlib (node:zlib, node:crypto, node:buffer). No `git` binary, no deps.
// Commit objects are stored and returned as the exact bytes received — never
// re-serialised — so clones round-trip them byte-exactly.
//
// Contract exports (per BUILD-PLAN.md "Git module interface"):
export { parsePktLine, encodePktLine } from './pktline.ts';
export { hashObject, parseObject } from './objects.ts';
export { parsePack, buildPack } from './pack.ts';
export { handleUploadPack, handleInfoRefs } from './upload-pack.ts';
export { handleReceivePack } from './receive-pack.ts';

// Additional exports the coordinator / tests may use:
export { decodePackets, encodePktLineText, encodeDelim, encodeResponseEnd, encodeSideband } from './pktline.ts';
export {
  parseCommit,
  parseTree,
  parseTag,
  getObject,
  putObject,
  collectReachable,
  peelToCommit,
  isAncestorCommit,
  isFastForward,
} from './objects.ts';
export { applyDelta, makeDelta, packChecksum, verifyPackChecksum, encodeOfsDeltaOffset } from './pack.ts';
export type { PackObject, BuildPackOpts, PackBaseLookup } from './pack.ts';
export { negotiate, listRefs } from './upload-pack.ts';
export type { FetchRequest, Negotiation } from './upload-pack.ts';
export type { ObjType, StoredObject, Store, Repo, Issue, Comment, Pull, Label } from './types.ts';
export { ZERO_OID, isOid } from './types.ts';
