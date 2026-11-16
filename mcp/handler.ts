// MCP streamable-HTTP JSON-RPC at POST /mcp.
// Two protocol eras, both served:
//   modern 2026-07-28: server/discover answers identity + capabilities +
//           supportedVersions in one request; no handshake, no session.
//   legacy 2025-11-25 and earlier: initialize (+ notifications/initialized),
//           which the suite falls back to when server/discover is refused.
// The suite's client probes server/discover first, so the modern path is the
// one that runs; initialize is kept so a legacy-only client still works.
//
// Exact wire rules (checks-mcp.ts / mcp-client.ts):
//   - tools/list: the 6 required tools, byte-identical across calls.
//   - unknown tool -> JSON-RPC -32602 (accepted) / -32601; never HTTP 500.
//   - missing required arguments -> JSON-RPC -32602 (or isError:true).
//   - body that is not JSON -> HTTP 400 + JSON-RPC -32700.
//   - unknown method -> JSON-RPC -32601.
//   - concurrent calls keep their own ids: the request id is echoed verbatim.
//   - no Authorization -> HTTP 401 (the caller passes opts.authed=false, or
//     enforces it before calling; both work).
//   - never HTTP 500: every failure is a JSON-RPC error object with HTTP 200
//     (except parse errors: HTTP 400, and auth: HTTP 401).
import { PREFERRED_VERSION, SERVER_NAME, SERVER_VERSION, SUPPORTED_VERSIONS, TOOLS, TOOL_NAMES, callTool, missingArgs } from './tools.ts';
import { getViewer } from '../store-ops.ts';
import type { Store } from '../store-types.ts';

export interface MCPOpts {
  viewer?: string;
  /** false when the request carried no/invalid Authorization header. */
  authed?: boolean;
}
export interface HandlerResult {
  status: number;
  json: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function capabilities(): Record<string, unknown> {
  return { tools: {} };
}

/**
 * Handle one POST /mcp request. `body` should be the RAW request text so a
 * malformed body can be answered HTTP 400 / -32700; an already-parsed object
 * is also accepted. Auth is the caller's job — pass opts.authed=false (or
 * short-circuit with 401 before calling) when the request is unauthenticated.
 */
export function handleMCP(store: Store, body: unknown, opts: MCPOpts = {}): HandlerResult {
  const viewer = getViewer(store, opts.viewer);
  let parsed: unknown;
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed === '') {
      return { status: 400, json: rpcError(null, -32700, 'Parse error: empty body') };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { status: 400, json: rpcError(null, -32700, 'Parse error: body is not valid JSON') };
    }
  } else {
    parsed = body;
  }

  if (opts.authed === false) {
    const id = isRecord(parsed) ? parsed.id : null;
    return { status: 401, json: rpcError(id ?? null, -32001, 'Unauthorized') };
  }

  try {
    if (!isRecord(parsed)) {
      return { status: 200, json: rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object') };
    }
    const id = parsed.id;
    const method = parsed.method;
    if (typeof method !== 'string' || method === '') {
      return { status: 200, json: rpcError(id ?? null, -32600, 'Invalid Request: missing method') };
    }
    const params = isRecord(parsed.params) ? parsed.params : {};

    // Notifications (no id): acknowledge, no result routing.
    if (id === undefined) {
      if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
        return { status: 200, json: { jsonrpc: '2.0', result: {} } };
      }
      return { status: 200, json: { jsonrpc: '2.0', result: {} } };
    }

    switch (method) {
      case 'server/discover': {
        const info = serverInfo();
        return {
          status: 200,
          json: rpcResult(id, {
            resultType: 'discover',
            supportedVersions: [...SUPPORTED_VERSIONS],
            capabilities: capabilities(),
            instructions: 'GitHub-compatible git forge: repositories, issues, pull requests.',
            serverInfo: info,
            _meta: { 'io.modelcontextprotocol/serverInfo': info },
          }),
        };
      }
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : PREFERRED_VERSION;
        return {
          status: 200,
          json: rpcResult(id, {
            protocolVersion: negotiated,
            capabilities: capabilities(),
            serverInfo: serverInfo(),
          }),
        };
      }
      case 'ping': {
        return { status: 200, json: rpcResult(id, {}) };
      }
      case 'tools/list': {
        return { status: 200, json: rpcResult(id, { tools: TOOLS }) };
      }
      case 'tools/call': {
        const name = params.name;
        const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
        if (typeof name !== 'string' || name === '') {
          return { status: 200, json: rpcError(id, -32602, 'Invalid params: tools/call requires a tool name') };
        }
        if (!TOOL_NAMES.has(name)) {
          return { status: 200, json: rpcError(id, -32602, `Unknown tool: ${name}`) };
        }
        const missing = missingArgs(name, args);
        if (missing.length > 0) {
          return { status: 200, json: rpcError(id, -32602, `Invalid params: missing required argument(s): ${missing.join(', ')}`) };
        }
        const result = callTool(store, name, args, viewer);
        return { status: 200, json: rpcResult(id, result) };
      }
      default: {
        return { status: 200, json: rpcError(id, -32601, `Method not found: ${method}`) };
      }
    }
  } catch (err) {
    // Never HTTP 500: an unexpected failure is a JSON-RPC internal error.
    const id = isRecord(parsed) ? (parsed.id ?? null) : null;
    return { status: 200, json: rpcError(id, -32603, err instanceof Error ? err.message : String(err)) };
  }
}
