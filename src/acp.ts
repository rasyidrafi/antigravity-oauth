import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import {
  AuthenticationError,
  InvalidRequestError,
  ProcessFailureError,
  ProtocolFailureError,
  ProviderError,
  RequestAbortedError,
  RequestTimeoutError,
  SessionBusyError,
} from "./errors.js";
import { getGuardedPermissionResponse, permissionResponseAtWrite } from "./acp-permission-response.js";
import type { ProfileContext } from "./profiles.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_FRAME_BYTES = 1_048_576;
const DEFAULT_QUEUED_BYTES = 4_194_304;
const DEFAULT_PENDING_REQUESTS = 256;
const DEFAULT_INBOUND_MESSAGES = 256;
const DEFAULT_INBOUND_QUEUED_BYTES = 4_194_304;
const DEFAULT_STDERR_BYTES = 8_192;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 250;
const MAX_FRAME_BYTES = 16 * 1_048_576;
const MAX_QUEUED_BYTES = 64 * 1_048_576;
const MAX_PENDING_REQUESTS = 4_096;
const MAX_INBOUND_MESSAGES = 4_096;
const MAX_STDERR_BYTES = 1_048_576;
const MAX_SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const INTERACTIVE_LOGIN_BLOCK_MARKER = "AGY_INTERACTIVE_LOGIN_BLOCKED";

type JsonRpcId = string | number | null;
type JsonRecord = Record<string, unknown>;

export interface AcpSpawnOptions {
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdio: ["pipe", "pipe", "pipe"];
  readonly windowsHide: true;
}

export interface AcpReadableStream {
  on(event: "data" | "error", listener: (...args: any[]) => void): this;
  once(event: "end" | "close", listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  destroy(): unknown;
}

export interface AcpWritableStream {
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
  end(): unknown;
  on(event: "error", listener: (...args: any[]) => void): this;
  once(event: "drain", listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  destroy(): unknown;
}

/** Minimal child-process surface used by the transport and fake fixtures. */
export interface AcpChildProcess {
  readonly stdin: AcpWritableStream;
  readonly stdout: AcpReadableStream;
  readonly stderr: AcpReadableStream;
  on(event: "error", listener: (...args: any[]) => void): this;
  once(event: "error" | "exit" | "close", listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  kill(signal?: string): boolean;
}

/** Injectable seam around Node's child_process.spawn. */
export type ProcessFactory = (
  executable: string,
  args: readonly string[],
  options: AcpSpawnOptions,
) => AcpChildProcess;

export interface AcpServerRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

/** ACP notifications are kept generic so later slices can add typed methods. */
export interface AcpServerNotification {
  readonly method: string;
  readonly params?: unknown;
}

export type AcpServerRequestHandler = (
  request: AcpServerRequest,
) => unknown | Promise<unknown>;

/** Internal signal for an unhandled agent-to-client request method. */
export class AcpMethodNotFoundError extends Error {
  constructor() {
    super("ACP method not found.");
    this.name = "AcpMethodNotFoundError";
  }
}

export type AcpServerNotificationHandler = (
  notification: AcpServerNotification,
) => void | Promise<void>;

export interface AcpInitializeResponse extends Readonly<Record<string, unknown>> {
  readonly protocolVersion: 1;
}

export interface AcpOperationOptions {
  readonly signal?: AbortSignal;
  /** Per-operation timeout. Must be a positive integer number of milliseconds. */
  readonly timeoutMs?: number;
  /** Absolute Unix epoch deadline in milliseconds; the earlier limit wins. */
  readonly deadline?: number;
  /** @internal Synchronous response fence for request-scoped protocol pumps. */
  readonly onResponse?: () => void;
}

export interface AcpConnectionOptions {
  readonly executable: string;
  readonly profile: ProfileContext;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly processFactory?: ProcessFactory;
  /** Default deadline for requests and notifications. Defaults to 30 seconds. */
  readonly requestTimeoutMs?: number;
  /** Timeout used for the required initialize request. */
  readonly initializeTimeoutMs?: number;
  /** Grace period used at each shutdown stage. Defaults to 250ms. */
  readonly shutdownTimeoutMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxQueuedBytes?: number;
  readonly maxPendingRequests?: number;
  readonly maxInboundMessages?: number;
  readonly maxInboundQueuedBytes?: number;
  /** Maximum stderr byte count recorded for the redacted summary. */
  readonly maxStderrBytes?: number;
  /** Receives a content-free stderr summary when the process closes. */
  readonly onStderr?: (summary: string) => void;
  readonly onRequest?: AcpServerRequestHandler;
  readonly onNotification?: AcpServerNotificationHandler;
  /** Receives a safe SDK error when the transport fails; never receives child text. */
  readonly onFailure?: (error: Error) => void;
  /** Abort startup while the process is being initialized. */
  readonly signal?: AbortSignal;
}

/** Internal, narrowly-scoped environment bridge used only by explicit login. */
export interface AcpAuthBrowserCapture {
  readonly directory: string;
  readonly commandPath: string;
  readonly captureFile: string;
}

const connectWithAuthCapture: unique symbol = Symbol("connectWithAuthCapture");

interface TransportLimits {
  readonly requestTimeoutMs: number;
  readonly initializeTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly maxQueuedBytes: number;
  readonly maxPendingRequests: number;
  readonly maxInboundMessages: number;
  readonly maxInboundQueuedBytes: number;
  readonly maxStderrBytes: number;
}

interface WriteJob {
  readonly bytes: Buffer;
  readonly prepareAtWrite: (() => Buffer) | undefined;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly onStart: (() => void) | undefined;
  state: "queued" | "writing" | "done" | "rejected";
  settled: boolean;
  removeDrainListener: (() => void) | undefined;
}

interface PendingRequest {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onResponse: (() => void) | undefined;
  readonly expiresAt: number;
  abortListener: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  writeJob: WriteJob | undefined;
  writeStarted: boolean;
  settled: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeAuthenticationFailure(message: string, data: unknown): boolean {
  const candidates = [message];
  if (isRecord(data)) {
    for (const key of ["code", "type", "reason", "message"]) {
      const value = data[key];
      if (typeof value === "string") candidates.push(value);
    }
  }
  return candidates.some((value) => {
    const normalized = value.replace(/[_-]+/gu, " ");
    return /\b(?:auth(?:entication)?|authenticate|login|credentials?|unauthenticated|unauthori[sz]ed)\b/iu.test(normalized) ||
      /\b(?:invalid grant|token expired|token invalid|refresh token)\b/iu.test(normalized);
  });
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function idKey(id: JsonRpcId): string {
  if (id === null) return "null:";
  return typeof id === "string" ? `string:${id}` : `number:${id}`;
}

function validText(value: string): boolean {
  return !value.includes("\0");
}

function validatePositiveInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new InvalidRequestError(`${name} must be a positive integer within its supported bound.`);
  }
  return resolved;
}

function validateLimits(options: AcpConnectionOptions): TransportLimits {
  const requestTimeoutMs = validatePositiveInteger(
    "requestTimeoutMs",
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_TIMER_DELAY_MS,
  );
  return {
    requestTimeoutMs,
    initializeTimeoutMs: validatePositiveInteger(
      "initializeTimeoutMs",
      options.initializeTimeoutMs,
      requestTimeoutMs,
      MAX_TIMER_DELAY_MS,
    ),
    shutdownTimeoutMs: validatePositiveInteger(
      "shutdownTimeoutMs",
      options.shutdownTimeoutMs,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
      MAX_SHUTDOWN_TIMEOUT_MS,
    ),
    maxFrameBytes: validatePositiveInteger(
      "maxFrameBytes",
      options.maxFrameBytes,
      DEFAULT_FRAME_BYTES,
      MAX_FRAME_BYTES,
    ),
    maxQueuedBytes: validatePositiveInteger(
      "maxQueuedBytes",
      options.maxQueuedBytes,
      DEFAULT_QUEUED_BYTES,
      MAX_QUEUED_BYTES,
    ),
    maxPendingRequests: validatePositiveInteger(
      "maxPendingRequests",
      options.maxPendingRequests,
      DEFAULT_PENDING_REQUESTS,
      MAX_PENDING_REQUESTS,
    ),
    maxInboundMessages: validatePositiveInteger(
      "maxInboundMessages",
      options.maxInboundMessages,
      DEFAULT_INBOUND_MESSAGES,
      MAX_INBOUND_MESSAGES,
    ),
    maxInboundQueuedBytes: validatePositiveInteger(
      "maxInboundQueuedBytes",
      options.maxInboundQueuedBytes,
      DEFAULT_INBOUND_QUEUED_BYTES,
      MAX_QUEUED_BYTES,
    ),
    maxStderrBytes: validatePositiveInteger(
      "maxStderrBytes",
      options.maxStderrBytes,
      DEFAULT_STDERR_BYTES,
      MAX_STDERR_BYTES,
    ),
  };
}

function childEnvironment(
  profile: ProfileContext,
  authBrowserCapture?: AcpAuthBrowserCapture,
): Record<string, string> {
  if (!profile || typeof profile !== "object" || !isRecord(profile.childEnvironment)) {
    throw new InvalidRequestError("A profile context with an isolated child environment is required.");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.childEnvironment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || !validText(value)) {
      throw new InvalidRequestError("The profile child environment contains an invalid entry.");
    }
    result[key] = value;
  }
  if (authBrowserCapture) {
    const directory = resolve(authBrowserCapture.directory);
    const commandPath = resolve(authBrowserCapture.commandPath);
    const captureFile = resolve(authBrowserCapture.captureFile);
    if (
      !isAbsolute(authBrowserCapture.directory) ||
      !isAbsolute(authBrowserCapture.commandPath) ||
      !isAbsolute(authBrowserCapture.captureFile) ||
      dirname(commandPath) !== directory ||
      dirname(captureFile) !== directory
    ) {
      throw new InvalidRequestError("The internal auth browser capture paths are invalid.");
    }
    result.BROWSER = commandPath;
    result.PATH = [directory, result.PATH].filter(Boolean).join(delimiter);
    result.ANTIGRAVITY_SDK_OAUTH_CAPTURE_FILE = captureFile;
  }
  return result;
}

function validateConnectionOptions(options: AcpConnectionOptions): TransportLimits {
  if (
    !options ||
    typeof options.executable !== "string" ||
    options.executable.length === 0 ||
    !validText(options.executable)
  ) {
    throw new InvalidRequestError("executable must be a non-empty command without NUL bytes.");
  }
  if (options.cwd !== undefined && (typeof options.cwd !== "string" || !validText(options.cwd))) {
    throw new InvalidRequestError("cwd must be a string without NUL bytes.");
  }
  if (
    options.args !== undefined &&
    (!Array.isArray(options.args) || options.args.some((argument) => typeof argument !== "string" || !validText(argument)))
  ) {
    throw new InvalidRequestError("args must contain only strings without NUL bytes.");
  }
  childEnvironment(options.profile);
  return validateLimits(options);
}

function assertJsonValue(value: unknown, visited: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") throw new Error("not-json");
  if (visited.has(value)) throw new Error("cyclic-json");
  visited.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error("sparse-json-array");
      assertJsonValue(value[index], visited);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("non-record-json");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("symbol-json-key");
    for (const key of Object.keys(value)) assertJsonValue((value as JsonRecord)[key], visited);
  }
  visited.delete(value);
}

function encodeJsonFrame(value: unknown, maxFrameBytes: number): Buffer {
  try {
    assertJsonValue(value, new Set());
    const json = JSON.stringify(value);
    if (typeof json !== "string") throw new Error("empty-json");
    const frame = Buffer.from(`${json}\n`, "utf8");
    if (frame.byteLength - 1 > maxFrameBytes) {
      throw new InvalidRequestError("ACP JSON-RPC frame exceeds the configured frame limit.");
    }
    return frame;
  } catch (error) {
    if (error instanceof InvalidRequestError) throw error;
    throw new InvalidRequestError("ACP JSON-RPC payload must be finite, acyclic JSON data.");
  }
}

function calculateExpiry(options: AcpOperationOptions, defaultTimeoutMs: number): number {
  const timeoutMs = validatePositiveInteger(
    "timeoutMs",
    options.timeoutMs,
    defaultTimeoutMs,
    MAX_TIMER_DELAY_MS,
  );
  const wallClockNow = Date.now();
  const monotonicNow = performance.now();
  let expiresAt = monotonicNow + timeoutMs;
  if (options.deadline !== undefined) {
    if (!Number.isSafeInteger(options.deadline) || options.deadline < 1) {
      throw new InvalidRequestError("deadline must be a positive Unix epoch timestamp in milliseconds.");
    }
    expiresAt = Math.min(expiresAt, monotonicNow + (options.deadline - wallClockNow));
  }
  return expiresAt;
}

function operationTimeoutError(): RequestTimeoutError {
  return new RequestTimeoutError("ACP operation exceeded its deadline.");
}

function abortedError(): RequestAbortedError {
  return new RequestAbortedError("ACP operation was aborted.");
}

/**
 * Standalone ACP v1 stdio transport. It owns only the explicitly spawned child
 * and does not perform authentication, session creation, or prompting.
 */
export class AcpConnection {
  private readonly process: AcpChildProcess;
  private readonly limits: TransportLimits;
  private readonly onStderr: AcpConnectionOptions["onStderr"];
  private readonly processExitPromise: Promise<void>;
  private readonly processClosePromise: Promise<void>;
  private resolveProcessExit!: () => void;
  private resolveProcessClose!: () => void;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly abandonedRequestIds = new Set<number>();
  private readonly incomingRequestIds = new Set<string>();
  private readonly writeQueue: WriteJob[] = [];
  private queuedBytes = 0;
  private stderrBytes = 0;
  private stderrTruncated = false;
  private stderrMarkerTail = "";
  private inboundHandlers = 0;
  private inboundQueuedBytes = 0;
  private nextRequestId = 0;
  private pendingFrame = Buffer.alloc(0);
  private failure: Error | undefined;
  private stateValue: "open" | "closing" | "closed" | "failed" = "open";
  private processEnded = false;
  private processClosed = false;
  private stderrFlushed = false;
  private closePromise: Promise<void> | undefined;
  private failureKillTimer: ReturnType<typeof setTimeout> | undefined;
  private activeWrite: WriteJob | undefined;
  private requestHandler: AcpServerRequestHandler | undefined;
  private notificationHandler: AcpServerNotificationHandler | undefined;
  private readonly onFailure: AcpConnectionOptions["onFailure"];
  private initializeValue: AcpInitializeResponse | undefined;

  private readonly onStdoutData = (chunk: unknown): void => this.consumeStdout(chunk);
  private readonly onStdoutEnd = (): void => this.handleStdoutEnd();
  private readonly onStdoutError = (): void => this.fail(new ProcessFailureError("ACP stdout failed."));
  private readonly onStderrData = (chunk: unknown): void => this.captureStderr(chunk);
  private readonly onStderrError = (): void => this.fail(new ProcessFailureError("ACP stderr failed."));
  private readonly onStdinError = (): void => this.fail(new ProcessFailureError("ACP stdin failed."));
  private readonly onChildError = (): void => {
    this.fail(new ProcessFailureError("ACP process could not be started or failed."));
  };
  private readonly onChildExit = (): void => this.handleProcessExit();
  private readonly onChildClose = (): void => this.handleProcessClose();

  private constructor(
    options: AcpConnectionOptions,
    limits: TransportLimits,
    child: AcpChildProcess,
  ) {
    this.process = child;
    this.limits = limits;
    this.onStderr = options.onStderr;
    this.requestHandler = options.onRequest;
    this.notificationHandler = options.onNotification;
    this.onFailure = options.onFailure;
    this.processExitPromise = new Promise((resolve) => {
      this.resolveProcessExit = resolve;
    });
    this.processClosePromise = new Promise((resolve) => {
      this.resolveProcessClose = resolve;
    });

    child.stdout.on("data", this.onStdoutData);
    child.stdout.once("end", this.onStdoutEnd);
    child.stdout.once("close", this.onStdoutEnd);
    child.stdout.on("error", this.onStdoutError);
    child.stderr.on("data", this.onStderrData);
    child.stderr.on("error", this.onStderrError);
    child.stdin.on("error", this.onStdinError);
    child.once("error", this.onChildError);
    child.once("exit", this.onChildExit);
    child.once("close", this.onChildClose);
  }

  /** The negotiated ACP v1 response, available after connectAcp resolves. */
  get initializeResult(): AcpInitializeResponse {
    if (!this.initializeValue) throw new ProcessFailureError("ACP initialization has not completed.");
    return this.initializeValue;
  }

  /** Start the executable and complete ACP initialize before returning. */
  static async connect(options: AcpConnectionOptions): Promise<AcpConnection> {
    return AcpConnection[connectWithAuthCapture](options);
  }

  static async [connectWithAuthCapture](
    options: AcpConnectionOptions,
    authBrowserCapture?: AcpAuthBrowserCapture,
  ): Promise<AcpConnection> {
    const limits = validateConnectionOptions(options);
    if (options.signal?.aborted) throw abortedError();

    const environment = childEnvironment(options.profile, authBrowserCapture);
    const factory = options.processFactory ?? defaultProcessFactory;
    let child: AcpChildProcess;
    try {
      const spawnOptions: AcpSpawnOptions = {
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      };
      child = factory(options.executable, [...(options.args ?? [])], spawnOptions);
    } catch {
      throw new ProcessFailureError("ACP process could not be started.");
    }

    const connection = new AcpConnection(options, limits, child);
    try {
      const response = await connection.request(
        "initialize",
        { protocolVersion: 1, clientCapabilities: {} },
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs: limits.initializeTimeoutMs,
        },
      );
      connection.assertHealthyAfterInitialize();
      if (!isRecord(response) || response.protocolVersion !== 1) {
        throw new ProtocolFailureError("ACP agent did not negotiate protocol version 1.");
      }
      connection.initializeValue = Object.freeze({ ...response, protocolVersion: 1 });
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  /** Send a correlated JSON-RPC request. Late replies to aborted calls are tracked. */
  request(method: string, params?: unknown, options: AcpOperationOptions = {}): Promise<unknown> {
    try {
      this.assertWritable();
      this.validateMethodAndParams(method, params);
      if (options.signal?.aborted) return Promise.reject(abortedError());
      const expiresAt = calculateExpiry(options, this.limits.requestTimeoutMs);
      if (expiresAt <= performance.now()) return Promise.reject(operationTimeoutError());
      if (this.pending.size + this.abandonedRequestIds.size >= this.limits.maxPendingRequests) {
        return Promise.reject(new SessionBusyError("ACP outstanding-request limit has been reached."));
      }
      if (this.nextRequestId >= Number.MAX_SAFE_INTEGER) {
        return Promise.reject(new ProcessFailureError("ACP request identifier space is exhausted."));
      }

      const id = ++this.nextRequestId;
      const frame = encodeJsonFrame(
        { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) },
        this.limits.maxFrameBytes,
      );
      let resolveResult!: (value: unknown) => void;
      let rejectResult!: (error: unknown) => void;
      const result = new Promise<unknown>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const entry: PendingRequest = {
        id,
        resolve: resolveResult,
        reject: rejectResult,
        signal: options.signal,
        onResponse: options.onResponse,
        expiresAt,
        abortListener: undefined,
        timer: undefined,
        writeJob: undefined,
        writeStarted: false,
        settled: false,
      };
      this.pending.set(id, entry);
      this.scheduleRequestDeadline(entry);
      if (entry.settled) return result;
      if (options.signal) {
        entry.abortListener = () => this.abortPendingRequest(entry);
        options.signal.addEventListener("abort", entry.abortListener, { once: true });
        if (options.signal.aborted) this.abortPendingRequest(entry);
      }
      if (entry.settled) return result;

      const writePromise = this.enqueueWrite(frame, () => {
        entry.writeStarted = true;
      }, (job) => {
        entry.writeJob = job;
      });
      void writePromise.catch((error: unknown) => {
        if (this.pending.get(id) !== entry) return;
        if (error instanceof SessionBusyError || error instanceof InvalidRequestError) {
          this.settlePendingRequest(entry, error, false);
        } else {
          this.fail(error instanceof Error ? error : new ProcessFailureError("ACP write failed."));
        }
      });
      return result;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Send a JSON-RPC notification; it has no response ID by definition. */
  async notify(
    method: string,
    params?: unknown,
    options: AcpOperationOptions = {},
  ): Promise<void> {
    this.assertWritable();
    this.validateMethodAndParams(method, params);
    if (options.signal?.aborted) throw abortedError();
    const expiresAt = calculateExpiry(options, this.limits.requestTimeoutMs);
    if (expiresAt <= performance.now()) throw operationTimeoutError();
    const frame = encodeJsonFrame(
      { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) },
      this.limits.maxFrameBytes,
    );

    let job: WriteJob | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let settled = false;
    let resolveOperation!: () => void;
    let rejectOperation!: (error: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (options.signal && abortListener) options.signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    };
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolveOperation();
      else rejectOperation(error);
    };
    const cancel = (error: Error): void => {
      if (job?.state === "queued") this.cancelQueuedWrite(job, error);
      finish(error);
    };

    const writePromise = this.enqueueWrite(frame, undefined, (createdJob) => {
      job = createdJob;
    });
    void writePromise.then(
      () => finish(),
      (error: unknown) => finish(error),
    );
    const scheduleTimeout = (): void => {
      const remaining = expiresAt - performance.now();
      if (remaining <= 0) {
        cancel(operationTimeoutError());
        return;
      }
      timer = setTimeout(scheduleTimeout, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    scheduleTimeout();
    if (options.signal) {
      abortListener = () => cancel(abortedError());
      options.signal.addEventListener("abort", abortListener, { once: true });
      if (options.signal.aborted) cancel(abortedError());
    }
    return operation;
  }

  /** Replace the handler used for agent-to-client JSON-RPC requests. */
  setRequestHandler(handler: AcpServerRequestHandler | undefined): void {
    this.assertWritable();
    this.requestHandler = handler;
  }

  /** Replace the handler used for agent-to-client JSON-RPC notifications. */
  setNotificationHandler(handler: AcpServerNotificationHandler | undefined): void {
    this.assertWritable();
    this.notificationHandler = handler;
  }

  /** Close the child transport. Repeated calls share the same completion. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    const wasFailed = this.failure !== undefined;
    this.stateValue = "closing";
    const closedError = new ProcessFailureError("ACP connection is closed.");
    this.rejectAllPending(closedError);
    this.rejectAllWrites(closedError);

    if (!this.processClosed) {
      try {
        this.process.stdin.end();
      } catch {
        // The process may already have closed its input pipe.
      }
      await this.waitForProcessClose(this.limits.shutdownTimeoutMs);
      if (!this.processClosed && !this.processEnded) {
        try {
          this.process.kill("SIGTERM");
        } catch {
          // Continue to the forced cleanup path.
        }
        await this.waitForProcessClose(this.limits.shutdownTimeoutMs);
      }
      if (!this.processClosed) {
        if (!this.processEnded) {
          try {
            this.process.kill("SIGKILL");
          } catch {
            // The child may have exited between the check and kill.
          }
        }
        await this.waitForProcessClose(this.limits.shutdownTimeoutMs);
      }
    }

    if (!this.processClosed) {
      this.destroyPipes();
      this.markProcessClosed();
    }
    this.flushStderr();
    this.cleanupListeners();
    this.stateValue = wasFailed ? "failed" : "closed";
  }

  private waitForProcessClose(timeoutMs: number): Promise<void> {
    if (this.processClosed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      void this.processClosePromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private assertWritable(): void {
    if (this.failure) throw this.failure;
    if (this.stateValue !== "open") throw new ProcessFailureError("ACP connection is not open.");
  }

  private assertHealthyAfterInitialize(): void {
    if (this.failure) throw this.failure;
    if (this.stateValue !== "open" || this.processEnded || this.processClosed) {
      throw new ProcessFailureError("ACP process closed during initialization.");
    }
  }

  private validateMethodAndParams(method: string, params: unknown): void {
    if (typeof method !== "string" || method.length === 0 || !validText(method)) {
      throw new InvalidRequestError("ACP method must be a non-empty string without NUL bytes.");
    }
    if (params !== undefined) {
      if (params === null || typeof params !== "object") {
        throw new InvalidRequestError("ACP params must be a JSON object or array.");
      }
      try {
        assertJsonValue(params, new Set());
      } catch {
        throw new InvalidRequestError("ACP params must be finite, acyclic JSON data.");
      }
    }
  }

  private scheduleRequestDeadline(entry: PendingRequest): void {
    const checkDeadline = (): void => {
      if (entry.settled) return;
      const remaining = entry.expiresAt - performance.now();
      if (remaining <= 0) {
        this.settlePendingRequest(entry, operationTimeoutError(), entry.writeStarted);
        return;
      }
      entry.timer = setTimeout(checkDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
    };
    checkDeadline();
  }

  private abortPendingRequest(entry: PendingRequest): void {
    this.settlePendingRequest(entry, abortedError(), entry.writeStarted);
  }

  private settlePendingRequest(entry: PendingRequest, error: unknown, keepAbandonedId: boolean): void {
    if (entry.settled || this.pending.get(entry.id) !== entry) return;
    entry.settled = true;
    this.pending.delete(entry.id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.signal && entry.abortListener) entry.signal.removeEventListener("abort", entry.abortListener);
    entry.abortListener = undefined;

    const job = entry.writeJob;
    if (job?.state === "queued") {
      this.cancelQueuedWrite(
        job,
        error instanceof Error ? error : new ProcessFailureError("ACP request was cancelled."),
      );
      keepAbandonedId = false;
    }
    if (keepAbandonedId && !this.failure && !this.processEnded) this.abandonedRequestIds.add(entry.id);
    entry.reject(error);
  }

  private resolvePendingRequest(entry: PendingRequest, value: unknown, error?: Error): void {
    if (entry.settled || this.pending.get(entry.id) !== entry) return;
    try {
      entry.onResponse?.();
    } catch {
      this.fail(new ProtocolFailureError("ACP response observer failed."));
      return;
    }
    entry.settled = true;
    this.pending.delete(entry.id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.signal && entry.abortListener) entry.signal.removeEventListener("abort", entry.abortListener);
    entry.abortListener = undefined;
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  private rejectAllPending(error: Error): void {
    for (const entry of [...this.pending.values()]) this.settlePendingRequest(entry, error, false);
    this.pending.clear();
    this.abandonedRequestIds.clear();
  }

  private enqueueWrite(
    bytes: Buffer,
    onStart: (() => void) | undefined,
    onCreated: (job: WriteJob) => void,
    prepareAtWrite?: () => Buffer,
  ): Promise<void> {
    try {
      this.assertWritable();
    } catch (error) {
      return Promise.reject(error);
    }
    if (bytes.byteLength > this.limits.maxQueuedBytes) {
      return Promise.reject(new SessionBusyError("ACP outbound write exceeds the configured queue limit."));
    }
    if (this.queuedBytes + bytes.byteLength > this.limits.maxQueuedBytes) {
      return Promise.reject(new SessionBusyError("ACP outbound write queue is full."));
    }
    let resolveJob!: () => void;
    let rejectJob!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job: WriteJob = {
      bytes,
      prepareAtWrite,
      resolve: resolveJob,
      reject: rejectJob,
      onStart,
      state: "queued",
      settled: false,
      removeDrainListener: undefined,
    };
    onCreated(job);
    this.writeQueue.push(job);
    this.queuedBytes += bytes.byteLength;
    this.pumpWriteQueue();
    return promise;
  }

  private pumpWriteQueue(): void {
    if (this.activeWrite || this.failure || this.stateValue !== "open") return;
    const job = this.writeQueue.shift();
    if (!job) return;
    job.state = "writing";
    this.activeWrite = job;
    try {
      job.onStart?.();
    } catch {
      this.fail(new ProcessFailureError("ACP outbound write could not be started."));
      return;
    }

    let bytes = job.bytes;
    let callbackDone = false;
    let drainNeeded: boolean | undefined;
    let drainSeen = false;
    const onDrain = (): void => {
      drainSeen = true;
      finishIfWritten();
    };
    const finishIfWritten = (): void => {
      if (job.settled || !callbackDone || drainNeeded === undefined) return;
      if (drainNeeded && !drainSeen) return;
      job.removeDrainListener?.();
      job.removeDrainListener = undefined;
      this.activeWrite = undefined;
      this.queuedBytes = Math.max(0, this.queuedBytes - job.bytes.byteLength);
      job.state = "done";
      job.settled = true;
      job.resolve();
      this.pumpWriteQueue();
    };
    this.process.stdin.once("drain", onDrain);
    job.removeDrainListener = () => this.process.stdin.removeListener("drain", onDrain);
    try {
      if (job.prepareAtWrite) {
        // A guarded permission frame is selected and serialized only when it
        // reaches the head of the FIFO, directly before stdin.write(). The
        // preparation rechecks monotonic expiry after serialization as well.
        bytes = job.prepareAtWrite();
        if (bytes.byteLength > job.bytes.byteLength) {
          throw new Error("prepared frame exceeds its reserved queue bytes");
        }
      }
      // Guard evaluation may synchronously abort its callback signal; user
      // abort listeners can close this connection reentrantly. Do not continue
      // into write() after that shutdown. Calling write is the byte-commit
      // boundary: accepted bytes already buffered by Node cannot be retracted.
      if (job.settled || this.activeWrite !== job || this.failure || this.stateValue !== "open") return;
      const accepted = this.process.stdin.write(bytes, (error?: Error | null) => {
        if (error) {
          this.fail(new ProcessFailureError("ACP stdin write failed."));
          return;
        }
        callbackDone = true;
        finishIfWritten();
      });
      drainNeeded = !accepted;
      if (!drainNeeded) {
        drainSeen = true;
        job.removeDrainListener();
        job.removeDrainListener = undefined;
      }
      finishIfWritten();
    } catch {
      this.fail(new ProcessFailureError("ACP stdin write failed."));
    }
  }

  private cancelQueuedWrite(job: WriteJob, error: Error): void {
    if (job.state !== "queued" || job.settled) return;
    const index = this.writeQueue.indexOf(job);
    if (index < 0) return;
    this.writeQueue.splice(index, 1);
    this.queuedBytes = Math.max(0, this.queuedBytes - job.bytes.byteLength);
    job.state = "rejected";
    job.settled = true;
    job.reject(error);
  }

  private rejectAllWrites(error: Error): void {
    const jobs = [...this.writeQueue];
    this.writeQueue.length = 0;
    if (this.activeWrite) jobs.unshift(this.activeWrite);
    this.activeWrite = undefined;
    this.queuedBytes = 0;
    for (const job of jobs) {
      if (job.settled) continue;
      job.removeDrainListener?.();
      job.removeDrainListener = undefined;
      job.state = "rejected";
      job.settled = true;
      job.reject(error);
    }
  }

  private consumeStdout(chunk: unknown): void {
    if (this.failure || this.stateValue === "closing" || this.stateValue === "closed") return;
    let bytes: Buffer;
    if (Buffer.isBuffer(chunk)) bytes = chunk;
    else if (typeof chunk === "string") bytes = Buffer.from(chunk, "utf8");
    else if (chunk instanceof Uint8Array) {
      bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else {
      this.fail(new ProtocolFailureError("ACP stdout emitted a non-byte protocol frame."));
      return;
    }

    let offset = 0;
    while (offset < bytes.byteLength && !this.failure) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) {
        const tail = bytes.subarray(offset);
        if (this.pendingFrame.byteLength + tail.byteLength > this.limits.maxFrameBytes) {
          this.fail(new ProtocolFailureError("ACP frame exceeds the configured frame limit."));
          return;
        }
        this.pendingFrame = this.pendingFrame.byteLength === 0
          ? Buffer.from(tail)
          : Buffer.concat([this.pendingFrame, tail]);
        return;
      }

      const segment = bytes.subarray(offset, newline);
      if (this.pendingFrame.byteLength + segment.byteLength > this.limits.maxFrameBytes) {
        this.fail(new ProtocolFailureError("ACP frame exceeds the configured frame limit."));
        return;
      }
      let frame = this.pendingFrame.byteLength === 0
        ? segment
        : Buffer.concat([this.pendingFrame, segment]);
      this.pendingFrame = Buffer.alloc(0);
      if (frame.byteLength > 0 && frame[frame.byteLength - 1] === 0x0d) {
        frame = frame.subarray(0, -1);
      }
      this.handleFrame(frame);
      offset = newline + 1;
    }
  }

  private handleFrame(frame: Buffer): void {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch {
      this.fail(new ProtocolFailureError("ACP stdout contained malformed UTF-8."));
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(decoded) as unknown;
    } catch {
      this.fail(new ProtocolFailureError("ACP stdout contained malformed JSON."));
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      this.fail(new ProtocolFailureError("ACP stdout contained an invalid JSON-RPC message."));
      return;
    }

    if (Object.hasOwn(message, "method")) {
      if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
        this.fail(new ProtocolFailureError("ACP server call contains response fields."));
        return;
      }
      this.handleInboundCall(message, frame.byteLength);
    } else {
      this.handleResponse(message);
    }
  }

  private handleInboundCall(message: JsonRecord, frameBytes: number): void {
    if (typeof message.method !== "string" || message.method.length === 0) {
      this.fail(new ProtocolFailureError("ACP server call has an invalid method."));
      return;
    }
    if (
      Object.hasOwn(message, "params") &&
      (message.params === null || typeof message.params !== "object")
    ) {
      this.fail(new ProtocolFailureError("ACP server call has invalid params."));
      return;
    }
    const hasId = Object.hasOwn(message, "id");
    if (!hasId) {
      this.dispatchNotification(
        {
          method: message.method,
          ...(Object.hasOwn(message, "params") ? { params: message.params } : {}),
        },
        frameBytes,
      );
      return;
    }
    if (!isJsonRpcId(message.id)) {
      this.fail(new ProtocolFailureError("ACP server request has an invalid identifier."));
      return;
    }
    this.dispatchRequest(
      {
        id: message.id,
        method: message.method,
        ...(Object.hasOwn(message, "params") ? { params: message.params } : {}),
      },
      frameBytes,
    );
  }

  private dispatchRequest(request: AcpServerRequest, frameBytes: number): void {
    const key = idKey(request.id);
    if (this.incomingRequestIds.has(key)) {
      this.fail(new ProtocolFailureError("ACP server reused an in-flight request identifier."));
      return;
    }
    this.incomingRequestIds.add(key);
    if (
      this.inboundHandlers >= this.limits.maxInboundMessages ||
      this.inboundQueuedBytes + frameBytes > this.limits.maxInboundQueuedBytes
    ) {
      void this.sendServerResponse(request.id, undefined, {
        code: -32000,
        message: "Client request queue is full.",
      }).finally(() => this.incomingRequestIds.delete(key));
      return;
    }

    this.inboundHandlers += 1;
    this.inboundQueuedBytes += frameBytes;
    void this.runServerRequest(request).finally(() => {
      this.inboundHandlers = Math.max(0, this.inboundHandlers - 1);
      this.inboundQueuedBytes = Math.max(0, this.inboundQueuedBytes - frameBytes);
      this.incomingRequestIds.delete(key);
    });
  }

  private async runServerRequest(request: AcpServerRequest): Promise<void> {
    let result: unknown;
    let rpcError: { readonly code: number; readonly message: string } | undefined;
    const handler = this.requestHandler;
    if (!handler) {
      rpcError = { code: -32601, message: "Method not found" };
    } else {
      try {
        result = await handler(request);
        if (result === undefined) rpcError = { code: -32601, message: "Method not found" };
      } catch (error) {
        rpcError = error instanceof AcpMethodNotFoundError
          ? { code: -32601, message: "Method not found" }
          : { code: -32603, message: "Internal error" };
      }
    }
    await this.sendServerResponse(request.id, result, rpcError);
  }

  private async sendServerResponse(
    id: JsonRpcId,
    result: unknown,
    rpcError: { readonly code: number; readonly message: string } | undefined,
  ): Promise<void> {
    let bytes: Buffer;
    let prepareAtWrite: (() => Buffer) | undefined;
    const guardedResponse = rpcError === undefined ? getGuardedPermissionResponse(result) : undefined;
    try {
      if (guardedResponse) {
        // Reserve the largest (selected) frame for the existing bounded FIFO,
        // but do not retain it as the actual write payload. The guard is
        // re-evaluated and the chosen permission response serialized again at
        // the head of the queue, directly before stdin.write(). A stale
        // authorization is replaced by the correlated cancellation result.
        bytes = encodeJsonFrame({ jsonrpc: "2.0", id, result: guardedResponse.result }, this.limits.maxFrameBytes);
        const reservedByteLength = bytes.byteLength;
        prepareAtWrite = () => {
          const selected = permissionResponseAtWrite(guardedResponse);
          const finalBytes = encodeJsonFrame({
            jsonrpc: "2.0",
            id,
            result: selected,
          }, this.limits.maxFrameBytes);
          // JSON serialization is synchronous but can still consume enough
          // time to cross the deadline. Recheck after serializing and replace
          // a now-stale selection before the immediately following write().
          const finalResult = permissionResponseAtWrite(guardedResponse);
          const committedBytes = finalResult === selected
            ? finalBytes
            : encodeJsonFrame({ jsonrpc: "2.0", id, result: finalResult }, this.limits.maxFrameBytes);
          if (committedBytes.byteLength > reservedByteLength) {
            throw new Error("permission fallback exceeded its reserved frame size");
          }
          return committedBytes;
        };
      } else {
        bytes = encodeJsonFrame(
          rpcError
            ? { jsonrpc: "2.0", id, error: rpcError }
            : { jsonrpc: "2.0", id, result },
          this.limits.maxFrameBytes,
        );
      }
    } catch {
      try {
        if (guardedResponse) {
          // If the selected option itself cannot fit the configured frame,
          // send only the smaller fail-closed cancellation response.
          bytes = encodeJsonFrame({
            jsonrpc: "2.0",
            id,
            result: guardedResponse.fallback,
          }, this.limits.maxFrameBytes);
          prepareAtWrite = () => bytes;
        } else {
          bytes = encodeJsonFrame(
            { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } },
            this.limits.maxFrameBytes,
          );
        }
      } catch {
        this.fail(new ProtocolFailureError("ACP server request response exceeds the configured frame limit."));
        return;
      }
    }
    try {
      await this.enqueueWrite(bytes, undefined, () => undefined, prepareAtWrite);
    } catch {
      if (!this.failure && this.stateValue === "open") {
        this.fail(new ProtocolFailureError("ACP server request could not be answered."));
      }
    }
  }

  private dispatchNotification(notification: AcpServerNotification, frameBytes: number): void {
    const handler = this.notificationHandler;
    if (!handler) return;
    if (
      this.inboundHandlers >= this.limits.maxInboundMessages ||
      this.inboundQueuedBytes + frameBytes > this.limits.maxInboundQueuedBytes
    ) {
      this.fail(new ProtocolFailureError("ACP inbound message queue is full."));
      return;
    }
    this.inboundHandlers += 1;
    this.inboundQueuedBytes += frameBytes;
    const complete = (): void => {
        this.inboundHandlers = Math.max(0, this.inboundHandlers - 1);
        this.inboundQueuedBytes = Math.max(0, this.inboundQueuedBytes - frameBytes);
    };
    let result: void | Promise<void>;
    try {
      // Invoke synchronously in wire order. Session-bound drivers use this to
      // distinguish notifications received before a correlated request from
      // updates that can confirm that request.
      result = handler(notification);
    } catch {
      this.fail(new ProtocolFailureError("ACP notification handler failed."));
      complete();
      return;
    }
    void Promise.resolve(result)
      .catch(() => {
        this.fail(new ProtocolFailureError("ACP notification handler failed."));
      })
      .finally(complete);
  }

  private handleResponse(message: JsonRecord): void {
    if (!Object.hasOwn(message, "id") || !isJsonRpcId(message.id)) {
      this.fail(new ProtocolFailureError("ACP response has an invalid identifier."));
      return;
    }
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) {
      this.fail(new ProtocolFailureError("ACP response must contain exactly one result or error."));
      return;
    }
    if (
      hasError &&
      (!isRecord(message.error) ||
        typeof message.error.code !== "number" ||
        !Number.isSafeInteger(message.error.code) ||
        typeof message.error.message !== "string")
    ) {
      this.fail(new ProtocolFailureError("ACP response contains an invalid JSON-RPC error."));
      return;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id) || message.id < 1) {
      this.fail(new ProtocolFailureError("ACP response identifier does not match a client request."));
      return;
    }

    const entry = this.pending.get(message.id);
    if (entry) {
      if (!entry.writeStarted) {
        this.fail(new ProtocolFailureError("ACP agent responded to an unsent request."));
        return;
      }
      if (hasError) {
        const rpcCode = (message.error as JsonRecord).code as number;
        const rpcMessage = (message.error as JsonRecord).message as string;
        this.resolvePendingRequest(
          entry,
          undefined,
          looksLikeAuthenticationFailure(rpcMessage, (message.error as JsonRecord).data)
            ? new AuthenticationError(
              "The ACP session requires authentication. Call account.auth.login() explicitly, then retry.",
            )
            : new ProviderError(`ACP agent rejected the request (JSON-RPC code ${rpcCode}).`),
        );
      } else {
        this.resolvePendingRequest(entry, message.result);
      }
      return;
    }
    if (this.abandonedRequestIds.delete(message.id)) return;
    this.fail(new ProtocolFailureError("ACP agent returned an unknown response identifier."));
  }

  private captureStderr(chunk: unknown): void {
    let bytes: Buffer;
    if (Buffer.isBuffer(chunk)) bytes = chunk;
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    else if (typeof chunk === "string") bytes = Buffer.from(chunk, "utf8");
    else return;

    // The reviewed Antigravity process uses the profile's BROWSER blocker.
    // Detect its content-free marker across chunk boundaries, without ever
    // retaining or forwarding child-controlled stderr text.
    const observed = this.stderrMarkerTail + bytes.toString("latin1");
    if (observed.includes(INTERACTIVE_LOGIN_BLOCK_MARKER)) {
      this.stderrMarkerTail = "";
      this.fail(new AuthenticationError(
        "ACP attempted interactive authentication. Call account.auth.login() explicitly, then retry.",
      ));
    } else {
      this.stderrMarkerTail = observed.slice(-(INTERACTIVE_LOGIN_BLOCK_MARKER.length - 1));
    }

    if (!this.onStderr) return;
    const byteLength = bytes.byteLength;

    const remaining = this.limits.maxStderrBytes - this.stderrBytes;
    this.stderrBytes += Math.min(byteLength, remaining);
    if (byteLength > remaining) this.stderrTruncated = true;
  }

  private flushStderr(): void {
    if (this.stderrFlushed) return;
    this.stderrFlushed = true;
    if (!this.onStderr) return;
    const amount = this.stderrTruncated ? `at least ${this.stderrBytes}` : `${this.stderrBytes}`;
    try {
      // Never emit child-controlled stderr bytes. Pattern redaction cannot
      // safely handle arbitrary secrets, chunk boundaries, or capped input.
      this.onStderr(`ACP stderr content withheld (${amount} bytes observed).`);
    } catch {
      // Diagnostics callbacks must not affect transport cleanup.
    }
  }

  private handleStdoutEnd(): void {
    if (this.failure || this.stateValue === "closing" || this.stateValue === "closed") return;
    if (this.pendingFrame.byteLength > 0) {
      this.fail(new ProtocolFailureError("ACP stdout ended with an incomplete JSON-RPC frame."));
    } else {
      this.fail(new ProcessFailureError("ACP stdout closed unexpectedly."));
    }
  }

  private handleProcessExit(): void {
    if (this.processEnded) return;
    this.processEnded = true;
    if (this.failureKillTimer) clearTimeout(this.failureKillTimer);
    this.failureKillTimer = undefined;
    this.resolveProcessExit();
    if (!this.failure && this.stateValue !== "closing" && this.stateValue !== "closed") {
      this.fail(new ProcessFailureError("ACP process exited unexpectedly."));
    }
  }

  private handleProcessClose(): void {
    if (!this.processEnded) {
      this.processEnded = true;
      if (this.failureKillTimer) clearTimeout(this.failureKillTimer);
      this.failureKillTimer = undefined;
      this.resolveProcessExit();
    }
    if (this.processClosed) return;
    this.processClosed = true;
    this.flushStderr();
    this.resolveProcessClose();
    if (!this.failure && this.stateValue !== "closing" && this.stateValue !== "closed") {
      this.fail(new ProcessFailureError("ACP process closed unexpectedly."));
    }
    this.cleanupListeners();
  }

  private markProcessClosed(): void {
    if (this.processClosed) return;
    this.processEnded = true;
    this.processClosed = true;
    if (this.failureKillTimer) clearTimeout(this.failureKillTimer);
    this.failureKillTimer = undefined;
    this.flushStderr();
    this.resolveProcessExit();
    this.resolveProcessClose();
  }

  private fail(error: Error): void {
    if (this.failure || this.stateValue === "closed" || this.stateValue === "closing") return;
    this.failure = error;
    this.stateValue = "failed";
    try {
      this.onFailure?.(error);
    } catch {
      // Failure observers cannot affect transport teardown.
    }
    this.rejectAllPending(error);
    this.rejectAllWrites(error);
    if (!this.processEnded) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // Retry with SIGKILL after the bounded grace period.
      }
      this.failureKillTimer = setTimeout(() => {
        this.failureKillTimer = undefined;
        if (this.processEnded) return;
        try {
          this.process.kill("SIGKILL");
        } catch {
          // The child may have exited already.
        }
      }, this.limits.shutdownTimeoutMs);
      this.failureKillTimer.unref?.();
    }
  }

  private destroyPipes(): void {
    for (const stream of [this.process.stdin, this.process.stdout, this.process.stderr]) {
      try {
        stream.destroy();
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  private cleanupListeners(): void {
    this.process.stdout.removeListener("data", this.onStdoutData);
    this.process.stdout.removeListener("end", this.onStdoutEnd);
    this.process.stdout.removeListener("close", this.onStdoutEnd);
    this.process.stdout.removeListener("error", this.onStdoutError);
    this.process.stderr.removeListener("data", this.onStderrData);
    this.process.stderr.removeListener("error", this.onStderrError);
    this.process.stdin.removeListener("error", this.onStdinError);
    this.process.removeListener("error", this.onChildError);
    this.process.removeListener("exit", this.onChildExit);
    this.process.removeListener("close", this.onChildClose);
  }
}

const defaultProcessFactory: ProcessFactory = (executable, args, options) =>
  spawn(executable, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...options.env },
    stdio: options.stdio,
    windowsHide: options.windowsHide,
  }) as unknown as AcpChildProcess;

/** Spawn and initialize an ACP v1 child using only the profile's child env. */
export async function connectAcp(options: AcpConnectionOptions): Promise<AcpConnection> {
  return AcpConnection.connect(options);
}

/** Internal to the package: explicit login's optional manual-browser bridge. */
export async function connectAcpForAuthentication(
  options: AcpConnectionOptions,
  authBrowserCapture: AcpAuthBrowserCapture,
): Promise<AcpConnection> {
  return AcpConnection[connectWithAuthCapture](options, authBrowserCapture);
}
