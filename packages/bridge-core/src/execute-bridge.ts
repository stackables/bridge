import type { ToolTrace, TraceLevel } from "./tracing.ts";
import type { Logger } from "./tree-types.ts";
import type { SourceLocation } from "@stackables/bridge-types";
import type {
  Bridge,
  BridgeDocument,
  ConstDef,
  DefineDef,
  Expression,
  ForceStatement,
  HandleBinding,
  NodeRef,
  ScopeStatement,
  SourceChain,
  SpreadStatement,
  Statement,
  ToolDef,
  ToolMap,
  WireAliasStatement,
  WireCatch,
  WireSourceEntry,
  WireStatement,
} from "./types.ts";
import { SELF_MODULE } from "./types.ts";
import {
  TraceCollector,
  resolveToolMeta,
  logToolSuccess,
  logToolError,
  type EffectiveToolLog,
} from "./tracing.ts";
import {
  BridgeAbortError,
  BridgePanicError,
  isFatalError,
  isPromise,
  applyControlFlow,
  isLoopControlSignal,
  decrementLoopControl,
  wrapBridgeRuntimeError,
  BREAK_SYM,
  CONTINUE_SYM,
  MAX_EXECUTION_DEPTH,
} from "./tree-types.ts";
import type { LoopControlSignal } from "./tree-types.ts";
import { UNSAFE_KEYS } from "./tree-utils.ts";
import { raceTimeout } from "./utils.ts";
import { attachBridgeErrorDocumentContext } from "./formatBridgeError.ts";
import {
  std as bundledStd,
  STD_VERSION as BUNDLED_STD_VERSION,
} from "@stackables/bridge-stdlib";
import { resolveStd } from "./version-check.ts";
import { buildBodyTraversalMaps } from "./enumerate-traversals.ts";
import type { TraceWireBits } from "./enumerate-traversals.ts";

export type ExecuteBridgeOptions = {
  /** Parsed bridge document (from `parseBridge` or `parseBridgeDiagnostics`). */
  document: BridgeDocument;
  /**
   * Which bridge to execute, as `"Type.field"`.
   * Mirrors the `bridge Type.field { ... }` declaration.
   * Example: `"Query.searchTrains"` or `"Mutation.sendEmail"`.
   */
  operation: string;
  /** Input arguments — equivalent to GraphQL field arguments. */
  input?: Record<string, unknown>;
  /**
   * Tool functions available to the engine.
   *
   * Supports namespaced nesting: `{ myNamespace: { myTool } }`.
   * The built-in `std` namespace is always included; user tools are
   * merged on top (shallow).
   *
   * To provide a specific version of std (e.g. when the bridge file
   * targets an older major), use a versioned namespace key:
   * ```ts
   * tools: { "std@1.5": oldStdNamespace }
   * ```
   */
  tools?: ToolMap;
  /** Context available via `with context as ctx` inside the bridge. */
  context?: Record<string, unknown>;
  /**
   * Enable tool-call tracing.
   * - `"off"` (default) — no collection, zero overhead
   * - `"basic"` — tool, fn, timing, errors; no input/output
   * - `"full"` — everything including input and output
   */
  trace?: TraceLevel;
  /** Structured logger for engine events. */
  logger?: Logger;
  /** External abort signal — cancels execution when triggered. */
  signal?: AbortSignal;
  /**
   * Hard timeout for tool calls in milliseconds.
   * Tools that exceed this duration throw a `BridgeTimeoutError`.
   * Default: 15_000 (15 seconds). Set to `0` to disable.
   */
  toolTimeoutMs?: number;
  /**
   * Maximum shadow-tree nesting depth.
   * Default: 30. Increase for deeply nested array mappings.
   */
  maxDepth?: number;
  /**
   * Sparse fieldset filter.
   *
   * When provided, only the listed output fields (and their transitive
   * dependencies) are resolved.  Tools that feed exclusively into
   * unrequested fields are never called.
   *
   * Supports dot-separated paths and a trailing wildcard:
   *   `["id", "price", "legs.*"]`
   *
   * Omit or pass an empty array to resolve all fields (the default).
   */
  requestedFields?: string[];
  /**
   * Enable partial success (Error Sentinels).
   *
   * When `true`, non-fatal errors on individual output fields are planted as
   * `Error` sentinels in the output tree rather than thrown.  A GraphQL
   * resolver higher in the stack can intercept them to deliver per-field
   * errors while sibling fields still resolve successfully.
   *
   * When `false` (default), the first non-fatal error is re-thrown and
   * surfaces as a single top-level field error.
   */
  partialSuccess?: boolean;
};

export type ExecuteBridgeResult<T = unknown> = {
  data: T;
  traces: ToolTrace[];
  /** Compact bitmask encoding which traversal paths were taken during execution. */
  executionTraceId: bigint;
};

// ── Scope-based pull engine (v3) ────────────────────────────────────────────

/** Shared empty pull path — avoids allocating a new Set on every entry point. */
const EMPTY_PULL_PATH: ReadonlySet<string> = new Set<string>();

/** Unique key for a tool instance trunk. */
function toolKey(module: string, field: string, instance?: number): string {
  return instance
    ? `${module}:Tools:${field}:${instance}`
    : `${module}:Tools:${field}`;
}

/** Ownership key for a tool (module:field, no instance). */
function toolOwnerKey(module: string, field: string): string {
  return module === SELF_MODULE ? field : `${module}:${field}`;
}

/**
 * Derive ownership key from a `with` binding name.
 * "std.httpCall" → "std:httpCall"
 */
function bindingOwnerKey(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1
    ? name
    : `${name.substring(0, dot)}:${name.substring(dot + 1)}`;
}

/**
 * Read a nested property from an object following a path array.
 * Returns undefined if any segment is missing.
 *
 * When `rootSafe` or `pathSafe` flags are provided, null/undefined at
 * safe-flagged segments returns undefined instead of propagating.
 */
function getPath(
  obj: unknown,
  path: string[],
  rootSafe?: boolean,
  pathSafe?: boolean[],
): unknown {
  let current: unknown = obj;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i]!;
    if (UNSAFE_KEYS.has(segment))
      throw new Error(`Unsafe property traversal: ${segment}`);
    if (current == null) {
      const safe = pathSafe?.[i] ?? (i === 0 ? (rootSafe ?? false) : false);
      if (safe) {
        current = undefined;
        continue;
      }
      // Throws TypeError: Cannot read properties of null/undefined
      return (current as unknown as Record<string, unknown>)[segment];
    }
    const isPrimitive =
      typeof current !== "object" && typeof current !== "function";
    const next = (current as Record<string, unknown>)[segment];
    if (isPrimitive && next === undefined) {
      const safe = pathSafe?.[i] ?? (i === 0 ? (rootSafe ?? false) : false);
      if (safe) {
        current = undefined;
        continue;
      }
      throw new TypeError(
        `Cannot read properties of ${String(current)} (reading '${segment}')`,
      );
    }
    current = next;
  }
  return current;
}

/**
 * Set a nested property on an object following a path array,
 * creating intermediate objects as needed.
 *
 * Empty path with a plain object merges into root. Empty path with
 * any other value (array, primitive) stores under `__rootValue__`
 * for the caller to extract.
 */
function setPath(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  // Empty path — merge value into root object or store raw value
  if (path.length === 0) {
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(obj, value as Record<string, unknown>);
    } else {
      obj.__rootValue__ = value;
    }
    return;
  }
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    if (UNSAFE_KEYS.has(segment))
      throw new Error(`Unsafe assignment key: ${segment}`);
    if (
      current[segment] == null ||
      typeof current[segment] !== "object" ||
      Array.isArray(current[segment])
    ) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = path[path.length - 1];
  if (leaf !== undefined) {
    if (UNSAFE_KEYS.has(leaf))
      throw new Error(`Unsafe assignment key: ${leaf}`);
    current[leaf] = value;
  }
}

/**
 * Look up a tool function by dotted name in the tools map.
 * Supports namespace traversal (e.g. "std.httpCall" → tools.std.httpCall).
 */
function lookupToolFn(
  tools: ToolMap,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  // Flat key first
  const flat = (tools as Record<string, unknown>)[name];
  if (typeof flat === "function")
    return flat as (...args: unknown[]) => unknown;

  // Namespace traversal
  if (name.includes(".")) {
    const parts = name.split(".");
    let current: unknown = tools;
    for (const part of parts) {
      if (UNSAFE_KEYS.has(part)) return undefined;
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    if (typeof current === "function")
      return current as (...args: unknown[]) => unknown;
  }

  return undefined;
}

/**
 * Execution scope — the core of the v3 pull-based engine.
 *
 * Each scope holds:
 *  - A parent pointer for lexical scope chain traversal
 *  - Owned tool bindings (declared via `with` in this scope)
 *  - Indexed tool input wires (evaluated lazily on first tool read)
 *  - Memoized tool call results
 *  - Element data stack for array iteration
 *  - Output object reference
 */
class ExecutionScope {
  readonly parent: ExecutionScope | null;
  readonly output: Record<string, unknown>;
  readonly selfInput: Record<string, unknown>;
  readonly engine: EngineContext;

  /** Tools declared via `with` at this scope level — keyed by "module:field". */
  private readonly ownedTools = new Set<string>();

  /** Tool input wires indexed by full tool key — evaluated lazily on demand. */
  private readonly toolInputWires = new Map<string, WireStatement[]>();

  /** Memoized tool call results — cached Promise per tool key. */
  private readonly toolResults = new Map<string, Promise<unknown>>();

  /** Element data stack for array iteration nesting. */
  private readonly elementData: unknown[] = [];

  /** Output wires (self-module and element) indexed by dot-joined target path.
   *  Multiple wires to the same path are stored as an array for overdefinition. */
  private readonly outputWires = new Map<string, WireStatement[]>();

  /** Spread statements collected during indexing, with optional path prefix for scope blocks. */
  private readonly spreadStatements: {
    stmt: SpreadStatement;
    pathPrefix: string[];
  }[] = [];

  /** Alias statements indexed by name — evaluated lazily on first read. */
  private readonly aliases = new Map<string, WireAliasStatement>();

  /** Cached alias evaluation results. */
  private readonly aliasResults = new Map<string, Promise<unknown>>();

  /** Handle bindings — maps handle alias to binding info. */
  private readonly handleBindings = new Map<string, HandleBinding>();

  /** Owned define modules — keyed by __define_<handle> prefix. */
  private readonly ownedDefines = new Set<string>();

  /** Force statements collected during indexing. */
  readonly forceStatements: ForceStatement[] = [];

  /** Define input wires indexed by "module:field" key. */
  private readonly defineInputWires = new Map<string, WireStatement[]>();

  /**
   * Lazy-input factories for define scopes: keyed by dot-joined selfInput path.
   * When a selfInput reference is read, the factory is called once and the
   * result promise is cached, enabling lazy input wire evaluation so only
   * the wires needed for requested output fields are actually executed.
   */
  private lazyInputFactories?: Map<string, () => Promise<unknown>>;
  private lazyInputCache?: Map<string, Promise<unknown>>;

  /** When true, this scope acts as a root for output writes (define scopes). */
  private isRootScope = false;

  /** Depth counter for array nesting — used for infinite loop protection. */
  private readonly depth: number;

  /** Set of tool owner keys that have memoize enabled. */
  private readonly memoizedToolKeys = new Set<string>();

  constructor(
    parent: ExecutionScope | null,
    selfInput: Record<string, unknown>,
    output: Record<string, unknown>,
    engine: EngineContext,
    depth = 0,
  ) {
    this.parent = parent;
    this.selfInput = selfInput;
    this.output = output;
    this.engine = engine;
    this.depth = depth;
  }

  /** Register that this scope owns a tool declared via `with`. */
  declareToolBinding(name: string, memoize?: true): void {
    this.ownedTools.add(bindingOwnerKey(name));
    if (memoize) {
      this.memoizedToolKeys.add(bindingOwnerKey(name));
    }
  }

  /** Register that this scope owns a define block declared via `with`. */
  declareDefineBinding(handle: string): void {
    this.ownedDefines.add(`__define_${handle}`);
  }

  /** Index a define input wire (wire targeting a __define_* module). */
  addDefineInputWire(wire: WireStatement): void {
    const key = `${wire.target.module}:${wire.target.field}`;
    let wires = this.defineInputWires.get(key);
    if (!wires) {
      wires = [];
      this.defineInputWires.set(key, wires);
    }
    wires.push(wire);
  }

  /** Register a handle binding for later lookup (pipe expressions, etc.). */
  registerHandle(binding: HandleBinding): void {
    this.handleBindings.set(binding.handle, binding);
  }

  /** Look up a handle binding by alias, walking the scope chain. */
  getHandleBinding(handle: string): HandleBinding | undefined {
    const local = this.handleBindings.get(handle);
    if (local) return local;
    return this.parent?.getHandleBinding(handle);
  }

  /**
   * Collect all tool input wires matching a tool name (any instance).
   * Used by pipe expressions to merge bridge wires into the pipe call.
   */
  collectToolInputWiresFor(toolName: string): WireStatement[] {
    const dot = toolName.lastIndexOf(".");
    const module = dot === -1 ? SELF_MODULE : toolName.substring(0, dot);
    const field = dot === -1 ? toolName : toolName.substring(dot + 1);
    const prefix = `${module}:Tools:${field}`;
    const result: WireStatement[] = [];
    for (const [key, wires] of this.toolInputWires) {
      if (key === prefix || key.startsWith(prefix + ":")) {
        result.push(...wires);
      }
    }
    return result;
  }

  /** Index a tool input wire for lazy evaluation during tool call. */
  addToolInputWire(wire: WireStatement): void {
    const key = toolKey(
      wire.target.module,
      wire.target.field,
      wire.target.instance,
    );
    let wires = this.toolInputWires.get(key);
    if (!wires) {
      wires = [];
      this.toolInputWires.set(key, wires);
    }
    wires.push(wire);
  }

  /** Index an output wire (self-module or element) by its target path.
   *  Multiple wires to the same path are collected for overdefinition. */
  addOutputWire(wire: WireStatement): void {
    const key = wire.target.path.join(".");
    let wires = this.outputWires.get(key);
    if (!wires) {
      wires = [];
      this.outputWires.set(key, wires);
    }
    wires.push(wire);
  }

  /** Add a spread statement with an optional path prefix for scope blocks. */
  addSpread(stmt: SpreadStatement, pathPrefix: string[] = []): void {
    this.spreadStatements.push({ stmt, pathPrefix });
  }

  /** Get all spread statements with their path prefixes. */
  getSpreads(): { stmt: SpreadStatement; pathPrefix: string[] }[] {
    return this.spreadStatements;
  }

  /** Get output wires by field path key. Returns array (may have multiple for overdefinition). */
  getOutputWires(field: string): WireStatement[] | undefined {
    return this.outputWires.get(field);
  }

  /** Get all indexed output field names. */
  allOutputFields(): string[] {
    return Array.from(this.outputWires.keys());
  }

  /**
   * Collect all output wire groups matching the requested fields via prefix matching.
   * Returns arrays of wires (one array per matched path, for overdefinition).
   */
  collectMatchingOutputWireGroups(
    requestedFields: string[],
  ): WireStatement[][] {
    // Bare "*" means all fields — skip filtering
    if (requestedFields.includes("*")) {
      return this.allOutputFields().map((f) => this.getOutputWires(f)!);
    }

    const matched = new Set<string>();
    const result: WireStatement[][] = [];

    for (const field of requestedFields) {
      for (const [key, wires] of this.outputWires) {
        if (matched.has(key)) continue;

        // Root key "" always matches — it IS the entire output
        if (key === "") {
          matched.add(key);
          result.push(wires);
          continue;
        }

        // Trailing wildcard: "legs.*" matches "legs.duration", "legs.distance"
        if (field.endsWith(".*")) {
          const prefix = field.slice(0, -2);
          if (key === prefix || key.startsWith(prefix + ".")) {
            matched.add(key);
            result.push(wires);
            continue;
          }
        }

        if (
          key === field ||
          key.startsWith(field + ".") ||
          field.startsWith(key + ".")
        ) {
          matched.add(key);
          result.push(wires);
        }
      }
    }

    return result;
  }

  /** Index an alias statement for lazy evaluation. */
  addAlias(stmt: WireAliasStatement): void {
    this.aliases.set(stmt.name, stmt);
  }

  /**
   * Resolve an alias by name — walks the scope chain.
   * Evaluates lazily and caches the result.
   */
  resolveAlias(
    name: string,
    evaluator: (
      chain: SourceChain,
      scope: ExecutionScope,
      requestedFields: undefined,
      pullPath: ReadonlySet<string>,
    ) => Promise<unknown>,
    pullPath: ReadonlySet<string> = EMPTY_PULL_PATH,
  ): Promise<unknown> {
    const aliasKey = `alias:${name}`;

    // 1. Cycle check first
    if (pullPath.has(aliasKey)) {
      throw new BridgePanicError(
        `Circular dependency detected in alias "${name}"`,
      );
    }

    // 2. Cache check second
    if (this.aliasResults.has(name)) return this.aliasResults.get(name)!;

    // Do I have this alias?
    const alias = this.aliases.get(name);
    if (alias) {
      // 3. Branch the path
      const nextPath = new Set(pullPath).add(aliasKey);
      const promise = evaluator(alias, this, undefined, nextPath);
      this.aliasResults.set(name, promise);
      return promise;
    }

    // Delegate to parent
    if (this.parent) {
      return this.parent.resolveAlias(name, evaluator, pullPath);
    }

    throw new Error(`Alias "${name}" not found in any scope`);
  }

  /** Push element data for array iteration. */
  pushElement(data: unknown): void {
    this.elementData.push(data);
  }

  /** Get element data at a given depth (0 = current, 1 = parent array, etc). */
  getElement(depth: number): unknown {
    const idx = this.elementData.length - 1 - depth;
    if (idx >= 0) return this.elementData[idx];
    if (this.parent)
      return this.parent.getElement(depth - this.elementData.length);
    return undefined;
  }

  /** Get the root scope (stops at define boundaries). */
  root(): ExecutionScope {
    let scope: ExecutionScope = this;
    while (scope.parent && !scope.isRootScope) scope = scope.parent;
    return scope;
  }

  /**
   * Resolve a tool result via lexical scope chain.
   *
   * Walks up the parent chain to find the scope that owns the tool
   * (declared via `with`). Tool calls are lazy — the tool function is
   * only invoked when its output is first read, at which point its
   * input wires are evaluated on demand.
   *
   * Cycle detection: tracks active pull keys to detect circular deps.
   */
  async resolveToolResult(
    module: string,
    field: string,
    instance: number | undefined,
    bridgeLoc?: SourceLocation,
    pullPath: ReadonlySet<string> = EMPTY_PULL_PATH,
  ): Promise<unknown> {
    const key = toolKey(module, field, instance);

    // Cycle detection — must happen before the cache check.
    // If this key is already in our pull path, we have a circular dependency.
    if (pullPath.has(key)) {
      const err = new BridgePanicError(
        `Circular dependency detected: "${key}" depends on itself`,
      );
      if (bridgeLoc)
        (err as unknown as { bridgeLoc: SourceLocation }).bridgeLoc = bridgeLoc;
      throw err;
    }

    // Does this scope own the tool?
    const ownerKey = toolOwnerKey(module, field);
    if (this.ownedTools.has(ownerKey)) {
      // Check local memoization cache
      if (this.toolResults.has(key)) return this.toolResults.get(key)!;

      // Branch the path for this tool's input evaluation
      const nextPath = new Set(pullPath);
      nextPath.add(key);
      return this.callTool(key, module, field, bridgeLoc, nextPath);
    }

    // Check local memoization cache for non-owned (delegated) results
    if (this.toolResults.has(key)) return this.toolResults.get(key)!;

    // Delegate to parent scope (lexical chain traversal)
    if (this.parent) {
      return this.parent.resolveToolResult(
        module,
        field,
        instance,
        bridgeLoc,
        pullPath,
      );
    }

    throw new Error(`Tool "${module}.${field}" not found in any scope`);
  }

  /**
   * Lazily call a tool — evaluates input wires on demand, invokes the
   * tool function, and caches the result.
   *
   * Supports ToolDef resolution, memoization, sync validation,
   * batching, timeouts, and bridgeLoc error attachment.
   */
  private callTool(
    key: string,
    module: string,
    field: string,
    bridgeLoc: SourceLocation | undefined,
    pullPath: ReadonlySet<string>,
  ): Promise<unknown> {
    const promise = (async () => {
      const toolName = module === SELF_MODULE ? field : `${module}.${field}`;

      // Resolve ToolDef (extends chain → root fn, merged wires, onError)
      const toolDef = resolveToolDefByName(
        this.engine.instructions,
        toolName,
        this.engine.toolDefCache,
      );
      const fnName = toolDef?.fn ?? toolName;
      const fn = lookupToolFn(this.engine.tools, fnName);

      // Build input: ToolDef base wires first, then bridge wires override.
      // Evaluated before the "fn not found" check so that tool-input wire
      // traversal bits are recorded even when the tool function is missing.
      // pullPath already contains this key — any re-entrant resolveToolResult
      // for the same key will detect the cycle.
      const input: Record<string, unknown> = {};

      if (toolDef?.body) {
        await evaluateToolDefBody(toolDef.body, input, this, pullPath);
      }

      const wires = this.toolInputWires.get(key) ?? [];
      const wireGroups = groupWiresByPath(wires);
      await Promise.all(
        wireGroups.map(async (group) => {
          const ordered =
            group.length > 1
              ? orderOverdefinedWires(group, this.engine)
              : group;
          let lastError: unknown;
          for (const wire of ordered) {
            try {
              const value = await evaluateSourceChain(
                wire,
                this,
                undefined,
                pullPath,
              );
              setPath(input, wire.target.path, value);
              if (value != null) return; // short-circuit: non-nullish wins
              lastError = undefined; // reset — wire succeeded (null)
            } catch (err) {
              if (isFatalError(err) || isLoopControlSignal(err)) throw err;
              lastError = err;
            }
          }
          if (lastError) throw lastError;
        }),
      );

      if (!fn) throw new Error(`No tool found for "${fnName}"`);
      const {
        doTrace,
        sync: isSyncTool,
        batch: batchMeta,
        log: toolLog,
      } = resolveToolMeta(fn);

      // Short-circuit if externally aborted
      if (this.engine.signal?.aborted) throw new BridgeAbortError();

      // Memoize check — if this tool is memoized, check cache by input hash
      // Use `key` (includes instance) so different handles for the same tool
      // maintain isolated caches.
      const ownerKey = toolOwnerKey(module, field);
      const isMemoized = this.memoizedToolKeys.has(ownerKey);
      if (isMemoized) {
        const cacheKey = stableMemoizeKey(input);
        let toolCache = this.engine.toolMemoCache.get(key);
        if (!toolCache) {
          toolCache = new Map();
          this.engine.toolMemoCache.set(key, toolCache);
        }
        const cached = toolCache.get(cacheKey);
        if (cached !== undefined) return cached;

        // Not cached — call and cache result
        const resultPromise = this.invokeToolFn(
          fn,
          input,
          toolName,
          fnName,
          isSyncTool,
          batchMeta,
          doTrace,
          toolLog,
          bridgeLoc,
        );
        toolCache.set(cacheKey, resultPromise);
        return resultPromise;
      }

      return this.invokeToolFn(
        fn,
        input,
        toolName,
        fnName,
        isSyncTool,
        batchMeta,
        doTrace,
        toolLog,
        bridgeLoc,
      );
    })();

    this.toolResults.set(key, promise);
    return promise;
  }

  /**
   * Invoke a tool function with tracing, timeout, sync validation,
   * batching, and error handling.
   */
  private async invokeToolFn(
    fn: (...args: unknown[]) => unknown,
    input: Record<string, unknown>,
    toolName: string,
    fnName: string,
    isSyncTool: boolean,
    batchMeta: { maxBatchSize?: number } | undefined,
    doTrace: boolean,
    toolLog: EffectiveToolLog,
    bridgeLoc?: SourceLocation,
  ): Promise<unknown> {
    const toolContext = {
      logger: this.engine.logger,
      signal: this.engine.signal,
    };
    const startMs = performance.now();
    const timeoutMs = this.engine.toolTimeoutMs;
    try {
      let result: unknown;

      if (batchMeta) {
        // Batched tool call — queue and flush on microtask
        // Tracing and logging are done in flushBatchedToolQueue, not here.
        result = await callBatchedTool(
          this.engine,
          fn,
          input,
          toolName,
          fnName,
          batchMeta,
          doTrace,
          toolLog,
        );
      } else {
        result = fn(input, toolContext);

        // Sync tool validation
        if (isSyncTool) {
          if (isPromise(result)) {
            throw new Error(
              `Tool "${fnName}" declared {sync:true} but returned a Promise`,
            );
          }
        } else if (isPromise(result)) {
          // Apply timeout if configured
          if (timeoutMs > 0) {
            result = await raceTimeout(
              result as Promise<unknown>,
              timeoutMs,
              toolName,
            );
          } else {
            result = await result;
          }
        }
      }

      const durationMs = performance.now() - startMs;

      // Batch calls have their own tracing/logging in flushBatchedToolQueue
      if (!batchMeta) {
        if (this.engine.tracer && doTrace) {
          this.engine.tracer.record(
            this.engine.tracer.entry({
              tool: toolName,
              fn: fnName,
              input,
              output: result,
              durationMs,
              startedAt: this.engine.tracer.now() - durationMs,
            }),
          );
        }
        logToolSuccess(
          this.engine.logger,
          toolLog.execution,
          toolName,
          fnName,
          durationMs,
        );
      }

      return result;
    } catch (err) {
      // Normalize platform AbortError to BridgeAbortError
      if (
        this.engine.signal?.aborted &&
        err instanceof DOMException &&
        err.name === "AbortError"
      ) {
        throw new BridgeAbortError();
      }

      const durationMs = performance.now() - startMs;

      if (!batchMeta) {
        if (this.engine.tracer && doTrace) {
          this.engine.tracer.record(
            this.engine.tracer.entry({
              tool: toolName,
              fn: fnName,
              input,
              error: (err as Error).message,
              durationMs,
              startedAt: this.engine.tracer.now() - durationMs,
            }),
          );
        }
        logToolError(
          this.engine.logger,
          toolLog.errors,
          toolName,
          fnName,
          err as Error,
        );
      }

      if (isFatalError(err)) throw err;

      const toolDef = resolveToolDefByName(
        this.engine.instructions,
        toolName,
        this.engine.toolDefCache,
      );
      if (toolDef?.onError) {
        if ("value" in toolDef.onError)
          return JSON.parse(toolDef.onError.value);
        // source-based onError — resolve from ToolDef handles
        if ("source" in toolDef.onError) {
          const parts = toolDef.onError.source.split(".");
          const src = parts[0]!;
          const path = parts.slice(1);
          const handle = toolDef.handles.find((h) => h.handle === src);
          if (handle?.kind === "context") {
            return getPath(this.engine.context, path);
          }
        }
      }

      // Attach bridgeLoc to error for source location reporting
      throw wrapBridgeRuntimeError(err, { bridgeLoc });
    }
  }

  /**
   * Resolve a define block result via scope chain.
   * Creates a child scope, indexes define body, and pulls output.
   *
   * @param subFields - Optional field filter; when non-empty, only the listed
   *   output fields (and their transitive deps) are resolved in the define
   *   scope, enabling lazy evaluation when the caller only needs a subset.
   *   Ignored on cache hits — the first-call's field set wins.
   */
  async resolveDefine(
    module: string,
    field: string,
    instance: number | undefined,
    pullPath: ReadonlySet<string> = EMPTY_PULL_PATH,
    subFields?: string[],
  ): Promise<unknown> {
    const key = `${module}:${field}`;

    // 1. Cycle check first
    if (pullPath.has(key)) {
      throw new BridgePanicError(
        `Circular dependency detected in define "${module}"`,
      );
    }

    // 2. Cache check second
    if (this.toolResults.has(key)) return this.toolResults.get(key)!;

    // Check ownership
    if (this.ownedDefines.has(module)) {
      // 3. Branch the path
      const nextPath = new Set(pullPath).add(key);
      return this.executeDefine(key, module, nextPath, subFields);
    }

    // Delegate to parent
    if (this.parent) {
      return this.parent.resolveDefine(
        module,
        field,
        instance,
        pullPath,
        subFields,
      );
    }

    throw new Error(`Define "${module}" not found in any scope`);
  }

  /**
   * Register a lazy input factory for this define scope.
   * Called by `executeDefine` so input wires are only evaluated on demand.
   */
  registerLazyInput(pathKey: string, factory: () => Promise<unknown>): void {
    if (!this.lazyInputFactories) this.lazyInputFactories = new Map();
    this.lazyInputFactories.set(pathKey, factory);
  }

  /**
   * Resolve a lazy selfInput value, computing the wire on first access and
   * caching the result (memoized lazy evaluation).
   */
  resolveLazyInput(pathKey: string): Promise<unknown> | undefined {
    const factory = this.lazyInputFactories?.get(pathKey);
    if (!factory) return undefined;
    if (!this.lazyInputCache) this.lazyInputCache = new Map();
    let cached = this.lazyInputCache.get(pathKey);
    if (!cached) {
      cached = factory().then((value) => {
        // Hydrate selfInput so subsequent getPath reads work
        setPath(this.selfInput, pathKey ? pathKey.split(".") : [], value);
        return value;
      });
      this.lazyInputCache.set(pathKey, cached);
    }
    return cached;
  }

  /**
   * Execute a define block — build input from bridge wires, create
   * child scope with define body, pull output.
   */
  private executeDefine(
    key: string,
    module: string,
    pullPath: ReadonlySet<string>,
    subFields?: string[],
  ): Promise<unknown> {
    const promise = (async () => {
      // Map from handle alias to define name via handle bindings
      const handle = module.substring("__define_".length);
      const binding = this.getHandleBinding(handle);
      const defineName = binding?.kind === "define" ? binding.name : handle;

      const defineDef = this.engine.instructions.find(
        (i): i is DefineDef => i.kind === "define" && i.name === defineName,
      );
      if (!defineDef?.body)
        throw new Error(`Define "${defineName}" not found or has no body`);

      // Collect bridge wires targeting this define (input wires).
      // Register them as lazy factories — they will only be evaluated when the
      // define scope actually reads from selfInput for the corresponding path.
      const inputWires = this.defineInputWires.get(key) ?? [];
      const defineInput: Record<string, unknown> = {};
      const defineOutput: Record<string, unknown> = {};
      const defineScope = new ExecutionScope(
        this,
        defineInput,
        defineOutput,
        this.engine,
      );
      defineScope.isRootScope = true;

      // Register each input wire (or group of overdefined wires) as a lazy
      // factory so it only fires when the define body reads that field.
      const parentScope = this;
      const wireGroups = groupWiresByPath(inputWires);
      for (const group of wireGroups) {
        const pathKey = group[0]!.target.path.join(".");
        const ordered =
          group.length > 1
            ? orderOverdefinedWires(group, parentScope.engine)
            : group;
        defineScope.registerLazyInput(pathKey, async () => {
          let lastError: unknown;
          for (const wire of ordered) {
            try {
              const value = await evaluateSourceChain(
                wire,
                parentScope,
                undefined,
                pullPath,
              );
              if (value != null) return value; // short-circuit: non-nullish wins
              lastError = undefined; // reset — wire succeeded (null)
            } catch (err) {
              if (isFatalError(err) || isLoopControlSignal(err)) throw err;
              lastError = err;
            }
          }
          if (lastError) throw lastError;
          return undefined;
        });
      }

      // Index define body and pull output.
      // Use caller-supplied subFields to enable lazy evaluation when only a
      // subset of the define's output fields are actually needed.
      indexStatements(defineDef.body, defineScope);
      await resolveRequestedFields(defineScope, subFields ?? [], pullPath);

      return "__rootValue__" in defineOutput
        ? defineOutput.__rootValue__
        : defineOutput;
    })();

    this.toolResults.set(key, promise);
    return promise;
  }
}

/** Shared engine-wide context. */
interface EngineContext {
  readonly tools: ToolMap;
  readonly instructions: readonly (Bridge | ToolDef | ConstDef | DefineDef)[];
  readonly type: string;
  readonly field: string;
  readonly context: Record<string, unknown>;
  readonly logger?: Logger;
  readonly tracer?: TraceCollector;
  readonly signal?: AbortSignal;
  readonly toolDefCache: Map<string, ToolDef | null>;
  readonly toolTimeoutMs: number;
  /** Memoize caches — shared across all scopes. Keyed by owner tool key → input hash → result. */
  readonly toolMemoCache: Map<string, Map<string, Promise<unknown>>>;
  /** Batch queues — shared across all scopes. Keyed by fn reference. */
  readonly toolBatchQueues: Map<
    (...args: unknown[]) => unknown,
    BatchToolQueue
  >;
  /** Maximum nesting depth for array mappings / shadow scopes. */
  readonly maxDepth: number;
  /** Whether non-fatal errors are planted as sentinels instead of thrown. */
  readonly partialSuccess: boolean;
  /** Trace bits map — keyed by sources array reference for O(1) lookup. */
  readonly traceBits: Map<WireSourceEntry[], TraceWireBits> | undefined;
  /** Empty-array bits map — keyed by ArrayExpression reference. */
  readonly emptyArrayBits: Map<Expression, number> | undefined;
  /** Mutable trace bitmask accumulator. */
  readonly traceMask: [bigint] | undefined;
}

/** Record a single trace bit in the engine's trace mask. */
function recordTraceBit(engine: EngineContext, bit: number | undefined): void {
  if (bit != null && engine.traceMask) {
    engine.traceMask[0] |= 1n << BigInt(bit);
  }
}

/** Pending batched tool call. */
type PendingBatchToolCall = {
  input: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

/** Queue for collecting same-tick batched calls. */
type BatchToolQueue = {
  items: PendingBatchToolCall[];
  scheduled: boolean;
  toolName: string;
  fnName: string;
  maxBatchSize?: number;
  doTrace: boolean;
  log: EffectiveToolLog;
};

/**
 * Build a deterministic cache key from an arbitrary value.
 * Used for memoize deduplication.
 */
function stableMemoizeKey(value: unknown): string {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (typeof value === "boolean") return value ? "T" : "F";
  if (typeof value === "number") return `d:${value}`;
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "bigint") return `B:${value}`;
  if (Array.isArray(value)) return `[${value.map(stableMemoizeKey).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${k}:${stableMemoizeKey((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return String(value);
}

// ── ToolDef resolution ──────────────────────────────────────────────────────

/**
 * Resolve a ToolDef by name, walking the extends chain.
 * Returns a merged ToolDef with fn from root, accumulated body, last onError.
 * Returns undefined if no ToolDef exists for this name.
 */
function resolveToolDefByName(
  instructions: readonly (Bridge | ToolDef | ConstDef | DefineDef)[],
  name: string,
  cache: Map<string, ToolDef | null>,
): ToolDef | undefined {
  if (cache.has(name)) return cache.get(name) ?? undefined;

  const toolDefs = instructions.filter((i): i is ToolDef => i.kind === "tool");
  const base = toolDefs.find((t) => t.name === name);
  if (!base) {
    cache.set(name, null);
    return undefined;
  }

  // Build extends chain: root → ... → leaf
  const chain: ToolDef[] = [base];
  let current = base;
  while (current.extends) {
    const parent = toolDefs.find((t) => t.name === current.extends);
    if (!parent)
      throw new Error(
        `Tool "${current.name}" extends unknown tool "${current.extends}"`,
      );
    chain.unshift(parent);
    current = parent;
  }

  // Merge: fn from root, handles deduplicated, body accumulated, onError last wins
  const merged: ToolDef = {
    kind: "tool",
    name,
    fn: chain[0]!.fn,
    handles: [],
    body: [],
  };

  for (const def of chain) {
    for (const h of def.handles) {
      if (!merged.handles.some((mh) => mh.handle === h.handle)) {
        merged.handles.push(h);
      }
    }
    if (def.body) {
      merged.body.push(...def.body);
    }
    if (def.onError) merged.onError = def.onError;
  }

  cache.set(name, merged);
  return merged;
}

/**
 * Evaluate ToolDef body statements to build base tool input.
 * Creates a child scope for inner tool handles and context resolution.
 */
async function evaluateToolDefBody(
  body: Statement[],
  input: Record<string, unknown>,
  callerScope: ExecutionScope,
  pullPath: ReadonlySet<string>,
): Promise<void> {
  // Create a temporary scope for ToolDef body — inner tools are owned here
  const toolDefScope = new ExecutionScope(
    callerScope,
    callerScope.selfInput,
    {},
    callerScope.engine,
  );

  // Register inner tool handles
  for (const stmt of body) {
    if (stmt.kind === "with") {
      if (stmt.binding.kind === "tool") {
        toolDefScope.declareToolBinding(stmt.binding.name);
      }
      toolDefScope.registerHandle(stmt.binding);
    }
  }

  // Index inner tool input wires (for tool-to-tool deps within ToolDef)
  for (const stmt of body) {
    if (stmt.kind === "wire" && stmt.target.instance != null) {
      toolDefScope.addToolInputWire(stmt);
    }
  }

  // Evaluate wires targeting the tool itself (no instance = tool config)
  const configStmts = body.filter(
    (stmt): stmt is WireStatement | ScopeStatement =>
      (stmt.kind === "wire" && stmt.target.instance == null) ||
      stmt.kind === "scope",
  );
  await Promise.all(
    configStmts.map(async (stmt) => {
      if (stmt.kind === "wire") {
        const value = await evaluateSourceChain(
          stmt,
          toolDefScope,
          undefined,
          pullPath,
        );
        setPath(input, stmt.target.path, value);
      } else {
        await evaluateToolDefScope(stmt, input, toolDefScope, pullPath);
      }
    }),
  );
}

/** Recursively evaluate scope blocks inside ToolDef bodies. */
async function evaluateToolDefScope(
  scope: ScopeStatement,
  input: Record<string, unknown>,
  toolDefScope: ExecutionScope,
  pullPath: ReadonlySet<string>,
): Promise<void> {
  const prefix = scope.target.path;
  await Promise.all(
    scope.body.map(async (inner) => {
      if (inner.kind === "wire" && inner.target.instance == null) {
        const value = await evaluateSourceChain(
          inner,
          toolDefScope,
          undefined,
          pullPath,
        );
        setPath(input, [...prefix, ...inner.target.path], value);
      } else if (inner.kind === "scope") {
        const nested: ScopeStatement = {
          ...inner,
          target: {
            ...inner.target,
            path: [...prefix, ...inner.target.path],
          },
        };
        await evaluateToolDefScope(nested, input, toolDefScope, pullPath);
      }
    }),
  );
}

// ── Batched tool calls ──────────────────────────────────────────────────────

/**
 * Queue a batched tool call — collects calls within the same microtask tick
 * and flushes them as a single array call to the tool function.
 */
function callBatchedTool(
  engine: EngineContext,
  fn: (...args: unknown[]) => unknown,
  input: Record<string, unknown>,
  toolName: string,
  fnName: string,
  batchMeta: { maxBatchSize?: number },
  doTrace: boolean,
  log: EffectiveToolLog,
): Promise<unknown> {
  let queue = engine.toolBatchQueues.get(fn);
  if (!queue) {
    queue = {
      items: [],
      scheduled: false,
      toolName,
      fnName,
      maxBatchSize: batchMeta.maxBatchSize,
      doTrace,
      log,
    };
    engine.toolBatchQueues.set(fn, queue);
  }

  return new Promise<unknown>((resolve, reject) => {
    queue.items.push({ input, resolve, reject });

    if (!queue.scheduled) {
      queue.scheduled = true;
      queueMicrotask(() => flushBatchedToolQueue(engine, fn, queue));
    }
  });
}

/**
 * Flush a batched tool queue — calls the tool with an array of inputs,
 * distributes results back to individual callers.
 */
async function flushBatchedToolQueue(
  engine: EngineContext,
  fn: (...args: unknown[]) => unknown,
  queue: BatchToolQueue,
): Promise<void> {
  const items = queue.items.splice(0);
  queue.scheduled = false;

  const tracer = engine.tracer;

  // Chunk by maxBatchSize if configured
  const maxSize = queue.maxBatchSize ?? items.length;
  for (let offset = 0; offset < items.length; offset += maxSize) {
    const chunk = items.slice(offset, offset + maxSize);
    const batchInput = chunk.map((c) => c.input);

    const toolContext = {
      logger: engine.logger,
      signal: engine.signal,
    };

    const startMs = tracer?.now();
    const wallStart = performance.now();

    try {
      let result = fn(batchInput, toolContext) as
        | unknown[]
        | Promise<unknown[]>;
      if (isPromise(result)) {
        if (engine.toolTimeoutMs > 0) {
          result = await raceTimeout(
            result as Promise<unknown[]>,
            engine.toolTimeoutMs,
            queue.toolName,
          );
        } else {
          result = await (result as Promise<unknown[]>);
        }
      }

      const durationMs = performance.now() - wallStart;

      // Record a single trace entry for the entire batch
      if (tracer && startMs != null && queue.doTrace) {
        tracer.record(
          tracer.entry({
            tool: queue.toolName,
            fn: queue.fnName,
            input: batchInput,
            output: result,
            durationMs,
            startedAt: startMs,
          }),
        );
      }
      logToolSuccess(
        engine.logger,
        queue.log.execution,
        queue.toolName,
        queue.fnName,
        durationMs,
      );

      if (!Array.isArray(result) || result.length !== chunk.length) {
        const err = new Error(
          `Batch tool "${queue.fnName}" returned ${Array.isArray(result) ? result.length : typeof result} items, expected ${chunk.length}`,
        );
        for (const item of chunk) item.reject(err);
        continue;
      }

      for (let i = 0; i < chunk.length; i++) {
        const value = result[i];
        if (value instanceof Error) {
          chunk[i]!.reject(value);
        } else {
          chunk[i]!.resolve(value);
        }
      }
    } catch (err) {
      const durationMs = performance.now() - wallStart;

      // Record error trace for the batch
      if (tracer && startMs != null && queue.doTrace) {
        tracer.record(
          tracer.entry({
            tool: queue.toolName,
            fn: queue.fnName,
            input: batchInput,
            error: (err as Error).message,
            durationMs,
            startedAt: startMs,
          }),
        );
      }
      logToolError(
        engine.logger,
        queue.log.errors,
        queue.toolName,
        queue.fnName,
        err as Error,
      );

      for (const item of chunk) item.reject(err);
    }
  }
}

// ── Statement indexing & pulling ────────────────────────────────────────────

/**
 * Index phase — walk statements and register tool bindings and input wires.
 * Does NOT evaluate anything. Recurses into ScopeStatements (same scope).
 */
function indexStatements(
  statements: Statement[],
  scope: ExecutionScope,
  scopeCtx?: { pathPrefix: string[]; toolTarget?: NodeRef },
): void {
  for (const stmt of statements) {
    switch (stmt.kind) {
      case "with":
        if (stmt.binding.kind === "tool") {
          scope.declareToolBinding(stmt.binding.name, stmt.binding.memoize);
        } else if (stmt.binding.kind === "define") {
          scope.declareDefineBinding(stmt.binding.handle);
        }
        scope.registerHandle(stmt.binding);
        break;
      case "spread":
        scope.addSpread(stmt, scopeCtx?.pathPrefix ?? []);
        break;
      case "wire": {
        const target = stmt.target;
        // Define input wire — wire targeting a __define_* module
        if (target.module.startsWith("__define_")) {
          scope.addDefineInputWire(stmt);
          break;
        }
        const isToolInput = target.instance != null && !target.element;
        if (isToolInput) {
          // Direct tool input wire (e.g. a.q <- i.q)
          scope.addToolInputWire(stmt);
        } else if (scopeCtx?.toolTarget) {
          // Wire inside a tool input scope block — remap to tool input
          const tt = scopeCtx.toolTarget;
          const prefixed = {
            ...stmt,
            target: {
              ...tt,
              path: [...scopeCtx.pathPrefix, ...target.path],
            },
          };
          scope.addToolInputWire(prefixed);
        } else if (scopeCtx) {
          // Wire inside an output scope block — prefix the path
          const prefixed = {
            ...stmt,
            target: {
              ...target,
              path: [...scopeCtx.pathPrefix, ...target.path],
            },
          };
          scope.addOutputWire(prefixed);
        } else {
          scope.addOutputWire(stmt);
        }
        break;
      }
      case "alias":
        scope.addAlias(stmt);
        break;
      case "scope": {
        const st = stmt.target;
        const isScopeOnTool = st.instance != null && !st.element;
        const prefix = [...(scopeCtx?.pathPrefix ?? []), ...st.path];
        if (isScopeOnTool) {
          // Scope block targeting a tool input (e.g. a.query { ... })
          indexStatements(stmt.body, scope, {
            pathPrefix: prefix,
            toolTarget: scopeCtx?.toolTarget ?? st,
          });
        } else if (scopeCtx?.toolTarget) {
          // Nested output scope inside a tool scope — keep tool context
          indexStatements(stmt.body, scope, {
            pathPrefix: prefix,
            toolTarget: scopeCtx.toolTarget,
          });
        } else {
          // Output scope block (e.g. o.result { ... })
          indexStatements(stmt.body, scope, { pathPrefix: prefix });
        }
        break;
      }
      case "force":
        scope.forceStatements.push(stmt);
        break;
    }
  }
}

/**
 * Compute sub-requestedFields for a wire target.
 *
 * Given a wire at `wireKey` and the parent's `requestedFields`, returns the
 * fields that should be forwarded to array expressions within the wire.
 * - Root wire (key ""): all requestedFields pass through unchanged
 * - Exact match: empty array (unrestricted — resolve all sub-fields)
 * - Prefix match: strip the wire key prefix
 */
function computeSubRequestedFields(
  wireKey: string,
  requestedFields: string[],
): string[] {
  if (wireKey === "") return requestedFields;

  const subFields: string[] = [];
  for (const field of requestedFields) {
    if (field === wireKey) return []; // Exact match → unrestricted
    if (field.startsWith(wireKey + ".")) {
      subFields.push(field.slice(wireKey.length + 1));
    }
    // Handle wildcard: "legs.*" for wireKey "legs" → sub-field "*"
    if (field.endsWith(".*") && wireKey === field.slice(0, -2)) {
      return []; // Wildcard on this exact level → unrestricted
    }
  }
  return subFields;
}

/**
 * Demand-driven pull — resolve only the requested output fields.
 * Evaluates output wires from the index (not by walking the AST).
 * Tool calls happen lazily when their output is read during source evaluation.
 *
 * If no specific fields are requested, all indexed output wires are resolved.
 *
 * All output wire groups are evaluated concurrently so that tool-referencing
 * wires can start their tool calls before input-only wires that may panic.
 * This matches v1 eager-evaluation semantics.
 *
 * Supports overdefinition: when multiple wires target the same output path,
 * they are ordered by cost (cheapest first) and evaluated with null-coalescing
 * — the first non-null result wins.
 */
async function resolveRequestedFields(
  scope: ExecutionScope,
  requestedFields: string[],
  pullPath: ReadonlySet<string> = EMPTY_PULL_PATH,
): Promise<LoopControlSignal | typeof BREAK_SYM | typeof CONTINUE_SYM | void> {
  // Get wire groups — each group is an array of wires targeting the same path
  const wireGroups: WireStatement[][] =
    requestedFields.length > 0
      ? scope.collectMatchingOutputWireGroups(requestedFields)
      : scope.allOutputFields().map((f) => scope.getOutputWires(f)!);

  // Evaluate all wire groups concurrently
  type Signal = LoopControlSignal | typeof BREAK_SYM | typeof CONTINUE_SYM;

  const settled = await Promise.allSettled(
    wireGroups.map(async (wires): Promise<Signal | undefined> => {
      // Order overdefined wires by cost (cheapest first)
      const ordered =
        wires.length > 1 ? orderOverdefinedWires(wires, scope.engine) : wires;

      // Compute sub-requestedFields for array expressions within this wire.
      // Strip the wire's target path prefix from the parent requestedFields.
      let subFields: string[] | undefined;
      if (requestedFields.length > 0) {
        const wireKey = ordered[0]!.target.path.join(".");
        subFields = computeSubRequestedFields(wireKey, requestedFields);
      }

      // Null-coalescing across overdefined wires
      let value: unknown;
      let lastError: unknown;
      for (const wire of ordered) {
        try {
          value = await evaluateSourceChain(wire, scope, subFields, pullPath);
          if (isLoopControlSignal(value)) return value;
          if (value != null) break; // First non-null wins
        } catch (err) {
          // With partialSuccess, even fatal errors are scoped to the field —
          // they become per-field Error Sentinels instead of killing the whole
          // execution. Without partialSuccess, fatal errors always propagate.
          if (isFatalError(err) && !scope.engine.partialSuccess) throw err;
          lastError = err;
          // Continue to next wire — maybe a cheaper fallback succeeds
        }
      }

      // THE FIX: If all wires returned null/undefined and there was an error,
      // plant the error as an Error Sentinel in the output tree instead of
      // throwing. This allows GraphQL to deliver partial success — the field
      // becomes null with an error entry, while sibling fields still resolve.
      if (value == null && lastError) {
        if (scope.engine.partialSuccess) {
          writeTarget(
            ordered[0]!.target,
            lastError instanceof Error
              ? lastError
              : new Error(String(lastError)),
            scope,
          );
          return undefined;
        }
        throw lastError;
      }

      writeTarget(ordered[0]!.target, value, scope);
      return undefined;
    }),
  );

  // Evaluate spread statements concurrently — merge source objects into output
  await Promise.all(
    scope.getSpreads().map(async ({ stmt: spread, pathPrefix }) => {
      try {
        const spreadValue = await evaluateSourceChain(
          spread,
          scope,
          undefined,
          pullPath,
        );
        if (
          spreadValue != null &&
          typeof spreadValue === "object" &&
          !Array.isArray(spreadValue)
        ) {
          // Spreads always target the root output (self-module output)
          const targetOutput = scope.root().output;
          if (pathPrefix.length > 0) {
            // Spread inside a scope block — navigate to the nested object and merge
            let nested: Record<string, unknown> = targetOutput;
            for (const segment of pathPrefix) {
              if (UNSAFE_KEYS.has(segment))
                throw new Error(`Unsafe assignment key: ${segment}`);
              if (
                nested[segment] == null ||
                typeof nested[segment] !== "object" ||
                Array.isArray(nested[segment])
              ) {
                nested[segment] = {};
              }
              nested = nested[segment] as Record<string, unknown>;
            }
            Object.assign(nested, spreadValue as Record<string, unknown>);
          } else {
            Object.assign(targetOutput, spreadValue as Record<string, unknown>);
          }
        }
      } catch (err) {
        if (isFatalError(err)) throw err;
        throw err;
      }
    }),
  );

  // Process results: collect errors and signals, preserving wire order.
  let fatalError: unknown;
  let firstError: unknown;
  let firstSignal: Signal | undefined;

  for (const result of settled) {
    if (result.status === "rejected") {
      if (isFatalError(result.reason)) {
        if (!fatalError) fatalError = result.reason;
      } else {
        // Collect non-fatal errors. With partialSuccess, evaluation errors
        // become sentinels (no rejection), so only unplantable writeTarget
        // failures reach here — those should always surface.
        if (!firstError) firstError = result.reason;
      }
    } else if (result.value != null) {
      if (!firstSignal) firstSignal = result.value;
    }
  }

  if (fatalError) throw fatalError;
  if (firstSignal) return firstSignal;
  if (firstError) throw firstError;
}

/**
 * Group a flat array of wires by their target path.
 * Used to detect overdefinition and apply short-circuit evaluation.
 */
function groupWiresByPath(wires: WireStatement[]): WireStatement[][] {
  const groups = new Map<string, WireStatement[]>();
  for (const wire of wires) {
    const pathKey = wire.target.path.join(".");
    let group = groups.get(pathKey);
    if (!group) {
      group = [];
      groups.set(pathKey, group);
    }
    group.push(wire);
  }
  return Array.from(groups.values());
}

/**
 * Order overdefined wires by cost — cheapest source first.
 * Input/context/const/element refs are "free" (cost 0), tool refs are expensive.
 * Same-cost wires preserve authored order.
 */
function orderOverdefinedWires(
  wires: WireStatement[],
  engine: EngineContext,
): WireStatement[] {
  const ranked = wires.map((wire, index) => ({
    wire,
    index,
    cost: computeExprCost(wire.sources[0]!.expr, engine, new Set()),
  }));
  ranked.sort((left, right) => {
    if (left.cost !== right.cost) return left.cost - right.cost;
    return left.index - right.index; // stable: preserve source order
  });
  return ranked.map((entry) => entry.wire);
}

/**
 * Compute the optimistic cost of an expression for overdefinition ordering.
 * - literals/control → 0
 * - input/context/const/element refs → 0
 * - tool refs → 2 (or sync tool → 1, or meta.cost if set)
 * - ternary/and/or → max of branches
 */
function computeExprCost(
  expr: Expression,
  engine: EngineContext,
  visited: Set<string>,
): number {
  switch (expr.type) {
    case "literal":
    case "control":
      return 0;
    case "ref": {
      const ref = expr.ref;
      if (ref.element) return 0;
      if (ref.type === "Context" || ref.type === "Const") return 0;
      if (ref.module === SELF_MODULE && ref.type === "__local") return 0;
      if (ref.module === SELF_MODULE && ref.instance == null) return 0; // input ref
      // Tool ref — look up metadata
      const toolName =
        ref.module === SELF_MODULE ? ref.field : `${ref.module}.${ref.field}`;
      const key = toolName;
      if (visited.has(key)) return Infinity;
      visited.add(key);
      const fn = lookupToolFn(engine.tools, toolName);
      if (fn) {
        const meta = (fn as unknown as Record<string, unknown>).bridge as
          | Record<string, unknown>
          | undefined;
        if (meta?.cost != null) return meta.cost as number;
        return meta?.sync ? 1 : 2;
      }
      return 2;
    }
    case "ternary":
      return Math.max(
        computeExprCost(expr.cond, engine, visited),
        computeExprCost(expr.then, engine, visited),
        computeExprCost(expr.else, engine, visited),
      );
    case "and":
    case "or":
      return Math.max(
        computeExprCost(expr.left, engine, visited),
        computeExprCost(expr.right, engine, visited),
      );
    case "array":
    case "pipe":
      return computeExprCost(expr.source, engine, visited);
    case "binary":
      return Math.max(
        computeExprCost(expr.left, engine, visited),
        computeExprCost(expr.right, engine, visited),
      );
    case "unary":
      return computeExprCost(expr.operand, engine, visited);
    case "concat": {
      let max = 0;
      for (const part of expr.parts) {
        max = Math.max(max, computeExprCost(part, engine, visited));
      }
      return max;
    }
  }
}

/**
 * Evaluate a source chain (fallback gates: ||, ??).
 * Wraps with catch handler if present. Attaches bridgeLoc on error.
 * Records execution trace bits when the engine has trace maps configured.
 */
async function evaluateSourceChain(
  chain: SourceChain,
  scope: ExecutionScope,
  requestedFields?: string[],
  pullPath: ReadonlySet<string> = EMPTY_PULL_PATH,
): Promise<unknown> {
  const bits = scope.engine.traceBits?.get(chain.sources);
  let lastEntryLoc: SourceLocation | undefined;
  let firstExprLoc: SourceLocation | undefined;
  let activeSourceIndex = -1;
  let ternaryElsePath = false;

  try {
    let value: unknown;

    for (let i = 0; i < chain.sources.length; i++) {
      const entry = chain.sources[i]!;
      if (entry.gate === "falsy" && value) continue;
      if (entry.gate === "nullish" && value != null) continue;
      lastEntryLoc = entry.loc;
      if (!firstExprLoc) firstExprLoc = entry.expr.loc;
      activeSourceIndex = i;

      const expr = entry.expr;

      // Record the trace bit BEFORE evaluating so even if the expression
      // throws, the path is marked as visited.
      if (bits) {
        if (i === 0 && expr.type === "ternary") {
          // Ternary primary — defer bit recording until we know which branch
        } else if (i === 0) {
          recordTraceBit(scope.engine, bits.primary);
        } else {
          recordTraceBit(scope.engine, bits.fallbacks?.[i - 1]);
        }
      }

      // Ternary primary — evaluate condition inline to record then/else bits
      if (i === 0 && expr.type === "ternary" && bits) {
        const cond = await evaluateExpression(
          expr.cond,
          scope,
          undefined,
          pullPath,
        );
        if (cond) {
          recordTraceBit(scope.engine, bits.primary);
          value = await evaluateExpression(
            expr.then,
            scope,
            requestedFields,
            pullPath,
          );
        } else {
          ternaryElsePath = true;
          recordTraceBit(scope.engine, bits.else);
          value = await evaluateExpression(
            expr.else,
            scope,
            requestedFields,
            pullPath,
          );
        }
      } else {
        value = await evaluateExpression(
          expr,
          scope,
          requestedFields,
          pullPath,
        );
      }
    }

    return value;
  } catch (err) {
    if (isFatalError(err)) {
      // Attach bridgeLoc to fatal errors (panic) so they carry source location
      const fatLoc =
        firstExprLoc ?? lastEntryLoc ?? (chain as { loc?: SourceLocation }).loc;
      if (fatLoc && !(err as { bridgeLoc?: SourceLocation }).bridgeLoc) {
        (err as { bridgeLoc?: SourceLocation }).bridgeLoc = fatLoc;
      }
      throw err;
    }
    if (chain.catch) {
      // Record catch bit and delegate to catch handler
      recordTraceBit(scope.engine, bits?.catch);
      try {
        return await applyCatchHandler(chain.catch, scope, pullPath);
      } catch (catchErr) {
        // Record catchError only for non-control-flow errors from the catch handler
        if (
          bits?.catchError != null &&
          !isFatalError(catchErr) &&
          catchErr !== BREAK_SYM &&
          catchErr !== CONTINUE_SYM
        ) {
          recordTraceBit(scope.engine, bits.catchError);
        }
        throw catchErr;
      }
    }
    // No catch — record error bit for the active source
    if (bits) {
      if (activeSourceIndex === 0 && ternaryElsePath) {
        recordTraceBit(scope.engine, bits.elseError);
      } else if (activeSourceIndex === 0) {
        recordTraceBit(scope.engine, bits.primaryError);
      } else if (activeSourceIndex > 0) {
        recordTraceBit(
          scope.engine,
          bits.fallbackErrors?.[activeSourceIndex - 1],
        );
      }
    }
    // Use the first source entry's expression loc (start of source chain)
    const loc =
      firstExprLoc ?? lastEntryLoc ?? (chain as { loc?: SourceLocation }).loc;
    if (loc) throw wrapBridgeRuntimeError(err, { bridgeLoc: loc });
    throw err;
  }
}

/**
 * Apply a catch handler — returns a literal, resolves a ref, or
 * executes control flow (throw/panic/continue/break).
 */
async function applyCatchHandler(
  c: WireCatch,
  scope: ExecutionScope,
  pullPath: ReadonlySet<string> = EMPTY_PULL_PATH,
): Promise<unknown> {
  if ("control" in c) {
    return applyControlFlow(c.control);
  }
  if ("expr" in c) {
    return evaluateExpression(c.expr, scope, undefined, pullPath);
  }
  if ("ref" in c) {
    return resolveRef(c.ref, scope, undefined, pullPath);
  }
  // Literal value
  return c.value;
}

/**
 * Eagerly schedule force tool calls.
 *
 * Returns an array of promises for critical (non-catch) force statements.
 * Fire-and-forget forces (`catch null`) have errors silently swallowed.
 */
function executeForced(scope: ExecutionScope): Promise<unknown>[] {
  const critical: Promise<unknown>[] = [];

  for (const stmt of scope.forceStatements) {
    const promise = scope.resolveToolResult(
      stmt.module,
      stmt.field,
      stmt.instance,
      undefined,
      EMPTY_PULL_PATH,
    );
    if (stmt.catchError) {
      promise.catch(() => {});
    } else {
      critical.push(promise);
    }
  }

  return critical;
}

/**
 * Evaluate an expression safely — swallows non-fatal errors and returns undefined.
 * Fatal errors (panic, abort) always propagate.
 */
async function evaluateExprSafe(
  fn: () => unknown | Promise<unknown>,
): Promise<unknown> {
  try {
    const result = fn();
    if (
      result != null &&
      typeof (result as Promise<unknown>).then === "function"
    ) {
      return await (result as Promise<unknown>);
    }
    return result;
  } catch (err) {
    if (isFatalError(err)) throw err;
    return undefined;
  }
}

/**
 * Evaluate an expression tree.
 */
async function evaluateExpression(
  expr: Expression,
  scope: ExecutionScope,
  requestedFields?: string[],
  pullPath: ReadonlySet<string> = EMPTY_PULL_PATH,
): Promise<unknown> {
  switch (expr.type) {
    case "ref":
      if (expr.safe) {
        return evaluateExprSafe(() =>
          resolveRef(
            expr.ref,
            scope,
            expr.refLoc ?? expr.loc,
            pullPath,
            requestedFields,
          ),
        );
      }
      return resolveRef(
        expr.ref,
        scope,
        expr.refLoc ?? expr.loc,
        pullPath,
        requestedFields,
      );

    case "literal":
      return expr.value;

    case "array":
      return evaluateArrayExpr(expr, scope, requestedFields, pullPath);

    case "ternary": {
      let cond: unknown;
      try {
        cond = await evaluateExpression(expr.cond, scope, undefined, pullPath);
      } catch (err) {
        if (isFatalError(err)) throw err;
        const loc = expr.condLoc ?? expr.cond.loc ?? expr.loc;
        if (loc) throw wrapBridgeRuntimeError(err, { bridgeLoc: loc });
        throw err;
      }
      const branch = cond ? expr.then : expr.else;
      try {
        return await evaluateExpression(branch, scope, undefined, pullPath);
      } catch (err) {
        if (isFatalError(err)) throw err;
        const loc = branch.loc ?? expr.loc;
        if (loc) throw wrapBridgeRuntimeError(err, { bridgeLoc: loc });
        throw err;
      }
    }

    case "and": {
      const left = expr.leftSafe
        ? await evaluateExprSafe(() =>
            evaluateExpression(expr.left, scope, undefined, pullPath),
          )
        : await evaluateExpression(expr.left, scope, undefined, pullPath);
      if (!left) return false;
      if (expr.right.type === "literal" && expr.right.value === "true") {
        return Boolean(left);
      }
      const right = expr.rightSafe
        ? await evaluateExprSafe(() =>
            evaluateExpression(expr.right, scope, undefined, pullPath),
          )
        : await evaluateExpression(expr.right, scope, undefined, pullPath);
      return Boolean(right);
    }

    case "or": {
      const left = expr.leftSafe
        ? await evaluateExprSafe(() =>
            evaluateExpression(expr.left, scope, undefined, pullPath),
          )
        : await evaluateExpression(expr.left, scope, undefined, pullPath);
      if (left) return true;
      if (expr.right.type === "literal" && expr.right.value === "true") {
        return Boolean(left);
      }
      const right = expr.rightSafe
        ? await evaluateExprSafe(() =>
            evaluateExpression(expr.right, scope, undefined, pullPath),
          )
        : await evaluateExpression(expr.right, scope, undefined, pullPath);
      return Boolean(right);
    }

    case "control": {
      try {
        return applyControlFlow(expr.control);
      } catch (err) {
        if (isFatalError(err)) {
          if (expr.loc && !(err as { bridgeLoc?: SourceLocation }).bridgeLoc) {
            (err as { bridgeLoc?: SourceLocation }).bridgeLoc = expr.loc;
          }
          throw err;
        }
        throw wrapBridgeRuntimeError(err, { bridgeLoc: expr.loc });
      }
    }

    case "binary": {
      const [left, right] = await Promise.all([
        evaluateExpression(expr.left, scope, undefined, pullPath),
        evaluateExpression(expr.right, scope, undefined, pullPath),
      ]);
      switch (expr.op) {
        case "add":
          return Number(left) + Number(right);
        case "sub":
          return Number(left) - Number(right);
        case "mul":
          return Number(left) * Number(right);
        case "div":
          return Number(left) / Number(right);
        case "eq":
          return left === right;
        case "neq":
          return left !== right;
        case "gt":
          return Number(left) > Number(right);
        case "gte":
          return Number(left) >= Number(right);
        case "lt":
          return Number(left) < Number(right);
        case "lte":
          return Number(left) <= Number(right);
      }
      break;
    }

    case "unary":
      return !(await evaluateExpression(
        expr.operand,
        scope,
        undefined,
        pullPath,
      ));

    case "concat": {
      const parts = await Promise.all(
        expr.parts.map((p) =>
          evaluateExpression(p, scope, undefined, pullPath),
        ),
      );
      return parts.map((v) => (v == null ? "" : String(v))).join("");
    }

    case "pipe":
      return evaluatePipeExpression(expr, scope, pullPath);

    default:
      throw new Error(`Unknown expression type: ${(expr as Expression).type}`);
  }
}

/**
 * Evaluate an array mapping expression.
 *
 * Creates a child scope for each element, indexes its body statements,
 * then pulls output wires. Tool reads inside the body trigger lazy
 * evaluation up the scope chain.
 */
async function evaluateArrayExpr(
  expr: Extract<Expression, { type: "array" }>,
  scope: ExecutionScope,
  requestedFields?: string[],
  pullPath: ReadonlySet<string> = EMPTY_PULL_PATH,
): Promise<
  unknown[] | LoopControlSignal | typeof BREAK_SYM | typeof CONTINUE_SYM | null
> {
  const sourceValue = await evaluateExpression(
    expr.source,
    scope,
    undefined,
    pullPath,
  );
  if (sourceValue == null) {
    // Null/undefined source — record empty-array bit
    const emptyBit = scope.engine.emptyArrayBits?.get(expr);
    if (emptyBit != null) recordTraceBit(scope.engine, emptyBit);
    return null;
  }
  if (!Array.isArray(sourceValue)) return [];

  // Empty array — record empty-array bit
  if (sourceValue.length === 0) {
    const emptyBit = scope.engine.emptyArrayBits?.get(expr);
    if (emptyBit != null) recordTraceBit(scope.engine, emptyBit);
    return [];
  }

  // Depth protection — prevent infinite nesting
  const childDepth = scope["depth"] + 1;
  if (childDepth > scope.engine.maxDepth) {
    throw new BridgePanicError(
      `Maximum execution depth exceeded (${childDepth}). Check for infinite recursion or circular array mappings.`,
    );
  }

  const results: unknown[] = [];

  // Launch all loop body evaluations concurrently so that batched tool calls
  // accumulate within the same microtask tick before the batch queue flushes.
  const settled = await Promise.allSettled(
    sourceValue.map(async (element) => {
      const elementOutput: Record<string, unknown> = {};
      const childScope = new ExecutionScope(
        scope,
        scope.selfInput,
        elementOutput,
        scope.engine,
        childDepth,
      );
      childScope.pushElement(element);

      // Index then pull — child scope may declare its own tools
      indexStatements(expr.body, childScope);
      const signal = await resolveRequestedFields(
        childScope,
        requestedFields ?? [],
        pullPath,
      );
      return { elementOutput, signal };
    }),
  );

  let propagate:
    | LoopControlSignal
    | typeof BREAK_SYM
    | typeof CONTINUE_SYM
    | undefined;

  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
    const { elementOutput, signal } = result.value;

    if (isLoopControlSignal(signal)) {
      if (signal === CONTINUE_SYM) continue;
      if (signal === BREAK_SYM) break;
      // Multi-level: consume one boundary, propagate rest
      propagate = decrementLoopControl(signal);
      if (signal.__bridgeControl === "break") break;
      continue; // "continue" kind → skip this element
    }

    results.push(elementOutput);
  }

  if (propagate) return propagate;
  return results;
}

/**
 * Evaluate a pipe expression — creates an independent tool call.
 *
 * Each pipe evaluation is a separate, non-memoized tool call.
 * Pipe source goes to `input.in` (default) or `input.<named>` (if path set).
 * ToolDef base wires and bridge input wires are merged in.
 */
async function evaluatePipeExpression(
  expr: Extract<Expression, { type: "pipe" }>,
  scope: ExecutionScope,
  pullPath: ReadonlySet<string> = EMPTY_PULL_PATH,
): Promise<unknown> {
  const pipeKey = `pipe:${expr.handle}`;

  // 1. Cycle check
  if (pullPath.has(pipeKey)) {
    throw new BridgePanicError(
      `Circular dependency detected in pipe "${expr.handle}"`,
    );
  }

  // 2. Branch the path
  const nextPath = new Set(pullPath).add(pipeKey);

  // 3. Evaluate source (use original pullPath — source is outside the pipe)
  const sourceValue = await evaluateExpression(
    expr.source,
    scope,
    undefined,
    pullPath,
  );

  // 4. Look up handle binding
  const binding = scope.getHandleBinding(expr.handle);
  if (!binding)
    throw new Error(`Pipe handle "${expr.handle}" not found in scope`);

  if (binding.kind !== "tool")
    throw new Error(
      `Pipe handle "${expr.handle}" must reference a tool, got "${binding.kind}"`,
    );

  // 5. Resolve ToolDef
  const toolName = binding.name;
  const toolDef = resolveToolDefByName(
    scope.engine.instructions,
    toolName,
    scope.engine.toolDefCache,
  );
  const fnName = toolDef?.fn ?? toolName;
  const fn = lookupToolFn(scope.engine.tools, fnName);
  if (!fn) throw new Error(`No tool found for "${fnName}"`);
  const { doTrace } = resolveToolMeta(fn);

  // 6. Build input
  const input: Record<string, unknown> = {};

  // 6a. ToolDef body wires (base configuration)
  if (toolDef?.body) {
    await evaluateToolDefBody(toolDef.body, input, scope, nextPath);
  }

  // 6b. Bridge wires for this tool (non-pipe input wires)
  const bridgeWires = scope.collectToolInputWiresFor(toolName);
  const bridgeWireGroups = groupWiresByPath(bridgeWires);
  await Promise.all(
    bridgeWireGroups.map(async (group) => {
      const ordered =
        group.length > 1 ? orderOverdefinedWires(group, scope.engine) : group;
      let lastError: unknown;
      for (const wire of ordered) {
        try {
          const value = await evaluateSourceChain(
            wire,
            scope,
            undefined,
            nextPath,
          );
          setPath(input, wire.target.path, value);
          if (value != null) return; // short-circuit: non-nullish wins
          lastError = undefined; // reset — wire succeeded (null)
        } catch (err) {
          if (isFatalError(err) || isLoopControlSignal(err)) throw err;
          lastError = err;
        }
      }
      if (lastError) throw lastError;
    }),
  );

  // 4c. Pipe source → "in" or named field
  const pipePath = expr.path && expr.path.length > 0 ? expr.path : ["in"];
  setPath(input, pipePath, sourceValue);

  // 5. Call tool (not memoized — each pipe is independent)
  if (scope.engine.signal?.aborted) throw new BridgeAbortError();

  const toolContext = {
    logger: scope.engine.logger,
    signal: scope.engine.signal,
  };
  const timeoutMs = scope.engine.toolTimeoutMs;
  const startMs = performance.now();
  try {
    let result: unknown = fn(input, toolContext);
    if (isPromise(result)) {
      if (timeoutMs > 0) {
        result = await raceTimeout(
          result as Promise<unknown>,
          timeoutMs,
          toolName,
        );
      } else {
        result = await result;
      }
    }
    const durationMs = performance.now() - startMs;

    if (scope.engine.tracer && doTrace) {
      scope.engine.tracer.record(
        scope.engine.tracer.entry({
          tool: toolName,
          fn: fnName,
          input,
          output: result,
          durationMs,
          startedAt: scope.engine.tracer.now() - durationMs,
        }),
      );
    }

    return result;
  } catch (err) {
    if (
      scope.engine.signal?.aborted &&
      err instanceof DOMException &&
      err.name === "AbortError"
    ) {
      throw new BridgeAbortError();
    }

    const durationMs = performance.now() - startMs;

    if (scope.engine.tracer && doTrace) {
      scope.engine.tracer.record(
        scope.engine.tracer.entry({
          tool: toolName,
          fn: fnName,
          input,
          error: (err as Error).message,
          durationMs,
          startedAt: scope.engine.tracer.now() - durationMs,
        }),
      );
    }

    if (isFatalError(err)) throw err;

    if (toolDef?.onError) {
      if ("value" in toolDef.onError) return JSON.parse(toolDef.onError.value);
    }

    throw err;
  }
}

/**
 * Resolve a NodeRef to its value.
 */
async function resolveRef(
  ref: NodeRef,
  scope: ExecutionScope,
  bridgeLoc?: SourceLocation,
  pullPath: ReadonlySet<string> = EMPTY_PULL_PATH,
  requestedFields?: string[],
): Promise<unknown> {
  // Element reference — reading from array iterator binding
  if (ref.element) {
    const depth = ref.elementDepth ?? 0;
    const elementData = scope.getElement(depth);
    return getPath(elementData, ref.path, ref.rootSafe, ref.pathSafe);
  }

  // Alias reference — lazy evaluation with caching
  if (ref.module === SELF_MODULE && ref.type === "__local") {
    const aliasResult = await scope.resolveAlias(
      ref.field,
      evaluateSourceChain,
      pullPath,
    );
    return getPath(aliasResult, ref.path, ref.rootSafe, ref.pathSafe);
  }

  // Context reference — reading from engine-supplied context
  if (ref.type === "Context") {
    return getPath(scope.engine.context, ref.path, ref.rootSafe, ref.pathSafe);
  }

  // Const reference — reading from const definitions
  if (ref.type === "Const") {
    return resolveConst(ref, scope);
  }

  // Define reference — resolve define subgraph
  if (ref.module.startsWith("__define_")) {
    // Thread requestedFields as subFields so the define scope can skip tools
    // that feed fields the caller doesn't need (lazy define evaluation).
    //
    // When ref.path is non-empty we are reading a specific output field of the
    // define (e.g. `en.enriched`). The define only needs to resolve that one
    // field — pass it as the subfield. We must NOT forward the caller's
    // requestedFields here because those describe sub-fields of the define's
    // eventual output value, not output field names within the define block
    // itself.
    //
    // When ref.path is empty we are reading the define's entire output (or a
    // caller-specified subset). Forward the caller's requestedFields directly
    // so the define can skip unneeded output wires.
    const defineSubFields =
      ref.path.length > 0
        ? [ref.path[0]!]
        : requestedFields && requestedFields.length > 0
          ? requestedFields
          : undefined;
    const result = await scope.resolveDefine(
      ref.module,
      ref.field,
      ref.instance,
      pullPath,
      defineSubFields,
    );
    return getPath(result, ref.path, ref.rootSafe, ref.pathSafe);
  }

  // Self-module input reference — reading from input args.
  // For define scopes with lazy input wires, resolve on first access.
  if (ref.module === SELF_MODULE && ref.instance == null) {
    const pathKey = ref.path.join(".");
    const lazyExact = scope.resolveLazyInput(pathKey);
    if (lazyExact !== undefined) {
      await lazyExact;
      return getPath(scope.selfInput, ref.path, ref.rootSafe, ref.pathSafe);
    }
    // Check if a parent path has a lazy wire (e.g. reading "a.b" when "a" is
    // lazy, or reading "a" when the whole input "" is lazy — passthrough bridges)
    for (let len = ref.path.length - 1; len >= 0; len--) {
      const parentKey = ref.path.slice(0, len).join(".");
      const lazyParent = scope.resolveLazyInput(parentKey);
      if (lazyParent !== undefined) {
        await lazyParent;
        return getPath(scope.selfInput, ref.path, ref.rootSafe, ref.pathSafe);
      }
    }
    return getPath(scope.selfInput, ref.path, ref.rootSafe, ref.pathSafe);
  }

  // Tool reference — reading from a tool's output (triggers lazy call)
  const toolResult = await scope.resolveToolResult(
    ref.module,
    ref.field,
    ref.instance,
    bridgeLoc,
    pullPath,
  );
  return getPath(toolResult, ref.path, ref.rootSafe, ref.pathSafe);
}

/**
 * Resolve a const reference — looks up the ConstDef by name and traverses path.
 */
function resolveConst(ref: NodeRef, scope: ExecutionScope): unknown {
  if (!ref.path.length) return undefined;

  const constName = ref.path[0]!;
  const constDef = scope.engine.instructions.find(
    (i): i is ConstDef => i.kind === "const" && i.name === constName,
  );
  if (!constDef) throw new Error(`Const "${constName}" not found`);

  const parsed: unknown = JSON.parse(constDef.value);
  const remaining = ref.path.slice(1);
  const remainingPathSafe = ref.pathSafe?.slice(1);
  return getPath(parsed, remaining, ref.rootSafe, remainingPathSafe);
}

/**
 * Write a value to the target output location.
 *
 * Element wires write to the local scope output (the array element object).
 * Non-element self-module wires write to the root scope output (the top-level
 * GraphQL response), ensuring writes from nested scopes don't get stranded.
 */
function writeTarget(
  target: NodeRef,
  value: unknown,
  scope: ExecutionScope,
): void {
  if (target.element) {
    // Writing to element output (inside array body)
    setPath(scope.output, target.path, value);
  } else if (target.module === SELF_MODULE) {
    // Non-element self write — always targets root output
    setPath(scope.root().output, target.path, value);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Execute a bridge operation using the v3 scope-based engine.
 *
 * Pull-based: tools are only called when their output is first read.
 * Tool input wires are evaluated lazily at that point, not eagerly.
 * Uses `body: Statement[]` directly — no legacy `wires: Wire[]`.
 */
export async function executeBridge<T = unknown>(
  options: ExecuteBridgeOptions,
): Promise<ExecuteBridgeResult<T>> {
  const { document: doc, operation, input = {}, context = {} } = options;

  const parts = operation.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid operation "${operation}" — expected "Type.field" (e.g. "Query.myField")`,
    );
  }

  const [type, field] = parts as [string, string];

  // Find the bridge instruction for this operation
  const bridge = doc.instructions.find(
    (i): i is Bridge =>
      i.kind === "bridge" && i.type === type && i.field === field,
  );
  if (!bridge) {
    throw new Error(`Bridge "${operation}" not found in document`);
  }
  if (!bridge.body) {
    throw new Error(
      `Bridge "${operation}" has no body — v3 engine requires Statement[] body`,
    );
  }

  // Resolve std namespace
  const userTools = options.tools ?? {};
  const { namespace: activeStd } = resolveStd(
    doc.version,
    bundledStd,
    BUNDLED_STD_VERSION,
    userTools,
  );
  const allTools: ToolMap = { std: activeStd, ...userTools };

  // Set up tracer
  const traceLevel = options.trace ?? "off";
  const tracer =
    traceLevel !== "off" ? new TraceCollector(traceLevel) : undefined;

  // Build execution trace maps for traversal tracking
  const { chainBitsMap, emptyArrayBits } = buildBodyTraversalMaps(bridge);
  const traceMask: [bigint] = [0n];

  // Create engine context
  const engine: EngineContext = {
    tools: allTools,
    instructions: doc.instructions,
    type,
    field,
    context,
    logger: options.logger,
    tracer,
    signal: options.signal,
    toolDefCache: new Map(),
    toolTimeoutMs: options.toolTimeoutMs ?? 15_000,
    toolMemoCache: new Map(),
    toolBatchQueues: new Map(),
    maxDepth: options.maxDepth ?? MAX_EXECUTION_DEPTH,
    partialSuccess: options.partialSuccess ?? false,
    traceBits: chainBitsMap,
    emptyArrayBits,
    traceMask,
  };

  // Create root scope and execute
  const output: Record<string, unknown> = {};
  const rootScope = new ExecutionScope(null, input, output, engine);

  // Index: register tool bindings, tool input wires, and output wires
  indexStatements(bridge.body, rootScope);

  // Schedule force statements — run eagerly alongside output resolution
  const forcePromises = executeForced(rootScope);

  // Pull: resolve requested output fields — tool calls happen lazily on demand
  try {
    await Promise.all([
      resolveRequestedFields(rootScope, options.requestedFields ?? []),
      ...forcePromises,
    ]);
  } catch (err) {
    if (isFatalError(err)) {
      // Attach collected traces to fatal errors (abort, panic)
      if (tracer) {
        (err as { traces?: ToolTrace[] }).traces = tracer.traces;
      }
      (err as { executionTraceId?: bigint }).executionTraceId = traceMask[0];
      throw attachBridgeErrorDocumentContext(err, doc);
    }
    // Wrap non-fatal errors in BridgeRuntimeError with traces
    const wrapped = wrapBridgeRuntimeError(err);
    if (tracer) {
      wrapped.traces = tracer.traces;
    }
    wrapped.executionTraceId = traceMask[0];
    throw attachBridgeErrorDocumentContext(wrapped, doc);
  }

  // Extract root value if a wire wrote to the output root with a non-object value
  const data =
    "__rootValue__" in output ? (output.__rootValue__ as T) : (output as T);

  return {
    data,
    traces: tracer?.traces ?? [],
    executionTraceId: traceMask[0],
  };
}
