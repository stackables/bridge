import { SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { parsePath } from "./utils.js";
import type {
  Bridge,
  ConstDef,
  Instruction,
  NodeRef,
  ToolCallFn,
  ToolDef,
  ToolMap,
  Wire,
} from "./types.js";
import { SELF_MODULE } from "./types.js";

const otelTracer = trace.getTracer("@stackables/bridge");

const otelMeter = metrics.getMeter("@stackables/bridge");
const toolCallCounter = otelMeter.createCounter("bridge.tool.calls", {
  description: "Total number of tool invocations",
});
const toolDurationHistogram = otelMeter.createHistogram("bridge.tool.duration", {
  description: "Tool call duration in milliseconds",
  unit: "ms",
});
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
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
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
  /** Tool name as resolved (e.g. "hereGeo", "std.upperCase") */
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
  entry(base: { tool: string; fn: string; startedAt: number; durationMs: number; input?: Record<string, any>; output?: any; error?: string }): ToolTrace {
    if (this.level === "basic") {
      const t: ToolTrace = { tool: base.tool, fn: base.fn, durationMs: base.durationMs, startedAt: base.startedAt };
      if (base.error) t.error = base.error;
      return t;
    }
    // full
    const t: ToolTrace = { tool: base.tool, fn: base.fn, durationMs: base.durationMs, startedAt: base.startedAt };
    if (base.input) t.input = structuredClone(base.input);
    if (base.error) t.error = base.error;
    else if (base.output !== undefined) t.output = base.output;
    return t;
  }
}

/** Set a value at a nested path, creating intermediate objects/arrays as needed */
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
  private pipeHandleMap: Map<string, NonNullable<Bridge["pipeHandles"]>[number]> | undefined;
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

  /** Deep-lookup a tool function by dotted name (e.g. "std.upperCase").
   *  Falls back to a flat key lookup for backward compat (e.g. "hereapi.geocode" as literal key). */
  private lookupToolFn(name: string): ToolCallFn | ((...args: any[]) => any) | undefined {
    if (name.includes(".")) {
      // Try namespace traversal first
      const parts = name.split(".");
      let current: any = this.toolFns;
      for (const part of parts) {
        if (current == null || typeof current !== "object") { current = undefined; break; }
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
    return typeof stdFn === "function" ? stdFn : undefined;
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
        setNested(input, parsePath(wire.target), wire.value);
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
      const constKey = trunkKey({ module: SELF_MODULE, type: "Const", field: "const" });
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
    // Delegate to parent (shadow trees don't schedule directly)
    if (this.parent) {
      return this.parent.schedule(target);
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
      const forkWires = this.bridge?.wires.filter((w) => sameTrunk(w.to, target)) ?? [];
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
        if (!group) { group = []; wireGroups.set(key, group); }
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
    const traceStart = tracer?.now();
    const metricAttrs = { "bridge.tool.name": toolName, "bridge.tool.fn": fnName };
    return otelTracer.startActiveSpan(
      `bridge.tool.${toolName}.${fnName}`,
      { attributes: metricAttrs },
      async (span) => {
        const wallStart = performance.now();
        try {
          const result = await fnImpl(input);
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
          logger?.debug("[bridge] tool %s (%s) completed in %dms", toolName, fnName, durationMs);
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
          logger?.error("[bridge] tool %s (%s) failed: %s", toolName, fnName, (err as Error).message);
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
            (w) =>
              sameTrunk(w.to, ref) && pathEquals(w.to.path, ref.path),
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
    for (const segment of ref.path) {
      if (Array.isArray(result) && !/^\d+$/.test(segment)) {
        this.logger?.warn(
          `[bridge] Accessing ".${segment}" on an array (${result.length} items) — did you mean to use pickFirst or array mapping? Source: ${trunkKey(ref)}.${ref.path.join(".")}`,
        );
      }
      result = result?.[segment];
    }
    return result;
  }

  /**
   * Infer the cost of resolving a NodeRef.
   * Cost 0: memory reads (input, context, const) — no I/O.
   * Cost 1: everything else (tool calls, pipes, defines) — may involve network.
   */
  private inferCost(ref: NodeRef): number {
    // Input args, context, and const live in the state map — free reads
    if (ref.module === SELF_MODULE) {
      const key = trunkKey(ref);
      // Already resolved in state? Free.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      let cursor: ExecutionTree | undefined = this;
      while (cursor) {
        if (cursor.state[key] !== undefined) return 0;
        cursor = cursor.parent;
      }
      // Input/context/const trunks are always cost 0
      if (ref.type === "Context" || ref.type === "Const") return 0;
      // Input args trunk: _:Query:fieldName (same as this.trunk) — cost 0
      if (ref.module === SELF_MODULE && ref.type === this.trunk.type && ref.field === this.trunk.field && !ref.element) return 0;
    }
    return 1;
  }

  async pull(refs: NodeRef[]): Promise<any> {
    if (refs.length === 1) return this.pullSingle(refs[0]);

    // Cost-sorted sequential evaluation with short-circuit.
    //
    // Sort by inferred cost (stable — preserves declaration order within
    // the same cost tier). This means:
    //   • ||  chains (both sources are tools = same cost) → left-to-right
    //   • Overdefinition with mixed costs → cheapest first
    //
    // Evaluate sequentially. Return the first non-null value.
    // If all return null/undefined → return undefined (lets || fire).
    // If all throw → throw AggregateError (lets ?? fire).
    const sorted = [...refs].sort((a, b) => this.inferCost(a) - this.inferCost(b));
    const errors: unknown[] = [];

    for (const ref of sorted) {
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

  push(args: Record<string, any>) {
    this.state[trunkKey(this.trunk)] = args;
  }

  /** Eagerly schedule tools targeted by forced (<-!) wires. */
  executeForced(): void {
    const forcedWires = this.bridge?.wires.filter(
      (w): w is Extract<Wire, { from: NodeRef }> & { force: true } =>
        "from" in w && !!w.force,
    ) ?? [];

    const scheduled = new Set<string>();
    for (const wire of forcedWires) {
      // For pipe wires the target is the fork trunk; for regular wires it's
      // the tool trunk.  In both cases scheduling the target kicks off
      // resolution of all its input wires (including the forced source).
      const key = trunkKey(wire.to);
      if (scheduled.has(key) || this.state[key] !== undefined) continue;
      scheduled.add(key);
      this.state[key] = this.schedule(wire.to);
      // Fire-and-forget: suppress unhandled rejection for side-effect tools
      // whose output is never consumed.
      Promise.resolve(this.state[key]).catch(() => {});
    }
  }

  /** Resolve a set of matched wires — constants win, then pull from sources.
   *  `||` (nullFallback): fires when all sources resolve to null/undefined.
   *  `??` (fallback/fallbackRef): fires when all sources reject (throw/error). */
  private resolveWires(wires: Wire[]): Promise<any> {
    const constant = wires.find(
      (w): w is Extract<Wire, { value: string }> => "value" in w,
    );
    if (constant) return Promise.resolve(constant.value);

    const pulls = wires.filter(
      (w): w is Extract<Wire, { from: NodeRef }> => "from" in w,
    );

    // First wire with each fallback kind wins
    const nullFallbackWire = pulls.find((w) => w.nullFallback != null);
    // Error fallback: JSON literal (`fallback`) or source/pipe reference (`fallbackRef`)
    const errorFallbackWire = pulls.find((w) => w.fallback != null || w.fallbackRef != null);

    let result: Promise<any> = this.pull(pulls.map((w) => w.from));

    // || null-guard: fires when resolution succeeds but value is null/undefined
    if (nullFallbackWire) {
      result = result.then((value) => {
        if (value != null) return value;
        try {
          return JSON.parse(nullFallbackWire.nullFallback!);
        } catch {
          return nullFallbackWire.nullFallback;
        }
      });
    }

    // ?? error-guard: fires when resolution throws
    if (!errorFallbackWire) return result;

    return result.catch(() => {
      // Source/pipe reference: schedule it lazily and pull the result
      if (errorFallbackWire.fallbackRef) {
        return this.pullSingle(errorFallbackWire.fallbackRef);
      }
      // JSON literal
      try {
        return JSON.parse(errorFallbackWire.fallback!);
      } catch {
        return errorFallbackWire.fallback;
      }
    });
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
      if (elementData != null && typeof elementData === "object" && !Array.isArray(elementData)) {
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
            sameTrunk(w.to, defOutTrunk) &&
            pathEquals(w.to.path, cleanPath),
        ) ?? [];
      result.push(...fieldWires);
    }
    return result;
  }
}
