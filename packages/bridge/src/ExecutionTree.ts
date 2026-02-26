import { SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { parsePath } from "./utils.ts";
import type {
  Bridge,
  Instruction,
  NodeRef,
  ToolCallFn,
  ToolContext,
  ToolDef,
  ToolMap,
  Wire,
} from "./types.ts";
import { SELF_MODULE } from "./types.ts";

const otelTracer = trace.getTracer("@stackables/bridge");

const otelMeter = metrics.getMeter("@stackables/bridge");
const toolCallCounter = otelMeter.createCounter("bridge.tool.calls", {
  description: "Total number of tool invocations",
});
const toolDurationHistogram = otelMeter.createHistogram(
  "bridge.tool.duration",
  {
    description: "Tool call duration in milliseconds",
    unit: "ms",
  },
);
const toolErrorCounter = otelMeter.createCounter("bridge.tool.errors", {
  description: "Total number of tool invocation errors",
});

/** Round milliseconds to 2 decimal places */
function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/**
 * Structured logger interface for Bridge engine events.
 * Accepts any compatible logger: pino, winston, bunyan, `console`, etc.
 * All methods default to silent no-ops when no logger is provided.
 */
export interface Logger {
  debug?: (...args: any[]) => void;
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
}

/** Matches graphql's internal Path type (not part of the public exports map) */
interface Path {
  readonly prev: Path | undefined;
  readonly key: string | number;
  readonly typename: string | undefined;
}

type Trunk = { module: string; type: string; field: string; instance?: number };

/** Stable string key for the state map */
function trunkKey(ref: Trunk & { element?: boolean }): string {
  if (ref.element) return `${ref.module}:${ref.type}:${ref.field}:*`;
  return `${ref.module}:${ref.type}:${ref.field}${ref.instance != null ? `:${ref.instance}` : ""}`;
}

/** Match two trunks (ignoring path and element) */
function sameTrunk(a: Trunk, b: Trunk): boolean {
  return (
    a.module === b.module &&
    a.type === b.type &&
    a.field === b.field &&
    (a.instance ?? undefined) === (b.instance ?? undefined)
  );
}

/** Strict path equality */
function pathEquals(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Trace verbosity level.
 *  - `"off"` (default) — no collection, zero overhead
 *  - `"basic"` — tool, fn, timing, errors; no input/output
 *  - `"full"` — everything including input and output */
export type TraceLevel = "basic" | "full" | "off";

/** A single recorded tool invocation. */
export type ToolTrace = {
  /** Tool name as resolved (e.g. "hereGeo", "std.str.toUpperCase") */
  tool: string;
  /** The function that was called (e.g. "httpCall", "upperCase") */
  fn: string;
  /** Input object passed to the tool function (only in "full" level) */
  input?: Record<string, any>;
  /** Resolved output (only in "full" level, on success) */
  output?: any;
  /** Error message (present when the tool threw) */
  error?: string;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** Monotonic timestamp (ms) relative to the first trace in the request */
  startedAt: number;
};

/** Shared trace collector — one per request, passed through the tree. */
export class TraceCollector {
  readonly traces: ToolTrace[] = [];
  readonly level: "basic" | "full";
  private readonly epoch = performance.now();

  constructor(level: "basic" | "full" = "full") {
    this.level = level;
  }

  /** Returns ms since the collector was created */
  now(): number {
    return roundMs(performance.now() - this.epoch);
  }

  record(trace: ToolTrace): void {
    this.traces.push(trace);
  }

  /** Build a trace entry, omitting input/output for basic level. */
  entry(base: {
    tool: string;
    fn: string;
    startedAt: number;
    durationMs: number;
    input?: Record<string, any>;
    output?: any;
    error?: string;
  }): ToolTrace {
    if (this.level === "basic") {
      const t: ToolTrace = {
        tool: base.tool,
        fn: base.fn,
        durationMs: base.durationMs,
        startedAt: base.startedAt,
      };
      if (base.error) t.error = base.error;
      return t;
    }
    // full
    const t: ToolTrace = {
      tool: base.tool,
      fn: base.fn,
      durationMs: base.durationMs,
      startedAt: base.startedAt,
    };
    if (base.input) t.input = structuredClone(base.input);
    if (base.error) t.error = base.error;
    else if (base.output !== undefined) t.output = base.output;
    return t;
  }
}

/** Set a value at a nested path, creating intermediate objects/arrays as needed */
/**
 * Coerce a constant wire value string to its proper JS type.
 *
 * The parser stores all bare constants as strings (because the Wire type
 * uses `value: string`). JSON.parse recovers the original type:
 *   "true" → true, "false" → false, "null" → null, "42" → 42
 * Plain strings that aren't valid JSON (like "hello", "/search") fall
 * through and are returned as-is.
 */
function coerceConstant(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function setNested(obj: any, path: string[], value: any): void {
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (obj[key] == null) {
      obj[key] = /^\d+$/.test(nextKey) ? [] : {};
    }
    obj = obj[key];
  }
  if (path.length > 0) {
    obj[path[path.length - 1]] = value;
  }
}

export class ExecutionTree {
  state: Record<string, any> = {};
  bridge: Bridge | undefined;
  private toolDepCache: Map<string, Promise<any>> = new Map();
  private toolDefCache: Map<string, ToolDef | null> = new Map();
  private pipeHandleMap:
    | Map<string, NonNullable<Bridge["pipeHandles"]>[number]>
    | undefined;
  /** Promise that resolves when all critical `force` handles have settled. */
  private forcedExecution?: Promise<void>;
  /** Shared trace collector — present only when tracing is enabled. */
  tracer?: TraceCollector;
  /** Structured logger passed from BridgeOptions. Defaults to no-ops. */
  logger?: Logger;

  constructor(
    public trunk: Trunk,
    private instructions: Instruction[],
    private toolFns?: ToolMap,
    private context?: Record<string, any>,
    private parent?: ExecutionTree,
  ) {
    this.bridge = instructions.find(
      (i): i is Bridge =>
        i.kind === "bridge" && i.type === trunk.type && i.field === trunk.field,
    );
    if (this.bridge?.pipeHandles) {
      this.pipeHandleMap = new Map(
        this.bridge.pipeHandles.map((ph) => [ph.key, ph]),
      );
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

  /** Derive tool name from a trunk */
  private getToolName(target: Trunk): string {
    if (target.module === SELF_MODULE) return target.field;
    return `${target.module}.${target.field}`;
  }

  /** Deep-lookup a tool function by dotted name (e.g. "std.str.toUpperCase").
   *  Falls back to a flat key lookup for backward compat (e.g. "hereapi.geocode" as literal key). */
  private lookupToolFn(
    name: string,
  ): ToolCallFn | ((...args: any[]) => any) | undefined {
    if (name.includes(".")) {
      // Try namespace traversal first
      const parts = name.split(".");
      let current: any = this.toolFns;
      for (const part of parts) {
        if (current == null || typeof current !== "object") {
          current = undefined;
          break;
        }
        current = current[part];
      }
      if (typeof current === "function") return current;
      // Fall back to flat key (e.g. "hereapi.geocode" as a literal property name)
      const flat = (this.toolFns as any)?.[name];
      return typeof flat === "function" ? flat : undefined;
    }
    // Try root level first
    const fn = (this.toolFns as any)?.[name];
    if (typeof fn === "function") return fn;
    // Fall back to std namespace (builtins are callable without std. prefix)
    const stdFn = (this.toolFns as any)?.std?.[name];
    if (typeof stdFn === "function") return stdFn;
    // Fall back to math namespace (math/comparison tools)
    const mathFn = (this.toolFns as any)?.math?.[name];
    return typeof mathFn === "function" ? mathFn : undefined;
  }

  /** Resolve a ToolDef by name, merging the extends chain (cached) */
  private resolveToolDefByName(name: string): ToolDef | undefined {
    if (this.toolDefCache.has(name))
      return this.toolDefCache.get(name) ?? undefined;

    const toolDefs = this.instructions.filter(
      (i): i is ToolDef => i.kind === "tool",
    );
    const base = toolDefs.find((t) => t.name === name);
    if (!base) {
      this.toolDefCache.set(name, null);
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

    // Merge: root provides base, each child overrides
    const merged: ToolDef = {
      kind: "tool",
      name,
      fn: chain[0].fn, // fn from root ancestor
      deps: [],
      wires: [],
    };

    for (const def of chain) {
      // Merge deps (dedupe by handle)
      for (const dep of def.deps) {
        if (!merged.deps.some((d) => d.handle === dep.handle)) {
          merged.deps.push(dep);
        }
      }
      // Merge wires (child overrides parent by target; onError replaces onError)
      for (const wire of def.wires) {
        if (wire.kind === "onError") {
          const idx = merged.wires.findIndex((w) => w.kind === "onError");
          if (idx >= 0) merged.wires[idx] = wire;
          else merged.wires.push(wire);
        } else {
          const idx = merged.wires.findIndex(
            (w) => "target" in w && w.target === wire.target,
          );
          if (idx >= 0) merged.wires[idx] = wire;
          else merged.wires.push(wire);
        }
      }
    }

    this.toolDefCache.set(name, merged);
    return merged;
  }

  /** Resolve a tool definition's wires into a nested input object */
  private async resolveToolWires(
    toolDef: ToolDef,
    input: Record<string, any>,
  ): Promise<void> {
    // Constants applied synchronously
    for (const wire of toolDef.wires) {
      if (wire.kind === "constant") {
        setNested(input, parsePath(wire.target), coerceConstant(wire.value));
      }
    }

    // Pull wires resolved in parallel (independent deps shouldn't wait on each other)
    const pullWires = toolDef.wires.filter((w) => w.kind === "pull");
    if (pullWires.length > 0) {
      const resolved = await Promise.all(
        pullWires.map(async (wire) => ({
          target: wire.target,
          value: await this.resolveToolSource(wire.source, toolDef),
        })),
      );
      for (const { target, value } of resolved) {
        setNested(input, parsePath(target), value);
      }
    }
  }

  /** Resolve a source reference from a tool wire against its dependencies */
  private async resolveToolSource(
    source: string,
    toolDef: ToolDef,
  ): Promise<any> {
    const dotIdx = source.indexOf(".");
    const handle = dotIdx === -1 ? source : source.substring(0, dotIdx);
    const restPath =
      dotIdx === -1 ? [] : source.substring(dotIdx + 1).split(".");

    const dep = toolDef.deps.find((d) => d.handle === handle);
    if (!dep)
      throw new Error(`Unknown source "${handle}" in tool "${toolDef.name}"`);

    let value: any;
    if (dep.kind === "context") {
      // Walk the full parent chain for context
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      let cursor: ExecutionTree | undefined = this;
      while (cursor && value === undefined) {
        value = cursor.context;
        cursor = cursor.parent;
      }
    } else if (dep.kind === "const") {
      // Walk the full parent chain for const state
      const constKey = trunkKey({
        module: SELF_MODULE,
        type: "Const",
        field: "const",
      });
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      let cursor: ExecutionTree | undefined = this;
      while (cursor && value === undefined) {
        value = cursor.state[constKey];
        cursor = cursor.parent;
      }
    } else if (dep.kind === "tool") {
      value = await this.resolveToolDep(dep.tool);
    }

    for (const segment of restPath) {
      value = value?.[segment];
    }
    return value;
  }

  /** Call a tool dependency (cached per request) */
  private resolveToolDep(toolName: string): Promise<any> {
    // Check parent first (shadow trees delegate)
    if (this.parent) return this.parent.resolveToolDep(toolName);

    if (this.toolDepCache.has(toolName))
      return this.toolDepCache.get(toolName)!;

    const promise = (async () => {
      const toolDef = this.resolveToolDefByName(toolName);
      if (!toolDef) throw new Error(`Tool dependency "${toolName}" not found`);

      const input: Record<string, any> = {};
      await this.resolveToolWires(toolDef, input);

      const fn = this.lookupToolFn(toolDef.fn!);
      if (!fn) throw new Error(`Tool function "${toolDef.fn}" not registered`);

      // on error: wrap the tool call with fallback from onError wire
      const onErrorWire = toolDef.wires.find((w) => w.kind === "onError");
      try {
        return await this.callTool(toolName, toolDef.fn!, fn, input);
      } catch (err) {
        if (!onErrorWire) throw err;
        if ("value" in onErrorWire) return JSON.parse(onErrorWire.value);
        return this.resolveToolSource(onErrorWire.source, toolDef);
      }
    })();

    this.toolDepCache.set(toolName, promise);
    return promise;
  }

  schedule(target: Trunk): any {
    // Delegate to parent (shadow trees don't schedule directly) unless
    // the target fork has bridge wires sourced from element data,
    // or a __local binding whose source chain touches element data.
    if (this.parent) {
      const forkWires =
        this.bridge?.wires.filter((w) => sameTrunk(w.to, target)) ?? [];
      const hasElementSource = forkWires.some(
        (w) =>
          ("from" in w && !!w.from.element) ||
          ("condAnd" in w && (!!w.condAnd.leftRef.element || !!w.condAnd.rightRef?.element)) ||
          ("condOr" in w && (!!w.condOr.leftRef.element || !!w.condOr.rightRef?.element)),
      );
      // For __local trunks, also check transitively: if the source is a
      // pipe fork whose own wires reference element data, keep it local.
      const hasTransitiveElementSource =
        target.module === "__local" &&
        forkWires.some((w) => {
          if (!("from" in w)) return false;
          const srcTrunk = {
            module: w.from.module,
            type: w.from.type,
            field: w.from.field,
            instance: w.from.instance,
          };
          return (
            this.bridge?.wires.some(
              (iw) =>
                sameTrunk(iw.to, srcTrunk) && "from" in iw && !!iw.from.element,
            ) ?? false
          );
        });
      if (!hasElementSource && !hasTransitiveElementSource) {
        return this.parent.schedule(target);
      }
    }

    return (async () => {
      // If this target is a pipe fork, also apply bridge wires from its base
      // handle (non-pipe wires, e.g. `c.currency <- i.currency`) as defaults
      // before the fork-specific pipe wires.
      const targetKey = trunkKey(target);
      const pipeFork = this.pipeHandleMap?.get(targetKey);
      const baseTrunk = pipeFork?.baseTrunk;

      const baseWires = baseTrunk
        ? (this.bridge?.wires.filter(
            (w) => !("pipe" in w) && sameTrunk(w.to, baseTrunk),
          ) ?? [])
        : [];
      // Fork-specific wires (pipe wires targeting the fork's own instance)
      const forkWires =
        this.bridge?.wires.filter((w) => sameTrunk(w.to, target)) ?? [];
      // Merge: base provides defaults, fork overrides
      const bridgeWires = [...baseWires, ...forkWires];

      // Look up ToolDef for this target
      const toolName = this.getToolName(target);
      const toolDef = this.resolveToolDefByName(toolName);

      // Build input object: tool wires first (base), then bridge wires (override)
      const input: Record<string, any> = {};

      if (toolDef) {
        await this.resolveToolWires(toolDef, input);
      }

      // Resolve bridge wires and apply on top.
      // Group wires by target path so that || (null-fallback) and ??
      // (error-fallback) semantics are honoured via resolveWires().
      const wireGroups = new Map<string, Wire[]>();
      for (const w of bridgeWires) {
        const key = w.to.path.join(".");
        let group = wireGroups.get(key);
        if (!group) {
          group = [];
          wireGroups.set(key, group);
        }
        group.push(w);
      }

      const groupEntries = Array.from(wireGroups.entries());
      const resolved = await Promise.all(
        groupEntries.map(async ([, group]): Promise<[string[], any]> => {
          const value = await this.resolveWires(group);
          return [group[0].to.path, value];
        }),
      );
      for (const [path, value] of resolved) {
        if (path.length === 0 && value != null && typeof value === "object") {
          Object.assign(input, value);
        } else {
          setNested(input, path, value);
        }
      }

      // Call ToolDef-backed tool function
      if (toolDef) {
        const fn = this.lookupToolFn(toolDef.fn!);
        if (!fn)
          throw new Error(`Tool function "${toolDef.fn}" not registered`);

        // on error: wrap the tool call with fallback from onError wire
        const onErrorWire = toolDef.wires.find((w) => w.kind === "onError");
        try {
          return await this.callTool(toolName, toolDef.fn!, fn, input);
        } catch (err) {
          if (!onErrorWire) throw err;
          if ("value" in onErrorWire) return JSON.parse(onErrorWire.value);
          return this.resolveToolSource(onErrorWire.source, toolDef);
        }
      }

      // Direct tool function lookup by name (simple or dotted)
      const directFn = this.lookupToolFn(toolName);
      if (directFn) {
        return this.callTool(toolName, toolName, directFn, input);
      }

      // Define pass-through: synthetic trunks created by define inlining
      // act as data containers — bridge wires set their values, no tool needed.
      if (target.module.startsWith("__define_")) {
        return input;
      }

      // Local binding or logic node: the wire resolves the source and stores
      // the result — no tool call needed.  For path=[] wires the resolved
      // value may be a primitive (boolean from condAnd/condOr, string from
      // a pipe tool like upperCase), so return the resolved value directly.
      if (target.module === "__local" || target.field === "__and" || target.field === "__or") {
        for (const [path, value] of resolved) {
          if (path.length === 0) return value;
        }
        return input;
      }

      throw new Error(`No tool found for "${toolName}"`);
    })();
  }

  /**
   * Invoke a tool function, recording both an OpenTelemetry span and (when
   * tracing is enabled) a ToolTrace entry.  All three tool-call sites in the
   * engine delegate here so instrumentation lives in exactly one place.
   */
  private async callTool(
    toolName: string,
    fnName: string,
    fnImpl: (...args: any[]) => any,
    input: Record<string, any>,
  ): Promise<any> {
    const tracer = this.tracer;
    const logger = this.logger;
    const toolContext: ToolContext = { logger: logger ?? {} };
    const traceStart = tracer?.now();
    const metricAttrs = {
      "bridge.tool.name": toolName,
      "bridge.tool.fn": fnName,
    };
    return otelTracer.startActiveSpan(
      `bridge.tool.${toolName}.${fnName}`,
      { attributes: metricAttrs },
      async (span) => {
        const wallStart = performance.now();
        try {
          const result = await fnImpl(input, toolContext);
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
          logger?.debug?.(
            "[bridge] tool %s (%s) completed in %dms",
            toolName,
            fnName,
            durationMs,
          );
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
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (err as Error).message,
          });
          logger?.error?.(
            "[bridge] tool %s (%s) failed: %s",
            toolName,
            fnName,
            (err as Error).message,
          );
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  shadow(): ExecutionTree {
    const child = new ExecutionTree(
      this.trunk,
      this.instructions,
      this.toolFns,
      undefined,
      this,
    );
    child.tracer = this.tracer;
    child.logger = this.logger;
    return child;
  }

  /** Returns collected traces (empty array when tracing is disabled). */
  getTraces(): ToolTrace[] {
    return this.tracer?.traces ?? [];
  }

  private async pullSingle(ref: NodeRef): Promise<any> {
    const key = trunkKey(ref);
    // Walk the full parent chain — shadow trees may be nested multiple levels
    let value: any = undefined;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let cursor: ExecutionTree | undefined = this;
    while (cursor && value === undefined) {
      value = cursor.state[key];
      cursor = cursor.parent;
    }

    if (value === undefined) {
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
          return this.resolveWires(fieldWires);
        }
      }

      this.state[key] = this.schedule(ref);
      value = this.state[key];
    }

    // Always await in case the stored value is a Promise (e.g. from schedule()).
    const resolved = await Promise.resolve(value);

    if (!ref.path.length) {
      return resolved;
    }

    let result: any = resolved;
    
    // Root-level null check: if root data is null/undefined
    if (result == null && ref.path.length > 0) {
      if (ref.rootSafe) return undefined;
      throw new TypeError(`Cannot read properties of ${result} (reading '${ref.path[0]}')`);
    }
    
    for (let i = 0; i < ref.path.length; i++) {
      const segment = ref.path[i];
      if (Array.isArray(result) && !/^\d+$/.test(segment)) {
        this.logger?.warn?.(
          `[bridge] Accessing ".${segment}" on an array (${result.length} items) — did you mean to use pickFirst or array mapping? Source: ${trunkKey(ref)}.${ref.path.join(".")}`,
        );
      }
      result = result[segment];
      // Check for null/undefined AFTER access, before next segment
      if (result == null && i < ref.path.length - 1) {
        const nextSafe = ref.pathSafe?.[i + 1] ?? false;
        if (nextSafe) return undefined;
        throw new TypeError(`Cannot read properties of ${result} (reading '${ref.path[i + 1]}')`);
      }
    }
    return result;
  }

  async pull(refs: NodeRef[]): Promise<any> {
    if (refs.length === 1) return this.pullSingle(refs[0]);

    // Strict left-to-right sequential evaluation with short-circuit.
    // We respect the exact fallback priority authored by the developer.
    const errors: unknown[] = [];

    for (const ref of refs) {
      try {
        const value = await this.pullSingle(ref);
        if (value != null) return value; // Short-circuit: found data
      } catch (err) {
        errors.push(err);
      }
    }

    // All resolved to null/undefined, or all threw
    if (errors.length === refs.length) {
      throw new AggregateError(errors, "All sources failed");
    }
    return undefined;
  }

  /**
   * Safe execution pull: wraps individual safe-flagged pulls in try/catch.
   * Wires with `safe: true` swallow errors and return undefined.
   * Non-safe wires propagate errors normally.
   */
  async pullSafe(
    pulls: Extract<Wire, { from: NodeRef }>[],
  ): Promise<any> {
    if (pulls.length === 1) {
      const w = pulls[0];
      if (w.safe) {
        try {
          return await this.pullSingle(w.from);
        } catch {
          return undefined;
        }
      }
      return this.pullSingle(w.from);
    }

    const errors: unknown[] = [];
    for (const w of pulls) {
      try {
        const value = w.safe
          ? await this.pullSingle(w.from).catch(() => undefined)
          : await this.pullSingle(w.from);
        if (value != null) return value;
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === pulls.length) {
      throw new AggregateError(errors, "All sources failed");
    }
    return undefined;
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

  /** Resolve a set of matched wires — constants win, then pull from sources.
   *  `||` (falsyFallback): fires when all sources resolve to a falsy value.
   *  `??` (nullishFallback): fires when value is null/undefined.
   *  `catch` (catchFallback): fires when sources throw an error.
   *  `? :` (cond/thenRef/elseRef): conditional — pulls only the chosen branch. */
  private resolveWires(wires: Wire[]): Promise<any> {
    // Conditional (ternary) wire: evaluate condition, pull only the chosen branch
    const conditional = wires.find(
      (w): w is Extract<Wire, { cond: NodeRef }> => "cond" in w,
    );
    if (conditional) {
      // Sibling pull wires from `|| sourceRef` fallbacks
      const siblingPulls = wires.filter(
        (w): w is Extract<Wire, { from: NodeRef }> => "from" in w,
      );

      let result: Promise<any> = (async () => {
        const condValue = await this.pullSingle(conditional.cond);
        if (condValue) {
          if (conditional.thenRef !== undefined)
            return this.pullSingle(conditional.thenRef);
          if (conditional.thenValue !== undefined) {
            try {
              return JSON.parse(conditional.thenValue);
            } catch {
              return conditional.thenValue;
            }
          }
          return undefined;
        } else {
          if (conditional.elseRef !== undefined)
            return this.pullSingle(conditional.elseRef);
          if (conditional.elseValue !== undefined) {
            try {
              return JSON.parse(conditional.elseValue);
            } catch {
              return conditional.elseValue;
            }
          }
          return undefined;
        }
      })();

      // || falsy-guard: try sibling source refs, then literal falsyFallback
      if (siblingPulls.length > 0) {
        result = result.then(async (value) => {
          if (value) return value;
          return this.pull(siblingPulls.map((w) => w.from));
        });
      }
      if (conditional.falsyFallback != null) {
        result = result.then((value) => {
          if (value) return value;
          try {
            return JSON.parse(conditional.falsyFallback!);
          } catch {
            return conditional.falsyFallback;
          }
        });
      }

      // ?? nullish-guard
      if (conditional.nullishFallbackRef || conditional.nullishFallback != null) {
        result = result.then(async (value: any) => {
          if (value != null) return value;
          if (conditional.nullishFallbackRef) return this.pullSingle(conditional.nullishFallbackRef);
          try { return JSON.parse(conditional.nullishFallback!); }
          catch { return conditional.nullishFallback; }
        });
      }

      // catch error-guard
      if (!conditional.catchFallbackRef && !conditional.catchFallback) return result;
      return result.catch(() => {
        if (conditional.catchFallbackRef)
          return this.pullSingle(conditional.catchFallbackRef);
        try {
          return JSON.parse(conditional.catchFallback!);
        } catch {
          return conditional.catchFallback;
        }
      });
    }

    // Short-circuit logical AND: evaluate left, skip right if left is falsy
    const condAndWire = wires.find(
      (w): w is Extract<Wire, { condAnd: any }> => "condAnd" in w,
    );
    if (condAndWire) {
      const { leftRef, rightRef, rightValue, safe: isSafe, rightSafe } = condAndWire.condAnd;
      let result: Promise<any> = (async () => {
        const leftVal = isSafe
          ? await this.pullSingle(leftRef).catch(() => undefined)
          : await this.pullSingle(leftRef);
        if (!leftVal) return false; // short-circuit: left is falsy
        if (rightRef !== undefined) {
          const rightVal = rightSafe
            ? await this.pullSingle(rightRef).catch(() => undefined)
            : await this.pullSingle(rightRef);
          return Boolean(rightVal);
        }
        if (rightValue !== undefined) {
          try { return Boolean(JSON.parse(rightValue)); }
          catch { return Boolean(rightValue); }
        }
        return Boolean(leftVal);
      })();

      // || falsy-guard
      if (condAndWire.falsyFallback != null) {
        result = result.then((value) => {
          if (value) return value;
          try { return JSON.parse(condAndWire.falsyFallback!); }
          catch { return condAndWire.falsyFallback; }
        });
      }
      // ?? nullish-guard
      if (condAndWire.nullishFallbackRef || condAndWire.nullishFallback != null) {
        result = result.then(async (value: any) => {
          if (value != null) return value;
          if (condAndWire.nullishFallbackRef) return this.pullSingle(condAndWire.nullishFallbackRef);
          try { return JSON.parse(condAndWire.nullishFallback!); }
          catch { return condAndWire.nullishFallback; }
        });
      }
      // catch error-guard
      if (condAndWire.catchFallbackRef || condAndWire.catchFallback) {
        result = result.catch(() => {
          if (condAndWire.catchFallbackRef) return this.pullSingle(condAndWire.catchFallbackRef!);
          try { return JSON.parse(condAndWire.catchFallback!); }
          catch { return condAndWire.catchFallback; }
        });
      }
      return result;
    }

    // Short-circuit logical OR: evaluate left, skip right if left is truthy
    const condOrWire = wires.find(
      (w): w is Extract<Wire, { condOr: any }> => "condOr" in w,
    );
    if (condOrWire) {
      const { leftRef, rightRef, rightValue, safe: isSafe, rightSafe } = condOrWire.condOr;
      let result: Promise<any> = (async () => {
        const leftVal = isSafe
          ? await this.pullSingle(leftRef).catch(() => undefined)
          : await this.pullSingle(leftRef);
        if (leftVal) return true; // short-circuit: left is truthy
        if (rightRef !== undefined) {
          const rightVal = rightSafe
            ? await this.pullSingle(rightRef).catch(() => undefined)
            : await this.pullSingle(rightRef);
          return Boolean(rightVal);
        }
        if (rightValue !== undefined) {
          try { return Boolean(JSON.parse(rightValue)); }
          catch { return Boolean(rightValue); }
        }
        return Boolean(leftVal);
      })();

      // || falsy-guard
      if (condOrWire.falsyFallback != null) {
        result = result.then((value) => {
          if (value) return value;
          try { return JSON.parse(condOrWire.falsyFallback!); }
          catch { return condOrWire.falsyFallback; }
        });
      }
      // ?? nullish-guard
      if (condOrWire.nullishFallbackRef || condOrWire.nullishFallback != null) {
        result = result.then(async (value: any) => {
          if (value != null) return value;
          if (condOrWire.nullishFallbackRef) return this.pullSingle(condOrWire.nullishFallbackRef);
          try { return JSON.parse(condOrWire.nullishFallback!); }
          catch { return condOrWire.nullishFallback; }
        });
      }
      // catch error-guard
      if (condOrWire.catchFallbackRef || condOrWire.catchFallback) {
        result = result.catch(() => {
          if (condOrWire.catchFallbackRef) return this.pullSingle(condOrWire.catchFallbackRef!);
          try { return JSON.parse(condOrWire.catchFallback!); }
          catch { return condOrWire.catchFallback; }
        });
      }
      return result;
    }

    const constant = wires.find(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    if (constant) return Promise.resolve(coerceConstant(constant.value));

    const pulls = wires.filter(
      (w): w is Extract<Wire, { from: NodeRef }> => "from" in w,
    );

    // First wire with each fallback kind wins
    const falsyFallbackWire = pulls.find((w) => w.falsyFallback != null);
    const nullishFallbackWire = pulls.find(
      (w) => w.nullishFallback != null || w.nullishFallbackRef != null,
    );
    const catchFallbackWire = pulls.find(
      (w) => w.catchFallback != null || w.catchFallbackRef != null,
    );

    let result: Promise<any> = (async () => {
      // ==========================================
      // LAYER 1 & 2: Node Execution & Data Routing
      // ==========================================
      let resolvedValue: any;
      let hitTruthy = false;

      // --- LAYER 1: Execute Chain & Safe Modifiers ---
      for (const w of pulls) {
        if (w.safe) {
          try {
            resolvedValue = await this.pullSingle(w.from);
          } catch {
            resolvedValue = undefined; // ?. swallows error
          }
        } else {
          // Strict! If this throws, it skips Layer 2 and hits Layer 3 (catch).
          resolvedValue = await this.pullSingle(w.from);
        }

        // --- LAYER 2a: Falsy Gate (||) ---
        if (resolvedValue) {
          hitTruthy = true;
          break; // Short-circuit
        }
      }

      // --- LAYER 2a: Falsy Gate Literal ---
      if (!hitTruthy && falsyFallbackWire) {
        resolvedValue = coerceConstant(falsyFallbackWire.falsyFallback!);
      }

      // --- LAYER 2b: Nullish Gate (??) ---
      if (resolvedValue == null && nullishFallbackWire) {
        if (nullishFallbackWire.nullishFallbackRef) {
          resolvedValue = await this.pullSingle(nullishFallbackWire.nullishFallbackRef);
        } else if (nullishFallbackWire.nullishFallback != null) {
          resolvedValue = coerceConstant(nullishFallbackWire.nullishFallback);
        }
      }

      return resolvedValue;
    })();

    // ==========================================
    // LAYER 3: The Wire-Level Error Boundary (catch)
    // ==========================================
    if (!catchFallbackWire) return result;

    return result.catch(() => {
      if (catchFallbackWire.catchFallbackRef) {
        return this.pullSingle(catchFallbackWire.catchFallbackRef);
      }
      try {
        return JSON.parse(catchFallbackWire.catchFallback!);
      } catch {
        return catchFallbackWire.catchFallback;
      }
    });
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
    const items = (await result) as any[];
    return items.map((item) => {
      const s = this.shadow();
      s.state[trunkKey({ ...this.trunk, element: true })] = item;
      return s;
    });
  }

  /**
   * Execute the bridge end-to-end without GraphQL.
   *
   * Injects `input` as the trunk arguments, runs forced wires, then pulls
   * and materialises every output field into a plain JS object (or array of
   * objects for array-mapped bridges).
   *
   * This is the single entry-point used by `executeBridge()`.
   */
  async run(input: Record<string, unknown>): Promise<unknown> {
    const bridge = this.bridge;
    if (!bridge) {
      throw new Error(
        `No bridge definition found for ${this.trunk.type}.${this.trunk.field}`,
      );
    }

    this.push(input);
    const forcePromises = this.executeForced();

    const { type, field } = this.trunk;

    // Is there a root-level wire targeting the output with path []?
    const hasRootWire = bridge.wires.some(
      (w) =>
        "from" in w &&
        w.to.module === SELF_MODULE &&
        w.to.type === type &&
        w.to.field === field &&
        w.to.path.length === 0,
    );

    // Array-mapped output (`o <- items[] as x { ... }`) has BOTH a root wire
    // AND element-level wires (from.element === true).  A plain passthrough
    // (`o <- api.user`) only has the root wire.
    // Local bindings (from.__local) are also element-scoped.
    // Pipe fork output wires in element context (e.g. concat template strings)
    // may have to.element === true instead.
    const hasElementWires = bridge.wires.some(
      (w) =>
        "from" in w &&
        ((w.from as NodeRef).element === true ||
          (w.from as NodeRef).module === "__local" ||
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

    // Whole-object passthrough: `o <- api.user`
    if (hasRootWire) {
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

    if (outputFields.size === 0) {
      throw new Error(
        `Bridge "${type}.${field}" has no output wires. ` +
          `Ensure at least one wire targets the output (e.g. \`o.field <- ...\`).`,
      );
    }

    const result: Record<string, unknown> = {};
    await Promise.all([
      ...[...outputFields].map(async (name) => {
        result[name] = await this.pullOutputField([name]);
      }),
      ...forcePromises,
    ]);
    return result;
  }

  /**
   * Recursively convert shadow trees into plain JS objects.
   *
   * Wire categories at each level (prefix = P):
   *   Leaf  — `to.path = [...P, name]`, no deeper paths → scalar
   *   Array — direct wire AND deeper paths → pull as array, recurse
   *   Nested object — only deeper paths, no direct wire → pull each
   *             full path and assemble via setNested
   */
  private async materializeShadows(
    items: ExecutionTree[],
    pathPrefix: string[],
  ): Promise<unknown[]> {
    const wires = this.bridge!.wires;
    const { type, field } = this.trunk;

    const directFields = new Set<string>();
    const deepPaths = new Map<string, string[][]>();

    for (const wire of wires) {
      const p = wire.to.path;
      if (
        wire.to.module !== SELF_MODULE ||
        wire.to.type !== type ||
        wire.to.field !== field
      )
        continue;
      if (p.length <= pathPrefix.length) continue;
      if (!pathPrefix.every((seg, i) => p[i] === seg)) continue;

      const name = p[pathPrefix.length]!;
      if (p.length === pathPrefix.length + 1) {
        directFields.add(name);
      } else {
        let arr = deepPaths.get(name);
        if (!arr) {
          arr = [];
          deepPaths.set(name, arr);
        }
        arr.push(p);
      }
    }

    return Promise.all(
      items.map(async (shadow) => {
        const obj: Record<string, unknown> = {};
        const tasks: Promise<void>[] = [];

        for (const name of directFields) {
          const fullPath = [...pathPrefix, name];
          const hasDeeper = deepPaths.has(name);
          tasks.push(
            (async () => {
              if (hasDeeper) {
                const children = await shadow.pullOutputField(fullPath, true);
                obj[name] = Array.isArray(children)
                  ? await this.materializeShadows(
                      children as ExecutionTree[],
                      fullPath,
                    )
                  : children;
              } else {
                obj[name] = await shadow.pullOutputField(fullPath);
              }
            })(),
          );
        }

        for (const [name, paths] of deepPaths) {
          if (directFields.has(name)) continue;
          tasks.push(
            (async () => {
              const nested: Record<string, unknown> = {};
              await Promise.all(
                paths.map(async (fullPath) => {
                  const value = await shadow.pullOutputField(fullPath);
                  setNested(
                    nested,
                    fullPath.slice(pathPrefix.length + 1),
                    value,
                  );
                }),
              );
              obj[name] = nested;
            })(),
          );
        }

        await Promise.all(tasks);
        return obj;
      }),
    );
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
      const items = (await response) as any[];
      return items.map((item) => {
        const s = this.shadow();
        s.state[trunkKey({ ...this.trunk, element: true })] = item;
        return s;
      });
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
        const items = (await response) as any[];
        return items.map((item) => {
          const s = this.shadow();
          s.state[trunkKey({ ...this.trunk, element: true })] = item;
          return s;
        });
      }
    }

    // Fallback: if this shadow tree has stored element data, resolve the
    // requested field directly from it. This handles passthrough arrays
    // where the bridge maps an inner array (e.g. `.stops <- j.stops`) but
    // doesn't explicitly wire each scalar field on the element type.
    if (this.parent) {
      const elementKey = trunkKey({ ...this.trunk, element: true });
      const elementData = this.state[elementKey];
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
              s.state[elementKey] = item;
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
