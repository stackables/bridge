import { SpanStatusCode, metrics, trace } from "@opentelemetry/api";
import { parsePath } from "./utils.ts";
import { internal } from "./tools/index.ts";
import type {
  Bridge,
  BridgeDocument,
  ControlFlowInstruction,
  NodeRef,
  ToolCallFn,
  ToolContext,
  ToolDef,
  ToolMap,
  Wire,
} from "./types.ts";
import { SELF_MODULE } from "./types.ts";

/** Fatal panic error — bypasses all error boundaries (`?.` and `catch`). */
export class BridgePanicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgePanicError";
  }
}

/** Abort error — raised when an external AbortSignal cancels execution. */
export class BridgeAbortError extends Error {
  constructor(message = "Execution aborted by external signal") {
    super(message);
    this.name = "BridgeAbortError";
  }
}

/** Sentinel for `continue` — skip the current array element */
const CONTINUE_SYM = Symbol.for("BRIDGE_CONTINUE");
/** Sentinel for `break` — halt array iteration */
const BREAK_SYM = Symbol.for("BRIDGE_BREAK");

/** Maximum shadow-tree nesting depth before a BridgePanicError is thrown. */
export const MAX_EXECUTION_DEPTH = 30;

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

/** Check whether an error is a fatal halt (abort or panic) that must bypass all error boundaries. */
function isFatalError(err: any): boolean {
  return (
    err instanceof BridgePanicError ||
    err instanceof BridgeAbortError ||
    err?.name === "BridgeAbortError" ||
    err?.name === "BridgePanicError"
  );
}

/** Execute a control flow instruction, returning a sentinel or throwing. */
function applyControlFlow(ctrl: ControlFlowInstruction): symbol {
  if (ctrl.kind === "throw") throw new Error(ctrl.message);
  if (ctrl.kind === "panic") throw new BridgePanicError(ctrl.message);
  if (ctrl.kind === "continue") return CONTINUE_SYM;
  /* ctrl.kind === "break" */
  return BREAK_SYM;
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

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function setNested(obj: any, path: string[], value: any): void {
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (UNSAFE_KEYS.has(key)) throw new Error(`Unsafe assignment key: ${key}`);
    const nextKey = path[i + 1];
    if (obj[key] == null) {
      obj[key] = /^\d+$/.test(nextKey) ? [] : {};
    }
    obj = obj[key];
  }
  if (path.length > 0) {
    const finalKey = path[path.length - 1];
    if (UNSAFE_KEYS.has(finalKey))
      throw new Error(`Unsafe assignment key: ${finalKey}`);
    obj[finalKey] = value;
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
  /**
   * Maps trunk keys to `@version` strings from handle bindings.
   * Populated in the constructor so `schedule()` can prefer versioned
   * tool lookups (e.g. `std.str.toLowerCase@999.1`) over the default.
   */
  private handleVersionMap: Map<string, string> = new Map();
  /** Promise that resolves when all critical `force` handles have settled. */
  private forcedExecution?: Promise<void>;
  /** Shared trace collector — present only when tracing is enabled. */
  tracer?: TraceCollector;
  /** Structured logger passed from BridgeOptions. Defaults to no-ops. */
  logger?: Logger;
  /** External abort signal — cancels execution when triggered. */
  signal?: AbortSignal;
  private toolFns?: ToolMap;
  /** Shadow-tree nesting depth (0 for root). */
  private depth: number;

  constructor(
    public trunk: Trunk,
    private document: BridgeDocument,
    toolFns?: ToolMap,
    private context?: Record<string, any>,
    private parent?: ExecutionTree,
  ) {
    this.depth = parent ? parent.depth + 1 : 0;
    if (this.depth > MAX_EXECUTION_DEPTH) {
      throw new BridgePanicError(
        `Maximum execution depth exceeded (${this.depth}) at ${trunkKey(trunk)}. Check for infinite recursion or circular array mappings.`,
      );
    }
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
        if (h.version) {
          const key = trunkKey({ module, type, field, instance });
          this.handleVersionMap.set(key, h.version);
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
        if (UNSAFE_KEYS.has(part)) return undefined;
        if (current == null || typeof current !== "object") {
          current = undefined;
          break;
        }
        current = current[part];
      }
      if (typeof current === "function") return current;
      // Fall back to flat key (e.g. "hereapi.geocode" as a literal property name)
      const flat = (this.toolFns as any)?.[name];
      if (typeof flat === "function") return flat;

      // Try versioned namespace keys (e.g. "std.str@999.1" → { toLowerCase })
      // For "std.str.toLowerCase@999.1", check:
      //   toolFns["std.str@999.1"]?.toLowerCase
      //   toolFns["std@999.1"]?.str?.toLowerCase
      const atIdx = name.lastIndexOf("@");
      if (atIdx > 0) {
        const baseName = name.substring(0, atIdx);
        const version = name.substring(atIdx + 1);
        const nameParts = baseName.split(".");
        for (let i = nameParts.length - 1; i >= 1; i--) {
          const nsKey = nameParts.slice(0, i).join(".") + "@" + version;
          const remainder = nameParts.slice(i);
          let ns: any = (this.toolFns as any)?.[nsKey];
          if (ns != null && typeof ns === "object") {
            for (const part of remainder) {
              if (ns == null || typeof ns !== "object") {
                ns = undefined;
                break;
              }
              ns = ns[part];
            }
            if (typeof ns === "function") return ns;
          }
        }
      }

      return undefined;
    }
    // Try root level first
    const fn = (this.toolFns as any)?.[name];
    if (typeof fn === "function") return fn;
    // Fall back to std namespace (builtins are callable without std. prefix)
    const stdFn = (this.toolFns as any)?.std?.[name];
    if (typeof stdFn === "function") return stdFn;
    // Fall back to internal namespace (engine-internal tools: math ops, concat, etc.)
    const internalFn = (this.toolFns as any)?.internal?.[name];
    return typeof internalFn === "function" ? internalFn : undefined;
  }

  /** Resolve a ToolDef by name, merging the extends chain (cached) */
  private resolveToolDefByName(name: string): ToolDef | undefined {
    if (this.toolDefCache.has(name))
      return this.toolDefCache.get(name) ?? undefined;

    const toolDefs = this.document.instructions.filter(
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

  schedule(target: Trunk, pullChain?: Set<string>): any {
    // Delegate to parent (shadow trees don't schedule directly) unless
    // the target fork has bridge wires sourced from element data,
    // or a __local binding whose source chain touches element data.
    if (this.parent) {
      const forkWires =
        this.bridge?.wires.filter((w) => sameTrunk(w.to, target)) ?? [];
      const hasElementSource = forkWires.some(
        (w) =>
          ("from" in w && !!w.from.element) ||
          ("condAnd" in w &&
            (!!w.condAnd.leftRef.element || !!w.condAnd.rightRef?.element)) ||
          ("condOr" in w &&
            (!!w.condOr.leftRef.element || !!w.condOr.rightRef?.element)),
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
        return this.parent.schedule(target, pullChain);
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
          const value = await this.resolveWires(group, pullChain);
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

      // Direct tool function lookup by name (simple or dotted).
      // When the handle carries a @version tag, try the versioned key first
      // (e.g. "std.str.toLowerCase@999.1") so user-injected overrides win.
      // For pipe forks, fall back to the baseTrunk's version since forks
      // use synthetic instance numbers (100000+).
      const handleVersion =
        this.handleVersionMap.get(trunkKey(target)) ??
        (baseTrunk
          ? this.handleVersionMap.get(trunkKey(baseTrunk))
          : undefined);
      let directFn = handleVersion
        ? this.lookupToolFn(`${toolName}@${handleVersion}`)
        : undefined;
      if (!directFn) {
        directFn = this.lookupToolFn(toolName);
      }
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
      if (
        target.module === "__local" ||
        target.field === "__and" ||
        target.field === "__or"
      ) {
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
      this.document,
      this.toolFns,
      undefined,
      this,
    );
    child.tracer = this.tracer;
    child.logger = this.logger;
    child.signal = this.signal;
    return child;
  }

  /** Returns collected traces (empty array when tracing is disabled). */
  getTraces(): ToolTrace[] {
    return this.tracer?.traces ?? [];
  }

  private async pullSingle(
    ref: NodeRef,
    pullChain: Set<string> = new Set(),
  ): Promise<any> {
    const key = trunkKey(ref);

    // ── Cycle detection ─────────────────────────────────────────────
    // If this exact key is already in our active pull chain, it is a
    // circular dependency that would deadlock (await-on-self).
    if (pullChain.has(key)) {
      throw new BridgePanicError(
        `Circular dependency detected: "${key}" depends on itself`,
      );
    }

    // Walk the full parent chain — shadow trees may be nested multiple levels
    let value: any = undefined;
    let cursor: ExecutionTree | undefined = this;
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
          return this.resolveWires(fieldWires, nextChain);
        }
      }

      this.state[key] = this.schedule(ref, nextChain);
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
      throw new TypeError(
        `Cannot read properties of ${result} (reading '${ref.path[0]}')`,
      );
    }

    for (let i = 0; i < ref.path.length; i++) {
      const segment = ref.path[i];
      if (UNSAFE_KEYS.has(segment))
        throw new Error(`Unsafe property traversal: ${segment}`);
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
        throw new TypeError(
          `Cannot read properties of ${result} (reading '${ref.path[i + 1]}')`,
        );
      }
    }
    return result;
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
   * Resolve a set of matched wires.
   *
   * Architecture: two distinct resolution axes —
   *
   *  **Falsy Gate** (`||`, within a wire): `falsyFallbackRefs` + `falsyFallback`
   *    → truthy check — falsy values (0, "", false) trigger fallback chain.
   *
   *  **Overdefinition** (across wires): multiple wires target the same path
   *    → nullish check — only null/undefined falls through to the next wire.
   *
   * Per-wire layers:
   *   Layer 1  — Execution (pullSingle + safe modifier)
   *   Layer 2a — Falsy Gate   (falsyFallbackRefs → falsyFallback / falsyControl)
   *   Layer 2b — Nullish Gate  (nullishFallbackRef / nullishFallback / nullishControl)
   *   Layer 3  — Catch         (catchFallbackRef / catchFallback / catchControl)
   *
   * After layers 1–2b, the overdefinition boundary (`!= null`) decides whether
   * to return or continue to the next wire.
   */
  private async resolveWires(
    wires: Wire[],
    pullChain?: Set<string>,
  ): Promise<any> {
    let lastError: any;

    for (const w of wires) {
      // Constant wire — always wins, no modifiers
      if ("value" in w) return coerceConstant(w.value);

      try {
        // --- Layer 1: Execution ---
        let resolvedValue: any;

        if ("cond" in w) {
          const condValue = await this.pullSingle(w.cond, pullChain);
          if (condValue) {
            if (w.thenRef !== undefined)
              resolvedValue = await this.pullSingle(w.thenRef, pullChain);
            else if (w.thenValue !== undefined)
              resolvedValue = coerceConstant(w.thenValue);
          } else {
            if (w.elseRef !== undefined)
              resolvedValue = await this.pullSingle(w.elseRef, pullChain);
            else if (w.elseValue !== undefined)
              resolvedValue = coerceConstant(w.elseValue);
          }
        } else if ("condAnd" in w) {
          const {
            leftRef,
            rightRef,
            rightValue,
            safe: isSafe,
            rightSafe,
          } = w.condAnd;
          const leftVal = isSafe
            ? await this.pullSingle(leftRef, pullChain).catch((e: any) => {
                if (isFatalError(e)) throw e;
                return undefined;
              })
            : await this.pullSingle(leftRef, pullChain);
          if (!leftVal) {
            resolvedValue = false;
          } else if (rightRef !== undefined) {
            const rightVal = rightSafe
              ? await this.pullSingle(rightRef, pullChain).catch((e: any) => {
                  if (isFatalError(e)) throw e;
                  return undefined;
                })
              : await this.pullSingle(rightRef, pullChain);
            resolvedValue = Boolean(rightVal);
          } else if (rightValue !== undefined) {
            resolvedValue = Boolean(coerceConstant(rightValue));
          } else {
            resolvedValue = Boolean(leftVal);
          }
        } else if ("condOr" in w) {
          const {
            leftRef,
            rightRef,
            rightValue,
            safe: isSafe,
            rightSafe,
          } = w.condOr;
          const leftVal = isSafe
            ? await this.pullSingle(leftRef, pullChain).catch((e: any) => {
                if (isFatalError(e)) throw e;
                return undefined;
              })
            : await this.pullSingle(leftRef, pullChain);
          if (leftVal) {
            resolvedValue = true;
          } else if (rightRef !== undefined) {
            const rightVal = rightSafe
              ? await this.pullSingle(rightRef, pullChain).catch((e: any) => {
                  if (isFatalError(e)) throw e;
                  return undefined;
                })
              : await this.pullSingle(rightRef, pullChain);
            resolvedValue = Boolean(rightVal);
          } else if (rightValue !== undefined) {
            resolvedValue = Boolean(coerceConstant(rightValue));
          } else {
            resolvedValue = Boolean(leftVal);
          }
        } else if ("from" in w) {
          if (w.safe) {
            try {
              resolvedValue = await this.pullSingle(w.from, pullChain);
            } catch (err: any) {
              if (isFatalError(err)) throw err;
              resolvedValue = undefined;
            }
          } else {
            resolvedValue = await this.pullSingle(w.from, pullChain);
          }
        } else {
          continue;
        }

        // --- Layer 2a: Falsy Gate (||) ---
        if (!resolvedValue && w.falsyFallbackRefs?.length) {
          for (const ref of w.falsyFallbackRefs) {
            // Assign the fallback value regardless of whether it is truthy or falsy.
            // e.g. `false || 0` will correctly update resolvedValue to `0`.
            resolvedValue = await this.pullSingle(ref, pullChain);

            // If it is truthy, we are done! Short-circuit the || chain.
            if (resolvedValue) break;
          }
        }

        if (!resolvedValue) {
          if (w.falsyControl) {
            resolvedValue = applyControlFlow(w.falsyControl);
          } else if (w.falsyFallback != null) {
            resolvedValue = coerceConstant(w.falsyFallback);
          }
        }

        // --- Layer 2b: Nullish Gate (??) ---
        if (resolvedValue == null) {
          if (w.nullishControl) {
            resolvedValue = applyControlFlow(w.nullishControl);
          } else if (w.nullishFallbackRef) {
            resolvedValue = await this.pullSingle(
              w.nullishFallbackRef,
              pullChain,
            );
          } else if (w.nullishFallback != null) {
            resolvedValue = coerceConstant(w.nullishFallback);
          }
        }

        // --- Overdefinition Boundary ---
        if (resolvedValue != null) return resolvedValue;
      } catch (err: any) {
        // --- Layer 3: Catch ---
        if (isFatalError(err)) throw err;
        if (w.catchControl) return applyControlFlow(w.catchControl);
        if (w.catchFallbackRef)
          return this.pullSingle(w.catchFallbackRef, pullChain);
        if (w.catchFallback != null) return coerceConstant(w.catchFallback);
        lastError = err;
      }
    }

    if (lastError) throw lastError;
    return undefined;
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
    if (resolved === BREAK_SYM || resolved === CONTINUE_SYM) return [];
    const items = resolved as any[];
    const finalShadowTrees: ExecutionTree[] = [];
    for (const item of items) {
      if (item === BREAK_SYM) break;
      if (item === CONTINUE_SYM) continue;
      const s = this.shadow();
      s.state[trunkKey({ ...this.trunk, element: true })] = item;
      finalShadowTrees.push(s);
    }
    return finalShadowTrees;
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
      const elementKey = trunkKey({ ...this.trunk, element: true });
      return this.state[elementKey];
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

    const resolveField = async (prefix: string[]): Promise<unknown> => {
      const exactWires = bridge.wires.filter(
        (w) =>
          w.to.module === SELF_MODULE &&
          w.to.type === type &&
          w.to.field === field &&
          pathEquals(w.to.path, prefix),
      );
      if (exactWires.length > 0) {
        return this.resolveWires(exactWires);
      }

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
      if (subFields.size === 0) return undefined;

      const obj: Record<string, unknown> = {};
      await Promise.all(
        [...subFields].map(async (sub) => {
          obj[sub] = await resolveField([...prefix, sub]);
        }),
      );
      return obj;
    };

    await Promise.all(
      [...outputFields].map(async (name) => {
        result[name] = await resolveField([name]);
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

    // Resolves a single output field at `prefix` — either via an exact-match
    // wire (leaf), or by collecting sub-fields from deeper wires (nested object).
    const resolveField = async (prefix: string[]): Promise<unknown> => {
      const exactWires = bridge.wires.filter(
        (w) =>
          w.to.module === SELF_MODULE &&
          w.to.type === type &&
          w.to.field === field &&
          pathEquals(w.to.path, prefix),
      );
      if (exactWires.length > 0) {
        return this.resolveWires(exactWires);
      }

      // No exact wire — gather sub-field names from deeper-path wires
      // (e.g. `o.why { .temperature <- ... }` produces path ["why","temperature"])
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
      if (subFields.size === 0) return undefined;

      const obj: Record<string, unknown> = {};
      await Promise.all(
        [...subFields].map(async (sub) => {
          obj[sub] = await resolveField([...prefix, sub]);
        }),
      );
      return obj;
    };

    await Promise.all([
      ...[...outputFields].map(async (name) => {
        result[name] = await resolveField([name]);
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

    const rawResults = await Promise.all(
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
        // Check if any field resolved to a sentinel — propagate it
        for (const v of Object.values(obj)) {
          if (v === CONTINUE_SYM) return CONTINUE_SYM;
          if (v === BREAK_SYM) return BREAK_SYM;
        }
        return obj;
      }),
    );

    // Filter sentinels from the final result
    const finalResults: unknown[] = [];
    for (const item of rawResults) {
      if (item === BREAK_SYM) break;
      if (item === CONTINUE_SYM) continue;
      finalResults.push(item);
    }
    return finalResults;
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
      if (resolved === BREAK_SYM || resolved === CONTINUE_SYM) return [];
      const items = resolved as any[];
      const shadowTrees: ExecutionTree[] = [];
      for (const item of items) {
        if (item === BREAK_SYM) break;
        if (item === CONTINUE_SYM) continue;
        const s = this.shadow();
        s.state[trunkKey({ ...this.trunk, element: true })] = item;
        shadowTrees.push(s);
      }
      return shadowTrees;
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
        if (resolved === BREAK_SYM || resolved === CONTINUE_SYM) return [];
        const items = resolved as any[];
        const shadowTrees: ExecutionTree[] = [];
        for (const item of items) {
          if (item === BREAK_SYM) break;
          if (item === CONTINUE_SYM) continue;
          const s = this.shadow();
          s.state[trunkKey({ ...this.trunk, element: true })] = item;
          shadowTrees.push(s);
        }
        return shadowTrees;
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
