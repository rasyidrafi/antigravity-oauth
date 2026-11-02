import { isAbsolute } from "node:path";
import {
  createProfileAuth,
  createProfileRuntimeManager,
  getProfileAuthCleanupController,
  type AuthLoginOptions,
  type AuthLogoutOptions,
  type AuthStatus,
  type ProfileAuthCleanupController,
  type ProfileAuth,
  type ProfileRuntimeWorker,
  type ProfileRuntimeWorkerLease,
} from "./auth.js";
import type { ProcessFactory } from "./acp.js";
import { createAcpSessionDriverFactory } from "./acp-session-driver.js";
import { connectAcpModelDiscovery } from "./acp-models.js";
import { createAccountProviderData } from "./account-info.js";
import type {
  AcpPermissionPolicy,
  AcpPermissionsOptions,
  Account,
  AccountDataRequestOptions,
  AccountModel,
  AccountModelListOptions,
  AccountSessions,
  MaxTokensPolicy,
  Session,
  SessionCreateOptions,
  SessionDriverFactory,
} from "./contracts.js";
import {
  InternalError,
  InvalidRequestError,
  ProcessFailureError,
  SDKClosedError,
} from "./errors.js";
import {
  createProfileRegistry,
  type AccountProfile,
  type AccountProfileRegistry,
  type EnvironmentSource,
  type ProfileRegistry,
  type ProfileRegistryOptions,
} from "./profiles.js";
import { createProfileSessionEngine } from "./session.js";
import { normalizeAcpPermissionPolicy } from "./acp-permissions.js";

/** Injectable registry initialization seam, primarily useful for offline lifecycle tests. */
export type ProfileRegistryFactory = (
  options: ProfileRegistryOptions,
) => Promise<ProfileRegistry>;

export interface AntigravitySDKOptions {
  /** Absolute directory reserved for this SDK's local account profiles. */
  readonly storageDir: string;
  /** Explicit Antigravity ACP executable used for authentication and session startup. */
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /**
   * Optional explicitly supplied safe environment source. Only the profile
   * registry's fixed non-credential allowlist is copied; by default no ambient
   * process environment values are read or inherited.
   */
  readonly environment?: EnvironmentSource;
  /** Legacy output-token policy; retained for compatibility and does not block unbounded ACP inference. */
  readonly maxTokensPolicy?: MaxTokensPolicy;
  /**
   * Built-in ACP permission policy. Omission normalizes to `mode: "auto"`;
   * this selects the first offered `allow_once` and denies when unavailable.
   * It never selects `allow_always`. ACP origin is unverified, approvals may
   * authorize arbitrary agent-side effects.
   * The SDK cannot revoke a previously written approval or ACP-side persistent
   * grant; `{ mode: "deny" }` rejects subsequent requests only. Use it to opt
   * out. A custom driver owns its permission policy; explicitly combining it
   * with this option is rejected.
   */
  readonly permissions?: AcpPermissionsOptions;
  /** ACP process seam used only by explicit authentication; never used by the built-in session driver. */
  readonly processFactory?: ProcessFactory;
  /**
   * Explicit integration/test override. The built-in driver starts an
   * allowlisted ACP session and selects the pinned model. ACP does not enforce
   * the requested `max_tokens` bound; any supplied value is disclosed as
   * ignored, and an omitted value is disclosed as unbounded. Custom drivers own
   * their own permission behavior; omission of `permissions` does not impose
   * the built-in automatic policy on them.
   */
  readonly sessionDriverFactory?: SessionDriverFactory;
  /** Registry initialization seam; production defaults to createProfileRegistry. */
  readonly profileRegistryFactory?: ProfileRegistryFactory;
}

export interface SDKAccountCollection {
  /** Create and persist a new, independently authenticated account profile. */
  create(): Promise<Account>;
  /** Return a synchronous account handle; existence is checked by its operations. */
  get(accountId: string): Account;
  /** Load all persisted account handles. */
  list(): Promise<readonly Account[]>;
}

const SAFE_ENVIRONMENT_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

function invalidOptions(): InvalidRequestError {
  return new InvalidRequestError("The AntigravitySDK options are invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyDataProperties(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function validateModelListOptions(input: AccountModelListOptions): {
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
} {
  if (!isRecord(input) || !hasOnlyDataProperties(input, ["cwd", "signal"]) ||
      typeof input.cwd !== "string" || input.cwd.length === 0 || input.cwd.includes("\0") ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))) {
    throw new InvalidRequestError("ACP model discovery options are invalid.");
  }
  return { cwd: input.cwd, signal: input.signal };
}

function copyExplicitEnvironment(source: EnvironmentSource | undefined): EnvironmentSource {
  if (source === undefined) return Object.freeze({});
  if (!isRecord(source)) throw invalidOptions();
  const copy: Record<string, string | undefined> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && (typeof value !== "string" || value.includes("\0"))) {
      throw invalidOptions();
    }
    if (value !== undefined) copy[key] = value;
  }
  return Object.freeze(copy);
}

function validateOptions(options: AntigravitySDKOptions): {
  readonly storageDir: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly environment: EnvironmentSource;
  readonly processFactory: ProcessFactory | undefined;
  readonly maxTokensPolicy: MaxTokensPolicy;
  readonly sessionDriverFactory: SessionDriverFactory;
  readonly profileRegistryFactory: ProfileRegistryFactory;
} {
  if (!isRecord(options)) throw invalidOptions();
  const allowed = new Set([
    "storageDir",
    "executable",
    "args",
    "cwd",
    "environment",
    "maxTokensPolicy",
    "permissions",
    "processFactory",
    "sessionDriverFactory",
    "profileRegistryFactory",
  ]);
  if (!hasOnlyDataProperties(options, [...allowed])) throw invalidOptions();
  if (
    (options.maxTokensPolicy !== undefined && options.maxTokensPolicy !== "strict" &&
      options.maxTokensPolicy !== "allow-unenforced-max-tokens") ||
    typeof options.storageDir !== "string" ||
    !isAbsolute(options.storageDir) ||
    typeof options.executable !== "string" ||
    options.executable.length === 0 ||
    options.executable.includes("\0") ||
    (options.cwd !== undefined &&
      (typeof options.cwd !== "string" || options.cwd.includes("\0"))) ||
    (options.args !== undefined &&
      (!Array.isArray(options.args) ||
        options.args.some((argument) => typeof argument !== "string" || argument.includes("\0")))) ||
    (options.processFactory !== undefined && typeof options.processFactory !== "function") ||
    (options.sessionDriverFactory !== undefined && typeof options.sessionDriverFactory !== "function") ||
    (options.profileRegistryFactory !== undefined && typeof options.profileRegistryFactory !== "function")
  ) {
    throw invalidOptions();
  }

  const args = Object.freeze([...(options.args ?? [])]);
  const maxTokensPolicy = options.maxTokensPolicy ?? "strict";
  const permissions: AcpPermissionPolicy = normalizeAcpPermissionPolicy(options.permissions);
  if (options.permissions !== undefined && options.sessionDriverFactory !== undefined) throw invalidOptions();
  const defaultDriver = createAcpSessionDriverFactory({
    executable: options.executable,
    args,
    maxTokensPolicy,
    permissions,
  });
  return Object.freeze({
    storageDir: options.storageDir,
    executable: options.executable,
    args,
    cwd: options.cwd,
    environment: copyExplicitEnvironment(options.environment),
    processFactory: options.processFactory,
    maxTokensPolicy,
    sessionDriverFactory: options.sessionDriverFactory ?? defaultDriver,
    profileRegistryFactory: options.profileRegistryFactory ?? createProfileRegistry,
  });
}

function ensureProfileIdentity(profile: AccountProfile, expectedId?: string): void {
  if (
    !profile ||
    typeof profile.id !== "string" ||
    profile.id.length === 0 ||
    profile.context?.accountId !== profile.id ||
    (expectedId !== undefined && profile.id !== expectedId)
  ) {
    throw new InternalError("The account profile identity could not be validated.");
  }
}

/**
 * Public composition root. Construction is synchronous and performs no file,
 * process, browser, listener, or network work; registry initialization is lazy.
 */
export class AntigravitySDK {
  readonly accounts: SDKAccountCollection;

  private readonly options: ReturnType<typeof validateOptions>;
  private readonly runtimeManager = createProfileRuntimeManager();
  private readonly handles = new Map<string, Account>();
  private readonly engines = new Map<string, ReturnType<typeof createProfileSessionEngine>>();
  private readonly modelDiscoveryLeases = new Set<ProfileRuntimeWorkerLease<ProfileRuntimeWorker>>();
  private modelDiscoveryFactory: typeof connectAcpModelDiscovery = connectAcpModelDiscovery;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly loginControllers = new Set<AbortController>();
  private readonly authCleanupControllers = new Set<ProfileAuthCleanupController>();
  private readonly registryAccounts: AccountProfileRegistry;
  private registryPromise: Promise<ProfileRegistry> | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: AntigravitySDKOptions) {
    this.options = validateOptions(options);
    this.registryAccounts = Object.freeze({
      create: async () => (await this.getRegistry()).accounts.create(),
      get: async (id: string) => (await this.getRegistry()).accounts.get(id),
      list: async () => (await this.getRegistry()).accounts.list(),
    });
    this.accounts = Object.freeze({
      create: () => this.track(async () => {
        const registry = await this.getRegistry();
        this.ensureOpen();
        const profile = await registry.accounts.create();
        ensureProfileIdentity(profile);
        return this.accountFor(profile.id);
      }),
      get: (accountId: string) => {
        this.ensureOpen();
        if (typeof accountId !== "string" || accountId.length === 0 || accountId.includes("\0")) {
          throw new InvalidRequestError("The account ID must be a non-empty string.");
        }
        return this.accountFor(accountId);
      },
      list: () => this.track(async () => {
        const profiles = await this.getRegistry().then((registry) => registry.accounts.list());
        const accounts: Account[] = [];
        for (const profile of profiles) {
          ensureProfileIdentity(profile);
          accounts.push(this.accountFor(profile.id));
        }
        return Object.freeze(accounts);
      }),
    });
  }

  /** Close owned sessions and reject further account/SDK operations. Safe to retry after cleanup failure. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const cleanupGenerations = new Map(
      [...this.authCleanupControllers].map((controller) => [controller, controller.generation]),
    );
    this.closed = true;
    for (const controller of this.loginControllers) controller.abort();

    const engines = [...this.engines.values()];
    const operations = [...this.pending];
    const closing = (async () => {
      const engineClosures = Promise.allSettled(engines.map((engine) => engine.close()));
      const operationResults = await Promise.allSettled(operations);
      const engineResults = await engineClosures;
      const newAuthCleanupFailure = [...this.authCleanupControllers].some(
        (controller) => controller.pendingCount > 0 &&
          controller.generation > (cleanupGenerations.get(controller) ?? 0),
      );
      if (newAuthCleanupFailure) {
        // Do not retry a cleanup failure discovered during this close attempt:
        // surface it once, keep the obligation owned, and retry on close().
        const cause = operationResults.find((result) =>
          result.status === "rejected" && result.reason instanceof ProcessFailureError,
        );
        throw new ProcessFailureError(
          "Profile auth cleanup failed during SDK shutdown; call close() again to retry owned cleanup.",
          { cause: cause?.status === "rejected" ? cause.reason : undefined },
        );
      }

      const authCleanupResults = await Promise.allSettled(
        [...this.authCleanupControllers].map((controller) => controller.retryPending()),
      );
      const modelDiscoveryCleanupResults = await Promise.allSettled(
        [...this.modelDiscoveryLeases].map((lease) => this.closeModelDiscoveryLease(lease)),
      );
      const failure = engineResults.find((result) => result.status === "rejected") ??
        authCleanupResults.find((result) => result.status === "rejected") ??
        modelDiscoveryCleanupResults.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw new ProcessFailureError("The SDK could not complete owned cleanup safely.", {
          cause: failure.reason,
        });
      }
    })();
    this.closePromise = closing;
    void closing.catch(() => {
      if (this.closePromise === closing) this.closePromise = undefined;
    });
    return closing;
  }

  private ensureOpen(): void {
    if (this.closed) throw new SDKClosedError();
  }

  private async closeModelDiscoveryLease(
    lease: ProfileRuntimeWorkerLease<ProfileRuntimeWorker>,
  ): Promise<void> {
    await lease.close();
    this.modelDiscoveryLeases.delete(lease);
  }

  private track<T>(start: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new SDKClosedError());
    let started: Promise<T>;
    try {
      started = start();
    } catch (error) {
      started = Promise.reject(error);
    }
    const operation = Promise.resolve(started).then((value) => {
      this.ensureOpen();
      return value;
    });
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  private getRegistry(): Promise<ProfileRegistry> {
    if (this.registryPromise) return this.registryPromise;
    const options: ProfileRegistryOptions = {
      storageDir: this.options.storageDir,
      environment: this.options.environment,
    };
    let pending!: Promise<ProfileRegistry>;
    pending = Promise.resolve()
      .then(() => this.options.profileRegistryFactory(options))
      .then((registry) => {
        if (!registry || !registry.accounts ||
          typeof registry.accounts.create !== "function" ||
          typeof registry.accounts.get !== "function" ||
          typeof registry.accounts.list !== "function") {
          throw new InternalError("The profile registry factory returned an invalid registry.");
        }
        return registry;
      });
    this.registryPromise = pending;
    void pending.catch(() => {
      if (this.registryPromise === pending) this.registryPromise = undefined;
    });
    return pending;
  }

  private accountFor(accountId: string): Account {
    this.ensureOpen();
    const existing = this.handles.get(accountId);
    if (existing) return existing;

    const authCore = createProfileAuth(this.registryAccounts, accountId, {
      executable: this.options.executable,
      args: this.options.args,
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      ...(this.options.processFactory === undefined ? {} : { processFactory: this.options.processFactory }),
      workerManager: this.runtimeManager,
    });
    const auth = this.bindAuth(authCore);
    const cleanupController = getProfileAuthCleanupController(authCore);
    if (cleanupController) this.authCleanupControllers.add(cleanupController);
    const engine = createProfileSessionEngine(this.registryAccounts, accountId, {
      workerManager: this.runtimeManager,
      driverFactory: this.options.sessionDriverFactory,
      maxTokensPolicy: this.options.maxTokensPolicy,
    });
    const providerData = createAccountProviderData(this.registryAccounts, accountId);
    this.authCleanupControllers.add(providerData.cleanupController);
    const sessions: AccountSessions = Object.freeze({
      create: (sessionOptions: SessionCreateOptions) => this.track(async () => {
        const session = await engine.create(sessionOptions);
        if (session.accountId !== accountId) {
          await session.close().catch(() => undefined);
          throw new InternalError("The session engine returned a foreign account session.");
        }
        return session as Session;
      }),
    });
    const identity = Object.freeze({
      get: (options?: AccountDataRequestOptions) =>
        this.track(() => providerData.identity.get(options)),
    });
    const quota = Object.freeze({
      summary: (options?: AccountDataRequestOptions) =>
        this.track(() => providerData.quota.summary(options)),
    });
    const models = Object.freeze({
      list: (input: AccountModelListOptions): Promise<readonly AccountModel[]> => this.track(async () => {
        const options = validateModelListOptions(input);
        const profile = await this.registryAccounts.get(accountId);
        ensureProfileIdentity(profile, accountId);
        const lease = await this.runtimeManager.connect(profile.context, async () => {
          const discovery = await this.modelDiscoveryFactory({
            executable: this.options.executable,
            args: this.options.args,
            profile: profile.context,
            cwd: options.cwd,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          return discovery;
        });
        this.modelDiscoveryLeases.add(lease);
        try {
          return await lease.worker.list(options.cwd, options.signal);
        } finally {
          await this.closeModelDiscoveryLease(lease);
        }
      }),
    });
    const composedAccount: Account = Object.freeze({ id: accountId, auth, sessions, identity, quota, models });
    this.engines.set(accountId, engine);
    this.handles.set(accountId, composedAccount);
    return composedAccount;
  }

  private bindAuth(auth: ProfileAuth): ProfileAuth {
    const login = (options?: AuthLoginOptions): Promise<void> => this.track(() => {
      const controller = new AbortController();
      const externalSignal = options?.signal;
      const abortFromCaller = (): void => controller.abort();
      if (externalSignal?.aborted) controller.abort();
      else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
      this.loginControllers.add(controller);
      const loginOptions: AuthLoginOptions = {
        ...(options ?? {}),
        signal: controller.signal,
      };
      return auth.login(loginOptions).finally(() => {
        this.loginControllers.delete(controller);
        externalSignal?.removeEventListener("abort", abortFromCaller);
      });
    });
    const status = (): Promise<AuthStatus> => this.track(() => auth.status());
    const logout = (options?: AuthLogoutOptions): Promise<void> => this.track(() => auth.logout(options));
    return Object.freeze({ login, status, logout });
  }
}

/** Internal seam for lifecycle tests; intentionally not re-exported from the package root. */
export function createAntigravitySDKWithModelDiscoveryFactoryForTests(
  options: AntigravitySDKOptions,
  factory: typeof connectAcpModelDiscovery,
): AntigravitySDK {
  if (typeof factory !== "function") throw invalidOptions();
  const sdk = new AntigravitySDK(options);
  Object.defineProperty(sdk, "modelDiscoveryFactory", { value: factory, configurable: true, writable: true });
  return sdk;
}
