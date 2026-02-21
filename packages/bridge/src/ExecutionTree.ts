import { parsePath } from "./bridge-format.js";
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
      value = this.context ?? this.parent?.context;
    } else if (dep.kind === "const") {
      value = this.state[
        trunkKey({ module: SELF_MODULE, type: "Const", field: "const" })
      ] ?? this.parent?.state[
        trunkKey({ module: SELF_MODULE, type: "Const", field: "const" })
      ];
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
        return await fn(input);
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
          return await fn(input);
        } catch (err) {
          if (!onErrorWire) throw err;
          if ("value" in onErrorWire) return JSON.parse(onErrorWire.value);
          return this.resolveToolSource(onErrorWire.source, toolDef);
        }
      }

      // Direct tool function lookup by name (simple or dotted)
      const directFn = this.lookupToolFn(toolName);
      if (directFn) {
        return directFn(input);
      }

      // Define pass-through: synthetic trunks created by define inlining
      // act as data containers — bridge wires set their values, no tool needed.
      if (target.module.startsWith("__define_")) {
        return input;
      }

      throw new Error(`No tool found for "${toolName}"`);
    })();
  }

  shadow(): ExecutionTree {
    return new ExecutionTree(
      this.trunk,
      this.instructions,
      this.toolFns,
      undefined,
      this,
    );
  }

  private async pullSingle(ref: NodeRef): Promise<any> {
    const key = trunkKey(ref);
    let value: any = this.state[key] ?? this.parent?.state[key];

    if (value === undefined) {
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
        console.warn(
          `[bridge] Accessing ".${segment}" on an array (${result.length} items) — did you mean to use pickFirst or array mapping? Source: ${trunkKey(ref)}.${ref.path.join(".")}`,
        );
      }
      result = result?.[segment];
    }
    return result;
  }

  async pull(refs: NodeRef[]): Promise<any> {
    if (refs.length === 1) return this.pullSingle(refs[0]);

    // Multiple sources: all start in parallel.
    // Return the first that resolves to a non-null/undefined value.
    // If all resolve to null/undefined → resolve undefined (lets || fire).
    // If all reject → throw AggregateError (lets ?? fire).
    return new Promise<any>((resolve, reject) => {
      let remaining = refs.length;
      let hasValue = false;
      const errors: unknown[] = [];

      const settle = () => {
        if (--remaining === 0 && !hasValue) {
          if (errors.length === refs.length) {
            reject(new AggregateError(errors, "All sources failed"));
          } else {
            resolve(undefined); // all resolved to null/undefined
          }
        }
      };

      for (const ref of refs) {
        this.pullSingle(ref).then(
          (value) => {
            if (!hasValue && value != null) {
              hasValue = true;
              resolve(value);
            }
            settle();
          },
          (err) => { errors.push(err); settle(); },
        );
      }
    });
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

    // Return self to trigger downstream resolvers
    return this;
  }
}
