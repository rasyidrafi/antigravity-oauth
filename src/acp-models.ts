import {
  InvalidRequestError,
  ProcessFailureError,
  ProtocolFailureError,
  RequestAbortedError,
  UnsupportedFeatureError,
} from "./errors.js";
import { connectAcp, type AcpConnection } from "./acp.js";
import { assertReviewedAcpPair } from "./acp-compatibility.js";
import { createNoninteractiveAuthGuard, type NoninteractiveAuthGuard } from "./noninteractive-auth.js";
import type { AccountModel } from "./contracts.js";
import type { ProfileContext } from "./profiles.js";

const DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_CONFIG_OPTIONS = 256;
const MAX_MODELS = 2_048;
const MAX_NESTING = 8;
const MAX_MODEL_ID_BYTES = 1_024;
const MAX_MODEL_LABEL_BYTES = 512;

type JsonRecord = Record<string, unknown>;

export interface AcpModelDiscoveryWorker {
  list(cwd: string, signal?: AbortSignal): Promise<readonly AccountModel[]>;
  close(): Promise<void>;
}

interface ConnectAcpModelDiscoveryOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly profile: ProfileContext;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validLabel(value: unknown, maximum: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ProtocolFailureError("ACP returned an unsupported model configuration label.");
  }
  return value;
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 512;
}

/** Project only exact model selector values and their bounded display labels. */
export function extractAcpAdvertisedModels(configOptions: unknown): readonly AccountModel[] {
  if (!Array.isArray(configOptions) || configOptions.length > MAX_CONFIG_OPTIONS) {
    throw new UnsupportedFeatureError("ACP did not advertise a supported model selector for this session.");
  }
  const candidates = configOptions.filter((option) => isRecord(option) &&
    (option.category === "model" || option.id === "model"));
  if (candidates.length !== 1 || !isRecord(candidates[0]) ||
      typeof candidates[0].id !== "string" || candidates[0].id.length === 0 ||
      candidates[0].id.length > 256 || !Array.isArray(candidates[0].options)) {
    throw new UnsupportedFeatureError("ACP did not advertise an unambiguous model selector for this session.");
  }

  const models: AccountModel[] = [];
  const ids = new Set<string>();
  let visited = 0;
  const visit = (items: readonly unknown[], inheritedGroup: string | undefined, depth: number): void => {
    if (depth > MAX_NESTING) throw new ProtocolFailureError("ACP returned nested model options that are too deep.");
    for (const option of items) {
      visited += 1;
      if (visited > MAX_MODELS || !isRecord(option)) {
        throw new ProtocolFailureError("ACP returned unsupported model configuration options.");
      }
      if (Object.hasOwn(option, "options")) {
        if (!Array.isArray(option.options) || Object.hasOwn(option, "value")) {
          throw new ProtocolFailureError("ACP returned malformed grouped model options.");
        }
        const group = validLabel(option.name, MAX_MODEL_LABEL_BYTES, false) ?? inheritedGroup;
        visit(option.options, group, depth + 1);
        continue;
      }
      const id = validLabel(option.value, MAX_MODEL_ID_BYTES, true)!;
      if (ids.has(id)) throw new ProtocolFailureError("ACP advertised a duplicate model selector value.");
      ids.add(id);
      const name = validLabel(option.name, MAX_MODEL_LABEL_BYTES, false);
      models.push(Object.freeze({
        id,
        ...(name === undefined ? {} : { name }),
        ...(inheritedGroup === undefined ? {} : { group: inheritedGroup }),
      }));
    }
  };
  visit(candidates[0].options, undefined, 0);
  if (models.length === 0) throw new UnsupportedFeatureError("ACP advertised no selectable models for this session.");
  return Object.freeze(models);
}

/** Testable protocol projection; production calls this only on an ACP session/new response. */
export function createAcpModelDiscoveryWorker(connection: Pick<AcpConnection, "request" | "close">): AcpModelDiscoveryWorker {
  if (!connection || typeof connection.request !== "function" || typeof connection.close !== "function") {
    throw new InvalidRequestError("The ACP model discovery connection is invalid.");
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    async list(cwd: string, signal?: AbortSignal): Promise<readonly AccountModel[]> {
      if (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0")) {
        throw new InvalidRequestError("A valid working directory is required for ACP model discovery.");
      }
      if (signal?.aborted) throw new RequestAbortedError("ACP model discovery was aborted.");
      const created = await connection.request("session/new", {
        cwd,
        mcpServers: [],
        _meta: { agy: { enabledTools: [] } },
      }, { ...(signal === undefined ? {} : { signal }), timeoutMs: DISCOVERY_TIMEOUT_MS });
      if (!isRecord(created) || !validSessionId(created.sessionId)) {
        throw new ProtocolFailureError("ACP returned an invalid model discovery session.");
      }
      return extractAcpAdvertisedModels(created.configOptions);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = Promise.resolve().then(() => connection.close());
      void closePromise.catch(() => {
        closePromise = undefined;
      });
      return closePromise;
    },
  });
}

/** Start the reviewed, noninteractive ACP binary for model-only discovery. */
export async function connectAcpModelDiscovery(
  options: ConnectAcpModelDiscoveryOptions,
): Promise<AcpModelDiscoveryWorker> {
  if (!options || typeof options.executable !== "string" || options.executable.length === 0 ||
      !Array.isArray(options.args) || options.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      !options.profile || options.profile.accountId.length === 0 ||
      (options.cwd !== undefined && (typeof options.cwd !== "string" || options.cwd.includes("\0")))) {
    throw new InvalidRequestError("The ACP model discovery configuration is invalid.");
  }
  if (options.signal?.aborted) throw new RequestAbortedError("ACP model discovery was aborted.");
  const executable = await assertReviewedAcpPair(options.executable, options.cwd, options.profile.childEnvironment);
  let guard: NoninteractiveAuthGuard | undefined;
  let connection: AcpConnection | undefined;
  try {
    guard = await createNoninteractiveAuthGuard(options.profile);
    connection = await connectAcp({
      executable,
      profile: guard.profile,
      args: options.args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      requestTimeoutMs: DISCOVERY_TIMEOUT_MS,
      initializeTimeoutMs: DISCOVERY_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const ownedConnection = connection;
    const ownedGuard = guard;
    const worker = createAcpModelDiscoveryWorker(ownedConnection);
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      list: worker.list,
      close: () => {
        if (closePromise) return closePromise;
        const closing = (async () => {
          let connectionError: unknown;
          let guardError: unknown;
          let connectionClosed = false;
          try {
            await worker.close();
            connectionClosed = true;
          } catch (error) {
            connectionError = error;
          }
          if (connectionClosed) {
            try {
              await ownedGuard.dispose();
            } catch (error) {
              guardError = error;
            }
          }
          if (connectionError !== undefined || guardError !== undefined) {
            throw new ProcessFailureError("ACP model discovery cleanup could not complete safely.", {
              cause: connectionError ?? guardError,
            });
          }
        })();
        closePromise = closing;
        void closing.catch(() => {
          closePromise = undefined;
        });
        return closing;
      },
    });
  } catch (error) {
    let connectionError: unknown;
    let guardError: unknown;
    let connectionClosed = connection === undefined;
    try {
      if (connection) await connection.close();
      connectionClosed = true;
    } catch (closeError) {
      connectionError = closeError;
    }
    if (connectionClosed) {
      try {
        await guard?.dispose();
      } catch (disposeError) {
        guardError = disposeError;
      }
    }
    if (connectionError !== undefined || guardError !== undefined) {
      throw new ProcessFailureError("ACP model discovery failed and cleanup could not complete safely.", { cause: error });
    }
    throw error;
  }
}
