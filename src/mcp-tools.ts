import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { isIPv4 } from "node:net";
import { TextDecoder } from "node:util";
import { InvalidRequestError, SessionNotFoundError } from "./errors.js";
import type {
  PendingToolCall,
  SessionMcpServer,
  SessionMcpServerLimits,
  SessionMcpToolCallHandler,
  SessionMcpToolResult,
  SessionMcpDeliveryOutcome,
  SessionToolRegistry,
} from "./contracts.js";
import {
  copyToolCallArguments,
  copyToolJson,
  validateCallerToolArguments,
  type CompiledCallerTool,
  type CompiledCallerToolCatalog,
} from "./tool-schema.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 64;
const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 16;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BYTES = 16 * 1_048_576;
const MAX_RESPONSE_BYTES = 16 * 1_048_576;
const MAX_CONCURRENT_REQUESTS = 256;
const MAX_CONCURRENT_TOOL_CALLS = 64;
const MAX_SHUTDOWN_TIMEOUT_MS = 10_000;
const CANCELLATION_RESERVE = 8;
const MAX_JSON_NODES = 25_000;
const MAX_JSON_DEPTH = 64;
const MAX_SERIALIZED_RPC_ID_BYTES = 256;
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SESSION_HEADER = "mcp-session-id";
const ACCOUNT_HEADER = "x-antigravity-account-id";
const BOUND_SESSION_HEADER = "x-antigravity-session-id";
const CATALOG_HEADER = "x-antigravity-tool-catalog";

type RpcId = string | number;
type AbortKind = "timeout" | "cancel" | "client-disconnect" | "server-close";

interface Limits {
  readonly requestTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxConcurrentRequests: number;
  readonly maxConcurrentToolCalls: number;
  readonly shutdownTimeoutMs: number;
}

interface RequestState {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly controller: AbortController;
  readonly deadlineAt: number;
  abortKind?: AbortKind;
  requestId?: RpcId;
  idKey?: string;
  parsed: boolean;
  responseSent: boolean;
  timer?: NodeJS.Timeout;
}

interface SessionMcpBinding {
  readonly accountId: string;
  readonly sessionId: string;
  readonly catalog: CompiledCallerToolCatalog;
  readonly defaultHandler: SessionMcpToolCallHandler;
  readonly onServerCreated?: (server: SessionMcpServer) => Promise<void>;
  readonly onDelivery?: (callId: string, outcome: SessionMcpDeliveryOutcome) => Promise<void>;
}

class HttpRejection extends Error {
  constructor(readonly status: number) {
    super("The MCP HTTP request was rejected.");
  }
}

class JsonParseFailure extends Error {
  constructor() {
    super("The MCP request body is not valid JSON.");
  }
}

class AbortedRequest extends Error {
  constructor(readonly kind: AbortKind) {
    super("The MCP request was interrupted.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validatePositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  minimum = 1,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new InvalidRequestError("MCP server limits must be positive integers within their supported bounds.");
  }
  return resolved;
}

function validateLimits(value: SessionMcpServerLimits | undefined): Limits {
  const options = value ?? {};
  if (
    !isRecord(options) ||
    Object.keys(options).some((key) => ![
      "requestTimeoutMs", "maxRequestBytes", "maxResponseBytes", "maxConcurrentRequests",
      "maxConcurrentToolCalls", "shutdownTimeoutMs",
    ].includes(key))
  ) throw new InvalidRequestError("MCP server limits are invalid.");
  const numberOption = (key: keyof SessionMcpServerLimits): number | undefined => {
    const option = (options as Record<string, unknown>)[key];
    if (option === undefined) return undefined;
    if (typeof option !== "number") {
      throw new InvalidRequestError("MCP server limits must be numbers.");
    }
    return option;
  };
  return Object.freeze({
    requestTimeoutMs: validatePositiveInteger(numberOption("requestTimeoutMs"), DEFAULT_REQUEST_TIMEOUT_MS, MAX_REQUEST_TIMEOUT_MS),
    maxRequestBytes: validatePositiveInteger(numberOption("maxRequestBytes"), DEFAULT_MAX_REQUEST_BYTES, MAX_REQUEST_BYTES, 256),
    maxResponseBytes: validatePositiveInteger(numberOption("maxResponseBytes"), DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, 1_024),
    maxConcurrentRequests: validatePositiveInteger(
      numberOption("maxConcurrentRequests"),
      DEFAULT_MAX_CONCURRENT_REQUESTS,
      MAX_CONCURRENT_REQUESTS,
    ),
    maxConcurrentToolCalls: validatePositiveInteger(
      numberOption("maxConcurrentToolCalls"),
      DEFAULT_MAX_CONCURRENT_TOOL_CALLS,
      MAX_CONCURRENT_TOOL_CALLS,
    ),
    shutdownTimeoutMs: validatePositiveInteger(numberOption("shutdownTimeoutMs"), DEFAULT_SHUTDOWN_TIMEOUT_MS, MAX_SHUTDOWN_TIMEOUT_MS),
  });
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isBoundedRpcId(value: unknown): value is RpcId {
  if (!isRpcId(value)) return false;
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized, "utf8") <= MAX_SERIALIZED_RPC_ID_BYTES;
}

function rpcIdKey(value: RpcId): string {
  return typeof value === "string" ? `s:${value}` : `n:${JSON.stringify(value)}`;
}

function requestIdFromEnvelope(value: unknown): RpcId | undefined {
  if (!isRecord(value) || !hasOwn(value, "id") || !isBoundedRpcId(value.id)) return undefined;
  return value.id;
}

function assertParsedJsonBounds(value: unknown): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) throw new HttpRejection(400);
    if (typeof current.value === "object" && current.value !== null) {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
}

function oneHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function hasLoopbackPeer(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  if (address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1") return true;
  return address !== undefined && isIPv4(address) && address.startsWith("127.");
}

function secureStringEqual(left: string, right: string): boolean {
  const first = Buffer.from(left, "utf8");
  const second = Buffer.from(right, "utf8");
  return first.byteLength === second.byteLength && timingSafeEqual(first, second);
}

async function raceWithAbort<T>(promise: Promise<T>, state: RequestState): Promise<T> {
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new AbortedRequest(state.abortKind ?? "server-close"));
    if (state.controller.signal.aborted) listener();
    else state.controller.signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (listener) state.controller.signal.removeEventListener("abort", listener);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeToolResult(input: unknown, maxBytes: number): SessionMcpToolResult {
  if (!isRecord(input) || !exactKeys(input, ["content", "isError", "structuredContent"])) {
    throw new Error("invalid-tool-result");
  }
  const copied = copyToolJson(input, maxBytes) as Record<string, unknown>;
  if (!Array.isArray(copied.content)) throw new Error("invalid-tool-result");
  const content: Array<{ type: "text"; text: string }> = [];
  for (const block of copied.content) {
    if (!isRecord(block) || !exactKeys(block, ["type", "text"]) || block.type !== "text" || typeof block.text !== "string") {
      throw new Error("invalid-tool-result");
    }
    content.push(Object.freeze({ type: "text", text: block.text }));
  }
  if (hasOwn(copied, "isError") && typeof copied.isError !== "boolean") throw new Error("invalid-tool-result");
  if (hasOwn(copied, "structuredContent") && !isRecord(copied.structuredContent)) throw new Error("invalid-tool-result");
  const result: {
    content: readonly { type: "text"; text: string }[];
    isError?: boolean;
    structuredContent?: Readonly<Record<string, unknown>>;
  } = { content: Object.freeze(content) };
  if (typeof copied.isError === "boolean") result.isError = copied.isError;
  if (isRecord(copied.structuredContent)) {
    result.structuredContent = Object.freeze(copied.structuredContent);
  }
  return Object.freeze(result);
}

/** Exact serialized JSON-RPC result envelope used by the loopback tool server. */
export function sessionMcpToolResultResponseBytes(
  requestId: string | number,
  result: SessionMcpToolResult,
): number {
  try {
    const serialized = JSON.stringify({ jsonrpc: "2.0", id: requestId, result });
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

class McpToolServer {
  readonly #http: HttpServer;
  readonly #token = randomBytes(32).toString("base64url");
  readonly #mcpSessionId = randomBytes(24).toString("base64url");
  readonly #requestStates = new Set<RequestState>();
  readonly #activeRequests = new Map<string, RequestState>();
  readonly #activeToolCallStates = new Map<string, RequestState>();
  readonly #handlerPromises = new Set<Promise<SessionMcpToolResult>>();
  readonly #limits: Limits;
  readonly #onToolCall: SessionMcpToolCallHandler;
  readonly #binding: SessionMcpBinding;
  #started = false;
  #closed = false;
  #initialized = false;
  #clientInitialized = false;
  #protocolVersion: string | undefined;
  #port: number | undefined;
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #activeToolCalls = 0;
  #publicServer: SessionMcpServer | undefined;

  constructor(
    binding: SessionMcpBinding,
    onToolCall: SessionMcpToolCallHandler,
    limits: Limits,
  ) {
    this.#binding = binding;
    this.#onToolCall = onToolCall;
    this.#limits = limits;
    this.#http = createHttpServer((request, response) => {
      void this.#handleRequest(request, response).catch(() => {
        if (!response.destroyed && !response.writableEnded) this.#sendHttpError(response, 500);
      });
    });
    this.#http.maxHeadersCount = 64;
    this.#http.maxConnections = limits.maxConcurrentRequests + CANCELLATION_RESERVE;
    this.#http.headersTimeout = Math.min(10_000, Math.max(1_000, limits.requestTimeoutMs));
    this.#http.requestTimeout = limits.requestTimeoutMs;
    // The explicit wall-clock timer covers in-flight RPC/handoff work; an
    // inactivity socket timeout would race it and silently drop JSON-RPC errors.
    this.#http.timeout = 0;
    this.#http.keepAliveTimeout = 5_000;
    this.#http.on("error", () => {
      if (this.#started && !this.#closed) this.#abortAll("server-close");
    });
  }

  get publicServer(): SessionMcpServer | undefined {
    return this.#publicServer;
  }

  start(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    if (this.#closed) return Promise.reject(new SessionNotFoundError("The session tool server is closed."));
    this.#startPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#http.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#http.removeListener("error", onError);
        const address = this.#http.address();
        if (!address || typeof address === "string") {
          reject(new Error("invalid-listen-address"));
          return;
        }
        this.#port = address.port;
        this.#started = true;
        const endpoint = `http://127.0.0.1:${address.port}/mcp`;
        const headers = Object.freeze({
          authorization: `Bearer ${this.#token}`,
          [ACCOUNT_HEADER]: this.#binding.accountId,
          [BOUND_SESSION_HEADER]: this.#binding.sessionId,
          [CATALOG_HEADER]: this.#binding.catalog.id,
        });
        this.#publicServer = Object.freeze({
          url: endpoint,
          headers,
          accountId: this.#binding.accountId,
          sessionId: this.#binding.sessionId,
          catalogId: this.#binding.catalog.id,
          close: () => this.close(),
        });
        resolve();
      };
      this.#http.once("error", onError);
      this.#http.once("listening", onListening);
      this.#http.listen({ host: "127.0.0.1", port: 0, exclusive: true });
    }).then(async () => {
      if (this.#closed) {
        await this.#stopHttpServer();
        throw new SessionNotFoundError("The session tool server closed during startup.");
      }
    });
    return this.#startPromise;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#abortAll("server-close");
    this.#closePromise = (async () => {
      const start = this.#startPromise;
      if (start) await Promise.race([start.catch(() => undefined), delay(this.#limits.shutdownTimeoutMs)]);
      const handlers = [...this.#handlerPromises];
      if (handlers.length > 0) {
        await Promise.race([
          Promise.allSettled(handlers).then(() => undefined),
          delay(this.#limits.shutdownTimeoutMs),
        ]);
      }
      await this.#stopHttpServer();
    })();
    return this.#closePromise;
  }

  async #stopHttpServer(): Promise<void> {
    if (!this.#http.listening) return;
    const closed = new Promise<void>((resolve) => {
      try {
        this.#http.close(() => resolve());
        this.#http.closeIdleConnections();
        this.#http.closeAllConnections();
      } catch {
        resolve();
      }
    });
    await Promise.race([closed, delay(this.#limits.shutdownTimeoutMs)]);
  }

  #abortAll(kind: AbortKind): void {
    for (const state of this.#requestStates) this.#abort(state, kind);
  }

  #abort(state: RequestState, kind: AbortKind): void {
    if (!state.controller.signal.aborted) {
      state.abortKind = kind;
      state.controller.abort(kind);
    }
    // A response that has started cannot be replaced by a JSON-RPC timeout
    // error. Cut off a stalled socket instead of letting it outlive the request.
    if (
      kind === "timeout" && state.response.headersSent &&
      !state.response.writableFinished
    ) {
      if (!state.response.destroyed) state.response.destroy();
      if (!state.request.socket.destroyed) state.request.socket.destroy();
    }
  }

  cancelToolCall(callId: string): void {
    const state = this.#activeToolCallStates.get(callId);
    if (!state) return;
    this.#abort(state, "cancel");
    // An MCP result may already have been handed to ServerResponse.end while a
    // peer is not reading it. A session abort must not wait for finish/close.
    if (state.response.headersSent && !state.response.writableFinished && !state.response.destroyed) {
      state.response.destroy();
      if (!state.request.socket.destroyed) state.request.socket.destroy();
    }
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!hasLoopbackPeer(request)) {
      this.#sendHttpError(response, 403);
      return;
    }
    if (request.headers.origin !== undefined) {
      this.#sendHttpError(response, 403);
      return;
    }
    if (request.headers.host !== `127.0.0.1:${this.#port}`) {
      this.#sendHttpError(response, 400);
      return;
    }
    const url = request.url;
    if (url !== "/mcp") {
      this.#sendHttpError(response, 404);
      return;
    }
    const authorization = oneHeader(request, "authorization");
    const presentedToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!secureStringEqual(presentedToken, this.#token)) {
      this.#sendHttpError(response, 401);
      return;
    }
    if (
      oneHeader(request, ACCOUNT_HEADER) !== this.#binding.accountId ||
      oneHeader(request, BOUND_SESSION_HEADER) !== this.#binding.sessionId ||
      oneHeader(request, CATALOG_HEADER) !== this.#binding.catalog.id
    ) {
      this.#sendHttpError(response, 404);
      return;
    }
    if (request.method !== "POST") {
      this.#sendHttpError(response, 405);
      return;
    }
    if (this.#closed) {
      this.#sendHttpError(response, 503);
      return;
    }
    if (this.#requestStates.size >= this.#limits.maxConcurrentRequests + CANCELLATION_RESERVE) {
      this.#sendHttpError(response, 503);
      return;
    }

    const state: RequestState = {
      request,
      response,
      controller: new AbortController(),
      deadlineAt: Date.now() + this.#limits.requestTimeoutMs,
      parsed: false,
      responseSent: false,
    };
    this.#requestStates.add(state);
    const onResponseClose = (): void => {
      if (!response.writableEnded) this.#abort(state, "client-disconnect");
    };
    response.once("close", onResponseClose);
    state.timer = setTimeout(() => this.#abort(state, "timeout"), this.#limits.requestTimeoutMs);
    state.timer.unref();

    try {
      const envelope = await this.#readJsonBody(state);
      state.parsed = true;
      if (Date.now() >= state.deadlineAt) this.#abort(state, "timeout");
      if (state.controller.signal.aborted) throw new AbortedRequest(state.abortKind ?? "server-close");
      if (
        this.#requestStates.size > this.#limits.maxConcurrentRequests &&
        !this.#isCancellationNotification(envelope)
      ) {
        this.#sendHttpError(response, 503, state);
        return;
      }
      await this.#handleEnvelope(state, envelope);
    } catch (error) {
      if (state.responseSent || response.destroyed || response.writableEnded) return;
      if (error instanceof JsonParseFailure) {
        this.#sendRpc(state, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, 400);
      } else if (error instanceof HttpRejection) {
        this.#sendHttpError(response, error.status, state);
      } else if (error instanceof AbortedRequest || state.controller.signal.aborted) {
        const kind = error instanceof AbortedRequest ? error.kind : state.abortKind;
        if (kind === "timeout") {
          if (state.parsed) this.#sendRpcError(state, state.requestId ?? null, -32001, "Request timed out.");
          else this.#sendHttpError(response, 408, state);
        } else if (kind === "cancel") {
          this.#sendRpcError(state, state.requestId ?? null, -32800, "Request cancelled.");
        }
      } else {
        this.#sendHttpError(response, 400, state);
      }
    } finally {
      try {
        if (state.responseSent) await this.#waitForResponse(state);
      } finally {
        if (state.timer) clearTimeout(state.timer);
        response.removeListener("close", onResponseClose);
        if (state.idKey && this.#activeRequests.get(state.idKey) === state) {
          this.#activeRequests.delete(state.idKey);
        }
        this.#requestStates.delete(state);
      }
    }
  }

  #waitForResponse(state: RequestState): Promise<void> {
    const response = state.response;
    if (response.writableFinished || response.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        response.removeListener("finish", done);
        response.removeListener("close", done);
        resolve();
      };
      response.once("finish", done);
      response.once("close", done);
      if (response.writableFinished || response.destroyed) done();
    });
  }

  #waitForResponseDelivery(state: RequestState): Promise<SessionMcpDeliveryOutcome> {
    const response = state.response;
    if (response.writableFinished) return Promise.resolve(state.controller.signal.aborted ? "uncertain" : "delivered");
    if (response.destroyed) return Promise.resolve("uncertain");
    return new Promise<SessionMcpDeliveryOutcome>((resolve) => {
      const cleanup = (): void => {
        response.removeListener("finish", onFinish);
        response.removeListener("close", onClose);
        state.controller.signal.removeEventListener("abort", onAbort);
      };
      const onFinish = (): void => {
        cleanup();
        resolve(state.controller.signal.aborted ? "uncertain" : "delivered");
      };
      const onClose = (): void => {
        cleanup();
        resolve(response.writableFinished && !state.controller.signal.aborted ? "delivered" : "uncertain");
      };
      const onAbort = (): void => {
        if (response.destroyed || response.writableFinished) onClose();
      };
      response.once("finish", onFinish);
      response.once("close", onClose);
      state.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (state.controller.signal.aborted) onAbort();
      if (response.writableFinished || response.destroyed) onClose();
    });
  }

  #isCancellationNotification(value: unknown): boolean {
    return isRecord(value) && !hasOwn(value, "id") && value.method === "notifications/cancelled";
  }

  async #readJsonBody(state: RequestState): Promise<unknown> {
    const { request } = state;
    const contentType = oneHeader(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      request.resume();
      throw new HttpRejection(415);
    }
    const contentEncoding = oneHeader(request, "content-encoding");
    if (contentEncoding !== undefined && contentEncoding.toLowerCase() !== "identity") {
      request.resume();
      throw new HttpRejection(415);
    }
    const lengthHeader = oneHeader(request, "content-length");
    if (lengthHeader !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/u.test(lengthHeader)) {
        request.resume();
        throw new HttpRejection(400);
      }
      if (Number(lengthHeader) > this.#limits.maxRequestBytes) {
        request.resume();
        throw new HttpRejection(413);
      }
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    const body = new Promise<Buffer>((resolve, reject) => {
      const cleanup = (): void => {
        request.removeListener("data", onData);
        request.removeListener("end", onEnd);
        request.removeListener("error", onError);
        request.removeListener("aborted", onAborted);
        state.controller.signal.removeEventListener("abort", onAbort);
      };
      const onData = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > this.#limits.maxRequestBytes) {
          tooLarge = true;
          chunks.length = 0;
        } else if (!tooLarge) {
          chunks.push(buffer);
        }
      };
      const onEnd = (): void => {
        cleanup();
        if (tooLarge) reject(new HttpRejection(413));
        else resolve(Buffer.concat(chunks, bytes));
      };
      const onError = (): void => {
        cleanup();
        reject(new HttpRejection(400));
      };
      const onAborted = (): void => {
        cleanup();
        reject(new AbortedRequest(state.abortKind ?? "client-disconnect"));
      };
      const onAbort = (): void => {
        cleanup();
        request.resume();
        reject(new AbortedRequest(state.abortKind ?? "server-close"));
      };
      request.on("data", onData);
      request.once("end", onEnd);
      request.once("error", onError);
      request.once("aborted", onAborted);
      state.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (state.controller.signal.aborted) onAbort();
    });

    let bytesBody: Buffer;
    try {
      bytesBody = await body;
    } catch (error) {
      throw error;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytesBody);
    } catch {
      throw new JsonParseFailure();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new JsonParseFailure();
    }
    assertParsedJsonBounds(parsed);
    return parsed;
  }

  async #handleEnvelope(state: RequestState, input: unknown): Promise<void> {
    if (!isRecord(input) || input.jsonrpc !== "2.0" || typeof input.method !== "string") {
      this.#sendRpcError(state, requestIdFromEnvelope(input) ?? null, -32600, "Invalid Request.");
      return;
    }
    const hasId = hasOwn(input, "id");
    if (hasId && !isBoundedRpcId(input.id)) {
      this.#sendRpcError(state, null, -32600, "Invalid Request.");
      return;
    }
    if (hasId) {
      state.requestId = input.id as RpcId;
      state.idKey = rpcIdKey(state.requestId);
      if (this.#activeRequests.has(state.idKey)) {
        this.#sendRpcError(state, state.requestId, -32600, "A request with this ID is already active.");
        return;
      }
      this.#activeRequests.set(state.idKey, state);
    }

    try {
      if (state.controller.signal.aborted) throw new AbortedRequest(state.abortKind ?? "server-close");
      if (input.method === "initialize") {
        if (!hasId) return this.#sendAccepted(state);
        await this.#initialize(state, input.params);
        return;
      }

      this.#assertBoundMcpSession(state, input.method);
      if (!hasId) {
        await this.#handleNotification(state, input.method, input.params);
        return;
      }
      if (input.method === "notifications/initialized" || input.method === "notifications/cancelled") {
        this.#sendRpcError(state, state.requestId!, -32600, "Notifications must not include an ID.");
        return;
      }
      if (!this.#clientInitialized) {
        this.#sendRpcError(state, state.requestId!, -32600, "The MCP session is not initialized.");
        return;
      }
      if (input.method === "tools/list") {
        this.#toolsList(state, input.params);
        return;
      }
      if (input.method === "tools/call") {
        await this.#toolsCall(state, input.params);
        return;
      }
      this.#sendRpcError(state, state.requestId!, -32601, "Method not found.");
    } catch (error) {
      if (state.responseSent || state.response.destroyed || state.response.writableEnded) return;
      if (error instanceof HttpRejection) {
        this.#sendHttpError(state.response, error.status, state);
      } else if (error instanceof AbortedRequest || state.controller.signal.aborted) {
        const kind = error instanceof AbortedRequest ? error.kind : state.abortKind;
        if (kind === "cancel") this.#sendRpcError(state, state.requestId ?? null, -32800, "Request cancelled.");
        else if (kind === "timeout") this.#sendRpcError(state, state.requestId ?? null, -32001, "Request timed out.");
      } else {
        this.#sendRpcError(state, state.requestId ?? null, -32603, "Internal error.");
      }
    }
  }

  async #initialize(state: RequestState, input: unknown): Promise<void> {
    if (oneHeader(state.request, SESSION_HEADER) !== undefined) throw new HttpRejection(404);
    if (this.#initialized) {
      this.#sendRpcError(state, state.requestId!, -32600, "The MCP session is already initialized.");
      return;
    }
    if (!isRecord(input) || !exactKeys(input, ["protocolVersion", "capabilities", "clientInfo", "_meta"])) {
      this.#sendRpcError(state, state.requestId!, -32602, "Invalid initialize parameters.");
      return;
    }
    if (
      typeof input.protocolVersion !== "string" || !isRecord(input.capabilities) ||
      !isRecord(input.clientInfo) || typeof input.clientInfo.name !== "string" ||
      typeof input.clientInfo.version !== "string"
    ) {
      this.#sendRpcError(state, state.requestId!, -32602, "Invalid initialize parameters.");
      return;
    }
    this.#protocolVersion = PROTOCOL_VERSIONS.has(input.protocolVersion)
      ? input.protocolVersion
      : LATEST_PROTOCOL_VERSION;
    this.#initialized = true;
    this.#sendRpc(state, {
      jsonrpc: "2.0",
      id: state.requestId!,
      result: {
        protocolVersion: this.#protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "antigravity-session-tools", version: "0.1.0" },
      },
    }, 200, true);
  }

  #assertBoundMcpSession(state: RequestState, method: string): void {
    const suppliedSessionId = oneHeader(state.request, SESSION_HEADER);
    if (!this.#initialized || !this.#publicServer) throw new HttpRejection(404);
    if (suppliedSessionId !== this.#mcpSessionId) throw new HttpRejection(404);
    const protocolHeader = oneHeader(state.request, "mcp-protocol-version");
    if (protocolHeader !== undefined && protocolHeader !== this.#protocolVersion) throw new HttpRejection(400);
    if (method === "initialize" && suppliedSessionId !== undefined) throw new HttpRejection(400);
  }

  async #handleNotification(state: RequestState, method: string, params: unknown): Promise<void> {
    if (method === "notifications/initialized") {
      if (params !== undefined && !isRecord(params)) {
        this.#sendAccepted(state);
        return;
      }
      this.#clientInitialized = true;
      this.#sendAccepted(state);
      return;
    }
    if (method === "notifications/cancelled") {
      if (!isRecord(params) || !exactKeys(params, ["requestId", "reason", "_meta"]) || !isBoundedRpcId(params.requestId)) {
        this.#sendAccepted(state);
        return;
      }
      const target = this.#activeRequests.get(rpcIdKey(params.requestId));
      if (target && target !== state) this.#abort(target, "cancel");
      this.#sendAccepted(state);
      return;
    }
    // JSON-RPC notifications never receive a response, including unknown ones.
    this.#sendAccepted(state);
  }

  #toolsList(state: RequestState, input: unknown): void {
    if (input !== undefined && (!isRecord(input) || !exactKeys(input, ["_meta"]))) {
      this.#sendRpcError(state, state.requestId!, -32602, "Invalid tools/list parameters.");
      return;
    }
    const tools = this.#binding.catalog.tools.map((tool) => {
      const response: { name: string; description?: string; inputSchema: Readonly<Record<string, unknown>> } = {
        name: tool.name,
        inputSchema: tool.inputSchema,
      };
      if (tool.description !== undefined) response.description = tool.description;
      return response;
    });
    this.#sendRpc(state, { jsonrpc: "2.0", id: state.requestId!, result: { tools } });
  }

  async #toolsCall(state: RequestState, input: unknown): Promise<void> {
    if (
      !isRecord(input) || !exactKeys(input, ["name", "arguments", "_meta"]) ||
      typeof input.name !== "string" ||
      (hasOwn(input, "arguments") && !isRecord(input.arguments))
    ) {
      this.#sendRpcError(state, state.requestId!, -32602, "Invalid tools/call parameters.");
      return;
    }
    const tool = this.#binding.catalog.tools.find(({ name }) => name === input.name);
    if (!tool) {
      this.#sendRpcError(state, state.requestId!, -32602, "Unknown tool.");
      return;
    }
    const args = hasOwn(input, "arguments") ? input.arguments : {};
    if (Date.now() >= state.deadlineAt) this.#abort(state, "timeout");
    if (state.controller.signal.aborted) throw new AbortedRequest(state.abortKind ?? "server-close");
    let valid = false;
    try {
      valid = validateCallerToolArguments(tool, args);
    } catch {
      valid = false;
    }
    if (Date.now() >= state.deadlineAt) this.#abort(state, "timeout");
    if (state.controller.signal.aborted) throw new AbortedRequest(state.abortKind ?? "server-close");
    if (!valid) {
      this.#sendRpcError(state, state.requestId!, -32602, "Tool arguments do not match the declared input schema.");
      return;
    }
    if (this.#activeToolCalls >= this.#limits.maxConcurrentToolCalls) {
      this.#sendRpcError(state, state.requestId!, -32004, "The tool-call limit is reached.");
      return;
    }

    let callArguments: Readonly<Record<string, unknown>>;
    try {
      callArguments = copyToolCallArguments(args);
    } catch {
      this.#sendRpcError(state, state.requestId!, -32602, "Tool arguments are invalid.");
      return;
    }
    if (Date.now() >= state.deadlineAt) this.#abort(state, "timeout");
    if (state.controller.signal.aborted) throw new AbortedRequest(state.abortKind ?? "server-close");
    const call: PendingToolCall = Object.freeze({
      callId: `toolu_${randomUUID().replaceAll("-", "")}`,
      requestId: state.requestId!,
      accountId: this.#binding.accountId,
      sessionId: this.#binding.sessionId,
      catalogId: this.#binding.catalog.id,
      name: tool.name,
      arguments: callArguments,
    });

    this.#activeToolCalls += 1;
    this.#activeToolCallStates.set(call.callId, state);
    let deliveryReported = false;
    const reportDelivery = async (outcome: SessionMcpDeliveryOutcome): Promise<void> => {
      if (deliveryReported) return;
      deliveryReported = true;
      await this.#binding.onDelivery?.(call.callId, outcome);
    };
    const rawHandlerResult = Promise.resolve().then(() => this.#onToolCall(call, {
      signal: state.controller.signal,
      maxResponseBytes: this.#limits.maxResponseBytes,
      deadlineAt: state.deadlineAt,
    }));
    const trackedHandlerResult = rawHandlerResult.then(
      (result) => {
        this.#activeToolCalls -= 1;
        this.#handlerPromises.delete(trackedHandlerResult);
        return result;
      },
      (error: unknown) => {
        this.#activeToolCalls -= 1;
        this.#handlerPromises.delete(trackedHandlerResult);
        throw error;
      },
    );
    this.#handlerPromises.add(trackedHandlerResult);
    try {
      const raw = await raceWithAbort(trackedHandlerResult, state);
      if (state.controller.signal.aborted) throw new AbortedRequest(state.abortKind ?? "server-close");
      const result = normalizeToolResult(raw, this.#limits.maxResponseBytes);
      const envelope = { jsonrpc: "2.0", id: state.requestId!, result };
      if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > this.#limits.maxResponseBytes) {
        this.#sendRpcError(state, state.requestId!, -32603, "The tool result exceeded the configured bound.");
        await reportDelivery("uncertain");
        return;
      }
      const sent = this.#sendRpc(state, envelope);
      if (!sent) {
        await reportDelivery("uncertain");
        return;
      }
      await reportDelivery(await this.#waitForResponseDelivery(state));
    } catch (error) {
      await reportDelivery("uncertain");
      if (error instanceof AbortedRequest || state.controller.signal.aborted) throw error;
      this.#sendRpcError(state, state.requestId!, -32603, "The tool-call handler failed.");
    } finally {
      if (this.#activeToolCallStates.get(call.callId) === state) {
        this.#activeToolCallStates.delete(call.callId);
      }
    }
  }

  #sendRpcError(state: RequestState, id: RpcId | null, code: number, message: string): void {
    this.#sendRpc(state, { jsonrpc: "2.0", id, error: { code, message } });
  }

  #sendRpc(
    state: RequestState,
    value: unknown,
    status = 200,
    includeMcpSessionHeaders = false,
  ): boolean {
    if (state.responseSent || state.response.destroyed || state.response.writableEnded) return false;
    let body: string;
    let sentOriginal = true;
    try {
      body = JSON.stringify(value);
    } catch {
      body = "";
    }
    if (Buffer.byteLength(body, "utf8") > this.#limits.maxResponseBytes || body.length === 0) {
      sentOriginal = false;
      body = JSON.stringify({
        jsonrpc: "2.0",
        // Admitted IDs have a strict serialized-byte bound. Preserve one when
        // available for JSON-RPC correlation; malformed/unadmitted requests
        // still receive the required null ID.
        id: state.requestId ?? null,
        error: { code: -32603, message: "Response exceeded the configured bound." },
      });
      status = 200;
      if (Buffer.byteLength(body, "utf8") > this.#limits.maxResponseBytes) {
        this.#sendHttpError(state.response, 500, state);
        return false;
      }
    }
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    if (this.#initialized && this.#protocolVersion) headers["mcp-protocol-version"] = this.#protocolVersion;
    if (includeMcpSessionHeaders || (this.#initialized && state.request.method === "POST")) {
      headers["mcp-session-id"] = this.#mcpSessionId;
    }
    state.responseSent = true;
    state.response.writeHead(status, headers);
    state.response.end(body);
    return sentOriginal;
  }

  #sendAccepted(state: RequestState): void {
    if (state.responseSent || state.response.destroyed || state.response.writableEnded) return;
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    if (this.#initialized && this.#protocolVersion) headers["mcp-protocol-version"] = this.#protocolVersion;
    if (this.#initialized) headers["mcp-session-id"] = this.#mcpSessionId;
    state.responseSent = true;
    state.response.writeHead(202, headers);
    state.response.end();
  }

  #sendHttpError(response: ServerResponse, status: number, state?: RequestState): void {
    if (state?.responseSent || response.destroyed || response.writableEnded) return;
    const body = JSON.stringify({ error: "Request rejected." });
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      connection: "close",
    };
    if (this.#initialized && this.#protocolVersion) headers["mcp-protocol-version"] = this.#protocolVersion;
    if (this.#initialized) headers["mcp-session-id"] = this.#mcpSessionId;
    if (state) state.responseSent = true;
    response.writeHead(status, headers);
    response.end(body);
  }
}

interface ManagedSessionToolRegistry extends SessionToolRegistry {
  cancelToolCall(callId: string): void;
  close(): Promise<void>;
}

/** Internal session factory; no standalone unauthenticated listener is exported from the package root. */
export function createSessionToolRegistry(
  binding: SessionMcpBinding,
): ManagedSessionToolRegistry {
  let closed = false;
  let createPromise: Promise<SessionMcpServer> | undefined;
  let closePromise: Promise<void> | undefined;
  let created = false;
  const servers = new Set<McpToolServer>();

  const registry: ManagedSessionToolRegistry = {
    catalogId: binding.catalog.id,
    cancelToolCall(callId: string): void {
      for (const server of servers) server.cancelToolCall(callId);
    },
    async createMcpServer(options = {}): Promise<SessionMcpServer> {
      if (closed) throw new SessionNotFoundError("The session tool registry is closed.");
      if (binding.catalog.tools.length === 0) {
        throw new InvalidRequestError("This session has no caller tools to expose through MCP.");
      }
      if (created || createPromise) {
        throw new InvalidRequestError("A session may create only one MCP tool server.");
      }
      if (!isRecord(options) || (options.onToolCall !== undefined && typeof options.onToolCall !== "function")) {
        throw new InvalidRequestError("MCP tool-server options are invalid.");
      }
      const limits = validateLimits(options.limits);
      const server = new McpToolServer(binding, options.onToolCall ?? binding.defaultHandler, limits);
      servers.add(server);
      const creating = (async (): Promise<SessionMcpServer> => {
        try {
          await server.start();
          if (closed) {
            await server.close();
            throw new SessionNotFoundError("The session closed while its MCP tool server was starting.");
          }
          const endpoint = server.publicServer;
          if (!endpoint) throw new Error("mcp-server-start-failed");
          await binding.onServerCreated?.(endpoint);
          created = true;
          return endpoint;
        } catch (error) {
          await server.close();
          servers.delete(server);
          throw error;
        }
      })();
      createPromise = creating;
      try {
        return await creating;
      } finally {
        if (createPromise === creating) createPromise = undefined;
      }
    },
    async close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      const closing = (async () => {
        const currentCreation = createPromise;
        const currentServers = [...servers];
        await Promise.allSettled(currentServers.map((server) => server.close()));
        await currentCreation?.catch(() => undefined);
        await Promise.allSettled([...servers].map((server) => server.close()));
        servers.clear();
      })();
      closePromise = closing;
      return closing;
    },
  };
  return Object.freeze(registry);
}
