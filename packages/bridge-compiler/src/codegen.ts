/**
 * AOT code generator v2 — lazy-getter pull-based compilation.
 *
 * Compiles a Bridge AST (Statement[] body) into a standalone JavaScript
 * function that mirrors the core engine's pull-based evaluation model.
 *
 * Instead of topological sorting and eager tool calls, the generated code
 * uses memoized lazy getters — tools are only invoked when an output wire
 * explicitly asks for their data.
 *
 * SECURITY NOTE: This file is a compiler back-end. It transforms a fully-parsed,
 * validated Bridge AST into JavaScript source strings. No raw external / user
 * input is ever spliced into the output.
 *
 * lgtm [js/code-injection]
 */

import type {
  BridgeDocument,
  Bridge,
  Statement,
  Expression,
  NodeRef,
  WireSourceEntry,
  WireCatch,
  WireStatement,
  WireAliasStatement,
  ScopeStatement,
  WithStatement,
  SpreadStatement,
  ForceStatement,
  ToolDef,
  DefineDef,
} from "@stackables/bridge-core";
import { BridgeCompilerIncompatibleError } from "./bridge-asserts.ts";
import { matchesRequestedFields } from "@stackables/bridge-core";

// ── Public types ────────────────────────────────────────────────────────────

export interface CompileOptions {
  /** The operation to compile, e.g. "Query.livingStandard" */
  operation: string;
  /**
   * Sparse fieldset filter — only emit code for the listed output fields.
   * Supports dot-separated paths and a trailing `*` wildcard.
   * Omit or pass an empty array to compile all output fields.
   */
  requestedFields?: string[];
}

export interface CompileResult {
  /** Generated JavaScript source code */
  code: string;
  /** The exported function name */
  functionName: string;
  /** The function body (without the function signature wrapper) */
  functionBody: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const SELF_MODULE = "_";

/** Safe JS identifier from a bridge handle name. */
function safeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

/** Safe JS string literal (single-quoted). */
function jsStr(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/**
 * Build a tool function lookup expression.
 * For dotted names like "vendor.sub.api", generates both a nested optional
 * chain (`tools?.["vendor"]?.["sub"]?.["api"]`) and a flat-key fallback
 * (`tools?.["vendor.sub.api"]`) so that either tools shape is accepted.
 * Single-segment names produce a plain bracket access.
 */
function buildToolLookupExpr(fnName: string): string {
  const segments = fnName.split(".");
  if (segments.length <= 1) return `tools[${jsStr(fnName)}]`;
  // Use double-quoted bracket notation: tools?.["a"]?.["b"]
  const dqSeg = (s: string) =>
    `["${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  const nested = `tools?.${segments.map(dqSeg).join("?.")}`;
  const flat = `tools?.${dqSeg(fnName)}`;
  return `(${nested} ?? ${flat})`;
}

/** Emit a JS object literal for a SourceLocation. */
function jsLoc(loc: {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}): string {
  return `{startLine:${loc.startLine},startColumn:${loc.startColumn},endLine:${loc.endLine},endColumn:${loc.endColumn}}`;
}

/**
 * Recursively check if a statement body (or any nested body) contains
 * break or continue control flow expressions. Used to decide whether
 * the sentinel check in array loops can be elided.
 */
function bodyHasControlFlow(body: Statement[]): boolean {
  for (const stmt of body) {
    if (stmt.kind === "scope") {
      if (bodyHasControlFlow(stmt.body)) return true;
      continue;
    }
    const sources: WireSourceEntry[] | undefined =
      "sources" in stmt ? stmt.sources : undefined;
    if (sources) {
      for (const src of sources) {
        if (exprHasControlFlow(src.expr)) return true;
      }
    }
    const wireCatch: WireCatch | undefined =
      "catch" in stmt ? (stmt as any).catch : undefined;
    if (wireCatch && "control" in wireCatch) {
      const k = wireCatch.control.kind;
      if (k === "break" || k === "continue") return true;
    }
  }
  return false;
}

function exprHasControlFlow(expr: Expression): boolean {
  switch (expr.type) {
    case "control":
      return expr.control.kind === "break" || expr.control.kind === "continue";
    case "ternary":
      return (
        exprHasControlFlow(expr.cond) ||
        exprHasControlFlow(expr.then) ||
        exprHasControlFlow(expr.else)
      );
    case "and":
    case "or":
    case "binary":
      return exprHasControlFlow(expr.left) || exprHasControlFlow(expr.right);
    case "concat":
      return expr.parts.some(exprHasControlFlow);
    case "array":
      return bodyHasControlFlow(expr.body);
    default:
      return false;
  }
}

/**
 * Compile a NodeRef path access into JS property access.
 * e.g. ref with path ["data", "items"] → `.data.items`
 * Handles rootSafe (?.) and pathSafe per-segment.
 *
 * Bridge `?.` has segment-local semantics: `a?.b.c` means "if a is nullish,
 * substitute undefined for .b, then access .c normally (may throw)".
 * JS `?.` short-circuits the entire chain instead, so when a safe segment
 * is followed by a non-safe segment we must generate a __getPath helper call.
 *
 * When `baseExpr` is provided and mixed safe/non-safe is detected, returns
 * a complete expression `__getPath(base, [...], [...])` instead of a suffix.
 * Otherwise returns a property-access suffix string.
 */
function emitPath(
  ref: NodeRef,
  startIdx = 0,
  forceRootSafe = false,
  baseExpr?: string,
): string {
  const pathSlice = ref.path.slice(startIdx);
  if (pathSlice.length === 0) return "";

  // Build per-segment safe flags
  const safes = pathSlice.map((_, i) => {
    const idx = i + startIdx;
    return !!(
      ref.pathSafe?.[idx] ||
      (idx === 0 && (ref.rootSafe || forceRootSafe))
    );
  });

  // Detect safe→non-safe transition
  let hasMixedSafe = false;
  for (let i = 0; i < pathSlice.length - 1; i++) {
    if (safes[i]) {
      for (let j = i + 1; j < pathSlice.length; j++) {
        if (!safes[j]) {
          hasMixedSafe = true;
          break;
        }
      }
      if (hasMixedSafe) break;
    }
  }

  if (hasMixedSafe && baseExpr) {
    // Use __getPath helper for Bridge's segment-local safe navigation
    const segs = pathSlice.map((s) => jsStr(s)).join(", ");
    const flags = safes.join(", ");
    return `__getPath(${baseExpr}, [${segs}], [${flags}])`;
  }

  // Use __getPath for multi-segment paths to match runtime primitive-check semantics
  if (pathSlice.length >= 2 && baseExpr) {
    const segs = pathSlice.map((s) => jsStr(s)).join(", ");
    const flags = safes.join(", ");
    return `__getPath(${baseExpr}, [${segs}], [${flags}])`;
  }

  // Standard path emission
  let code = "";
  for (let i = startIdx; i < ref.path.length; i++) {
    const seg = ref.path[i]!;
    const safe =
      ref.pathSafe?.[i] || (i === 0 && (ref.rootSafe || forceRootSafe));
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(seg)) {
      code += safe ? "?." : ".";
      code += seg;
    } else {
      code += safe ? "?." : "";
      code += `[${jsStr(seg)}]`;
    }
  }
  return code;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ── Scope-based code generator ──────────────────────────────────────────────

/**
 * Tracks what bindings are visible in the current scope.
 * Each scope can shadow parent bindings.
 */
interface ScopeBinding {
  kind:
    | "tool"
    | "input"
    | "output"
    | "context"
    | "const"
    | "define"
    | "alias"
    | "iterator";
  /** JS expression to access this binding's value */
  jsExpr: string;
  /** For tools: the tool function name for lookup */
  toolName?: string;
  /** For tools: cached __toolFn_ variable referencing tools['name'] */
  toolFnExpr?: string;
  /** For defines: the define name for lookup */
  defineName?: string;
  /** For tools: whether this is memoized */
  memoize?: boolean;
  /** For tools: the tool instance identifier */
  instanceKey?: string;
}

class ScopeChain {
  private bindings = new Map<string, ScopeBinding>();
  constructor(private parent?: ScopeChain) {}

  set(handle: string, binding: ScopeBinding) {
    this.bindings.set(handle, binding);
  }

  get(handle: string): ScopeBinding | undefined {
    return this.bindings.get(handle) ?? this.parent?.get(handle);
  }

  /** Find a tool binding by tool name (not handle name), with instance matching. */
  findTool(
    toolName: string,
    instance: number | undefined,
  ): ScopeBinding | undefined {
    let instanceCount = 0;
    for (const [, binding] of this.bindings) {
      if (binding.kind === "tool" && binding.toolName === toolName) {
        instanceCount++;
        if (!instance || instanceCount === instance) {
          return binding;
        }
      }
    }
    return this.parent?.findTool(toolName, instance);
  }

  child(): ScopeChain {
    return new ScopeChain(this);
  }
}

class CodegenContext {
  private bridge: Bridge;
  private constDefs: Map<string, string>;
  private toolDefs: Map<string, ToolDef>;
  private defineDefs: Map<string, DefineDef>;
  private toolDefCache = new Map<string, ToolDef | null>();
  private toolGetterCount = 0;
  private lines: string[] = [];
  private indent = 1; // start inside function body
  private iteratorStack: { iterVar: string; outVar: string }[] = [];
  private arrayDepthCounter = 0;
  private overdefCount = 0;
  private needsToolCostHelper = false;
  private needsBatchHelper = false;
  private currentBatchQueue: string | undefined;
  private requestedFields: string[] | undefined;
  private parallelBatchCount = 0;
  /**
   * Map from tool getter name → memo map variable name.
   * Populated during emitToolGetters for memoized-in-loop tools.
   * The Maps are emitted at function scope via post-processing.
   */
  private memoMapForGetter = new Map<string, string>();
  private memoMapCounter = 0;
  /** List of memo map variable names to inject at function scope. */
  private memoMapDeclarations: string[] = [];
  /**
   * When set inside an array loop body, compileSourceChainWithLoc uses a
   * shared loc-index variable + single try/catch instead of per-wire IIFEs.
   * Locs are precomputed in an array; only an integer index is written per-access.
   */
  private loopLocInfo:
    | { indexVar: string; locsVar: string; locs: string[] }
    | undefined;

  constructor(
    bridge: Bridge,
    constDefs: Map<string, string>,
    toolDefs: Map<string, ToolDef>,
    defineDefs: Map<string, DefineDef>,
    requestedFields?: string[],
  ) {
    this.bridge = bridge;
    this.constDefs = constDefs;
    this.toolDefs = toolDefs;
    this.defineDefs = defineDefs;
    this.requestedFields = requestedFields;
  }

  /** Get the scoped memo map variable for a memoized loop tool getter. */
  private getMemoMapVar(getterName: string): string | undefined {
    return this.memoMapForGetter.get(getterName);
  }

  /**
   * Resolve a ToolDef by name, walking the extends chain.
   * Mirrors the runtime's resolveToolDefByName logic:
   * - fn from root (chain[0])
   * - handles deduplicated (first-seen wins)
   * - body accumulated root → leaf
   * - onError last wins
   */
  private resolveToolDef(name: string): ToolDef | undefined {
    if (this.toolDefCache.has(name))
      return this.toolDefCache.get(name) ?? undefined;

    const base = this.toolDefs.get(name);
    if (!base) {
      this.toolDefCache.set(name, null);
      return undefined;
    }

    // Build extends chain: root → ... → leaf
    const chain: ToolDef[] = [base];
    let current = base;
    while (current.extends) {
      const parent = this.toolDefs.get(current.extends);
      if (!parent) break;
      chain.unshift(parent);
      current = parent;
    }

    // Merge
    const merged: ToolDef = {
      kind: "tool",
      name,
      fn: chain[0]!.fn,
      handles: [],
      body: [],
    };
    for (const def of chain) {
      for (const h of def.handles) {
        if (!merged.handles.some((mh) => mh.handle === h.handle))
          merged.handles.push(h);
      }
      if (def.body) merged.body.push(...def.body);
      if (def.onError) merged.onError = def.onError;
    }

    this.toolDefCache.set(name, merged);
    return merged;
  }

  compile(): CompileResult {
    const funcName = `${this.bridge.type}_${this.bridge.field}`;

    // Build root scope from bridge handles
    const rootScope = new ScopeChain();

    // Register non-tool/define handle bindings.
    // Tools and defines are registered by compileBody → registerWithBinding
    // when their actual scope is compiled, so we skip them here to avoid
    // polluting the root scope with nested (loop-scoped) handles.
    for (const h of this.bridge.handles) {
      switch (h.kind) {
        case "input":
          rootScope.set(h.handle, { kind: "input", jsExpr: "input" });
          break;
        case "output":
          rootScope.set(h.handle, { kind: "output", jsExpr: "__output" });
          break;
        case "context":
          rootScope.set(h.handle, { kind: "context", jsExpr: "context" });
          break;
        case "const": {
          rootScope.set(h.handle, { kind: "const", jsExpr: "__consts" });
          break;
        }
      }
    }

    // Emit preamble
    this.emit("// --- AOT compiled (lazy-getter pull-based) ---");
    this.emit("const __trace = __opts?.__trace;");
    this.emit("const __wrapErr = __opts?.__wrapBridgeRuntimeError;");
    this.emit(
      "const __isFatal = (__e) => __e?.name === 'BridgePanicError' || __e?.name === 'BridgeAbortError';",
    );
    this.emit(
      "const __toolCtx = { logger: __opts?.logger || {}, signal: __opts?.signal };",
    );
    this.emit("const __PanicError = __opts?.__BridgePanicError || Error;");
    this.emit("const __AbortError = __opts?.__BridgeAbortError || Error;");
    this.emit("const __timeoutMs = __opts?.toolTimeoutMs ?? 0;");
    this.emit("const __TimeoutError = __opts?.__BridgeTimeoutError;");
    this.emit(
      "const __checkAbort = () => { if (__opts?.signal?.aborted) throw new __AbortError(); };",
    );
    this.emit("const __str = (__v) => __v == null ? '' : String(__v);");
    this.emit(
      "const __catchSafe = (__e) => { if (__isFatal(__e)) throw __e; return undefined; };",
    );
    this.emit("__checkAbort();");
    this.emitMemoHelper();
    this.emitPipeHelper();
    this.emitGetPathHelper();
    this.emitStableKeyHelper();
    this.emitConsts();
    this.emitToolLookups(rootScope);
    this.emit("let __output = {};");
    this.emit("");

    // If the bridge body has no output wires (recursively), emit a runtime throw.
    if (!this.hasAnyOutputWires(this.bridge.body)) {
      this.emit(
        `throw new Error("Bridge '${this.bridge.type}.${this.bridge.field}' has no output wires.");`,
      );
    }

    // Compile the bridge body
    this.compileBody(this.bridge.body, rootScope, "__output");

    this.emit("");
    this.emit("return __output;");

    // Insert tool cost helper at the preamble position if needed
    if (this.needsToolCostHelper) {
      const helperLines = [
        "  function __toolCost(fn) {",
        "    const m = fn?.bridge;",
        "    if (m?.cost != null) return m.cost;",
        "    return m?.sync ? 1 : 2;",
        "  }",
        "",
      ];
      // Insert after the __pipe helper (after the first empty line after preamble block)
      const insertIdx = this.lines.findIndex(
        (l, i) => i > 5 && l.trim() === "" && this.lines[i - 1]?.trim() === "}",
      );
      if (insertIdx >= 0) {
        this.lines.splice(insertIdx + 1, 0, ...helperLines);
      }
    }

    // Insert batch helper at preamble position if needed
    if (this.needsBatchHelper) {
      const helperLines = [
        "  function __callBatched(__fn, __input, __bq, __toolName, __fnName, __doTrace) {",
        "    if (!__fn?.bridge?.batch) return __fn(__input, __toolCtx);",
        "    let __q = __bq.get(__fn);",
        "    if (!__q) {",
        "      __q = [];",
        "      __bq.set(__fn, __q);",
        "      queueMicrotask(async () => {",
        "        __bq.delete(__fn);",
        "        const __items = __q;",
        "        const __inputs = __items.map(__i => __i.input);",
        "        const __start = __doTrace ? performance.now() : 0;",
        "        try {",
        "          const __results = await __fn(__inputs, __toolCtx);",
        "          const __dur = performance.now() - __start;",
        "          if (__doTrace) __trace(__toolName, __fnName, __start, __start + __dur, __inputs, __results, null);",
        "          const __logLevel = __fn.bridge?.log?.execution;",
        "          if (__logLevel) __toolCtx.logger?.[__logLevel]?.({ tool: __toolName, fn: __fnName, durationMs: __dur }, '[bridge] tool completed');",
        "          if (!Array.isArray(__results) || __results.length !== __items.length) {",
        "            const __e = new Error('Batch tool \"' + __fnName + '\" returned ' + (Array.isArray(__results) ? __results.length : typeof __results) + ' items, expected ' + __items.length);",
        "            for (const __it of __items) __it.reject(__e);",
        "            return;",
        "          }",
        "          for (let __i = 0; __i < __items.length; __i++) {",
        "            if (__results[__i] instanceof Error) __items[__i].reject(__results[__i]);",
        "            else __items[__i].resolve(__results[__i]);",
        "          }",
        "        } catch (__e) {",
        "          const __dur = performance.now() - __start;",
        "          if (__doTrace) __trace(__toolName, __fnName, __start, __start + __dur, __inputs, null, __e);",
        "          const __logLevel = __fn.bridge?.log?.errors;",
        "          if (__logLevel) __toolCtx.logger?.[__logLevel]?.({ tool: __toolName, fn: __fnName, err: __e?.message }, '[bridge] tool failed');",
        "          for (const __it of __items) __it.reject(__e);",
        "        }",
        "      });",
        "    }",
        "    return new Promise((__resolve, __reject) => {",
        "      __q.push({ input: __input, resolve: __resolve, reject: __reject });",
        "    });",
        "  }",
        "",
      ];
      const insertIdx = this.lines.findIndex(
        (l, i) => i > 5 && l.trim() === "" && this.lines[i - 1]?.trim() === "}",
      );
      if (insertIdx >= 0) {
        this.lines.splice(insertIdx + 1, 0, ...helperLines);
      }
    }

    // Insert memoization Maps at function scope (before "let __output = {};")
    if (this.memoMapDeclarations.length > 0) {
      const mapLines = this.memoMapDeclarations.map(
        (v) => `  const ${v} = new Map();`,
      );
      const insertIdx = this.lines.findIndex(
        (l) => l.trim() === "let __output = {};",
      );
      if (insertIdx >= 0) {
        this.lines.splice(insertIdx, 0, ...mapLines);
      }
    }

    const functionBody = this.lines.join("\n");
    const header =
      "// " +
      "\u2500".repeat(62) +
      "\n" +
      "//          GENERATED FILE \u2014 DO NOT EDIT DIRECTLY\n" +
      "// " +
      "\u2500".repeat(62) +
      "\n";
    const code =
      header +
      `export default async function ${funcName}(input, tools, context, __opts) {\n` +
      functionBody +
      "\n}";

    return { code, functionName: funcName, functionBody };
  }

  // ── Emit helpers ──────────────────────────────────────────────────────

  private emit(line: string) {
    const pad = "  ".repeat(this.indent);
    this.lines.push(pad + line);
  }

  private pushIndent() {
    this.indent++;
  }
  private popIndent() {
    this.indent--;
  }

  // ── Preamble ──────────────────────────────────────────────────────────

  private emitMemoHelper() {
    this.emit("function __memoize(fn, name) {");
    this.pushIndent();
    this.emit("let cached; let active = false;");
    this.emit(
      "return () => { if (cached) return cached; if (active) throw new __PanicError('Circular dependency detected: \"' + (name || '?') + '\" depends on itself'); active = true; return (cached = fn()); };",
    );
    this.popIndent();
    this.emit("}");
    this.emit("");
  }

  private emitPipeHelper() {
    this.emit("async function __pipe(__fn, __name, __fnName, __input) {");
    this.pushIndent();
    this.emit(
      "if (typeof __fn !== \"function\") throw new Error('No tool found for \"' + __fnName + '\"');",
    );
    this.emit(
      "const __doTrace = __trace && (!__fn?.bridge || __fn.bridge.trace !== false);",
    );
    this.emit("const __start = __doTrace ? performance.now() : 0;");
    this.emit("try {");
    this.pushIndent();
    this.emit("let __raw = __fn(__input, __toolCtx);");
    this.emit(
      "if (__timeoutMs > 0 && __raw && typeof __raw.then === 'function') {",
    );
    this.pushIndent();
    this.emit("let __timer;");
    this.emit(
      "const __tout = new Promise((_, rej) => { __timer = setTimeout(() => rej(new (__TimeoutError || Error)(__fnName, __timeoutMs)), __timeoutMs); });",
    );
    this.emit(
      "__raw = Promise.race([__raw, __tout]).finally(() => clearTimeout(__timer));",
    );
    this.popIndent();
    this.emit("}");
    this.emit("const __result = await __raw;");
    this.emit(
      "if (__doTrace) __trace(__name, __fnName, __start, performance.now(), __input, __result, null);",
    );
    this.emit("return __result;");
    this.popIndent();
    this.emit("} catch (__err) {");
    this.pushIndent();
    this.emit(
      "if (__doTrace) __trace(__name, __fnName, __start, performance.now(), __input, null, __err);",
    );
    this.emit("throw __err;");
    this.popIndent();
    this.emit("}");
    this.popIndent();
    this.emit("}");
    this.emit("");
  }

  /**
   * Emit __getPath helper for Bridge's segment-local safe navigation.
   * Matches runtime getPath semantics: ?. only makes the immediately
   * following segment safe; subsequent non-safe segments throw normally.
   */
  private emitGetPathHelper() {
    this.emit("function __getPath(__obj, __segs, __safe) {");
    this.pushIndent();
    this.emit("let __c = __obj;");
    this.emit("for (let __i = 0; __i < __segs.length; __i++) {");
    this.pushIndent();
    this.emit("if (__c == null) {");
    this.pushIndent();
    this.emit("if (__safe[__i]) { __c = undefined; continue; }");
    this.emit("return __c[__segs[__i]];");
    this.popIndent();
    this.emit("}");
    // Match runtime: primitives where property access yields undefined must throw
    this.emit(
      'const __isPrim = typeof __c !== "object" && typeof __c !== "function";',
    );
    this.emit("const __next = __c[__segs[__i]];");
    this.emit("if (__isPrim && __next === undefined) {");
    this.pushIndent();
    this.emit("if (__safe[__i]) { __c = undefined; continue; }");
    this.emit(
      "throw new TypeError(`Cannot read properties of ${String(__c)} (reading '${__segs[__i]}')`);",
    );
    this.popIndent();
    this.emit("}");
    this.emit("__c = __next;");
    this.popIndent();
    this.emit("}");
    this.emit("return __c;");
    this.popIndent();
    this.emit("}");
    this.emit("");
  }

  private emitStableKeyHelper() {
    this.emit("function __stableKey(v) {");
    this.pushIndent();
    this.emit("if (v == null) return v === null ? 'n' : 'u';");
    this.emit("if (typeof v === 'boolean') return v ? 'T' : 'F';");
    this.emit(
      "if (typeof v === 'number' || typeof v === 'bigint') return typeof v === 'number' ? 'd:' + v : 'B:' + v;",
    );
    this.emit("if (typeof v === 'string') return 's:' + v;");
    this.emit(
      "if (Array.isArray(v)) return '[' + v.map(__stableKey).join(',') + ']';",
    );
    this.emit(
      "if (typeof v === 'object') { const ks = Object.keys(v).sort(); return '{' + ks.map(k => k + ':' + __stableKey(v[k])).join(',') + '}'; }",
    );
    this.emit("return String(v);");
    this.popIndent();
    this.emit("}");
    this.emit("");
  }

  private emitConsts() {
    if (this.constDefs.size === 0) return;
    this.emit("const __consts = {");
    this.pushIndent();
    for (const [name, value] of this.constDefs) {
      this.emit(`${safeId(name)}: ${value},`);
    }
    this.popIndent();
    this.emit("};");
    this.emit("");
  }

  private emitToolLookups(_scope: ScopeChain) {
    // Tool lookups are emitted by registerWithBinding during compileBody.
    // This method is kept as a no-op for structural clarity.
    this.emit("");
  }

  // ── Body compilation ──────────────────────────────────────────────────

  private compileBody(
    body: Statement[],
    scope: ScopeChain,
    outputVar: string,
    pathPrefix: string[] = [],
    absolutePrefix: string[] = [],
  ) {
    // First pass: register any `with` bindings in this scope
    for (const stmt of body) {
      if (stmt.kind === "with") {
        this.registerWithBinding(stmt, scope);
      }
    }

    // Collect tool handles declared in this body's `with` statements
    const localToolHandles = new Set<string>();
    for (const stmt of body) {
      if (stmt.kind === "with" && stmt.binding.kind === "tool") {
        localToolHandles.add(stmt.binding.handle);
      }
    }

    // Build a map of tool handles → input wires for memoized tool getters
    const toolInputs = this.collectToolInputs(body, scope);

    // Ensure ALL local tool handles get memoized getters for tracing & memoization,
    // even when they have no bridge input wires or ToolDef body.
    for (const handle of localToolHandles) {
      if (!toolInputs.has(handle)) {
        toolInputs.set(handle, []);
      }
    }

    // Collect define input wires
    const defineInputs = this.collectDefineInputs(body, scope);

    // Emit memoized tool getters for this scope
    this.emitToolGetters(toolInputs, scope);

    // Emit memoized define getters for this scope
    this.emitDefineGetters(defineInputs, scope);

    // Group output-targeting wires by target path for overdefinition handling
    const outputWireGroups = this.groupOutputWiresByPath(
      body,
      scope,
      pathPrefix,
    );
    const emittedPaths = new Set<string>();

    // Second pass: compile wires, scopes, force statements.
    // Batch consecutive output wires for parallel execution via Promise.all.
    // Force statements are deferred until after output wires (matching runtime
    // semantics where force runs concurrently with output resolution).
    let pendingWires: {
      valueExpr: string;
      targetExpr: string;
      isRoot: boolean;
      locExpr?: string;
    }[] = [];
    const deferredForces: ForceStatement[] = [];
    const flushPending = () => {
      if (pendingWires.length === 0) return;
      this.emitParallelAssignments(
        pendingWires.map((w) => ({
          expr: w.valueExpr,
          locExpr: w.locExpr,
          assign: (v: string) =>
            w.isRoot
              ? `Object.assign(${outputVar}, ${v});`
              : `${w.targetExpr} = ${v};`,
        })),
      );
      pendingWires = [];
    };

    for (const stmt of body) {
      switch (stmt.kind) {
        case "wire": {
          // Skip tool input wires (handled by tool getters)
          const handleName = this.findTargetHandle(stmt.target, scope);
          if (handleName) {
            const binding = scope.get(handleName);
            if (binding?.kind === "tool") break;
          }

          // Skip define input wires (handled by define getters)
          if (stmt.target.module.startsWith("__define_")) break;

          // requestedFields filtering: skip output wires for unrequested fields
          if (this.requestedFields && this.requestedFields.length > 0) {
            const pathKey = this.wireOutputPathKey(stmt.target, pathPrefix);
            if (pathKey !== undefined) {
              const absolutePath = [...absolutePrefix, ...pathKey.split(".")]
                .filter(Boolean)
                .join(".");
              if (
                absolutePath &&
                !matchesRequestedFields(absolutePath, this.requestedFields)
              )
                break;
            }
          }

          // Overdefinition: emit grouped wires on first encounter
          {
            const pathKey = this.wireOutputPathKey(stmt.target, pathPrefix);
            if (pathKey !== undefined) {
              const group = outputWireGroups.get(pathKey);
              if (group && group.length > 1) {
                if (!emittedPaths.has(pathKey)) {
                  emittedPaths.add(pathKey);
                  flushPending();
                  this.compileOverdefinedWires(
                    group,
                    scope,
                    outputVar,
                    pathPrefix,
                  );
                }
                break;
              }
            }
          }

          // Single wire — collect for parallel execution
          {
            const isArrayWire =
              stmt.sources.length === 1 &&
              stmt.sources[0]!.expr.type === "array";
            if (isArrayWire) {
              flushPending();
              this.compileWire(
                stmt,
                scope,
                outputVar,
                pathPrefix,
                absolutePrefix,
              );
            } else {
              const target = stmt.target;
              const targetExpr = this.compileTargetRef(
                target,
                scope,
                outputVar,
                pathPrefix,
              );
              // Use raw compileSourceChain (no IIFE wrapping) and capture loc
              // separately. emitParallelAssignments will annotate errors with
              // bridgeLoc at the batch level — avoiding per-expression async
              // IIFE closures in the hot path.
              const hasLoc = stmt.sources.some((s) => s.expr.loc);
              const locExpr =
                hasLoc && !stmt.catch
                  ? stmt.sources.length === 1 && stmt.sources[0]!.expr.loc
                    ? jsLoc(stmt.sources[0]!.expr.loc)
                    : undefined
                  : undefined;
              const valueExpr = locExpr
                ? this.compileSourceChain(stmt.sources, stmt.catch, scope)
                : this.compileSourceChainWithLoc(
                    stmt.sources,
                    stmt.catch,
                    scope,
                  );
              const isRoot =
                target.module === SELF_MODULE &&
                target.type === this.bridge.type &&
                target.field === this.bridge.field &&
                target.path.length === 0 &&
                pathPrefix.length === 0;
              pendingWires.push({ valueExpr, targetExpr, isRoot, locExpr });
            }
          }
          break;
        }
        case "alias":
          flushPending();
          this.compileAlias(stmt, scope);
          break;
        case "scope": {
          // Skip scope blocks targeting tools (handled by tool getters)
          const scopeHandle = this.findTargetHandle(stmt.target, scope);
          if (scopeHandle) {
            const scopeBinding = scope.get(scopeHandle);
            if (scopeBinding?.kind === "tool") break;
          }
          flushPending();
          this.compileScope(stmt, scope, outputVar, pathPrefix, absolutePrefix);
          break;
        }
        case "spread":
          flushPending();
          this.compileSpread(stmt, scope, outputVar);
          break;
        case "force":
          // Defer force statements until after output wires
          deferredForces.push(stmt);
          break;
        case "with":
          // Already handled in first pass
          break;
      }
    }
    flushPending();

    // Emit deferred force statements after all output wires
    for (const stmt of deferredForces) {
      this.compileForce(stmt, scope);
    }
  }

  private registerWithBinding(stmt: WithStatement, scope: ScopeChain) {
    const h = stmt.binding;
    switch (h.kind) {
      case "input":
        scope.set(h.handle, { kind: "input", jsExpr: "input" });
        break;
      case "output":
        scope.set(h.handle, { kind: "output", jsExpr: "__output" });
        break;
      case "context":
        scope.set(h.handle, { kind: "context", jsExpr: "context" });
        break;
      case "const":
        scope.set(h.handle, { kind: "const", jsExpr: "__consts" });
        break;
      case "tool": {
        const toolId = safeId(h.handle) + "_" + this.toolGetterCount++;
        const toolFnVar = `__toolFn_${toolId}`;
        scope.set(h.handle, {
          kind: "tool",
          jsExpr: toolFnVar,
          toolName: h.name,
          toolFnExpr: toolFnVar,
          memoize: h.memoize === true || undefined,
        });
        // Emit tool function lookup — resolve fn through ToolDef extends chain
        const toolDef = this.resolveToolDef(h.name);
        const fnName = toolDef?.fn ?? h.name;
        this.emit(`const ${toolFnVar} = ${buildToolLookupExpr(fnName)};`);
        break;
      }
      case "define":
        scope.set(h.handle, {
          kind: "define",
          jsExpr: `__define_${safeId(h.handle)}`,
          defineName: h.name,
        });
        break;
    }
  }

  // ── Tool input collection ─────────────────────────────────────────────

  /**
   * Collect all wire statements that target tool inputs in this scope level.
   * Returns a map: toolHandle → [{ inputField, sourceExpr }]
   */
  private collectToolInputs(
    body: Statement[],
    scope: ScopeChain,
  ): Map<string, { field: string; stmt: WireStatement }[]> {
    const map = new Map<string, { field: string; stmt: WireStatement }[]>();

    const addEntry = (
      handleName: string,
      field: string,
      stmt: WireStatement,
    ) => {
      let entries = map.get(handleName);
      if (!entries) {
        entries = [];
        map.set(handleName, entries);
      }
      entries.push({ field, stmt });
    };

    const collectFromScope = (
      stmts: Statement[],
      handleName: string,
      pathPrefix: string[],
    ) => {
      for (const inner of stmts) {
        if (inner.kind === "wire") {
          const field = [...pathPrefix, ...inner.target.path].join(".");
          addEntry(handleName, field, inner);
        } else if (inner.kind === "scope") {
          collectFromScope(inner.body, handleName, [
            ...pathPrefix,
            ...inner.target.path,
          ]);
        }
      }
    };

    for (const stmt of body) {
      if (stmt.kind === "wire") {
        const target = stmt.target;
        const handleName = this.findTargetHandle(target, scope);
        if (!handleName) continue;
        const binding = scope.get(handleName);
        if (!binding || binding.kind !== "tool") continue;
        const field = target.path.join(".");
        addEntry(handleName, field, stmt);
      } else if (stmt.kind === "scope") {
        // Check if the scope targets a tool (instance != null)
        const handleName = this.findTargetHandle(stmt.target, scope);
        if (!handleName) continue;
        const binding = scope.get(handleName);
        if (!binding || binding.kind !== "tool") continue;
        collectFromScope(stmt.body, handleName, stmt.target.path);
      }
    }

    return map;
  }

  /**
   * Collect all wire statements that target define inputs.
   * Define input wires have target.module starting with "__define_".
   */
  private collectDefineInputs(
    body: Statement[],
    _scope: ScopeChain,
  ): Map<string, { field: string; stmt: WireStatement }[]> {
    const map = new Map<string, { field: string; stmt: WireStatement }[]>();

    for (const stmt of body) {
      if (stmt.kind !== "wire") continue;
      if (!stmt.target.module.startsWith("__define_")) continue;

      // Extract handle name from module: "__define_sp" → "sp"
      const handleName = stmt.target.module.substring("__define_".length);
      let entries = map.get(handleName);
      if (!entries) {
        entries = [];
        map.set(handleName, entries);
      }

      const field = stmt.target.path.join(".");
      entries.push({ field, stmt });
    }

    return map;
  }

  /**
   * Emit memoized define getters for this scope.
   * Each define getter compiles the define body inline, using bridge wires as input.
   */
  private emitDefineGetters(
    defineInputs: Map<string, { field: string; stmt: WireStatement }[]>,
    scope: ScopeChain,
  ) {
    // Also emit getters for defines that have 0 input wires
    // (they might still be referenced as sources)
    for (const h of this.bridge.handles) {
      if (h.kind === "define" && !defineInputs.has(h.handle)) {
        defineInputs.set(h.handle, []);
      }
    }

    for (const [handleName, inputs] of defineInputs) {
      const binding = scope.get(handleName);
      if (!binding || binding.kind !== "define") continue;

      const defineName = binding.defineName ?? handleName;
      const defineDef = this.defineDefs.get(defineName);
      if (!defineDef) continue;

      const getterId = safeId(handleName) + "_def_" + this.toolGetterCount++;
      const getterName = `__get_${getterId}`;

      const defineKey = `_:Define:${defineName}`;
      this.emit(`const ${getterName} = __memoize(async () => {`);
      this.pushIndent();

      // Build define input from bridge wires
      this.emit("const __defInput = {};");
      const singleFields: { field: string; expr: string }[] = [];
      for (const { field, stmt } of inputs) {
        const valueExpr = this.compileSourceChain(
          stmt.sources,
          stmt.catch,
          scope,
        );
        if (field === "") {
          this.emit(`Object.assign(__defInput, ${valueExpr});`);
        } else {
          singleFields.push({ field, expr: valueExpr });
        }
      }
      this.emitParallelAssignments(
        singleFields.map((f) => ({
          expr: f.expr,
          assign: (v: string) => `__defInput[${jsStr(f.field)}] = ${v};`,
        })),
      );

      // Compile define body in a child scope
      this.emit("const __defOutput = {};");
      const defScope = scope.child();

      // Register marker for Define-type refs so compileRefExpr can resolve them
      defScope.set("__defineInput_" + defineName, {
        kind: "input",
        jsExpr: "__defInput",
      });

      // Register define body handles
      for (const stmt of defineDef.body) {
        if (stmt.kind === "with") {
          const h = stmt.binding;
          switch (h.kind) {
            case "input":
              defScope.set(h.handle, { kind: "input", jsExpr: "__defInput" });
              break;
            case "output":
              defScope.set(h.handle, {
                kind: "output",
                jsExpr: "__defOutput",
              });
              break;
            case "context":
              defScope.set(h.handle, { kind: "context", jsExpr: "context" });
              break;
            case "const":
              defScope.set(h.handle, { kind: "const", jsExpr: "__consts" });
              break;
            case "tool": {
              const toolId = safeId(h.handle) + "_" + this.toolGetterCount++;
              const toolFnVar = `__toolFn_${toolId}`;
              defScope.set(h.handle, {
                kind: "tool",
                jsExpr: toolFnVar,
                toolName: h.name,
                toolFnExpr: toolFnVar,
                memoize: h.memoize === true || undefined,
              });
              // Resolve fn through ToolDef extends chain
              const innerToolDef = this.resolveToolDef(h.name);
              const fnName = innerToolDef?.fn ?? h.name;
              this.emit(`const ${toolFnVar} = ${buildToolLookupExpr(fnName)};`);
              break;
            }
            case "define":
              defScope.set(h.handle, {
                kind: "define",
                jsExpr: `__define_${safeId(h.handle)}`,
                defineName: h.name,
              });
              break;
          }
        }
      }

      // The define body is compiled like a mini-bridge, but with
      // __defInput as input and __defOutput as output.
      // We temporarily override the bridge's type/field context for
      // target resolution.
      this.compileDefineBody(defineDef.body, defScope, "__defOutput");

      this.emit("return __defOutput;");
      this.popIndent();
      this.emit(`}, ${jsStr(defineKey)});`);

      // Update the scope binding to use this getter
      binding.jsExpr = getterName;
    }
  }

  /**
   * Compile a define body — like compileBody but uses the define's
   * input/output handles instead of the bridge's.
   */
  private compileDefineBody(
    body: Statement[],
    scope: ScopeChain,
    outputVar: string,
  ) {
    // Collect tool inputs within the define body
    const toolInputs = this.collectDefineToolInputs(body, scope);

    // Emit tool getters for the define scope
    this.emitToolGetters(toolInputs, scope);

    // Compile wires targeting define output
    for (const stmt of body) {
      if (stmt.kind === "wire") {
        // Skip tool input wires (handled by tool getters)
        const handleName = this.findDefineTargetHandle(
          stmt.target,
          scope,
          body,
        );
        if (handleName) {
          const binding = scope.get(handleName);
          if (binding?.kind === "tool") continue;
        }

        // Skip define input wires
        if (stmt.target.module.startsWith("__define_")) continue;

        // This is an output wire in the define
        const targetExpr = this.compileDefineTargetRef(
          stmt.target,
          scope,
          outputVar,
        );
        const valueExpr = this.compileSourceChainWithLoc(
          stmt.sources,
          stmt.catch,
          scope,
        );
        this.emit(`${targetExpr} = ${valueExpr};`);
      }
    }
  }

  /**
   * Collect tool input wires within a define body.
   */
  private collectDefineToolInputs(
    body: Statement[],
    scope: ScopeChain,
  ): Map<string, { field: string; stmt: WireStatement }[]> {
    const map = new Map<string, { field: string; stmt: WireStatement }[]>();

    for (const stmt of body) {
      if (stmt.kind !== "wire") continue;
      const handleName = this.findDefineTargetHandle(stmt.target, scope, body);
      if (!handleName) continue;

      const binding = scope.get(handleName);
      if (!binding || binding.kind !== "tool") continue;

      let entries = map.get(handleName);
      if (!entries) {
        entries = [];
        map.set(handleName, entries);
      }
      entries.push({ field: stmt.target.path.join("."), stmt });
    }

    return map;
  }

  /**
   * Find which handle a target node ref matches in a define body.
   * Similar to findTargetHandle but uses the define's handles from body.
   */
  private findDefineTargetHandle(
    target: NodeRef,
    _scope: ScopeChain,
    body: Statement[],
  ): string | undefined {
    let instanceCount = 0;
    for (const stmt of body) {
      if (stmt.kind !== "with") continue;
      const h = stmt.binding;
      if (h.kind === "tool") {
        const refName =
          target.module === SELF_MODULE
            ? target.field
            : `${target.module}.${target.field}`;
        const matches = refName === h.name;
        if (matches) {
          instanceCount++;
          if (!target.instance || instanceCount === target.instance) {
            return h.handle;
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Compile a target ref in a define body's output context.
   */
  private compileDefineTargetRef(
    target: NodeRef,
    _scope: ScopeChain,
    outputVar: string,
  ): string {
    // All output wires in a define body target the define's output
    const path = target.path;
    if (path.length > 1) {
      this.emitEnsurePath(outputVar, path.slice(0, -1));
    }
    return `${outputVar}${path.map((p) => `[${jsStr(p)}]`).join("")}`;
  }

  /**
   * Find which handle a NodeRef targets by matching module/type/field against scope bindings.
   */
  private findTargetHandle(
    target: NodeRef,
    _scope: ScopeChain,
  ): string | undefined {
    // Tool input wires have target refs like:
    // { module: "_", type: "Tools", field: "constants", path: ["greeting"], instance: 1 }
    // or for module-scoped tools:
    // { module: "test.async", type: "SyncAsync", field: "multitool", path: [], instance: 1 }
    //
    // Output wires targeting the bridge itself have type === bridgeType (e.g. "Query").
    // We must NOT match output wires as tool input wires.
    //
    // For self-module tools, target.type is "Tools" (from the parser).
    // For module-scoped tools, target.module !== SELF_MODULE.
    if (target.module === SELF_MODULE && target.type !== "Tools") {
      return undefined;
    }

    let instanceCount = 0;
    for (const h of this.bridge.handles) {
      if (h.kind === "tool") {
        const refName =
          target.module === SELF_MODULE
            ? target.field
            : `${target.module}.${target.field}`;
        const matches = refName === h.name;
        if (matches) {
          instanceCount++;
          if (!target.instance || instanceCount === target.instance) {
            return h.handle;
          }
        }
      }
    }

    return undefined;
  }

  // ── Tool getter emission ──────────────────────────────────────────────

  private emitToolGetters(
    toolInputs: Map<string, { field: string; stmt: WireStatement }[]>,
    scope: ScopeChain,
  ) {
    // Two-pass approach: first register all getter names so cross-references
    // between tool getters resolve to memoized getters (not raw tool fns).
    const entries: {
      handleName: string;
      inputs: { field: string; stmt: WireStatement }[];
      binding: ScopeBinding;
      getterName: string;
      memoKey: string;
    }[] = [];
    for (const [handleName, inputs] of toolInputs) {
      const binding = scope.get(handleName);
      if (!binding || binding.kind !== "tool") continue;

      const getterId = safeId(handleName) + "_" + this.toolGetterCount++;
      const getterName = `__get_${getterId}`;
      const memoKey = this.toolNodeKey(handleName, binding);

      // Update scope binding to getter BEFORE compiling any getter body so
      // cross-tool references go through memoized getters (with tracing).
      binding.jsExpr = getterName;
      binding.instanceKey = getterId;

      // For memoized tools inside a loop, allocate a function-scoped Map.
      // The Map is injected at function scope via post-processing so it
      // persists across all loop iterations (matching runtime semantics).
      if (binding.memoize && this.iteratorStack.length > 0) {
        const mapVar = `__memoMap_${this.memoMapCounter++}`;
        this.memoMapForGetter.set(getterName, mapVar);
        this.memoMapDeclarations.push(mapVar);
      }

      entries.push({ handleName, inputs, binding, getterName, memoKey });
    }

    // Second pass: emit getter bodies (all bindings already point to getters).
    for (const {
      handleName,
      inputs,
      binding,
      getterName,
      memoKey,
    } of entries) {
      const useMemoCache = this.getMemoMapVar(getterName);
      if (useMemoCache) {
        // Memoized-by-input: the getter is called every iteration and deduplicates by input key
        this.emit(`const ${getterName} = async () => {`);
      } else {
        this.emit(`const ${getterName} = __memoize(async () => {`);
      }
      this.pushIndent();

      // Check for root wire (empty field) — passes entire value as tool input
      const rootEntries = inputs.filter((e) => e.field === "");
      const fieldEntries = inputs.filter((e) => e.field !== "");

      // Group field entries by field name for overdefinition handling
      const fieldGroupMap = new Map<string, WireStatement[]>();
      for (const { field, stmt } of fieldEntries) {
        let group = fieldGroupMap.get(field);
        if (!group) {
          group = [];
          fieldGroupMap.set(field, group);
        }
        group.push(stmt);
      }
      const fieldGroups = Array.from(fieldGroupMap, ([field, stmts]) => ({
        field,
        stmts,
      }));

      if (rootEntries.length > 0) {
        // For overdefined root entries, use the cheapest
        const rootStmts = rootEntries.map((e) => e.stmt);
        let rootExpr: string;
        if (rootStmts.length > 1) {
          const ranked = rootStmts.map((s, i) => ({
            stmt: s,
            index: i,
            cost: this.computeExprCost(s.sources[0]!.expr, scope),
          }));
          ranked.sort((a, b) =>
            a.cost !== b.cost ? a.cost - b.cost : a.index - b.index,
          );
          rootExpr = this.compileSourceChainWithLoc(
            ranked[0]!.stmt.sources,
            ranked[0]!.stmt.catch,
            scope,
          );
        } else {
          rootExpr = this.compileSourceChainWithLoc(
            rootStmts[0]!.sources,
            rootStmts[0]!.catch,
            scope,
          );
        }
        if (fieldGroups.length > 0) {
          this.emit(`const __toolInput = { ...${rootExpr} };`);
        } else {
          // Match runtime setPath(input, [], value) behavior:
          // non-null objects are spread, null/undefined/primitives become {}
          this.emit(`const __rv = ${rootExpr};`);
          this.emit(
            `const __toolInput = __rv != null && typeof __rv === 'object' && !Array.isArray(__rv) ? __rv : {};`,
          );
        }
      } else {
        this.emit("const __toolInput = {};");
      }

      // Emit ToolDef self-wire defaults (before bridge wires override)
      if (binding.toolName) {
        this.emitToolDefDefaults(binding.toolName, scope);
      }

      // Separate overdefined from single-source fields
      const singleFields: { field: string; expr: string; locExpr?: string }[] =
        [];
      for (const { field, stmts } of fieldGroups) {
        // Prototype pollution guard for tool input fields
        if (UNSAFE_KEYS.has(field)) {
          this.emit(
            `throw new Error(${jsStr(`Unsafe assignment key: ${field}`)});`,
          );
          continue;
        }
        if (stmts.length === 1) {
          const stmt0 = stmts[0]!;
          const hasLoc = stmt0.sources.some((s) => s.expr.loc);
          const locExpr =
            hasLoc && !stmt0.catch
              ? stmt0.sources.length === 1 && stmt0.sources[0]!.expr.loc
                ? jsLoc(stmt0.sources[0]!.expr.loc)
                : undefined
              : undefined;
          const valueExpr = locExpr
            ? this.compileSourceChain(stmt0.sources, stmt0.catch, scope)
            : this.compileSourceChainWithLoc(stmt0.sources, stmt0.catch, scope);
          singleFields.push({ field, expr: valueExpr, locExpr });
        } else {
          // Overdefined — sort by cost and emit null-coalescing block
          const ranked = stmts.map((s, i) => ({
            stmt: s,
            index: i,
            cost: this.computeExprCost(s.sources[0]!.expr, scope),
          }));
          ranked.sort((a, b) =>
            a.cost !== b.cost ? a.cost - b.cost : a.index - b.index,
          );

          const errVar = `__ti_${safeId(field)}_err`;

          const firstExpr = this.compileSourceChainWithLoc(
            ranked[0]!.stmt.sources,
            ranked[0]!.stmt.catch,
            scope,
          );
          if (ranked[0]!.cost === 0) {
            this.emit(`__toolInput[${jsStr(field)}] = ${firstExpr};`);
            this.emit(`let ${errVar};`);
          } else {
            this.emit(`let ${errVar};`);
            this.emit(
              `try { __toolInput[${jsStr(field)}] = ${firstExpr}; } catch (_e) { ${errVar} = _e; }`,
            );
          }

          for (let i = 1; i < ranked.length; i++) {
            const nextExpr = this.compileSourceChainWithLoc(
              ranked[i]!.stmt.sources,
              ranked[i]!.stmt.catch,
              scope,
            );
            this.emit(`if (__toolInput[${jsStr(field)}] == null) {`);
            this.pushIndent();
            this.emit(
              `try { __toolInput[${jsStr(field)}] = ${nextExpr}; if (__toolInput[${jsStr(field)}] != null) ${errVar} = undefined; } catch (_e) { ${errVar} = _e; }`,
            );
            this.popIndent();
            this.emit("}");
          }

          this.emit(
            `if (__toolInput[${jsStr(field)}] == null && ${errVar}) throw ${errVar};`,
          );
        }
      }

      // Emit single-source fields — parallelize async ones via Promise.all
      // For dotted field paths (from scope blocks), ensure parent objects exist
      for (const f of singleFields) {
        if (f.field.includes(".")) {
          const parts = f.field.split(".");
          for (let i = 0; i < parts.length - 1; i++) {
            const parentPath = parts
              .slice(0, i + 1)
              .map((p) => `[${jsStr(p)}]`)
              .join("");
            this.emit(`__toolInput${parentPath} ??= {};`);
          }
        }
      }
      this.emitParallelAssignments(
        singleFields.map((f) => ({
          expr: f.expr,
          locExpr: f.locExpr,
          assign: (v: string) => {
            if (f.field.includes(".")) {
              const parts = f.field.split(".");
              const pathExpr = parts.map((p) => `[${jsStr(p)}]`).join("");
              return `__toolInput${pathExpr} = ${v};`;
            }
            return `__toolInput[${jsStr(f.field)}] = ${v};`;
          },
        })),
      );

      const toolFnExpr = this.resolveToolFnExpr(handleName, scope);
      const toolName = binding.toolName ?? handleName;
      const toolDef = binding.toolName
        ? this.resolveToolDef(binding.toolName)
        : undefined;
      const fnName = toolDef?.fn ?? toolName;

      // Call tool with tracing support (respecting trace:false on tool metadata)
      if (useMemoCache) {
        // Input-keyed memoization: check scoped cache before calling tool
        const mapVar = useMemoCache;
        this.emit(`const __ck = __stableKey(__toolInput);`);
        this.emit(`if (${mapVar}.has(__ck)) return ${mapVar}.get(__ck);`);
        this.emit(`const __p = (async () => {`);
        this.pushIndent();
      }
      this.emit("__checkAbort();");
      this.emit(
        `if (typeof ${toolFnExpr} !== 'function') throw new Error('No tool found for "${toolName}"');`,
      );
      this.emit(
        `const __doTrace = __trace && (!${toolFnExpr}?.bridge || ${toolFnExpr}.bridge.trace !== false);`,
      );
      this.emit("const __start = __doTrace ? performance.now() : 0;");
      this.emit("let __result;");
      this.emit("try {");
      this.pushIndent();

      if (this.currentBatchQueue) {
        // Inside a concurrent (Promise.all) loop — batch tools need __callBatched
        // For batch tools, tracing is handled by the __callBatched microtask flush.
        this.emit(`if (${toolFnExpr}?.bridge?.batch) {`);
        this.pushIndent();
        this.emit(
          `__result = await __callBatched(${toolFnExpr}, __toolInput, ${this.currentBatchQueue}, ${jsStr(toolName)}, ${jsStr(fnName)}, __doTrace);`,
        );
        this.popIndent();
        this.emit("} else {");
        this.pushIndent();
        this.emit(`let __raw = ${toolFnExpr}(__toolInput, __toolCtx);`);
        this.emit(
          `if (${toolFnExpr}?.bridge?.sync && __raw && typeof __raw.then === 'function') throw new Error('Tool "${fnName}" declared {sync:true} but returned a Promise');`,
        );
        this.emit(
          `if (__timeoutMs > 0 && __raw && typeof __raw.then === 'function') { let __timer; const __tout = new Promise((_, rej) => { __timer = setTimeout(() => rej(new (__TimeoutError || Error)(${jsStr(fnName)}, __timeoutMs)), __timeoutMs); }); __raw = Promise.race([__raw, __tout]).finally(() => clearTimeout(__timer)); }`,
        );
        this.emit(
          "__result = (__raw && typeof __raw.then === 'function') ? await __raw : __raw;",
        );
        this.emit(
          `if (__doTrace) __trace(${jsStr(toolName)}, ${jsStr(fnName)}, __start, performance.now(), __toolInput, __result, null);`,
        );
        this.popIndent();
        this.emit("}");
      } else {
        // Sync tool validation: check if tool declared {sync:true} but returned a Promise
        this.emit(`let __raw = ${toolFnExpr}(__toolInput, __toolCtx);`);
        this.emit(
          `if (${toolFnExpr}?.bridge?.sync && __raw && typeof __raw.then === 'function') throw new Error('Tool "${fnName}" declared {sync:true} but returned a Promise');`,
        );
        this.emit(
          `if (__timeoutMs > 0 && __raw && typeof __raw.then === 'function') { let __timer; const __tout = new Promise((_, rej) => { __timer = setTimeout(() => rej(new (__TimeoutError || Error)(${jsStr(fnName)}, __timeoutMs)), __timeoutMs); }); __raw = Promise.race([__raw, __tout]).finally(() => clearTimeout(__timer)); }`,
        );
        this.emit(
          "__result = (__raw && typeof __raw.then === 'function') ? await __raw : __raw;",
        );
        this.emit(
          `if (__doTrace) __trace(${jsStr(toolName)}, ${jsStr(fnName)}, __start, performance.now(), __toolInput, __result, null);`,
        );
      }

      this.popIndent();
      this.emit("} catch (__err) {");
      this.pushIndent();
      if (this.currentBatchQueue) {
        // Only trace errors for non-batch tools; batch tool error tracing is in __callBatched
        this.emit(
          `if (__doTrace && !${toolFnExpr}?.bridge?.batch) __trace(${jsStr(toolName)}, ${jsStr(fnName)}, __start, performance.now(), __toolInput, null, __err);`,
        );
      } else {
        this.emit(
          `if (__doTrace) __trace(${jsStr(toolName)}, ${jsStr(fnName)}, __start, performance.now(), __toolInput, null, __err);`,
        );
      }
      // onError — return fallback instead of rethrowing
      if (toolDef?.onError) {
        if ("value" in toolDef.onError) {
          this.emit(`__result = ${toolDef.onError.value};`);
        } else if ("source" in toolDef.onError) {
          const parts = toolDef.onError.source.split(".");
          const src = parts[0]!;
          const path = parts.slice(1);
          const handle = toolDef.handles.find((h) => h.handle === src);
          if (handle?.kind === "context") {
            const pathExpr =
              path.length > 0
                ? path.map((p) => `?.[${jsStr(p)}]`).join("")
                : "";
            this.emit(`__result = context${pathExpr};`);
          } else {
            this.emit("throw __err;");
          }
        } else {
          this.emit("throw __err;");
        }
      } else {
        this.emit("throw __err;");
      }
      this.popIndent();
      this.emit("}");
      if (useMemoCache) {
        this.emit("return __result;");
        this.popIndent();
        this.emit("})();");
        this.emit(`${useMemoCache}.set(__ck, __p);`);
        this.emit("return __p;");
      } else {
        this.emit("return __result;");
      }
      this.popIndent();
      if (useMemoCache) {
        this.emit("};");
      } else {
        this.emit(`}, ${jsStr(memoKey)});`);
      }
    }
  }

  private resolveToolFnExpr(handleName: string, scope: ScopeChain): string {
    const binding = scope.get(handleName);
    if (!binding || binding.kind !== "tool") {
      return `tools[${jsStr(handleName)}]`;
    }
    // Use the cached __toolFn_ variable (resolves extends chain once at declaration)
    if (binding.toolFnExpr) return binding.toolFnExpr;
    const toolDef = binding.toolName
      ? this.resolveToolDef(binding.toolName)
      : undefined;
    const fnName = toolDef?.fn ?? binding.toolName ?? handleName;
    return `tools[${jsStr(fnName)}]`;
  }

  /**
   * Emit ToolDef self-wire defaults into __toolInput.
   * Compiles wires from the ToolDef body where instance==null (config wires)
   * and scope blocks into properties on __toolInput.
   * Also handles inner tool dependencies (instance!=null wires).
   */
  private emitToolDefDefaults(toolName: string, parentScope: ScopeChain) {
    const toolDef = this.resolveToolDef(toolName);
    if (!toolDef || toolDef.body.length === 0) return;

    // Build a child scope for ToolDef body handles (e.g. with const, with context, with innerTool)
    const defScope = parentScope.child();
    for (const stmt of toolDef.body) {
      if (stmt.kind === "with") {
        if (stmt.binding.kind === "tool") {
          // Inner tool dependency — emit a memoized getter for it
          const innerName = stmt.binding.name;
          const innerHandle = stmt.binding.handle;
          const innerDef = this.resolveToolDef(innerName);
          const innerFn = innerDef?.fn ?? innerName;
          const innerId =
            safeId(innerHandle) + "_inner_" + this.toolGetterCount++;
          const innerGetterName = `__get_${innerId}`;

          // Emit inner tool getter
          const innerNodeKey = `_:Tools:${innerName}`;
          this.emit(`const ${innerGetterName} = __memoize(async () => {`);
          this.pushIndent();
          this.emit("const __innerInput = {};");

          // Compile inner tool's ToolDef defaults
          if (innerDef && innerDef.body.length > 0) {
            const innerDefScope = defScope.child();
            for (const is of innerDef.body) {
              if (is.kind === "with") {
                this.registerWithBinding(is, innerDefScope);
              }
            }
            for (const is of innerDef.body) {
              if (is.kind === "wire" && is.target.instance == null) {
                const value = this.compileSourceChain(
                  is.sources,
                  is.catch,
                  innerDefScope,
                );
                if (is.target.path.length === 0) {
                  this.emit(`Object.assign(__innerInput, ${value});`);
                } else {
                  this.emitSetPath("__innerInput", is.target.path, value);
                }
              } else if (is.kind === "scope") {
                this.emitToolDefScopeInner(
                  is,
                  innerDefScope,
                  [],
                  "__innerInput",
                );
              }
            }
          }

          // Collect inner tool input wires from ToolDef body (instance!=null targeting this inner tool)
          for (const stmt2 of toolDef.body) {
            if (stmt2.kind === "wire" && stmt2.target.instance != null) {
              // Check if this wire targets the inner tool
              const targetName =
                stmt2.target.module === SELF_MODULE
                  ? stmt2.target.field
                  : `${stmt2.target.module}.${stmt2.target.field}`;
              if (targetName === innerName) {
                const value = this.compileSourceChain(
                  stmt2.sources,
                  stmt2.catch,
                  defScope,
                );
                if (stmt2.target.path.length === 0) {
                  this.emit(`Object.assign(__innerInput, ${value});`);
                } else {
                  this.emitSetPath("__innerInput", stmt2.target.path, value);
                }
              }
            }
          }

          const innerFnExpr = `tools[${jsStr(innerFn)}]`;
          // onError for inner tool
          if (innerDef?.onError && "value" in innerDef.onError) {
            this.emit(`try {`);
            this.pushIndent();
            this.emit(
              `return await __pipe(${innerFnExpr}, ${jsStr(innerName)}, ${jsStr(innerFn)}, __innerInput);`,
            );
            this.popIndent();
            this.emit(`} catch (__err) {`);
            this.pushIndent();
            this.emit(`return ${innerDef.onError.value};`);
            this.popIndent();
            this.emit("}");
          } else {
            this.emit(
              `return await __pipe(${innerFnExpr}, ${jsStr(innerName)}, ${jsStr(innerFn)}, __innerInput);`,
            );
          }
          this.popIndent();
          this.emit(`}, ${jsStr(innerNodeKey)});`);

          // Register inner tool in scope
          defScope.set(innerHandle, {
            kind: "tool",
            jsExpr: innerGetterName,
            toolName: innerName,
          });
        } else {
          this.registerWithBinding(stmt, defScope);
        }
      }
    }

    // Compile self-wires (instance==null, non-scope) and scope blocks.
    // Collect single-path wires for parallel execution, emit others directly.
    const parallelWires: { expr: string; assign: (v: string) => string }[] = [];
    for (const stmt of toolDef.body) {
      if (stmt.kind === "wire" && stmt.target.instance == null) {
        const value = this.compileSourceChain(
          stmt.sources,
          stmt.catch,
          defScope,
        );
        const path = stmt.target.path;
        if (path.length === 0) {
          // Root wire — spread into __toolInput (not parallelizable)
          this.emit(`Object.assign(__toolInput, ${value});`);
        } else {
          // Ensure parent objects exist for multi-segment paths
          for (let i = 0; i < path.length - 1; i++) {
            const parentPath = path
              .slice(0, i + 1)
              .map((p) => `[${jsStr(p)}]`)
              .join("");
            this.emit(`__toolInput${parentPath} ??= {};`);
          }
          parallelWires.push({
            expr: value,
            assign: (v: string) => {
              const pathExpr = path.map((p) => `[${jsStr(p)}]`).join("");
              return `__toolInput${pathExpr} = ${v};`;
            },
          });
        }
      } else if (stmt.kind === "scope") {
        // Flush any pending parallel wires before scope block
        this.emitParallelAssignments(parallelWires);
        parallelWires.length = 0;
        this.emitToolDefScope(stmt, defScope, []);
      }
    }
    // Flush remaining parallel wires
    this.emitParallelAssignments(parallelWires);
  }

  /**
   * Emit a ToolDef scope block, setting nested properties on __toolInput.
   */
  private emitToolDefScope(
    stmt: ScopeStatement,
    scope: ScopeChain,
    prefix: string[],
  ) {
    const path = [...prefix, ...stmt.target.path];
    for (const inner of stmt.body) {
      if (inner.kind === "wire" && inner.target.instance == null) {
        const value = this.compileSourceChain(
          inner.sources,
          inner.catch,
          scope,
        );
        const fullPath = [...path, ...inner.target.path];
        this.emitSetPath("__toolInput", fullPath, value);
      } else if (inner.kind === "scope") {
        this.emitToolDefScope(inner, scope, path);
      }
    }
  }

  /**
   * Emit scope blocks for inner tool input (used inside inner tool getters).
   */
  private emitToolDefScopeInner(
    stmt: ScopeStatement,
    scope: ScopeChain,
    prefix: string[],
    targetVar: string,
  ) {
    const path = [...prefix, ...stmt.target.path];
    for (const inner of stmt.body) {
      if (inner.kind === "wire" && inner.target.instance == null) {
        const value = this.compileSourceChain(
          inner.sources,
          inner.catch,
          scope,
        );
        const fullPath = [...path, ...inner.target.path];
        this.emitSetPath(targetVar, fullPath, value);
      } else if (inner.kind === "scope") {
        this.emitToolDefScopeInner(inner, scope, path, targetVar);
      }
    }
  }

  /**
   * Emit code to set a nested path on an object, ensuring parents exist.
   */
  private emitSetPath(objVar: string, path: string[], valueExpr: string) {
    // Prototype pollution guard — static check at compile time
    for (const key of path) {
      if (UNSAFE_KEYS.has(key)) {
        this.emit(
          `throw new Error(${jsStr(`Unsafe assignment key: ${key}`)});`,
        );
        return;
      }
    }
    // Ensure parent objects exist
    for (let i = 0; i < path.length - 1; i++) {
      const parentPath = path
        .slice(0, i + 1)
        .map((p) => `[${jsStr(p)}]`)
        .join("");
      this.emit(`${objVar}${parentPath} ??= {};`);
    }
    const fullPath = path.map((p) => `[${jsStr(p)}]`).join("");
    this.emit(`${objVar}${fullPath} = ${valueExpr};`);
  }

  // ── Wire compilation ──────────────────────────────────────────────────

  private compileWire(
    wire: WireStatement,
    scope: ScopeChain,
    outputVar: string,
    pathPrefix: string[],
    absolutePrefix: string[] = [],
  ) {
    const target = wire.target;

    // Check if this wire targets a tool input (already handled by tool getters)
    const handleName = this.findTargetHandle(target, scope);
    if (handleName) {
      const binding = scope.get(handleName);
      if (binding?.kind === "tool") {
        // Tool input wire — already collected for the getter
        return;
      }
    }

    // This wire targets output or something else
    const targetExpr = this.compileTargetRef(
      target,
      scope,
      outputVar,
      pathPrefix,
    );

    // Special handling for array source expressions (e.g. i.list[] as item { ... })
    if (wire.sources.length === 1 && wire.sources[0]!.expr.type === "array") {
      // Compute absolute prefix for array element body:
      // inner fields are at absolutePrefix + target.path (e.g. ["legs"])
      const arrayAbsPrefix = [...absolutePrefix, ...pathPrefix, ...target.path];
      this.compileArrayAssignment(
        wire.sources[0]!.expr as Extract<Expression, { type: "array" }>,
        targetExpr,
        scope,
        arrayAbsPrefix,
      );
      return;
    }

    const valueExpr = this.compileSourceChainWithLoc(
      wire.sources,
      wire.catch,
      scope,
    );

    // Root output wire — spread into output object instead of reassigning
    if (
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field &&
      target.path.length === 0 &&
      pathPrefix.length === 0
    ) {
      this.emit(`Object.assign(${outputVar}, ${valueExpr});`);
    } else {
      this.emit(`${targetExpr} = ${valueExpr};`);
    }
  }

  private compileAlias(alias: WireAliasStatement, scope: ScopeChain) {
    const valueExpr = this.compileSourceChain(
      alias.sources,
      alias.catch,
      scope,
    );
    const varName = `__alias_${safeId(alias.name)}`;
    this.emit(`const ${varName} = ${valueExpr};`);

    // Register alias in scope
    scope.set(alias.name, { kind: "alias", jsExpr: varName });
  }

  private compileScope(
    stmt: ScopeStatement,
    parentScope: ScopeChain,
    outputVar: string,
    pathPrefix: string[],
    absolutePrefix: string[] = [],
  ) {
    const target = stmt.target;
    // Scope targets are relative to the output
    // target.path is the nested path within the output
    const scopePath = [...pathPrefix, ...target.path];
    const absoluteScopePath = [...absolutePrefix, ...scopePath];

    // requestedFields filtering: skip scopes for unrequested fields
    if (this.requestedFields && this.requestedFields.length > 0) {
      const fieldPath = absoluteScopePath.join(".");
      if (fieldPath && !matchesRequestedFields(fieldPath, this.requestedFields))
        return;
    }

    const scopeVar = `__scope_${scopePath.join("_")}`;
    const childScope = parentScope.child();

    // Ensure parent objects exist
    this.emitEnsurePath(outputVar, scopePath);
    this.emit(
      `const ${scopeVar} = ${outputVar}${scopePath.map((p) => `[${jsStr(p)}]`).join("")};`,
    );

    this.compileBody(stmt.body, childScope, scopeVar, [], absoluteScopePath);
  }

  private compileSpread(
    _stmt: SpreadStatement,
    _scope: ScopeChain,
    _outputVar: string,
  ): never {
    // TODO: implement spread compilation
    throw new BridgeCompilerIncompatibleError(
      `${this.bridge.type}.${this.bridge.field}`,
      "Spread statements are not yet supported by the compiler.",
    );
  }

  private compileForce(stmt: ForceStatement, scope: ScopeChain) {
    const binding = scope.get(stmt.handle);
    if (!binding) return;

    if (binding.kind === "tool") {
      // Force the tool getter to execute
      if (stmt.catchError) {
        this.emit(`try { await ${binding.jsExpr}(); } catch (_) {}`);
      } else {
        this.emit(`await ${binding.jsExpr}();`);
      }
    }
  }

  // ── Overdefinition ────────────────────────────────────────────────────

  /**
   * Compute the output path key for a wire targeting the current bridge's output.
   * Returns undefined if the wire doesn't target output (e.g. targets another tool).
   */
  private wireOutputPathKey(
    target: NodeRef,
    pathPrefix: string[],
  ): string | undefined {
    if (
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field
    ) {
      return [...pathPrefix, ...target.path].join(".");
    }
    return undefined;
  }

  /** Recursively check if any output wire or spread exists in the body tree. */
  private hasAnyOutputWires(body: Statement[]): boolean {
    for (const stmt of body) {
      if (stmt.kind === "wire") {
        if (
          stmt.target.module === SELF_MODULE &&
          stmt.target.type === this.bridge.type &&
          stmt.target.field === this.bridge.field
        ) {
          return true;
        }
      } else if (stmt.kind === "spread") {
        return true;
      } else if (stmt.kind === "scope") {
        if (this.hasAnyOutputWires(stmt.body)) return true;
      }
    }
    return false;
  }

  /**
   * Group output-targeting wire statements by their target path key.
   * Only groups wires that target the bridge's own output (skips tool input wires).
   */
  private groupOutputWiresByPath(
    body: Statement[],
    scope: ScopeChain,
    pathPrefix: string[],
  ): Map<string, WireStatement[]> {
    const groups = new Map<string, WireStatement[]>();
    for (const stmt of body) {
      if (stmt.kind !== "wire") continue;

      // Skip tool input wires
      const handleName = this.findTargetHandle(stmt.target, scope);
      if (handleName) {
        const binding = scope.get(handleName);
        if (binding?.kind === "tool") continue;
      }

      const pathKey = this.wireOutputPathKey(stmt.target, pathPrefix);
      if (pathKey === undefined) continue;

      let group = groups.get(pathKey);
      if (!group) {
        group = [];
        groups.set(pathKey, group);
      }
      group.push(stmt);
    }
    return groups;
  }

  /**
   * Compile a group of overdefined wires targeting the same output path.
   * Sorts by expression cost (cheapest first) and emits a null-coalescing
   * block that short-circuits on the first non-null result.
   *
   * When all wires have equal static cost > 0 (e.g. all tool refs), emits
   * a runtime-sorted block using tool metadata for cost disambiguation.
   */
  private compileOverdefinedWires(
    wires: WireStatement[],
    scope: ScopeChain,
    outputVar: string,
    pathPrefix: string[],
  ) {
    // Compute static costs
    const ranked = wires.map((wire, index) => ({
      wire,
      index,
      cost: this.computeExprCost(wire.sources[0]!.expr, scope),
    }));

    // Check if all costs are equal and > 0 (needs runtime sorting)
    const allSameCost =
      ranked.length > 1 &&
      ranked[0]!.cost > 0 &&
      ranked.every((r) => r.cost === ranked[0]!.cost);

    if (allSameCost) {
      this.compileRuntimeSortedOverdef(ranked, scope, outputVar, pathPrefix);
      return;
    }

    // Static sorting: cheapest first, authored order for ties
    ranked.sort((a, b) =>
      a.cost !== b.cost ? a.cost - b.cost : a.index - b.index,
    );
    const sorted = ranked.map((e) => e.wire);

    const target = sorted[0]!.target;
    const targetExpr = this.compileTargetRef(
      target,
      scope,
      outputVar,
      pathPrefix,
    );

    // Root output wire — special handling
    const isRoot =
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field &&
      target.path.length === 0 &&
      pathPrefix.length === 0;

    const odVar = `__od_${this.overdefCount++}`;
    const errVar = `${odVar}_err`;

    // Emit the first (cheapest) wire's value
    const firstVal = this.compileSourceChainWithLoc(
      sorted[0]!.sources,
      sorted[0]!.catch,
      scope,
    );

    // If the first wire has cost 0, it can't throw a tool error — emit directly
    if (ranked[0]!.cost === 0) {
      this.emit(`let ${odVar} = ${firstVal};`);
      this.emit(`let ${errVar};`);
    } else {
      this.emit(`let ${odVar};`);
      this.emit(`let ${errVar};`);
      this.emit(
        `try { ${odVar} = ${firstVal}; } catch (_e) { ${errVar} = _e; }`,
      );
    }

    for (let i = 1; i < sorted.length; i++) {
      const nextVal = this.compileSourceChainWithLoc(
        sorted[i]!.sources,
        sorted[i]!.catch,
        scope,
      );
      this.emit(`if (${odVar} == null) {`);
      this.pushIndent();
      this.emit(
        `try { ${odVar} = ${nextVal}; if (${odVar} != null) ${errVar} = undefined; } catch (_e) { ${errVar} = _e; }`,
      );
      this.popIndent();
      this.emit("}");
    }

    this.emit(`if (${odVar} == null && ${errVar}) throw ${errVar};`);

    if (isRoot) {
      this.emit(`Object.assign(${outputVar}, ${odVar});`);
    } else {
      this.emit(`${targetExpr} = ${odVar};`);
    }
  }

  /**
   * Throw a compile-time error for overdefined wires where all static costs
   * are equal and greater than zero (i.e. all sources are tool-backed with
   * the same priority).  The AOT compiler cannot statically determine which
   * tool should win, so this configuration is rejected as incompatible.
   */
  private compileRuntimeSortedOverdef(
    ranked: { wire: WireStatement; index: number; cost: number }[],
    scope: ScopeChain,
    outputVar: string,
    pathPrefix: string[],
  ) {
    this.needsToolCostHelper = true;
    const target = ranked[0]!.wire.target;
    const targetExpr = this.compileTargetRef(
      target,
      scope,
      outputVar,
      pathPrefix,
    );
    const isRoot =
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field &&
      target.path.length === 0 &&
      pathPrefix.length === 0;

    const odVar = `__od_${this.overdefCount++}`;

    // Build an array of { cost, fn } entries sorted at runtime by cost
    // Each fn is a lazy async function that evaluates the wire's source chain
    const entries = ranked.map((r, _i) => {
      const runtimeCost = this.computeRuntimeCostExpr(
        r.wire.sources[0]!.expr,
        scope,
      );
      return { wire: r.wire, costExpr: runtimeCost, index: r.index };
    });

    // Emit: sort entries by runtime cost, then evaluate in order
    this.emit(`const ${odVar}_entries = [`);
    this.pushIndent();
    for (const entry of entries) {
      const valueExpr = this.compileSourceChainWithLoc(
        entry.wire.sources,
        entry.wire.catch,
        scope,
      );
      this.emit(
        `{ cost: ${entry.costExpr}, idx: ${entry.index}, fn: async () => ${valueExpr} },`,
      );
    }
    this.popIndent();
    this.emit(
      `].sort((a, b) => a.cost !== b.cost ? a.cost - b.cost : a.idx - b.idx);`,
    );

    this.emit(`let ${odVar};`);
    this.emit(`let ${odVar}_err;`);
    this.emit(`for (const __e of ${odVar}_entries) {`);
    this.pushIndent();
    this.emit(
      `try { ${odVar} = await __e.fn(); if (${odVar} != null) ${odVar}_err = undefined; } catch (_e) { ${odVar}_err = _e; continue; }`,
    );
    this.emit(`if (${odVar} != null) break;`);
    this.popIndent();
    this.emit("}");
    this.emit(`if (${odVar} == null && ${odVar}_err) throw ${odVar}_err;`);

    if (isRoot) {
      this.emit(`Object.assign(${outputVar}, ${odVar});`);
    } else {
      this.emit(`${targetExpr} = ${odVar};`);
    }
  }

  /**
   * Compute a runtime cost expression for a source expression.
   * For tool refs, checks `tools[name].bridge?.cost ?? (tools[name].bridge?.sync ? 1 : 2)`.
   * For non-tool expressions, returns a literal number.
   */
  private computeRuntimeCostExpr(expr: Expression, scope: ScopeChain): string {
    if (expr.type === "ref") {
      const ref = expr.ref;
      if (ref.element) return "0";
      if (ref.type === "Context" || ref.type === "Const") return "0";
      if (ref.module === SELF_MODULE && ref.type === "__local") return "0";
      if (ref.module === SELF_MODULE && ref.instance == null) return "0";
      // Tool ref — generate runtime cost check
      const handle = this.findSourceHandle(ref, scope);
      if (handle) {
        const binding = scope.get(handle);
        if (binding?.kind === "tool" && binding.toolName) {
          return `__toolCost(tools[${jsStr(binding.toolName)}])`;
        }
      }
      const toolKey =
        ref.module === SELF_MODULE ? ref.field : `${ref.module}.${ref.field}`;
      return `__toolCost(tools[${jsStr(toolKey)}])`;
    }
    return String(this.computeExprCost(expr, scope));
  }

  /**
   * Compute the static cost of an expression for overdefinition ordering.
   * Mirrors the runtime's computeExprCost logic.
   */
  private computeExprCost(expr: Expression, scope: ScopeChain): number {
    switch (expr.type) {
      case "literal":
      case "control":
        return 0;
      case "ref": {
        const ref = expr.ref;
        if (ref.element) return 0;
        if (ref.type === "Context" || ref.type === "Const") return 0;
        if (ref.module === SELF_MODULE && ref.type === "__local") return 0;
        // Input ref (self-module, no instance → not a tool)
        if (ref.module === SELF_MODULE && ref.instance == null) return 0;
        // Tool ref → default async cost
        return 2;
      }
      case "ternary":
        return Math.max(
          this.computeExprCost(expr.cond, scope),
          this.computeExprCost(expr.then, scope),
          this.computeExprCost(expr.else, scope),
        );
      case "and":
      case "or":
        return Math.max(
          this.computeExprCost(expr.left, scope),
          this.computeExprCost(expr.right, scope),
        );
      case "array":
      case "pipe":
        return this.computeExprCost(expr.source, scope);
      case "binary":
        return Math.max(
          this.computeExprCost(expr.left, scope),
          this.computeExprCost(expr.right, scope),
        );
      case "unary":
        return this.computeExprCost(expr.operand, scope);
      case "concat":
        return Math.max(
          ...expr.parts.map((p) => this.computeExprCost(p, scope)),
        );
    }
  }

  // ── Target reference compilation ──────────────────────────────────────

  private compileTargetRef(
    target: NodeRef,
    _scope: ScopeChain,
    outputVar: string,
    pathPrefix: string[],
  ): string {
    // Output wires: target is in the SELF_MODULE with bridge's type/field
    if (
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field
    ) {
      const fullPath = [...pathPrefix, ...target.path];
      // Ensure parent objects exist for nested paths
      if (fullPath.length > 1) {
        this.emitEnsurePath(outputVar, fullPath.slice(0, -1));
      }
      return `${outputVar}${fullPath.map((p) => `[${jsStr(p)}]`).join("")}`;
    }

    // Otherwise it's targeting a tool or something else
    return `${outputVar}${target.path.map((p) => `[${jsStr(p)}]`).join("")}`;
  }

  private emitEnsurePath(baseVar: string, path: string[]) {
    let current = baseVar;
    for (const seg of path) {
      const next = `${current}[${jsStr(seg)}]`;
      this.emit(`${next} ??= {};`);
      current = next;
    }
  }

  // ── Parallel assignment emission ──────────────────────────────────────

  /**
   * Emit a batch of assignments, parallelizing async items via Promise.all.
   * Each item provides the value `expr` and an `assign` function that
   * returns the full assignment statement given the resolved value.
   */
  private emitParallelAssignments(
    items: {
      expr: string;
      assign: (valueExpr: string) => string;
      locExpr?: string;
    }[],
  ) {
    if (items.length === 0) return;

    const hasAsync = items.some((it) => it.expr.includes("await"));
    const asyncItems: typeof items = [];
    const syncItems: typeof items = [];
    for (const it of items) {
      if (it.expr.includes("await")) {
        asyncItems.push(it);
      } else if (hasAsync && it.expr.includes("throw ")) {
        // Sync items that can throw must join the async batch so they
        // don't prevent concurrent tool getters from starting.
        asyncItems.push(it);
      } else {
        syncItems.push(it);
      }
    }

    // For sync items that have loc, wrap in try/catch at the statement level
    for (const it of syncItems) {
      if (it.locExpr) {
        this.emit(
          `try { ${it.assign(it.expr)} } catch (__e) { if (__isFatal(__e)) { if (__e && !__e.bridgeLoc) __e.bridgeLoc = ${it.locExpr}; throw __e; } throw __wrapErr(__e, {bridgeLoc:${it.locExpr}}); }`,
        );
      } else {
        this.emit(it.assign(it.expr));
      }
    }

    if (asyncItems.length > 1) {
      // Use Promise.all + .catch to wait for all wires to settle
      // (including traces) before we propagate the first error — matching
      // runtime semantics. Avoids Promise.allSettled wrapper-object allocation.
      const batchId = this.parallelBatchCount++;
      const settledVar = `__s${batchId}`;
      this.emit(`const ${settledVar} = await Promise.all([`);
      this.pushIndent();
      for (const it of asyncItems) {
        // Strip "await " prefix to access the raw Promise directly,
        // avoiding async IIFE closure allocation
        const raw = it.expr.startsWith("await ")
          ? it.expr.slice(6)
          : `(async () => ${it.expr})()`;
        this.emit(`${raw}.catch((__e) => __e),`);
      }
      this.popIndent();
      this.emit(`]);`);
      // Re-throw the first rejection (fatal errors first, matching runtime).
      // Annotate with bridgeLoc from the per-wire loc metadata when available.
      const hasLocs = asyncItems.some((it) => it.locExpr);
      if (hasLocs) {
        const locsArray = `[${asyncItems.map((it) => it.locExpr || "undefined").join(",")}]`;
        this.emit(
          `{ const __locs = ${locsArray}; let __fatal, __first, __fi = 0; for (let __i = 0; __i < ${settledVar}.length; __i++) { const __r = ${settledVar}[__i]; if (__r instanceof Error) { if (__isFatal(__r)) { if (!__fatal) { __fatal = __r; __fi = __i; } } else { if (!__first) { __first = __r; __fi = __i; } } } } if (__fatal) { if (__locs[__fi] && !__fatal.bridgeLoc) __fatal.bridgeLoc = __locs[__fi]; throw __fatal; } if (__first) { if (__locs[__fi]) throw __wrapErr(__first, {bridgeLoc:__locs[__fi]}); throw __first; } }`,
        );
      } else {
        this.emit(
          `{ let __fatal, __first; for (const __r of ${settledVar}) { if (__r instanceof Error) { if (__isFatal(__r)) { if (!__fatal) __fatal = __r; } else { if (!__first) __first = __r; } } } if (__fatal) throw __fatal; if (__first) throw __first; }`,
        );
      }
      for (let i = 0; i < asyncItems.length; i++) {
        this.emit(asyncItems[i]!.assign(`${settledVar}[${i}]`));
      }
    } else if (asyncItems.length === 1) {
      const it = asyncItems[0]!;
      if (it.locExpr) {
        // Single async item with loc — wrap assignment in try/catch
        this.emit(`try {`);
        this.pushIndent();
        this.emit(it.assign(it.expr));
        this.popIndent();
        this.emit(
          `} catch (__e) { if (__isFatal(__e)) { if (__e && !__e.bridgeLoc) __e.bridgeLoc = ${it.locExpr}; throw __e; } throw __wrapErr(__e, {bridgeLoc:${it.locExpr}}); }`,
        );
      } else {
        this.emit(it.assign(it.expr));
      }
    }
  }

  // ── Source chain compilation ──────────────────────────────────────────

  /**
   * Throw BridgeCompilerIncompatibleError if any source in the chain uses a
   * falsy gate (||) with a tool-backed ref as the fallback.  Tool-backed
   * falsy fallbacks are unsupported because they may trigger the secondary
   * tool call even for valid falsy values (0, "", false).  Use ?? (nullish)
   * or split into overdefined wires instead.
   */
  private compileSourceChain(
    sources: WireSourceEntry[],
    wireCatch: WireCatch | undefined,
    scope: ScopeChain,
  ): string {
    if (sources.length === 0) return "undefined";

    let expr = this.compileExpression(sources[0]!.expr, scope);

    // Fallback chain
    for (let i = 1; i < sources.length; i++) {
      const src = sources[i]!;
      const fbExpr = this.compileExpression(src.expr, scope);

      if (src.gate === "nullish") {
        expr = `(${expr} ?? ${fbExpr})`;
      } else if (src.gate === "falsy") {
        expr = `(${expr} || ${fbExpr})`;
      }
    }

    // Catch handler
    if (wireCatch) {
      const catchExpr = this.compileCatch(wireCatch, scope);
      if (expr.includes("await")) {
        return `(await (async () => ${expr})().catch(() => ${catchExpr}))`;
      }
      return `(() => { try { return ${expr}; } catch (_e) { return ${catchExpr}; } })()`;
    }

    return expr;
  }

  /**
   * Compile a source chain expression that wraps errors with bridgeLoc.
   *
   * For single-source chains, wraps the expression with the source's loc.
   * For multi-source (fallback) chains, compiles into a statement block that
   * tracks which source was active when the error occurred.
   *
   * Returns an expression string (may be an async IIFE).
   */
  private compileSourceChainWithLoc(
    sources: WireSourceEntry[],
    wireCatch: WireCatch | undefined,
    scope: ScopeChain,
  ): string {
    if (sources.length === 0) return "undefined";

    // If no source has loc, fall back to the regular compilation
    const hasLoc = sources.some((s) => s.expr.loc);
    if (!hasLoc) {
      return this.compileSourceChain(sources, wireCatch, scope);
    }

    // Single source — wrap with its loc
    if (sources.length === 1) {
      const expr = this.compileExpression(sources[0]!.expr, scope);
      const loc = sources[0]!.expr.loc;
      const locExpr = loc ? jsLoc(loc) : "undefined";

      // Fast path: when inside an optimized array loop body, use a comma
      // expression to set the loc index before the value is evaluated. The
      // caller wraps the entire loop body in a single try/catch. Locs are
      // precomputed in an array, so no object allocation per iteration.
      if (this.loopLocInfo && !wireCatch && !expr.includes("await")) {
        const idx = this.loopLocInfo.locs.length;
        this.loopLocInfo.locs.push(locExpr);
        return `(${this.loopLocInfo.indexVar} = ${idx}, ${expr})`;
      }

      const fatalGuard = `if (__isFatal(__e)) { if (__e && !__e.bridgeLoc) __e.bridgeLoc = ${locExpr}; throw __e; }`;
      const catchBody = wireCatch ? this.compileCatch(wireCatch, scope) : "";

      // Adaptive: only use async IIFE when the expression actually awaits
      const isAsync = expr.includes("await") || catchBody.includes("await");
      const wrap = isAsync ? "await (async () => {" : "(() => {";

      if (wireCatch) {
        return `${wrap} try { return ${expr}; } catch (__e) { ${fatalGuard} return ${catchBody}; } })()`;
      }

      return `${wrap} try { return ${expr}; } catch (__e) { ${fatalGuard} throw __wrapErr(__e, {bridgeLoc:${locExpr}}); } })()`;
    }

    // Multi-source fallback chain — build IIFE with per-entry loc tracking
    const firstExpr = this.compileExpression(sources[0]!.expr, scope);
    const firstLoc = sources[0]!.expr.loc;

    const locDecl = `let __loc = ${firstLoc ? jsLoc(firstLoc) : "undefined"};`;

    const tryParts: string[] = [];
    tryParts.push(`let __v = ${firstExpr};`);

    let anyAsync = firstExpr.includes("await");

    for (let i = 1; i < sources.length; i++) {
      const src = sources[i]!;
      const fbExpr = this.compileExpression(src.expr, scope);
      if (fbExpr.includes("await")) anyAsync = true;
      const fbLoc = src.expr.loc;

      const cond = src.gate === "nullish" ? "__v == null" : "!__v";
      tryParts.push(`if (${cond}) {`);
      if (fbLoc) tryParts.push(`  __loc = ${jsLoc(fbLoc)};`);
      tryParts.push(`  __v = ${fbExpr};`);
      tryParts.push(`}`);
    }
    tryParts.push(`return __v;`);

    const tryBody = tryParts.join(" ");
    const multiFatalGuard = `if (__isFatal(__e)) { if (__e && !__e.bridgeLoc) __e.bridgeLoc = __loc; throw __e; }`;
    const catchBody = wireCatch ? this.compileCatch(wireCatch, scope) : "";
    if (catchBody.includes("await")) anyAsync = true;

    const wrap = anyAsync ? "await (async () => {" : "(() => {";

    if (wireCatch) {
      return `${wrap} ${locDecl} try { ${tryBody} } catch (__e) { ${multiFatalGuard} return ${catchBody}; } })()`;
    }

    return `${wrap} ${locDecl} try { ${tryBody} } catch (__e) { ${multiFatalGuard} throw __wrapErr(__e, {bridgeLoc:__loc}); } })()`;
  }

  private compileCatch(wireCatch: WireCatch, scope: ScopeChain): string {
    if ("value" in wireCatch) {
      return JSON.stringify(wireCatch.value);
    }
    if ("ref" in wireCatch) {
      return this.compileRefExpr(wireCatch.ref, scope);
    }
    if ("control" in wireCatch) {
      return this.compileControlFlow(wireCatch.control);
    }
    if ("expr" in wireCatch) {
      return this.compileExpression(wireCatch.expr, scope);
    }
    return "undefined";
  }

  // ── Expression compilation ────────────────────────────────────────────

  private compileExpression(expr: Expression, scope: ScopeChain): string {
    switch (expr.type) {
      case "ref":
        if (expr.safe) {
          // Match runtime catchSafe: swallow non-fatal errors, rethrow fatal (panic/abort)
          const inner = this.compileRefExpr(expr.ref, scope);
          if (inner.includes("await")) {
            // Async: use .catch on the async wrapper — avoids try/catch inside async IIFE
            return `(await (async () => ${inner})().catch(__catchSafe))`;
          }
          // Sync: lightweight non-async IIFE — no promise overhead
          return `(() => { try { return ${inner}; } catch (__e) { return __catchSafe(__e); } })()`;
        }
        return this.compileRefExpr(expr.ref, scope);

      case "literal":
        return JSON.stringify(expr.value);

      case "ternary":
        return `(${this.compileExpression(expr.cond, scope)} ? ${this.compileExpression(expr.then, scope)} : ${this.compileExpression(expr.else, scope)})`;

      case "and":
        return this.compileAndOr(expr, scope, "and");

      case "or":
        return this.compileAndOr(expr, scope, "or");

      case "control":
        return this.compileControlFlow(expr.control);

      case "array":
        return this.compileArrayExpr(expr, scope);

      case "pipe":
        return this.compilePipeExpr(expr, scope);

      case "binary":
        return this.compileBinaryExpr(expr, scope);

      case "unary":
        if (expr.op === "not") {
          return `(!${this.compileExpression(expr.operand, scope)})`;
        }
        return "undefined";

      case "concat":
        return this.compileConcatExpr(expr, scope);
    }
  }

  /**
   * Combine a base expression with a path, using __getPath for mixed safe paths.
   */
  private emitAccessPath(
    base: string,
    ref: NodeRef,
    startIdx = 0,
    forceRootSafe = false,
  ): string {
    // Static prototype-pollution guard: reject unsafe path segments at compile time
    for (let i = startIdx; i < ref.path.length; i++) {
      if (UNSAFE_KEYS.has(ref.path[i]!)) {
        return `(() => { throw new Error("Unsafe property traversal: " + ${jsStr(ref.path[i]!)}); })()`;
      }
    }
    const pathStr = emitPath(ref, startIdx, forceRootSafe, base);
    // If emitPath returned a __getPath call (full expression), use it directly
    if (pathStr.startsWith("__getPath(")) return pathStr;
    return `${base}${pathStr}`;
  }

  private compileRefExpr(ref: NodeRef, scope: ScopeChain): string {
    // Element references (array iteration) — must resolve BEFORE self-module
    // because element refs share the same module/type/field as self-module refs.
    if (ref.element) {
      const depth = ref.elementDepth ?? 0;
      const stackIdx = this.iteratorStack.length - 1 - depth;
      if (stackIdx >= 0) {
        return this.emitAccessPath(this.iteratorStack[stackIdx]!.iterVar, ref);
      }
    }

    // Local references (aliases)
    if (ref.module === "__local" || ref.type === "__local") {
      const binding = scope.get(ref.field);
      if (binding) {
        return this.emitAccessPath(binding.jsExpr, ref);
      }
    }

    // Self-module references — in source position these are input reads
    if (
      ref.module === SELF_MODULE &&
      ref.type === this.bridge.type &&
      ref.field === this.bridge.field
    ) {
      return this.emitAccessPath("input", ref);
    }

    // Context references
    if (ref.module === SELF_MODULE && ref.type === "Context") {
      return this.emitAccessPath("context", ref);
    }

    // Const references
    if (ref.module === SELF_MODULE && ref.type === "Const") {
      return this.emitAccessPath("__consts", ref);
    }

    // Define-type references — inside a define body, source refs to the define
    // itself resolve to the define's input (e.g., {type: "Define", field: "userProfile"})
    if (ref.module === SELF_MODULE && ref.type === "Define") {
      const marker = scope.get("__defineInput_" + ref.field);
      if (marker) {
        return this.emitAccessPath(marker.jsExpr, ref);
      }
    }

    // Tool references — resolve through scope chain first, then bridge handles
    const refToolName =
      ref.module === SELF_MODULE ? ref.field : `${ref.module}.${ref.field}`;
    // Check scope chain for tool bindings (handles inner tool refs in ToolDef bodies
    // and define bodies where handle name differs from tool name)
    const scopeBinding =
      scope.get(refToolName) ?? scope.findTool(refToolName, ref.instance);
    if (scopeBinding?.kind === "tool") {
      if (ref.rootSafe) {
        return this.emitAccessPath(
          `(await ${scopeBinding.jsExpr}().catch(() => undefined))`,
          ref,
        );
      }
      return this.emitAccessPath(`(await ${scopeBinding.jsExpr}())`, ref);
    }

    const handle = this.findSourceHandle(ref, scope);
    if (handle) {
      const binding = scope.get(handle);
      if (binding?.kind === "tool") {
        if (ref.rootSafe) {
          // Error suppression via ?. — swallow tool errors → undefined
          return this.emitAccessPath(
            `(await ${binding.jsExpr}().catch(() => undefined))`,
            ref,
          );
        }
        return this.emitAccessPath(`(await ${binding.jsExpr}())`, ref);
      }
      if (binding) {
        return this.emitAccessPath(binding.jsExpr, ref);
      }
    }

    // Define references — module starts with "__define_"
    if (ref.module.startsWith("__define_")) {
      const defineHandle = ref.module.substring("__define_".length);
      const defineBinding = scope.get(defineHandle);
      if (defineBinding?.kind === "define") {
        return this.emitAccessPath(`(await ${defineBinding.jsExpr}())`, ref);
      }
    }

    // Fallback: direct tool access
    const toolKey =
      ref.module === SELF_MODULE ? ref.field : `${ref.module}.${ref.field}`;
    if (ref.rootSafe) {
      return this.emitAccessPath(
        `(await tools[${jsStr(toolKey)}]().catch(() => undefined))`,
        ref,
      );
    }
    return this.emitAccessPath(`(await tools[${jsStr(toolKey)}]())`, ref);
  }

  /**
   * Compute the runtime-compatible node key for a tool getter.
   * Format: `{module}:Tools:{name}:{instance}` matching the runtime's toolKey().
   */
  private toolNodeKey(handleName: string, binding: ScopeBinding): string {
    const toolName = binding.toolName ?? handleName;
    // Count instance by iterating handles with same tool name
    let instance = 0;
    for (const h of this.bridge.handles) {
      if (h.kind === "tool" && h.name === toolName) {
        instance++;
        if (h.handle === handleName) break;
      }
    }
    return `_:Tools:${toolName}:${instance || 1}`;
  }

  private findSourceHandle(
    ref: NodeRef,
    _scope: ScopeChain,
  ): string | undefined {
    // Look through scope bindings for a match.
    // When multiple handles share the same tool name, use `instance` to
    // pick the correct one.
    let instanceCount = 0;
    for (const h of this.bridge.handles) {
      if (h.kind === "tool") {
        const refName =
          ref.module === SELF_MODULE ? ref.field : `${ref.module}.${ref.field}`;
        const matches = refName === h.name;
        if (matches) {
          instanceCount++;
          if (!ref.instance || instanceCount === ref.instance) {
            return h.handle;
          }
        }
      }
      if (h.kind === "input") {
        if (
          ref.module === SELF_MODULE &&
          ref.type === this.bridge.type &&
          ref.field === this.bridge.field
        ) {
          return h.handle;
        }
      }
    }
    return undefined;
  }

  // ── Array expression ──────────────────────────────────────────────────

  /**
   * Compile an array mapping expression as a wire assignment.
   *
   * Uses a for-loop to support continue/break control flow sentinels.
   * When the loop body contains a tool with `batch` metadata, the loop
   * is compiled concurrently (Promise.all + map) so that microtask-based
   * batch queueing can accumulate all per-element tool calls into a single
   * batched invocation.
   */
  private compileArrayAssignment(
    expr: Extract<Expression, { type: "array" }>,
    targetExpr: string,
    scope: ScopeChain,
    absolutePrefix: string[] = [],
  ) {
    const depth = this.arrayDepthCounter++;
    const iterVar = `__el_${depth}`;
    const outVar = `__elOut_${depth}`;
    const resultVar = `__result_${depth}`;
    const arrVar = `__arr_${depth}`;

    // Check if this loop body uses any tool — if so, we need batch support
    const hasTool = expr.body.some(
      (s) => s.kind === "with" && s.binding.kind === "tool",
    );

    // Compile the source iterable expression
    const sourceExpr = this.compileExpression(expr.source, scope);

    // Preserve null/undefined source — only map when array-like
    this.emit(`const ${arrVar} = ${sourceExpr};`);
    this.emit(`if (${arrVar} == null) {`);
    this.pushIndent();
    this.emit(`${targetExpr} = ${arrVar};`);
    this.popIndent();
    this.emit(`} else {`);
    this.pushIndent();

    if (hasTool) {
      this.needsBatchHelper = true;
      // Emit batch queue shared across all iterations of this loop
      const batchQueueVar = `__bq_${depth}`;
      this.emit(`const ${batchQueueVar} = new Map();`);
      this.currentBatchQueue = batchQueueVar;

      // Concurrent loop: Promise.all + map for batch support.
      // Each element runs concurrently; batch tools queue their calls
      // via microtask and flush once all elements have queued.
      this.emit(
        `const ${resultVar} = await Promise.all(${arrVar}.map(async (${iterVar}) => {`,
      );
      this.pushIndent();
      this.emit(`const ${outVar} = {};`);
    } else {
      this.emit(`const ${resultVar} = [];`);
    }

    // Static analysis: does this loop body use break/continue sentinels?
    const hasCtrlFlow = !hasTool && bodyHasControlFlow(expr.body);

    // Optimized sync path: consolidate per-wire IIFEs into a single try/catch
    // with a shared __loc variable. Hoist try/catch OUTSIDE the loop so V8
    // doesn't enter/exit the catch frame per element.
    const useLoopLoc = !hasTool && !hasCtrlFlow;
    const locVar = useLoopLoc ? `__li_${depth}` : undefined;
    const locsVar = useLoopLoc ? `__locs_${depth}` : undefined;
    const prevLoopLocInfo = this.loopLocInfo;
    const locCollector: string[] = [];
    if (locVar && locsVar) {
      this.emit(`let ${locVar} = 0;`);
      this.emit(`try {`);
      this.pushIndent();
      this.loopLocInfo = { indexVar: locVar, locsVar, locs: locCollector };
    }

    if (!hasTool) {
      this.emit(`for (const ${iterVar} of ${arrVar}) {`);
      this.pushIndent();
      this.emit(`const ${outVar} = {};`);
    }

    // Create child scope — iterator may shadow parent bindings (scope rules)
    const childScope = scope.child();
    childScope.set(expr.iteratorName, {
      kind: "iterator",
      jsExpr: iterVar,
    });

    // Push iterator stack for element ref resolution
    this.iteratorStack.push({ iterVar, outVar });

    // Compile body using the child scope with element output as outputVar
    this.compileBody(expr.body, childScope, outVar, [], absolutePrefix);

    this.iteratorStack.pop();
    this.currentBatchQueue = undefined;
    this.loopLocInfo = prevLoopLocInfo;

    if (hasTool) {
      // Concurrent path: return element output from map callback
      this.emit(`return ${outVar};`);
      this.popIndent();
      this.emit(`}));`);
      this.emit(`${targetExpr} = ${resultVar};`);
    } else if (!hasCtrlFlow) {
      // Optimized sequential path: no control flow → skip sentinel check
      this.emit(`${resultVar}.push(${outVar});`);
      this.popIndent();
      this.emit(`}`); // close for loop
      if (locVar && locsVar) {
        // Close the try block hoisted outside the loop
        const locsExpr = `[${locCollector.join(",")}]`;
        this.popIndent();
        this.emit(
          `} catch (__e) { if (__isFatal(__e)) { if (__e && !__e.bridgeLoc) __e.bridgeLoc = ${locsExpr}[${locVar}]; throw __e; } throw __wrapErr(__e, {bridgeLoc:${locsExpr}[${locVar}]}); }`,
        );
      }
      this.emit(`${targetExpr} = ${resultVar};`);
    } else {
      // Sequential path with control flow: check for sentinels
      const sigVar = `__sig_${depth}`;
      this.emit(
        `const ${sigVar} = Object.values(${outVar}).find(__v => __v === Symbol.for("BRIDGE_BREAK") || __v === Symbol.for("BRIDGE_CONTINUE") || (__v && typeof __v === 'object' && (__v.__bridgeControl === 'break' || __v.__bridgeControl === 'continue')));`,
      );
      this.emit(`if (${sigVar} != null) {`);
      this.pushIndent();
      // Single-level symbols: break/continue this loop directly
      this.emit(`if (${sigVar} === Symbol.for("BRIDGE_BREAK")) break;`);
      this.emit(
        `if (${sigVar} === Symbol.for("BRIDGE_CONTINUE")) { continue; }`,
      );
      // Multi-level: decrement and propagate as a value on the result array
      this.emit(
        `const __next = ${sigVar}.levels <= 2 ? (${sigVar}.__bridgeControl === 'break' ? Symbol.for("BRIDGE_BREAK") : Symbol.for("BRIDGE_CONTINUE")) : { __bridgeControl: ${sigVar}.__bridgeControl, levels: ${sigVar}.levels - 1 };`,
      );
      this.emit(
        `if (${sigVar}.__bridgeControl === 'break') { ${resultVar}.__propagate = __next; break; }`,
      );
      this.emit(`${resultVar}.__propagate = __next; continue;`);
      this.popIndent();
      this.emit("}");
      this.emit(`${resultVar}.push(${outVar});`);
      this.popIndent();
      this.emit(`}`);
      // If a multi-level signal was propagated, return it instead of the result
      this.emit(
        `if (${resultVar}.__propagate != null) { ${targetExpr} = ${resultVar}.__propagate; } else { ${targetExpr} = ${resultVar}; }`,
      );
    }
    this.popIndent();
    this.emit(`}`);
  }

  private compileArrayExpr(
    _expr: Extract<Expression, { type: "array" }>,
    _scope: ScopeChain,
  ): never {
    throw new BridgeCompilerIncompatibleError(
      `${this.bridge.type}.${this.bridge.field}`,
      "Array mapping is not yet supported by the new compiler.",
    );
  }

  // ── Pipe expression ───────────────────────────────────────────────────

  private compilePipeExpr(
    expr: Extract<Expression, { type: "pipe" }>,
    scope: ScopeChain,
  ): string {
    const sourceExpr = this.compileExpression(expr.source, scope);
    const pipePath = expr.path && expr.path.length > 0 ? expr.path : ["in"];

    // Look up tool binding for the pipe handle
    const binding = scope.get(expr.handle);
    if (!binding || binding.kind !== "tool") {
      throw new BridgeCompilerIncompatibleError(
        `${this.bridge.type}.${this.bridge.field}`,
        `Pipe handle "${expr.handle}" is not a tool binding.`,
      );
    }
    const toolName = binding.toolName ?? expr.handle;
    // Resolve fn through ToolDef extends chain
    const toolDef = this.resolveToolDef(toolName);
    const fnName = toolDef?.fn ?? toolName;
    const toolFnExpr = binding.toolFnExpr ?? `tools[${jsStr(fnName)}]`;

    // Check if this tool has ToolDef defaults or bridge input wires
    const hasToolDefDefaults = toolDef && toolDef.body.length > 0;

    // Check for bridge-level wires targeting this tool handle
    const hasBridgeWires = this.bridge.body.some(
      (s) =>
        s.kind === "wire" &&
        this.findTargetHandle(s.target, scope) === expr.handle,
    );

    if (!hasToolDefDefaults && !hasBridgeWires) {
      // Simple case — no ToolDef defaults or bridge wires, direct pipe call
      const inputObj = `{ ${pipePath.map((p) => `${jsStr(p)}: ${sourceExpr}`).join(", ")} }`;
      return `(await __pipe(${toolFnExpr}, ${jsStr(toolName)}, ${jsStr(fnName)}, ${inputObj}))`;
    }

    // Complex case — merge ToolDef defaults + pipe source
    // Emit as IIFE to build the input object
    const parts: string[] = [];
    parts.push("(await (async () => {");
    parts.push("  const __pipeInput = {};");

    // Compile ToolDef self-wire defaults inline (if toolDef exists)
    const defScope = scope.child();
    if (toolDef) {
      for (const stmt of toolDef.body) {
        if (stmt.kind === "with") {
          // Just register in scope — actual bindings come from parent
          if (stmt.binding.kind === "const") {
            defScope.set(stmt.binding.handle, {
              kind: "const",
              jsExpr: "__consts",
            });
          } else if (stmt.binding.kind === "context") {
            defScope.set(stmt.binding.handle, {
              kind: "context",
              jsExpr: "context",
            });
          }
        }
      }
      for (const stmt of toolDef.body) {
        if (stmt.kind === "wire" && stmt.target.instance == null) {
          const value = this.compileSourceChain(
            stmt.sources,
            stmt.catch,
            defScope,
          );
          const path = stmt.target.path;
          if (path.length === 0) {
            parts.push(`  Object.assign(__pipeInput, ${value});`);
          } else {
            for (let i = 0; i < path.length - 1; i++) {
              const pp = path
                .slice(0, i + 1)
                .map((p) => `[${jsStr(p)}]`)
                .join("");
              parts.push(`  __pipeInput${pp} ??= {};`);
            }
            parts.push(
              `  __pipeInput${path.map((p) => `[${jsStr(p)}]`).join("")} = ${value};`,
            );
          }
          parts.push(
            `  __pipeInput${path.map((p) => `[${jsStr(p)}]`).join("")} = ${value};`,
          );
        }
      }
    }

    // Bridge-level wires targeting this tool handle override ToolDef defaults
    for (const stmt of this.bridge.body) {
      if (stmt.kind !== "wire") continue;
      const handleName = this.findTargetHandle(stmt.target, scope);
      if (handleName !== expr.handle) continue;
      const value = this.compileSourceChain(stmt.sources, stmt.catch, scope);
      const path = stmt.target.path;
      if (path.length === 0) {
        parts.push(`  Object.assign(__pipeInput, ${value});`);
      } else {
        for (let i = 0; i < path.length - 1; i++) {
          const pp = path
            .slice(0, i + 1)
            .map((p) => `[${jsStr(p)}]`)
            .join("");
          parts.push(`  __pipeInput${pp} ??= {};`);
        }
        parts.push(
          `  __pipeInput${path.map((p) => `[${jsStr(p)}]`).join("")} = ${value};`,
        );
      }
    }

    // Pipe source overrides last
    for (let i = 0; i < pipePath.length - 1; i++) {
      const pp = pipePath
        .slice(0, i + 1)
        .map((p) => `[${jsStr(p)}]`)
        .join("");
      parts.push(`  __pipeInput${pp} ??= {};`);
    }
    parts.push(
      `  __pipeInput${pipePath.map((p) => `[${jsStr(p)}]`).join("")} = ${sourceExpr};`,
    );
    parts.push(
      `  return __pipe(${toolFnExpr}, ${jsStr(toolName)}, ${jsStr(fnName)}, __pipeInput);`,
    );
    parts.push("})())");

    return parts.join("\n");
  }

  // ── And/Or expression ─────────────────────────────────────────────────

  private compileAndOr(
    expr: Extract<Expression, { type: "and" | "or" }>,
    scope: ScopeChain,
    kind: "and" | "or",
  ): string {
    const leftExpr = this.compileExpression(expr.left, scope);
    const rightExpr = this.compileExpression(expr.right, scope);

    // Fast path — no safe flags
    if (!expr.leftSafe && !expr.rightSafe) {
      // Bridge and/or return Boolean values, unlike JS && / ||
      if (kind === "and") {
        return `(${leftExpr} ? Boolean(${rightExpr}) : false)`;
      }
      return `(${leftExpr} ? true : Boolean(${rightExpr}))`;
    }

    // Safe flags present — use IIFE with try/catch via preamble __catchSafe
    const hasAwait = leftExpr.includes("await") || rightExpr.includes("await");
    const parts: string[] = [];
    parts.push(hasAwait ? "(await (async () => {" : "(() => {");

    if (expr.leftSafe) {
      parts.push(
        `  let __l; try { __l = ${leftExpr}; } catch (__e) { __l = __catchSafe(__e); }`,
      );
    } else {
      parts.push(`  const __l = ${leftExpr};`);
    }

    if (kind === "and") {
      // and: if left falsy → false; else evaluate right
      parts.push("  if (!__l) return false;");
    } else {
      // or: if left truthy → true; else evaluate right
      parts.push("  if (__l) return true;");
    }

    if (expr.rightSafe) {
      parts.push(
        `  let __r; try { __r = ${rightExpr}; } catch (__e) { __r = __catchSafe(__e); }`,
      );
      parts.push("  return Boolean(__r);");
    } else {
      parts.push(`  return Boolean(${rightExpr});`);
    }

    parts.push(hasAwait ? "})())" : "})()");
    return parts.join("\n");
  }

  // ── Binary expression ─────────────────────────────────────────────────

  private compileBinaryExpr(
    expr: Extract<Expression, { type: "binary" }>,
    scope: ScopeChain,
  ): string {
    const left = this.compileExpression(expr.left, scope);
    const right = this.compileExpression(expr.right, scope);

    const opMap: Record<string, string> = {
      add: "+",
      sub: "-",
      mul: "*",
      div: "/",
      eq: "===",
      neq: "!==",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
    };

    const jsOp = opMap[expr.op];
    if (!jsOp) return "undefined";
    const isArithmetic =
      expr.op === "add" ||
      expr.op === "sub" ||
      expr.op === "mul" ||
      expr.op === "div";
    // Parallelize when both sides contain await to avoid sequential bottleneck
    if (left.includes("await") && right.includes("await")) {
      const rawL = left.startsWith("await ")
        ? left.slice(6)
        : `(async () => ${left})()`;
      const rawR = right.startsWith("await ")
        ? right.slice(6)
        : `(async () => ${right})()`;
      if (isArithmetic) {
        return `((__b) => __b[0] == null || __b[1] == null ? null : __b[0] ${jsOp} __b[1])(await Promise.all([${rawL}, ${rawR}]))`;
      }
      return `((__b) => __b[0] ${jsOp} __b[1])(await Promise.all([${rawL}, ${rawR}]))`;
    }
    if (isArithmetic) {
      return `((__a, __b) => __a == null || __b == null ? null : __a ${jsOp} __b)(${left}, ${right})`;
    }
    return `(${left} ${jsOp} ${right})`;
  }

  // ── Concat expression ─────────────────────────────────────────────────

  private compileConcatExpr(
    expr: Extract<Expression, { type: "concat" }>,
    scope: ScopeChain,
  ): string {
    const compiled = expr.parts.map((p) => this.compileExpression(p, scope));
    const asyncParts = compiled.filter((c) => c.includes("await"));
    if (asyncParts.length > 1) {
      // Parallelize async parts to avoid sequential await bottleneck
      const syncParts: string[] = [];
      const asyncIndices: number[] = [];
      for (let i = 0; i < compiled.length; i++) {
        if (compiled[i]!.includes("await")) asyncIndices.push(i);
      }
      const batchId = this.parallelBatchCount++;
      const resolved = `__cp${batchId}`;
      // Pre-resolve all async parts in parallel
      this.emit(
        `const ${resolved} = await Promise.all([${asyncIndices.map((i) => `(async () => ${compiled[i]!})()`).join(", ")}]);`,
      );
      let asyncIdx = 0;
      for (let i = 0; i < compiled.length; i++) {
        if (compiled[i]!.includes("await")) {
          syncParts.push(`__str(${resolved}[${asyncIdx++}])`);
        } else {
          syncParts.push(`__str(${compiled[i]!})`);
        }
      }
      return `(${syncParts.join(" + ")})`;
    }
    const parts = compiled.map((c) => `__str(${c})`);
    return `(${parts.join(" + ")})`;
  }

  // ── Control flow ──────────────────────────────────────────────────────

  private compileControlFlow(ctrl: {
    kind: string;
    message?: string;
    levels?: number;
  }): string {
    const levels =
      Number.isInteger(ctrl.levels) && (ctrl.levels as number) > 0
        ? (ctrl.levels as number)
        : 1;
    switch (ctrl.kind) {
      case "throw":
        return `(() => { throw new Error(${jsStr(ctrl.message ?? "")}); })()`;
      case "panic":
        return `(() => { throw new (__opts?.__BridgePanicError ?? Error)(${jsStr(ctrl.message ?? "")}); })()`;
      case "continue":
        return levels <= 1
          ? `Symbol.for("BRIDGE_CONTINUE")`
          : `({ __bridgeControl: "continue", levels: ${levels} })`;
      case "break":
        return levels <= 1
          ? `Symbol.for("BRIDGE_BREAK")`
          : `({ __bridgeControl: "break", levels: ${levels} })`;
      default:
        return "undefined";
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Compile a single bridge operation into a standalone async JavaScript function.
 *
 * The generated function uses a lazy-getter / pull-based model:
 * - Tools are wrapped in memoized async getters
 * - Output wires pull data on demand
 * - Scopes are JS closures with lexical binding
 */
export function compileBridge(
  document: BridgeDocument,
  options: CompileOptions,
): CompileResult {
  const { operation } = options;
  const dotIdx = operation.indexOf(".");
  if (dotIdx === -1) {
    throw new Error(
      `Invalid operation: "${operation}", expected "Type.field".`,
    );
  }
  const type = operation.substring(0, dotIdx);
  const field = operation.substring(dotIdx + 1);

  const bridge = document.instructions.find(
    (i): i is Bridge =>
      i.kind === "bridge" && i.type === type && i.field === field,
  );
  if (!bridge) {
    throw new Error(`No bridge definition found for operation: ${operation}`);
  }

  // Collect const definitions from the document
  const constDefs = new Map<string, string>();
  for (const inst of document.instructions) {
    if (inst.kind === "const") constDefs.set(inst.name, inst.value);
  }

  // Collect tool definitions from the document
  const toolDefs = new Map<string, ToolDef>();
  for (const inst of document.instructions) {
    if (inst.kind === "tool") toolDefs.set(inst.name, inst);
  }

  // Collect define definitions from the document
  const defineDefs = new Map<string, DefineDef>();
  for (const inst of document.instructions) {
    if (inst.kind === "define") defineDefs.set(inst.name, inst);
  }

  const ctx = new CodegenContext(
    bridge,
    constDefs,
    toolDefs,
    defineDefs,
    options.requestedFields,
  );
  return ctx.compile();
}
