import { materializeShadows as _materializeShadows } from "./materializeShadows.ts";
import { resolveWires as _resolveWires } from "./resolveWires.ts";
import {
  schedule as _schedule,
  trunkDependsOnElement,
} from "./scheduleTools.ts";
import { internal } from "./tools/index.ts";
import type { ToolTrace } from "./tracing.ts";
import {
  isOtelActive,
  logToolError,
  logToolSuccess,
  recordSpanError,
  resolveToolMeta,
  toolCallCounter,
  toolDurationHistogram,
  toolErrorCounter,
  TraceCollector,
  withSpan,
  withSyncSpan,
} from "./tracing.ts";
import type {
  Logger,
  LoopControlSignal,
  MaybePromise,
  Path,
  TreeContext,
  Trunk,
} from "./tree-types.ts";
import {
  BREAK_SYM,
  BridgeAbortError,
  BridgePanicError,
  wrapBridgeRuntimeError,
  CONTINUE_SYM,
  decrementLoopControl,
  isLoopControlSignal,
  isPromise,
  MAX_EXECUTION_DEPTH,
} from "./tree-types.ts";
import {
  pathEquals,
  roundMs,
  sameTrunk,
  TRUNK_KEY_CACHE,
  trunkKey,
  UNSAFE_KEYS,
} from "./tree-utils.ts";
import type {
  Bridge,
  BridgeDocument,
  Instruction,
  NodeRef,
  ToolContext,
  ToolDef,
  ToolMap,
  Wire,
} from "./types.ts";
import { SELF_MODULE } from "./types.ts";
import {
  filterOutputFields,
  matchesRequestedFields,
} from "./requested-fields.ts";
import { raceTimeout } from "./utils.ts";

function stableMemoizeKey(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableMemoizeKey(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableMemoizeKey(entryValue)}`,
    )
    .join(",")}}`;
}

export class ExecutionTree implements TreeContext {
  state: Record<string, any> = {};
  bridge: Bridge | undefined;
  source?: string;
  filename?: string;
  /**
   * Cache for resolved tool dependency promises.
   * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
   */
  toolDepCache: Map<string, Promise<any>> = new Map();
  /**
   * Cache for resolved ToolDef objects (null = not found).
   * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
   */
  toolDefCache: Map<string, ToolDef | null> = new Map();
  /**
   * Pipe fork lookup map — maps fork trunk keys to their base trunk.
   * Public to satisfy `SchedulerContext` — used by `scheduleTools.ts`.
   */
  pipeHandleMap:
    | Map<string, NonNullable<Bridge["pipeHandles"]>[number]>
    | undefined;
  /**
   * Maps trunk keys to `@version` strings from handle bindings.
   * Populated in the constructor so `schedule()` can prefer versioned
   * tool lookups (e.g. `std.str.toLowerCase@999.1`) over the default.
   * Public to satisfy `SchedulerContext` — used by `scheduleTools.ts`.
   */
  handleVersionMap: Map<string, string> = new Map();
  /** Tool trunks marked with `memoize`. Shared with shadow trees. */
  memoizedToolKeys: Set<string> = new Set();
  /** Per-tool memoization caches keyed by stable input fingerprints. */
  private toolMemoCache: Map<string, Map<string, MaybePromise<any>>> =
    new Map();
  /** Promise that resolves when all critical `force` handles have settled. */
  private forcedExecution?: Promise<void>;
  /** Shared trace collector — present only when tracing is enabled. */
  tracer?: TraceCollector;
  /** Structured logger passed from BridgeOptions. Defaults to no-ops. */
  logger?: Logger;
  /** External abort signal — cancels execution when triggered. */
  signal?: AbortSignal;
  /**
   * Hard timeout for tool calls in milliseconds.
   * When set, tool calls that exceed this duration throw a `BridgeTimeoutError`.
   * Default: 15_000 (15 seconds). Set to `0` to disable.
   */
  toolTimeoutMs: number = 15_000;
  /**
   * Maximum shadow-tree nesting depth.
   * Overrides `MAX_EXECUTION_DEPTH` when set.
   * Default: `MAX_EXECUTION_DEPTH` (30).
   */
  maxDepth: number = MAX_EXECUTION_DEPTH;
  /**
   * Registered tool function map.
   * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
   */
  toolFns?: ToolMap;
  /** Shadow-tree nesting depth (0 for root). */
  private depth: number;
  /** Pre-computed `trunkKey({ ...this.trunk, element: true })`.  See docs/performance.md (#4). */
  private elementTrunkKey: string;
  /** Sparse fieldset filter — set by `run()` when requestedFields is provided. */
  requestedFields: string[] | undefined;

  constructor(
    public trunk: Trunk,
    private document: BridgeDocument,
    toolFns?: ToolMap,
    /**
     * User-supplied context object.
     * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
     */
    public context?: Record<string, any>,
    /**
     * Parent tree (shadow-tree nesting).
     * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
     */
    public parent?: ExecutionTree,
  ) {
    this.depth = parent ? parent.depth + 1 : 0;
    if (this.depth > MAX_EXECUTION_DEPTH) {
      throw new BridgePanicError(
        `Maximum execution depth exceeded (${this.depth}) at ${trunkKey(trunk)}. Check for infinite recursion or circular array mappings.`,
      );
    }
    this.elementTrunkKey = `${trunk.module}:${trunk.type}:${trunk.field}:*`;
    this.toolFns = { internal, ...(toolFns ?? {}) };
    const instructions = document.instructions;
    this.bridge = instructions.find(
      (i): i is Bridge =>
        i.kind === "bridge" && i.type === trunk.type && i.field === trunk.field,
    );
    if (this.bridge?.pipeHandles) {
      this.pipeHandleMap = new Map(
        this.bridge.pipeHandles.map((ph) => [ph.key, ph]),
      );
    }
    // Build handle→version map from bridge handle bindings
    if (this.bridge) {
      const instanceCounters = new Map<string, number>();
      for (const h of this.bridge.handles) {
        if (h.kind !== "tool") continue;
        const name = h.name;
        const lastDot = name.lastIndexOf(".");
        let module: string, field: string, counterKey: string, type: string;
        if (lastDot !== -1) {
          module = name.substring(0, lastDot);
          field = name.substring(lastDot + 1);
          counterKey = `${module}:${field}`;
          type = this.trunk.type;
        } else {
          module = SELF_MODULE;
          field = name;
          counterKey = `Tools:${name}`;
          type = "Tools";
        }
        const instance = (instanceCounters.get(counterKey) ?? 0) + 1;
        instanceCounters.set(counterKey, instance);
        const key = trunkKey({ module, type, field, instance });
        if (h.version) {
          this.handleVersionMap.set(key, h.version);
        }
        if (h.memoize) {
          this.memoizedToolKeys.add(key);
        }
      }
    }
    if (context) {
      this.state[
        trunkKey({ module: SELF_MODULE, type: "Context", field: "context" })
      ] = context;
    }
    // Collect const definitions into a single namespace object
    const constObj: Record<string, any> = {};
    for (const inst of instructions) {
      if (inst.kind === "const") {
        constObj[inst.name] = JSON.parse(inst.value);
      }
    }
    if (Object.keys(constObj).length > 0) {
      this.state[
        trunkKey({ module: SELF_MODULE, type: "Const", field: "const" })
      ] = constObj;
    }
  }

  /**
   * Accessor for the document's instruction list.
   * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
   */
  get instructions(): readonly Instruction[] {
    return this.document.instructions;
  }

  /** Schedule resolution for a target trunk — delegates to `scheduleTools.ts`. */
  schedule(target: Trunk, pullChain?: Set<string>): MaybePromise<any> {
    return _schedule(this, target, pullChain);
  }

  /**
   * Invoke a tool function, recording both an OpenTelemetry span and (when
   * tracing is enabled) a ToolTrace entry.  All tool-call sites in the
   * engine delegate here so instrumentation lives in exactly one place.
   *
   * Public to satisfy `ToolLookupContext` — called by `toolLookup.ts`.
   */
  callTool(
    toolName: string,
    fnName: string,
    fnImpl: (...args: any[]) => any,
    input: Record<string, any>,
    memoizeKey?: string,
  ): MaybePromise<any> {
    if (memoizeKey) {
      const cacheKey = stableMemoizeKey(input);
      let toolCache = this.toolMemoCache.get(memoizeKey);
      if (!toolCache) {
        toolCache = new Map();
        this.toolMemoCache.set(memoizeKey, toolCache);
      }

      const cached = toolCache.get(cacheKey);
      if (cached !== undefined) return cached;

      try {
        const result = this.callTool(toolName, fnName, fnImpl, input);
        if (isPromise(result)) {
          const pending = Promise.resolve(result).catch((error) => {
            toolCache.delete(cacheKey);
            throw error;
          });
          toolCache.set(cacheKey, pending);
          return pending;
        }
        toolCache.set(cacheKey, result);
        return result;
      } catch (error) {
        toolCache.delete(cacheKey);
        throw error;
      }
    }

    // Short-circuit before starting if externally aborted
    if (this.signal?.aborted) {
      throw new BridgeAbortError();
    }
    const tracer = this.tracer;
    const logger = this.logger;
    const toolContext: ToolContext = {
      logger: logger ?? {},
      signal: this.signal,
    };

    const timeoutMs = this.toolTimeoutMs;
    const { sync: isSyncTool, doTrace, log } = resolveToolMeta(fnImpl);

    // ── Fast path: no instrumentation configured ──────────────────
    // When there is no internal tracer, no logger, and OpenTelemetry
    // has its default no-op provider, skip all instrumentation to
    // avoid closure allocation, template-string building, and no-op
    // metric calls.  See docs/performance.md (#5).
    if (!tracer && !logger && !isOtelActive()) {
      try {
        const result = fnImpl(input, toolContext);
        if (isSyncTool) {
          if (isPromise(result)) {
            throw new Error(
              `Tool "${fnName}" declared {sync:true} but returned a Promise`,
            );
          }
          return result;
        }
        if (timeoutMs > 0 && isPromise(result)) {
          return raceTimeout(result, timeoutMs, toolName);
        }
        return result;
      } catch (err) {
        // Normalize platform AbortError to BridgeAbortError
        if (
          this.signal?.aborted &&
          err instanceof DOMException &&
          err.name === "AbortError"
        ) {
          throw new BridgeAbortError();
        }
        throw err;
      }
    }

    // ── Instrumented path ─────────────────────────────────────────
    const traceStart = tracer?.now();
    const metricAttrs = {
      "bridge.tool.name": toolName,
      "bridge.tool.fn": fnName,
    };

    // ── Sync-optimised instrumented path ─────────────────────────
    // When the tool declares {sync: true}, use withSyncSpan to avoid
    // returning a Promise while still honouring OTel trace metadata.
    if (isSyncTool) {
      return withSyncSpan(
        doTrace,
        `bridge.tool.${toolName}.${fnName}`,
        metricAttrs,
        (span) => {
          const wallStart = performance.now();
          try {
            const result = fnImpl(input, toolContext);
            if (isPromise(result)) {
              throw new Error(
                `Tool "${fnName}" declared {sync:true} but returned a Promise`,
              );
            }
            const durationMs = roundMs(performance.now() - wallStart);
            toolCallCounter.add(1, metricAttrs);
            toolDurationHistogram.record(durationMs, metricAttrs);
            if (tracer && traceStart != null) {
              tracer.record(
                tracer.entry({
                  tool: toolName,
                  fn: fnName,
                  input,
                  output: result,
                  durationMs: roundMs(tracer.now() - traceStart),
                  startedAt: traceStart,
                }),
              );
            }
            logToolSuccess(logger, log.execution, toolName, fnName, durationMs);
            return result;
          } catch (err) {
            const durationMs = roundMs(performance.now() - wallStart);
            toolCallCounter.add(1, metricAttrs);
            toolDurationHistogram.record(durationMs, metricAttrs);
            toolErrorCounter.add(1, metricAttrs);
            if (tracer && traceStart != null) {
              tracer.record(
                tracer.entry({
                  tool: toolName,
                  fn: fnName,
                  input,
                  error: (err as Error).message,
                  durationMs: roundMs(tracer.now() - traceStart),
                  startedAt: traceStart,
                }),
              );
            }
            recordSpanError(span, err as Error);
            logToolError(logger, log.errors, toolName, fnName, err as Error);
            // Normalize platform AbortError to BridgeAbortError
            if (
              this.signal?.aborted &&
              err instanceof DOMException &&
              err.name === "AbortError"
            ) {
              throw new BridgeAbortError();
            }
            throw err;
          } finally {
            span?.end();
          }
        },
      );
    }

    return withSpan(
      doTrace,
      `bridge.tool.${toolName}.${fnName}`,
      metricAttrs,
      async (span) => {
        const wallStart = performance.now();
        try {
          const toolPromise = fnImpl(input, toolContext);
          const result =
            timeoutMs > 0 && isPromise(toolPromise)
              ? await raceTimeout(toolPromise, timeoutMs, toolName)
              : await toolPromise;
          const durationMs = roundMs(performance.now() - wallStart);
          toolCallCounter.add(1, metricAttrs);
          toolDurationHistogram.record(durationMs, metricAttrs);
          if (tracer && traceStart != null) {
            tracer.record(
              tracer.entry({
                tool: toolName,
                fn: fnName,
                input,
                output: result,
                durationMs: roundMs(tracer.now() - traceStart),
                startedAt: traceStart,
              }),
            );
          }
          logToolSuccess(logger, log.execution, toolName, fnName, durationMs);
          return result;
        } catch (err) {
          const durationMs = roundMs(performance.now() - wallStart);
          toolCallCounter.add(1, metricAttrs);
          toolDurationHistogram.record(durationMs, metricAttrs);
          toolErrorCounter.add(1, metricAttrs);
          if (tracer && traceStart != null) {
            tracer.record(
              tracer.entry({
                tool: toolName,
                fn: fnName,
                input,
                error: (err as Error).message,
                durationMs: roundMs(tracer.now() - traceStart),
                startedAt: traceStart,
              }),
            );
          }
          recordSpanError(span, err as Error);
          logToolError(logger, log.errors, toolName, fnName, err as Error);
          // Normalize platform AbortError to BridgeAbortError
          if (
            this.signal?.aborted &&
            err instanceof DOMException &&
            err.name === "AbortError"
          ) {
            throw new BridgeAbortError();
          }
          throw err;
        } finally {
          span?.end();
        }
      },
    );
  }

  shadow(): ExecutionTree {
    // Lightweight: bypass the constructor to avoid redundant work that
    // re-derives data identical to the parent (bridge lookup, pipeHandleMap,
    // handleVersionMap, constObj, toolFns spread).  See docs/performance.md (#2).
    const child = Object.create(ExecutionTree.prototype) as ExecutionTree;
    child.trunk = this.trunk;
    child.document = this.document;
    child.parent = this;
    child.depth = this.depth + 1;
    child.maxDepth = this.maxDepth;
    child.toolTimeoutMs = this.toolTimeoutMs;
    if (child.depth > child.maxDepth) {
      throw new BridgePanicError(
        `Maximum execution depth exceeded (${child.depth}) at ${trunkKey(this.trunk)}. Check for infinite recursion or circular array mappings.`,
      );
    }
    child.state = {};
    child.toolDepCache = new Map();
    child.toolDefCache = new Map();
    // Share read-only pre-computed data from parent
    child.bridge = this.bridge;
    child.pipeHandleMap = this.pipeHandleMap;
    child.handleVersionMap = this.handleVersionMap;
    child.memoizedToolKeys = this.memoizedToolKeys;
    child.toolMemoCache = this.toolMemoCache;
    child.toolFns = this.toolFns;
    child.elementTrunkKey = this.elementTrunkKey;
    child.tracer = this.tracer;
    child.logger = this.logger;
    child.signal = this.signal;
    child.source = this.source;
    child.filename = this.filename;
    return child;
  }

  /**
   * Wrap raw array items into shadow trees, honouring `break` / `continue`
   * sentinels.  Shared by `pullOutputField`, `response`, and `run`.
   */
  private createShadowArray(items: any[]): ExecutionTree[] {
    const shadows: ExecutionTree[] = [];
    for (const item of items) {
      // Abort discipline — yield immediately if client disconnected
      if (this.signal?.aborted) {
        throw new BridgeAbortError();
      }
      if (isLoopControlSignal(item)) {
        const ctrl = decrementLoopControl(item);
        if (ctrl === BREAK_SYM) break;
        if (ctrl === CONTINUE_SYM) continue;
      }
      const s = this.shadow();
      s.state[this.elementTrunkKey] = item;
      shadows.push(s);
    }
    return shadows;
  }

  /** Returns collected traces (empty array when tracing is disabled). */
  getTraces(): ToolTrace[] {
    return this.tracer?.traces ?? [];
  }

  /**
   * Traverse `ref.path` on an already-resolved value, respecting null guards.
   * Extracted from `pullSingle` so the sync and async paths can share logic.
   */
  private applyPath(resolved: any, ref: NodeRef, bridgeLoc?: Wire["loc"]): any {
    if (!ref.path.length) return resolved;

    let result: any = resolved;

    for (let i = 0; i < ref.path.length; i++) {
      const segment = ref.path[i]!;
      const accessSafe =
        ref.pathSafe?.[i] ?? (i === 0 ? (ref.rootSafe ?? false) : false);

      if (result == null) {
        if ((i === 0 && ref.element) || accessSafe) {
          result = undefined;
          continue;
        }
        throw wrapBridgeRuntimeError(
          new TypeError(
            `Cannot read properties of ${result} (reading '${segment}')`,
          ),
          {
            bridgeLoc,
            bridgeSource: this.source,
            bridgeFilename: this.filename,
          },
        );
      }

      if (UNSAFE_KEYS.has(segment))
        throw new Error(`Unsafe property traversal: ${segment}`);
      if (Array.isArray(result) && !/^\d+$/.test(segment)) {
        this.logger?.warn?.(
          `[bridge] Accessing ".${segment}" on an array (${result.length} items) — did you mean to use pickFirst or array mapping? Source: ${trunkKey(ref)}.${ref.path.join(".")}`,
        );
      }
      const next = result[segment];
      const isPrimitiveBase =
        result !== null &&
        typeof result !== "object" &&
        typeof result !== "function";
      if (isPrimitiveBase && next === undefined) {
        throw wrapBridgeRuntimeError(
          new TypeError(
            `Cannot read properties of ${result} (reading '${segment}')`,
          ),
          {
            bridgeLoc,
            bridgeSource: this.source,
            bridgeFilename: this.filename,
          },
        );
      }
      result = next;
    }
    return result;
  }

  /**
   * Pull a single value.  Returns synchronously when already in state;
   * returns a Promise only when the value is a pending tool call.
   * See docs/performance.md (#10).
   *
   * Public to satisfy `TreeContext` — extracted modules call this via
   * the interface.
   */
  pullSingle(
    ref: NodeRef,
    pullChain: Set<string> = new Set(),
    bridgeLoc?: Wire["loc"],
  ): MaybePromise<any> {
    // Cache trunkKey on the NodeRef via a Symbol key to avoid repeated
    // string allocation.  Symbol keys don't affect V8 hidden classes,
    // so this won't degrade parser allocation-site throughput.
    // See docs/performance.md (#11).
    const key: string = ((ref as any)[TRUNK_KEY_CACHE] ??= trunkKey(ref));

    // ── Cycle detection ─────────────────────────────────────────────
    if (pullChain.has(key)) {
      throw new BridgePanicError(
        `Circular dependency detected: "${key}" depends on itself`,
      );
    }

    // Shadow trees must share cached values for refs that do not depend on the
    // current element. Otherwise top-level aliases/tools reused inside arrays
    // are recomputed once per element instead of being memoized at the parent.
    if (this.parent && !ref.element && !this.isElementScopedTrunk(ref)) {
      return this.parent.pullSingle(ref, pullChain);
    }

    // Walk the full parent chain — shadow trees may be nested multiple levels
    let value: any = undefined;
    let cursor: ExecutionTree | undefined = this;
    if (ref.element && ref.elementDepth && ref.elementDepth > 0) {
      let remaining = ref.elementDepth;
      while (remaining > 0 && cursor) {
        cursor = cursor.parent;
        remaining--;
      }
    }
    while (cursor && value === undefined) {
      value = cursor.state[key];
      cursor = cursor.parent;
    }

    if (value === undefined) {
      const nextChain = new Set(pullChain).add(key);

      // ── Lazy define field resolution ────────────────────────────────
      // For define trunks (__define_in_* / __define_out_*) with a specific
      // field path, resolve ONLY the wire(s) targeting that field instead
      // of scheduling the entire trunk.  This avoids triggering unrelated
      // dependency chains (e.g. requesting "city" should not fire the
      // lat/lon coalesce chains that call the geo tool).
      if (ref.path.length > 0 && ref.module.startsWith("__define_")) {
        const fieldWires =
          this.bridge?.wires.filter(
            (w) => sameTrunk(w.to, ref) && pathEquals(w.to.path, ref.path),
          ) ?? [];
        if (fieldWires.length > 0) {
          // resolveWires already delivers the value at ref.path — no applyPath.
          return this.resolveWires(fieldWires, nextChain);
        }
      }

      this.state[key] = this.schedule(ref, nextChain);
      value = this.state[key]; // sync value or Promise (see #12)
    }

    // Sync fast path: value is already resolved (not a pending Promise).
    if (!isPromise(value)) {
      return this.applyPath(value, ref, bridgeLoc);
    }

    // Async: chain path traversal onto the pending promise.
    return (value as Promise<any>).then((resolved: any) =>
      this.applyPath(resolved, ref, bridgeLoc),
    );
  }

  push(args: Record<string, any>) {
    this.state[trunkKey(this.trunk)] = args;
  }

  /** Store the aggregated promise for critical forced handles so
   *  `response()` can await it exactly once per bridge execution. */
  setForcedExecution(p: Promise<void>): void {
    this.forcedExecution = p;
  }

  /** Return the critical forced-execution promise (if any). */
  getForcedExecution(): Promise<void> | undefined {
    return this.forcedExecution;
  }

  /**
   * Eagerly schedule tools targeted by `force <handle>` statements.
   *
   * Returns an array of promises for **critical** forced handles (those
   * without `?? null`).  Fire-and-forget handles (`catchError: true`) are
   * scheduled but their errors are silently suppressed.
   *
   * Callers must `await Promise.all(...)` the returned promises so that a
   * critical force failure propagates as a standard error.
   */
  executeForced(): Promise<any>[] {
    const forces = this.bridge?.forces;
    if (!forces || forces.length === 0) return [];

    const critical: Promise<any>[] = [];
    const scheduled = new Set<string>();
    for (const f of forces) {
      const trunk: Trunk = {
        module: f.module,
        type: f.type,
        field: f.field,
        instance: f.instance,
      };
      const key = trunkKey(trunk);
      if (scheduled.has(key) || this.state[key] !== undefined) continue;
      scheduled.add(key);
      this.state[key] = this.schedule(trunk);

      if (f.catchError) {
        // Fire-and-forget: suppress unhandled rejection.
        Promise.resolve(this.state[key]).catch(() => {});
      } else {
        // Critical: caller must await and let failure propagate.
        critical.push(Promise.resolve(this.state[key]));
      }
    }
    return critical;
  }

  /**
   * Resolve a set of matched wires — delegates to the extracted
   * `resolveWires` module.  See `resolveWires.ts` for the full
   * architecture comment (modifier layers, overdefinition, etc.).
   *
   * Public to satisfy `SchedulerContext` — used by `scheduleTools.ts`.
   */
  resolveWires(wires: Wire[], pullChain?: Set<string>): MaybePromise<any> {
    return _resolveWires(this, wires, pullChain);
  }

  /**
   * Resolve an output field by path for use outside of a GraphQL resolver.
   *
   * This is the non-GraphQL equivalent of what `response()` does per field:
   * it finds all wires targeting `this.trunk` at `path` and resolves them.
   *
   * Used by `executeBridge()` so standalone bridge execution does not need to
   * fabricate GraphQL Path objects to pull output data.
   *
   * @param path - Output field path, e.g. `["lat"]`. Pass `[]` for whole-output
   *               array bridges (`o <- items[] as x { ... }`).
   * @param array - When `true` and the result is an array, wraps each element
   *               in a shadow tree (mirrors `response()` array handling).
   */
  async pullOutputField(path: string[], array = false): Promise<unknown> {
    const matches =
      this.bridge?.wires.filter(
        (w) => sameTrunk(w.to, this.trunk) && pathEquals(w.to.path, path),
      ) ?? [];
    if (matches.length === 0) return undefined;
    const result = this.resolveWires(matches);
    if (!array) return result;
    const resolved = await result;
    if (isLoopControlSignal(resolved)) return [];
    return this.createShadowArray(resolved as any[]);
  }

  private isElementScopedTrunk(ref: NodeRef): boolean {
    return trunkDependsOnElement(this.bridge, {
      module: ref.module,
      type: ref.type,
      field: ref.field,
      instance: ref.instance,
    });
  }

  /**
   * Resolve pre-grouped wires on this shadow tree without re-filtering.
   * Called by the parent's `materializeShadows` to skip per-element wire
   * filtering.  Returns synchronously when the wire resolves sync (hot path).
   * See docs/performance.md (#8, #10).
   */
  resolvePreGrouped(wires: Wire[]): MaybePromise<unknown> {
    return this.resolveWires(wires);
  }

  /**
   * Recursively resolve an output field at `prefix` — either via exact-match
   * wires (leaf) or by collecting sub-fields from deeper wires (nested object).
   *
   * Shared by `collectOutput()` and `run()`.
   */
  private async resolveNestedField(prefix: string[]): Promise<unknown> {
    const bridge = this.bridge!;
    const { type, field } = this.trunk;

    const exactWires = bridge.wires.filter(
      (w) =>
        w.to.module === SELF_MODULE &&
        w.to.type === type &&
        w.to.field === field &&
        pathEquals(w.to.path, prefix),
    );

    // Separate spread wires from regular wires
    const spreadWires = exactWires.filter(
      (w) => "from" in w && "spread" in w && w.spread,
    );
    const regularWires = exactWires.filter(
      (w) => !("from" in w && "spread" in w && w.spread),
    );

    if (regularWires.length > 0) {
      // Check for array mapping: exact wires (the array source) PLUS
      // element-level wires deeper than prefix (the field mappings).
      // E.g. `o.entries <- src[] as x { .id <- x.item_id }` produces
      // an exact wire at ["entries"] and element wires at ["entries","id"].
      const hasElementWires = bridge.wires.some(
        (w) =>
          "from" in w &&
          ((w.from as NodeRef).element === true ||
            this.isElementScopedTrunk(w.from as NodeRef) ||
            w.to.element === true) &&
          w.to.module === SELF_MODULE &&
          w.to.type === type &&
          w.to.field === field &&
          w.to.path.length > prefix.length &&
          prefix.every((seg, i) => w.to.path[i] === seg),
      );

      if (hasElementWires) {
        // Array mapping on a sub-field: resolve the array source,
        // create shadow trees, and materialise with field mappings.
        const resolved = await this.resolveWires(regularWires);
        if (!Array.isArray(resolved)) return null;
        const shadows = this.createShadowArray(resolved);
        return this.materializeShadows(shadows, prefix);
      }

      return this.resolveWires(regularWires);
    }

    // Collect sub-fields from deeper wires
    const subFields = new Set<string>();
    for (const wire of bridge.wires) {
      const p = wire.to.path;
      if (
        wire.to.module === SELF_MODULE &&
        wire.to.type === type &&
        wire.to.field === field &&
        p.length > prefix.length &&
        prefix.every((seg, i) => p[i] === seg)
      ) {
        subFields.add(p[prefix.length]!);
      }
    }

    // Spread wires: resolve and merge, then overlay sub-field wires
    if (spreadWires.length > 0) {
      const result: Record<string, unknown> = {};

      // First resolve spread sources (in order)
      for (const wire of spreadWires) {
        const spreadValue = await this.resolveWires([wire]);
        if (spreadValue != null && typeof spreadValue === "object") {
          Object.assign(result, spreadValue);
        }
      }

      // Then resolve sub-fields and overlay on spread result
      const prefixStr = prefix.join(".");
      const activeSubFields = this.requestedFields
        ? [...subFields].filter((sub) => {
            const fullPath = prefixStr ? `${prefixStr}.${sub}` : sub;
            return matchesRequestedFields(fullPath, this.requestedFields);
          })
        : [...subFields];

      await Promise.all(
        activeSubFields.map(async (sub) => {
          result[sub] = await this.resolveNestedField([...prefix, sub]);
        }),
      );

      return result;
    }

    if (subFields.size === 0) return undefined;

    // Apply sparse fieldset filter at nested level
    const prefixStr = prefix.join(".");
    const activeSubFields = this.requestedFields
      ? [...subFields].filter((sub) => {
          const fullPath = prefixStr ? `${prefixStr}.${sub}` : sub;
          return matchesRequestedFields(fullPath, this.requestedFields);
        })
      : [...subFields];
    if (activeSubFields.length === 0) return undefined;

    const obj: Record<string, unknown> = {};
    await Promise.all(
      activeSubFields.map(async (sub) => {
        obj[sub] = await this.resolveNestedField([...prefix, sub]);
      }),
    );
    return obj;
  }

  /**
   * Materialise all output wires into a plain JS object.
   *
   * Used by the GraphQL adapter when a bridge field returns a scalar type
   * (e.g. `JSON`, `JSONObject`). In that case GraphQL won't call sub-field
   * resolvers, so we need to eagerly resolve every output wire and assemble
   * the result ourselves — the same logic `run()` uses for object output.
   */
  async collectOutput(): Promise<unknown> {
    const bridge = this.bridge;
    if (!bridge) return undefined;

    const { type, field } = this.trunk;

    // Shadow tree (array element) — resolve element-level output fields.
    // For scalar arrays ([JSON!]) GraphQL won't call sub-field resolvers,
    // so we eagerly materialise each element here.
    if (this.parent) {
      const outputFields = new Set<string>();
      for (const wire of bridge.wires) {
        if (
          wire.to.module === SELF_MODULE &&
          wire.to.type === type &&
          wire.to.field === field &&
          wire.to.path.length > 0
        ) {
          outputFields.add(wire.to.path[0]!);
        }
      }
      if (outputFields.size > 0) {
        const result: Record<string, unknown> = {};
        await Promise.all(
          [...outputFields].map(async (name) => {
            result[name] = await this.pullOutputField([name]);
          }),
        );
        return result;
      }
      // Passthrough: return stored element data directly
      return this.state[this.elementTrunkKey];
    }

    // Root wire (`o <- src`) — whole-object passthrough
    const hasRootWire = bridge.wires.some(
      (w) =>
        "from" in w &&
        w.to.module === SELF_MODULE &&
        w.to.type === type &&
        w.to.field === field &&
        w.to.path.length === 0,
    );
    if (hasRootWire) {
      return this.pullOutputField([]);
    }

    // Object output — collect unique top-level field names
    const outputFields = new Set<string>();
    for (const wire of bridge.wires) {
      if (
        wire.to.module === SELF_MODULE &&
        wire.to.type === type &&
        wire.to.field === field &&
        wire.to.path.length > 0
      ) {
        outputFields.add(wire.to.path[0]!);
      }
    }

    if (outputFields.size === 0) return undefined;

    const result: Record<string, unknown> = {};

    await Promise.all(
      [...outputFields].map(async (name) => {
        result[name] = await this.resolveNestedField([name]);
      }),
    );
    return result;
  }

  /**
   * Execute the bridge end-to-end without GraphQL.
   *
   * Injects `input` as the trunk arguments, runs forced wires, then pulls
   * and materialises every output field into a plain JS object (or array of
   * objects for array-mapped bridges).
   *
   * When `requestedFields` is provided, only matching output fields are
   * resolved — unneeded tools are never called because the pull-based
   * engine never reaches them.
   *
   * This is the single entry-point used by `executeBridge()`.
   */
  async run(
    input: Record<string, unknown>,
    requestedFields?: string[],
  ): Promise<unknown> {
    const bridge = this.bridge;
    if (!bridge) {
      throw new Error(
        `No bridge definition found for ${this.trunk.type}.${this.trunk.field}`,
      );
    }

    this.push(input);
    this.requestedFields = requestedFields;
    const forcePromises = this.executeForced();

    const { type, field } = this.trunk;

    // Separate root-level wires into passthrough vs spread
    const rootWires = bridge.wires.filter(
      (w) =>
        "from" in w &&
        w.to.module === SELF_MODULE &&
        w.to.type === type &&
        w.to.field === field &&
        w.to.path.length === 0,
    );

    // Passthrough wire: root wire without spread flag
    const hasPassthroughWire = rootWires.some(
      (w) => "from" in w && !("spread" in w && w.spread),
    );

    // Spread wires: root wires with spread flag
    const spreadWires = rootWires.filter(
      (w) => "from" in w && "spread" in w && w.spread,
    );

    const hasRootWire = rootWires.length > 0;

    // Array-mapped output (`o <- items[] as x { ... }`) has BOTH a root wire
    // AND element-level wires (from.element === true).  A plain passthrough
    // (`o <- api.user`) only has the root wire.
    // Pipe fork output wires in element context (e.g. concat template strings)
    // may have to.element === true instead.
    const hasElementWires = bridge.wires.some(
      (w) =>
        "from" in w &&
        ((w.from as NodeRef).element === true ||
          this.isElementScopedTrunk(w.from as NodeRef) ||
          w.to.element === true) &&
        w.to.module === SELF_MODULE &&
        w.to.type === type &&
        w.to.field === field,
    );

    if (hasRootWire && hasElementWires) {
      const [shadows] = await Promise.all([
        this.pullOutputField([], true) as Promise<ExecutionTree[]>,
        ...forcePromises,
      ]);
      return this.materializeShadows(shadows, []);
    }

    // Whole-object passthrough: `o <- api.user` (non-spread root wire)
    if (hasPassthroughWire) {
      const [result] = await Promise.all([
        this.pullOutputField([]),
        ...forcePromises,
      ]);
      return result;
    }

    // Object output — collect unique top-level field names
    const outputFields = new Set<string>();
    for (const wire of bridge.wires) {
      if (
        wire.to.module === SELF_MODULE &&
        wire.to.type === type &&
        wire.to.field === field &&
        wire.to.path.length > 0
      ) {
        outputFields.add(wire.to.path[0]!);
      }
    }

    // Spread wires: resolve and merge source objects
    // Later field wires will override spread properties
    const hasSpreadWires = spreadWires.length > 0;

    if (outputFields.size === 0 && !hasSpreadWires) {
      throw new Error(
        `Bridge "${type}.${field}" has no output wires. ` +
          `Ensure at least one wire targets the output (e.g. \`o.field <- ...\`).`,
      );
    }

    // Apply sparse fieldset filter
    const activeFields = filterOutputFields(outputFields, requestedFields);

    const result: Record<string, unknown> = {};

    // First resolve spread wires (in order) to build base object
    // Each spread source's properties are merged into result
    for (const wire of spreadWires) {
      const spreadValue = await this.resolveWires([wire]);
      if (spreadValue != null && typeof spreadValue === "object") {
        Object.assign(result, spreadValue);
      }
    }

    // Then resolve explicit field wires - these override spread properties
    await Promise.all([
      ...[...activeFields].map(async (name) => {
        result[name] = await this.resolveNestedField([name]);
      }),
      ...forcePromises,
    ]);
    return result;
  }

  /**
   * Recursively convert shadow trees into plain JS objects —
   * delegates to `materializeShadows.ts`.
   */
  private materializeShadows(
    items: ExecutionTree[],
    pathPrefix: string[],
  ): Promise<unknown[] | LoopControlSignal> {
    return _materializeShadows(this, items, pathPrefix);
  }

  async response(ipath: Path, array: boolean): Promise<any> {
    // Build path segments from GraphQL resolver info
    const pathSegments: string[] = [];
    let index = ipath;
    while (index.prev) {
      pathSegments.unshift(`${index.key}`);
      index = index.prev;
    }

    if (pathSegments.length === 0) {
      // Direct output for scalar/list return types (e.g. [String!])
      const directOutput =
        this.bridge?.wires.filter(
          (w) =>
            sameTrunk(w.to, this.trunk) &&
            w.to.path.length === 1 &&
            w.to.path[0] === this.trunk.field,
        ) ?? [];
      if (directOutput.length > 0) {
        return this.resolveWires(directOutput);
      }
    }

    // Strip numeric indices (array positions) from path for wire matching
    const cleanPath = pathSegments.filter((p) => !/^\d+$/.test(p));

    // Find wires whose target matches this trunk + path
    const matches =
      this.bridge?.wires.filter(
        (w) =>
          (w.to.element ? !!this.parent : true) &&
          sameTrunk(w.to, this.trunk) &&
          pathEquals(w.to.path, cleanPath),
      ) ?? [];

    if (matches.length > 0) {
      // ── Lazy define resolution ──────────────────────────────────────
      // When ALL matches at the root object level (path=[]) are
      // whole-object wires sourced from define output modules, defer
      // resolution to field-by-field GraphQL traversal.  This avoids
      // eagerly scheduling every tool inside the define block — only
      // fields actually requested by the query will trigger their
      // dependency chains.
      if (
        cleanPath.length === 0 &&
        !array &&
        matches.every(
          (w): boolean =>
            "from" in w &&
            w.from.module.startsWith("__define_out_") &&
            w.from.path.length === 0,
        )
      ) {
        return this;
      }

      const response = this.resolveWires(matches);

      if (!array) {
        return response;
      }

      // Array: create shadow trees for per-element resolution
      const resolved = await response;
      if (isLoopControlSignal(resolved)) return [];
      return this.createShadowArray(resolved as any[]);
    }

    // ── Resolve field from deferred define ────────────────────────────
    // No direct wires for this field path — check whether a define
    // forward wire exists at the root level (`o <- defineHandle`) and
    // resolve only the matching field wire from the define's output.
    if (cleanPath.length > 0) {
      const defineFieldWires = this.findDefineFieldWires(cleanPath);
      if (defineFieldWires.length > 0) {
        const response = this.resolveWires(defineFieldWires);
        if (!array) return response;
        const resolved = await response;
        if (isLoopControlSignal(resolved)) return [];
        return this.createShadowArray(resolved as any[]);
      }
    }

    // Fallback: if this shadow tree has stored element data, resolve the
    // requested field directly from it. This handles passthrough arrays
    // where the bridge maps an inner array (e.g. `.stops <- j.stops`) but
    // doesn't explicitly wire each scalar field on the element type.
    if (this.parent) {
      const elementData = this.state[this.elementTrunkKey];
      if (
        elementData != null &&
        typeof elementData === "object" &&
        !Array.isArray(elementData)
      ) {
        const fieldName = cleanPath[cleanPath.length - 1];
        if (fieldName !== undefined && fieldName in elementData) {
          const value = (elementData as Record<string, any>)[fieldName];
          if (array && Array.isArray(value)) {
            // Nested array: wrap items in shadow trees so they can
            // resolve their own fields via this same fallback path.
            return value.map((item: any) => {
              const s = this.shadow();
              s.state[this.elementTrunkKey] = item;
              return s;
            });
          }
          return value;
        }
      }
    }

    // Return self to trigger downstream resolvers
    return this;
  }

  /**
   * Find define output wires for a specific field path.
   *
   * Looks for whole-object define forward wires (`o <- defineHandle`)
   * at path=[] for this trunk, then searches the define's output wires
   * for ones matching the requested field path.
   */
  private findDefineFieldWires(cleanPath: string[]): Wire[] {
    const forwards =
      this.bridge?.wires.filter(
        (w): w is Extract<Wire, { from: NodeRef }> =>
          "from" in w &&
          sameTrunk(w.to, this.trunk) &&
          w.to.path.length === 0 &&
          w.from.module.startsWith("__define_out_") &&
          w.from.path.length === 0,
      ) ?? [];

    if (forwards.length === 0) return [];

    const result: Wire[] = [];
    for (const fw of forwards) {
      const defOutTrunk = fw.from;
      const fieldWires =
        this.bridge?.wires.filter(
          (w) =>
            sameTrunk(w.to, defOutTrunk) && pathEquals(w.to.path, cleanPath),
        ) ?? [];
      result.push(...fieldWires);
    }
    return result;
  }
}
