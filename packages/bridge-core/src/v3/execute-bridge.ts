import type { ToolTrace, TraceLevel } from "../tracing.ts";
import type { Logger } from "../tree-types.ts";
import type {
  Bridge,
  BridgeDocument,
  Expression,
  NodeRef,
  SourceChain,
  Statement,
  ToolDef,
  ToolMap,
  WireAliasStatement,
  WireCatch,
  WireStatement,
} from "../types.ts";
import { SELF_MODULE } from "../types.ts";
import { TraceCollector } from "../tracing.ts";
import { isFatalError } from "../tree-types.ts";
import {
  std as bundledStd,
  STD_VERSION as BUNDLED_STD_VERSION,
} from "@stackables/bridge-stdlib";
import { resolveStd } from "../version-check.ts";

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
};

export type ExecuteBridgeResult<T = unknown> = {
  data: T;
  traces: ToolTrace[];
  /** Compact bitmask encoding which traversal paths were taken during execution. */
  executionTraceId: bigint;
};

// ── Scope-based pull engine (v3) ────────────────────────────────────────────

/** Unique key for a tool instance trunk. */
function toolKey(module: string, field: string, instance?: number): string {
  return instance ? `${module}:${field}:${instance}` : `${module}:${field}`;
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
    if (current == null || typeof current !== "object") {
      const safe = pathSafe?.[i] ?? (i === 0 ? (rootSafe ?? false) : false);
      if (safe) return undefined;
      return undefined; // path traversal naturally returns undefined
    }
    current = (current as Record<string, unknown>)[path[i]!];
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

  /** Output wires (self-module and element) indexed by dot-joined target path. */
  private readonly outputWires = new Map<string, WireStatement>();

  /** Alias statements indexed by name — evaluated lazily on first read. */
  private readonly aliases = new Map<string, WireAliasStatement>();

  /** Cached alias evaluation results. */
  private readonly aliasResults = new Map<string, Promise<unknown>>();

  constructor(
    parent: ExecutionScope | null,
    selfInput: Record<string, unknown>,
    output: Record<string, unknown>,
    engine: EngineContext,
  ) {
    this.parent = parent;
    this.selfInput = selfInput;
    this.output = output;
    this.engine = engine;
  }

  /** Register that this scope owns a tool declared via `with`. */
  declareToolBinding(name: string): void {
    this.ownedTools.add(bindingOwnerKey(name));
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

  /** Index an output wire (self-module or element) by its target path. */
  addOutputWire(wire: WireStatement): void {
    const key = wire.target.path.join(".");
    this.outputWires.set(key, wire);
  }

  /** Get an output wire by field path key. */
  getOutputWire(field: string): WireStatement | undefined {
    return this.outputWires.get(field);
  }

  /** Get all indexed output field names. */
  allOutputFields(): string[] {
    return Array.from(this.outputWires.keys());
  }

  /**
   * Collect all output wires matching the requested fields via prefix matching.
   * - Requesting "profile" matches wires "profile", "profile.name", "profile.age"
   * - Requesting "profile.name" matches wire "profile" (parent provides the object)
   */
  collectMatchingOutputWires(requestedFields: string[]): WireStatement[] {
    const matched = new Set<string>();
    const result: WireStatement[] = [];

    for (const field of requestedFields) {
      for (const [key, wire] of this.outputWires) {
        if (matched.has(key)) continue;
        // Exact match, or prefix match in either direction
        if (
          key === field ||
          key.startsWith(field + ".") ||
          field.startsWith(key + ".")
        ) {
          matched.add(key);
          result.push(wire);
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
    evaluator: (chain: SourceChain, scope: ExecutionScope) => Promise<unknown>,
  ): Promise<unknown> {
    // Check local cache
    if (this.aliasResults.has(name)) return this.aliasResults.get(name)!;

    // Do I have this alias?
    const alias = this.aliases.get(name);
    if (alias) {
      const promise = evaluator(alias, this);
      this.aliasResults.set(name, promise);
      return promise;
    }

    // Delegate to parent
    if (this.parent) {
      return this.parent.resolveAlias(name, evaluator);
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

  /** Get the root scope (for non-element output writes). */
  root(): ExecutionScope {
    let scope: ExecutionScope = this;
    while (scope.parent) scope = scope.parent;
    return scope;
  }

  /**
   * Resolve a tool result via lexical scope chain.
   *
   * Walks up the parent chain to find the scope that owns the tool
   * (declared via `with`). Tool calls are lazy — the tool function is
   * only invoked when its output is first read, at which point its
   * input wires are evaluated on demand.
   */
  async resolveToolResult(
    module: string,
    field: string,
    instance: number | undefined,
  ): Promise<unknown> {
    const key = toolKey(module, field, instance);

    // Check local memoization cache
    if (this.toolResults.has(key)) return this.toolResults.get(key)!;

    // Does this scope own the tool?
    if (this.ownedTools.has(toolOwnerKey(module, field))) {
      return this.callTool(key, module, field);
    }

    // Delegate to parent scope (lexical chain traversal)
    if (this.parent) {
      return this.parent.resolveToolResult(module, field, instance);
    }

    throw new Error(`Tool "${module}.${field}" not found in any scope`);
  }

  /**
   * Lazily call a tool — evaluates input wires on demand, invokes the
   * tool function, and caches the result.
   */
  private callTool(
    key: string,
    module: string,
    field: string,
  ): Promise<unknown> {
    const promise = (async () => {
      // Pull: evaluate tool input wires lazily
      const input: Record<string, unknown> = {};
      const wires = this.toolInputWires.get(key) ?? [];
      for (const wire of wires) {
        const value = await evaluateSourceChain(wire, this);
        setPath(input, wire.target.path, value);
      }

      const toolName = module === SELF_MODULE ? field : `${module}.${field}`;
      const fn = lookupToolFn(this.engine.tools, toolName);
      if (!fn) throw new Error(`Tool function "${toolName}" not registered`);

      const startMs = performance.now();
      try {
        const result = await fn(input, { logger: this.engine.logger });
        const durationMs = performance.now() - startMs;

        if (this.engine.tracer) {
          this.engine.tracer.record(
            this.engine.tracer.entry({
              tool: toolName,
              fn: toolName,
              input,
              output: result,
              durationMs,
              startedAt: this.engine.tracer.now() - durationMs,
            }),
          );
        }

        return result;
      } catch (err) {
        const durationMs = performance.now() - startMs;

        if (this.engine.tracer) {
          this.engine.tracer.record(
            this.engine.tracer.entry({
              tool: toolName,
              fn: toolName,
              input,
              error: (err as Error).message,
              durationMs,
              startedAt: this.engine.tracer.now() - durationMs,
            }),
          );
        }

        throw err;
      }
    })();

    this.toolResults.set(key, promise);
    return promise;
  }
}

/** Shared engine-wide context. */
interface EngineContext {
  readonly tools: ToolMap;
  readonly instructions: readonly (Bridge | ToolDef | { kind: string })[];
  readonly type: string;
  readonly field: string;
  readonly context: Record<string, unknown>;
  readonly logger?: Logger;
  readonly tracer?: TraceCollector;
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
          scope.declareToolBinding(stmt.binding.name);
        }
        break;
      case "wire": {
        const target = stmt.target;
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
    }
  }
}

/**
 * Demand-driven pull — resolve only the requested output fields.
 * Evaluates output wires from the index (not by walking the AST).
 * Tool calls happen lazily when their output is read during source evaluation.
 *
 * If no specific fields are requested, all indexed output wires are resolved.
 */
async function resolveRequestedFields(
  scope: ExecutionScope,
  requestedFields: string[],
): Promise<void> {
  // If no specific fields, resolve all indexed output wires.
  // Otherwise, use prefix matching to find relevant wires.
  const wires =
    requestedFields.length > 0
      ? scope.collectMatchingOutputWires(requestedFields)
      : scope.allOutputFields().map((f) => scope.getOutputWire(f)!);

  for (const wire of wires) {
    const value = await evaluateSourceChain(wire, scope);
    writeTarget(wire.target, value, scope);
  }
}

/**
 * Evaluate a source chain (fallback gates: ||, ??).
 * Wraps with catch handler if present.
 */
async function evaluateSourceChain(
  chain: SourceChain,
  scope: ExecutionScope,
): Promise<unknown> {
  try {
    let value: unknown;

    for (const entry of chain.sources) {
      if (entry.gate === "falsy" && value) continue;
      if (entry.gate === "nullish" && value != null) continue;
      value = await evaluateExpression(entry.expr, scope);
    }

    return value;
  } catch (err) {
    if (isFatalError(err)) throw err;
    if (chain.catch) {
      return applyCatchHandler(chain.catch, scope);
    }
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
): Promise<unknown> {
  if ("control" in c) {
    if (c.control.kind === "throw") throw new Error(c.control.message);
    // panic, continue, break — import would be needed for full support
    throw new Error(
      `Control flow "${c.control.kind}" in catch not yet implemented in v3`,
    );
  }
  if ("ref" in c) {
    return resolveRef(c.ref, scope);
  }
  // Literal value
  return c.value;
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
): Promise<unknown> {
  switch (expr.type) {
    case "ref":
      if (expr.safe) {
        return evaluateExprSafe(() => resolveRef(expr.ref, scope));
      }
      return resolveRef(expr.ref, scope);

    case "literal":
      return expr.value;

    case "array":
      return evaluateArrayExpr(expr, scope);

    case "ternary": {
      const cond = await evaluateExpression(expr.cond, scope);
      return cond
        ? evaluateExpression(expr.then, scope)
        : evaluateExpression(expr.else, scope);
    }

    case "and": {
      const left = expr.leftSafe
        ? await evaluateExprSafe(() => evaluateExpression(expr.left, scope))
        : await evaluateExpression(expr.left, scope);
      if (!left) return false;
      if (expr.right.type === "literal" && expr.right.value === "true") {
        return Boolean(left);
      }
      const right = expr.rightSafe
        ? await evaluateExprSafe(() => evaluateExpression(expr.right, scope))
        : await evaluateExpression(expr.right, scope);
      return Boolean(right);
    }

    case "or": {
      const left = expr.leftSafe
        ? await evaluateExprSafe(() => evaluateExpression(expr.left, scope))
        : await evaluateExpression(expr.left, scope);
      if (left) return true;
      if (expr.right.type === "literal" && expr.right.value === "true") {
        return Boolean(left);
      }
      const right = expr.rightSafe
        ? await evaluateExprSafe(() => evaluateExpression(expr.right, scope))
        : await evaluateExpression(expr.right, scope);
      return Boolean(right);
    }

    case "control":
      throw new Error(
        `Control flow "${expr.control.kind}" not implemented in v3 POC`,
      );

    case "binary": {
      const left = await evaluateExpression(expr.left, scope);
      const right = await evaluateExpression(expr.right, scope);
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
      return !(await evaluateExpression(expr.operand, scope));

    case "concat": {
      const parts = await Promise.all(
        expr.parts.map((p) => evaluateExpression(p, scope)),
      );
      return parts.map((v) => (v == null ? "" : String(v))).join("");
    }

    case "pipe":
      throw new Error(
        `Expression type "${expr.type}" not implemented in v3 POC`,
      );

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
): Promise<unknown[]> {
  const sourceValue = await evaluateExpression(expr.source, scope);
  if (!Array.isArray(sourceValue)) return [];

  const results: unknown[] = [];

  for (const element of sourceValue) {
    const elementOutput: Record<string, unknown> = {};
    const childScope = new ExecutionScope(
      scope,
      scope.selfInput,
      elementOutput,
      scope.engine,
    );
    childScope.pushElement(element);

    // Index then pull — child scope may declare its own tools
    indexStatements(expr.body, childScope);
    await resolveRequestedFields(childScope, []);

    results.push(elementOutput);
  }

  return results;
}

/**
 * Resolve a NodeRef to its value.
 */
async function resolveRef(
  ref: NodeRef,
  scope: ExecutionScope,
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
    );
    return getPath(aliasResult, ref.path, ref.rootSafe, ref.pathSafe);
  }

  // Self-module input reference — reading from input args
  if (ref.module === SELF_MODULE && ref.instance == null) {
    return getPath(scope.selfInput, ref.path, ref.rootSafe, ref.pathSafe);
  }

  // Tool reference — reading from a tool's output (triggers lazy call)
  const toolResult = await scope.resolveToolResult(
    ref.module,
    ref.field,
    ref.instance,
  );
  return getPath(toolResult, ref.path, ref.rootSafe, ref.pathSafe);
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

  // Create engine context
  const engine: EngineContext = {
    tools: allTools,
    instructions: doc.instructions,
    type,
    field,
    context,
    logger: options.logger,
    tracer,
  };

  // Create root scope and execute
  const output: Record<string, unknown> = {};
  const rootScope = new ExecutionScope(null, input, output, engine);

  // Index: register tool bindings, tool input wires, and output wires
  indexStatements(bridge.body, rootScope);
  // Pull: resolve requested output fields — tool calls happen lazily on demand
  try {
    await resolveRequestedFields(rootScope, options.requestedFields ?? []);
  } catch (err) {
    // Attach collected traces to error for harness/caller access
    if (tracer) {
      (err as { traces?: ToolTrace[] }).traces = tracer.traces;
    }
    throw err;
  }

  // Extract root value if a wire wrote to the output root with a non-object value
  const data =
    "__rootValue__" in output ? (output.__rootValue__ as T) : (output as T);

  return {
    data,
    traces: tracer?.traces ?? [],
    executionTraceId: 0n,
  };
}
