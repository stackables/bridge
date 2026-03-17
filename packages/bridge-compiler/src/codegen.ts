/**
 * AOT code generator — turns a Bridge AST into a standalone JavaScript function.
 *
 * SECURITY NOTE: This entire file is a compiler back-end. Its sole purpose is
 * to transform a fully-parsed, validated Bridge AST into JavaScript source
 * strings. Every template-literal interpolation below assembles *generated
 * code* from deterministic AST walks — no raw external / user input is ever
 * spliced into the output. Security scanners (CodeQL js/code-injection,
 * Semgrep, LGTM) correctly flag dynamic code construction as a pattern worth
 * reviewing; after review the usage here is intentional and safe.
 *
 * lgtm [js/code-injection]
 */

import type {
  BridgeDocument,
  Bridge,
  NodeRef,
  ToolDef,
  Expression,
  ControlFlowInstruction,
  Statement,
  WireSourceEntry,
  WireCatch,
  HandleBinding,
  JsonValue,
  ScopeStatement,
} from "@stackables/bridge-core";
import { BridgePanicError } from "@stackables/bridge-core";
import type { SourceLocation } from "@stackables/bridge-types";
import {
  assertBridgeCompilerCompatible,
  BridgeCompilerIncompatibleError,
} from "./bridge-asserts.ts";

const SELF_MODULE = "_";
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function refTrunkKey(ref: NodeRef): string {
  if (ref.element) return `${ref.module}:${ref.type}:${ref.field}:*`;
  return `${ref.module}:${ref.type}:${ref.field}${ref.instance != null ? `:${ref.instance}` : ""}`;
}

function matchesRequestedFields(
  fieldPath: string,
  requestedFields: string[] | undefined,
): boolean {
  if (!requestedFields || requestedFields.length === 0) return true;
  for (const pattern of requestedFields) {
    if (pattern === fieldPath) return true;
    if (fieldPath.startsWith(pattern + ".")) return true;
    if (pattern.startsWith(fieldPath + ".")) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      if (fieldPath.startsWith(prefix + ".")) {
        const rest = fieldPath.slice(prefix.length + 1);
        if (!rest.includes(".")) return true;
      }
      if (fieldPath === prefix) return true;
    }
  }
  return false;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface CompileOptions {
  operation: string;
  requestedFields?: string[];
}

export interface CompileResult {
  code: string;
  functionName: string;
  functionBody: string;
}

export function compileBridge(
  document: BridgeDocument,
  options: CompileOptions,
): CompileResult {
  const { operation } = options;
  const dotIdx = operation.indexOf(".");
  if (dotIdx === -1)
    throw new Error(
      `Invalid operation: "${operation}", expected "Type.field".`,
    );
  const type = operation.substring(0, dotIdx);
  const field = operation.substring(dotIdx + 1);
  const bridge = document.instructions.find(
    (i): i is Bridge =>
      i.kind === "bridge" && i.type === type && i.field === field,
  );
  if (!bridge)
    throw new Error(`No bridge definition found for operation: ${operation}`);
  assertBridgeCompilerCompatible(bridge, options.requestedFields);
  const constDefs = new Map<string, string>();
  for (const inst of document.instructions) {
    if (inst.kind === "const") constDefs.set(inst.name, inst.value);
  }
  const toolDefs = document.instructions.filter(
    (i): i is ToolDef => i.kind === "tool",
  );
  const ctx = new CodegenContext(
    bridge,
    constDefs,
    toolDefs,
    options.requestedFields,
  );
  return ctx.compile();
}

// ── Internal types ──────────────────────────────────────────────────────────

interface ToolReg {
  trunkKey: string;
  toolName: string;
  handleName: string;
  varName: string;
  memoize?: boolean;
}

interface ExtractedWire {
  target: NodeRef;
  sources: WireSourceEntry[];
  catch?: WireCatch;
  loc?: SourceLocation;
}

// ── Codegen context ─────────────────────────────────────────────────────────

class CodegenContext {
  private bridge: Bridge;
  private constDefs: Map<string, string>;
  private toolDefs: ToolDef[];
  private requestedFields: string[] | undefined;
  private tools = new Map<string, ToolReg>();
  private toolInputWires = new Map<string, ExtractedWire[]>();
  private outputWires: ExtractedWire[] = [];
  private forces: { handle: string; module: string; type: string; field: string; instance?: number; catchError?: true }[] = [];
  private aliases = new Map<string, { sources: WireSourceEntry[]; catch?: WireCatch; loc?: SourceLocation }>();
  private spreads: { sources: WireSourceEntry[]; catch?: WireCatch; pathPrefix: string[]; loc?: SourceLocation }[] = [];
  private catchGuardedTools = new Set<string>();
  private memoizedToolKeys = new Set<string>();
  private toolFnVars = new Map<string, string>();
  private toolFnVarCounter = 0;
  private toolCounter = 0;

  constructor(
    bridge: Bridge,
    constDefs: Map<string, string>,
    toolDefs: ToolDef[],
    requestedFields?: string[],
  ) {
    this.bridge = bridge;
    this.constDefs = constDefs;
    this.toolDefs = toolDefs;
    this.requestedFields = requestedFields?.length ? requestedFields : undefined;
  }

  compile(): CompileResult {
    const { bridge } = this;
    const fnName = `${bridge.type}_${bridge.field}`;

    this.indexBody(bridge.body, []);
    this.validatePaths();

    const filteredOutputWires = this.requestedFields
      ? this.outputWires.filter((w) => {
          if (w.target.path.length === 0) return true;
          return matchesRequestedFields(w.target.path.join("."), this.requestedFields);
        })
      : this.outputWires;

    const orderedOutputWires = this.reorderOverdefinedWires(filteredOutputWires);

    if (orderedOutputWires.length === 0 && this.spreads.length === 0) {
      throw new Error(`Bridge ${bridge.type}.${bridge.field} has no output wires`);
    }

    this.detectCatchGuardedTools(orderedOutputWires);
    const toolLayers = this.topologicalLayers();
    const toolOrder = this.topologicalSort();
    const conditionalTools = this.analyzeOverdefinitionBypass(orderedOutputWires, toolOrder);
    const liveTools = this.findLiveTools(orderedOutputWires);

    const lines: string[] = [];
    lines.push(`// AOT-compiled bridge: ${bridge.type}.${bridge.field}`);
    lines.push(`// Generated by @stackables/bridge-compiler`);
    lines.push("");
    lines.push(`export default async function ${fnName}(input, tools, context, __opts) {`);

    this.emitPreamble(lines);
    this.emitToolLookups(lines, liveTools);
    this.emitToolCalls(lines, toolLayers, conditionalTools, liveTools);
    this.emitForceStatements(lines, liveTools);
    this.emitOutput(lines, orderedOutputWires);

    lines.push(`}`);

    const code = lines.join("\n");
    const bodyMatch = code.match(
      /export default async function \w+\(input, tools, context, __opts\) \{([\s\S]*)\}\s*$/,
    );
    return {
      code,
      functionName: fnName,
      functionBody: bodyMatch ? bodyMatch[1]! : code,
    };
  }

  // ── Statement tree indexing ─────────────────────────────────────────────

  private isSelfOutput(target: NodeRef): boolean {
    return (
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field &&
      !target.element &&
      target.instance == null
    );
  }

  private indexBody(stmts: Statement[], pathPrefix: string[]): void {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "with": {
          const b = stmt.binding;
          if (b.kind === "tool") this.registerTool(b);
          break;
        }
        case "wire": {
          const target = stmt.target;
          const isToolInput = target.instance != null && !target.element;
          if (isToolInput) {
            const tk = refTrunkKey(target);
            const arr = this.toolInputWires.get(tk) ?? [];
            arr.push({
              target: { ...target, path: [...pathPrefix, ...target.path] },
              sources: stmt.sources,
              catch: stmt.catch,
              loc: stmt.loc,
            });
            this.toolInputWires.set(tk, arr);
          } else if (this.isSelfOutput(target)) {
            this.outputWires.push({
              target: { ...target, path: [...pathPrefix, ...target.path] },
              sources: stmt.sources,
              catch: stmt.catch,
              loc: stmt.loc,
            });
          } else if (target.module.startsWith("__define_")) {
            const tk = refTrunkKey(target);
            const arr = this.toolInputWires.get(tk) ?? [];
            arr.push({
              target: { ...target, path: [...pathPrefix, ...target.path] },
              sources: stmt.sources,
              catch: stmt.catch,
              loc: stmt.loc,
            });
            this.toolInputWires.set(tk, arr);
          }
          break;
        }
        case "alias":
          this.aliases.set(stmt.name, { sources: stmt.sources, catch: stmt.catch, loc: stmt.loc });
          break;
        case "spread":
          this.spreads.push({ sources: stmt.sources, catch: stmt.catch, pathPrefix: [...pathPrefix], loc: stmt.loc });
          break;
        case "scope":
          this.indexBody(stmt.body, [...pathPrefix, ...stmt.target.path]);
          break;
        case "force":
          this.forces.push(stmt);
          break;
      }
    }
  }

  private registerTool(binding: HandleBinding & { kind: "tool" }): void {
    const resolved = this.resolveToolDef(binding.name);
    const fnName = resolved.fn ?? binding.name;

    let instance = 1;
    for (const stmt of this.flattenStatements(this.bridge.body)) {
      if (stmt.kind === "wire" && stmt.target.field === binding.name.split(".").pop() && stmt.target.instance != null) {
        instance = stmt.target.instance;
        break;
      }
      if (stmt.kind === "force" && stmt.field === binding.name.split(".").pop() && stmt.instance != null) {
        instance = stmt.instance;
        break;
      }
    }

    const dotIdx = binding.name.lastIndexOf(".");
    let module: string, fieldName: string, refType: string;
    if (dotIdx === -1) {
      module = SELF_MODULE;
      fieldName = binding.name;
      refType = "Tools";
    } else {
      module = binding.name.substring(0, dotIdx);
      fieldName = binding.name.substring(dotIdx + 1);
      refType = this.bridge.type;
    }

    const tk = `${module}:${refType}:${fieldName}:${instance}`;
    if (this.tools.has(tk)) return;

    const vn = `_t${++this.toolCounter}`;
    this.tools.set(tk, {
      trunkKey: tk,
      toolName: fnName,
      handleName: binding.name,
      varName: vn,
      memoize: binding.memoize,
    });
    if (binding.memoize) this.memoizedToolKeys.add(tk);
  }

  private resolveToolDef(name: string): { fn?: string; chain: ToolDef[] } {
    const chain: ToolDef[] = [];
    let current = name;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(current)) break;
      visited.add(current);
      const td = this.toolDefs.find((t) => t.name === current);
      if (!td) break;
      chain.push(td);
      if (td.fn) return { fn: td.fn, chain };
      if (td.extends) { current = td.extends; } else { break; }
    }
    return { fn: chain[0]?.fn, chain };
  }

  private *flattenStatements(stmts: Statement[]): Generator<Statement> {
    for (const s of stmts) {
      yield s;
      if (s.kind === "scope") yield* this.flattenStatements(s.body);
      if ((s.kind === "wire" || s.kind === "alias") && s.sources[0]?.expr.type === "array") {
        yield* this.flattenStatements(s.sources[0].expr.body);
      }
    }
  }

  // ── Validation ──────────────────────────────────────────────────────────

  private validatePaths(): void {
    const checkRef = (ref: NodeRef) => {
      for (const seg of ref.path) {
        if (UNSAFE_KEYS.has(seg)) throw new Error(`Unsafe property traversal: ${seg}`);
      }
    };
    for (const w of this.outputWires) {
      for (const seg of w.target.path) {
        if (UNSAFE_KEYS.has(seg)) throw new Error(`Unsafe assignment key: ${seg}`);
      }
      for (const src of w.sources) this.walkExprRefs(src.expr, checkRef);
    }
    for (const [, wires] of this.toolInputWires) {
      for (const w of wires) {
        for (const seg of w.target.path) {
          if (UNSAFE_KEYS.has(seg)) throw new Error(`Unsafe assignment key: ${seg}`);
        }
        for (const src of w.sources) this.walkExprRefs(src.expr, checkRef);
      }
    }
    for (const h of this.bridge.handles) {
      if (h.kind !== "tool") continue;
      for (const seg of h.name.split(".")) {
        if (UNSAFE_KEYS.has(seg))
          throw new Error(`No tool found for "${h.name}" — prototype-pollution attempt blocked`);
      }
    }
  }

  private walkExprRefs(expr: Expression, fn: (ref: NodeRef) => void): void {
    switch (expr.type) {
      case "ref": fn(expr.ref); break;
      case "ternary": this.walkExprRefs(expr.cond, fn); this.walkExprRefs(expr.then, fn); this.walkExprRefs(expr.else, fn); break;
      case "and": case "or": this.walkExprRefs(expr.left, fn); this.walkExprRefs(expr.right, fn); break;
      case "binary": this.walkExprRefs(expr.left, fn); this.walkExprRefs(expr.right, fn); break;
      case "unary": this.walkExprRefs(expr.operand, fn); break;
      case "concat": for (const p of expr.parts) this.walkExprRefs(p, fn); break;
      case "pipe": this.walkExprRefs(expr.source, fn); break;
      case "array": this.walkExprRefs(expr.source, fn); break;
    }
  }

  // ── Overdefinition reordering ─────────────────────────────────────────

  private reorderOverdefinedWires(wires: ExtractedWire[]): ExtractedWire[] {
    const groups = new Map<string, ExtractedWire[]>();
    for (const w of wires) {
      const key = w.target.path.join(".");
      const arr = groups.get(key) ?? [];
      arr.push(w);
      groups.set(key, arr);
    }
    const result: ExtractedWire[] = [];
    const seen = new Set<string>();
    for (const w of wires) {
      const key = w.target.path.join(".");
      if (seen.has(key)) continue;
      seen.add(key);
      const group = groups.get(key)!;
      if (group.length <= 1) {
        result.push(...group);
      } else {
        const sorted = [...group].sort((a, b) => this.wireCost(a) - this.wireCost(b));
        result.push(...sorted);
      }
    }
    return result;
  }

  private wireCost(w: ExtractedWire): number {
    return w.sources[0]?.expr ? this.exprCost(w.sources[0].expr) : 0;
  }

  private exprCost(expr: Expression): number {
    switch (expr.type) {
      case "literal": case "control": return 0;
      case "ref": {
        const ref = expr.ref;
        if (ref.module === "__local") return 0;
        if (ref.module === SELF_MODULE && ref.type === "Const") return 0;
        if (ref.module === SELF_MODULE && ref.type === "Context") return 0;
        if (ref.instance != null) return 1;
        if (ref.module === SELF_MODULE && ref.type === this.bridge.type && ref.field === this.bridge.field) return 0;
        return 1;
      }
      case "pipe": return 1;
      case "ternary": return Math.max(this.exprCost(expr.cond), this.exprCost(expr.then), this.exprCost(expr.else));
      default: return 0;
    }
  }

  // ── Catch-guard detection ─────────────────────────────────────────────

  private detectCatchGuardedTools(outputWires: ExtractedWire[]): void {
    for (const w of outputWires) {
      const needsCatch = w.catch != null || (w.sources[0]?.expr.type === "ref" && w.sources[0].expr.safe);
      if (!needsCatch) continue;
      if (w.sources[0]?.expr.type === "ref" && w.sources[0].expr.ref.instance != null) {
        this.catchGuardedTools.add(refTrunkKey(w.sources[0].expr.ref));
      }
    }
  }

  // ── Topological sort ──────────────────────────────────────────────────

  private getToolDeps(tk: string): Set<string> {
    const deps = new Set<string>();
    const wires = this.toolInputWires.get(tk) ?? [];
    for (const w of wires) {
      for (const src of w.sources) this.collectToolRefs(src.expr, deps);
    }
    const tool = this.tools.get(tk);
    if (tool) {
      const tdWires = this.getToolDefWires(tool.handleName);
      for (const w of tdWires) {
        for (const src of w.sources) this.collectToolRefs(src.expr, deps);
      }
    }
    return deps;
  }

  private collectToolRefs(expr: Expression, deps: Set<string>): void {
    switch (expr.type) {
      case "ref":
        if (expr.ref.instance != null) deps.add(refTrunkKey(expr.ref));
        if (expr.ref.module === "__local") {
          const alias = this.aliases.get(expr.ref.field);
          if (alias) { for (const src of alias.sources) this.collectToolRefs(src.expr, deps); }
        }
        break;
      case "pipe": {
        this.collectToolRefs(expr.source, deps);
        const ptk = this.findToolTkForHandle(expr.handle);
        if (ptk) deps.add(ptk);
        break;
      }
      case "ternary": this.collectToolRefs(expr.cond, deps); this.collectToolRefs(expr.then, deps); this.collectToolRefs(expr.else, deps); break;
      case "and": case "or": this.collectToolRefs(expr.left, deps); this.collectToolRefs(expr.right, deps); break;
      case "binary": this.collectToolRefs(expr.left, deps); this.collectToolRefs(expr.right, deps); break;
      case "unary": this.collectToolRefs(expr.operand, deps); break;
      case "concat": for (const p of expr.parts) this.collectToolRefs(p, deps); break;
      case "array": this.collectToolRefs(expr.source, deps); break;
    }
  }

  private findToolTkForHandle(handle: string): string | undefined {
    for (const [tk, reg] of this.tools) {
      if (reg.handleName === handle) return tk;
    }
    return undefined;
  }

  private topologicalSort(): string[] {
    const allTools = [...this.tools.keys()];
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();
    for (const tk of allTools) { inDegree.set(tk, 0); adjList.set(tk, []); }
    for (const tk of allTools) {
      const deps = this.getToolDeps(tk);
      for (const dep of deps) {
        if (allTools.includes(dep) && dep !== tk) {
          adjList.get(dep)!.push(tk);
          inDegree.set(tk, (inDegree.get(tk) ?? 0) + 1);
        }
      }
    }
    const queue: string[] = [];
    for (const [tk, deg] of inDegree) { if (deg === 0) queue.push(tk); }
    const result: string[] = [];
    while (queue.length > 0) {
      const tk = queue.shift()!;
      result.push(tk);
      for (const next of adjList.get(tk) ?? []) {
        const nd = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, nd);
        if (nd === 0) queue.push(next);
      }
    }
    return result;
  }

  private topologicalLayers(): string[][] {
    const allTools = [...this.tools.keys()];
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();
    for (const tk of allTools) { inDegree.set(tk, 0); adjList.set(tk, []); }
    for (const tk of allTools) {
      const deps = this.getToolDeps(tk);
      for (const dep of deps) {
        if (allTools.includes(dep) && dep !== tk) {
          adjList.get(dep)!.push(tk);
          inDegree.set(tk, (inDegree.get(tk) ?? 0) + 1);
        }
      }
    }
    const layers: string[][] = [];
    const remaining = new Map(inDegree);
    while (remaining.size > 0) {
      const layer: string[] = [];
      for (const [tk, deg] of remaining) { if (deg === 0) layer.push(tk); }
      if (layer.length === 0) break;
      for (const tk of layer) {
        remaining.delete(tk);
        for (const next of adjList.get(tk) ?? []) {
          if (remaining.has(next)) remaining.set(next, (remaining.get(next) ?? 1) - 1);
        }
      }
      layers.push(layer);
    }
    return layers;
  }

  // ── Dead tool elimination ─────────────────────────────────────────────

  private findLiveTools(outputWires: ExtractedWire[]): Set<string> {
    const live = new Set<string>();
    const visit = (tk: string) => {
      if (live.has(tk)) return;
      live.add(tk);
      const deps = this.getToolDeps(tk);
      for (const dep of deps) { if (this.tools.has(dep)) visit(dep); }
    };
    for (const w of outputWires) {
      for (const src of w.sources) {
        const deps = new Set<string>();
        this.collectToolRefs(src.expr, deps);
        for (const d of deps) visit(d);
      }
      if (w.catch) {
        const deps = new Set<string>();
        if ("ref" in w.catch && w.catch.ref.instance != null) deps.add(refTrunkKey(w.catch.ref));
        if ("expr" in w.catch) this.collectToolRefs(w.catch.expr, deps);
        for (const d of deps) visit(d);
      }
    }
    for (const s of this.spreads) {
      for (const src of s.sources) {
        const deps = new Set<string>();
        this.collectToolRefs(src.expr, deps);
        for (const d of deps) visit(d);
      }
    }
    for (const f of this.forces) {
      const tk = `${f.module}:${f.type}:${f.field}:${f.instance ?? 1}`;
      if (this.tools.has(tk)) visit(tk);
    }
    for (const [, a] of this.aliases) {
      for (const src of a.sources) {
        const deps = new Set<string>();
        this.collectToolRefs(src.expr, deps);
        for (const d of deps) visit(d);
      }
    }
    return live;
  }

  // ── Overdefinition bypass ─────────────────────────────────────────────

  private analyzeOverdefinitionBypass(
    outputWires: ExtractedWire[],
    _toolOrder: string[],
  ): Map<string, { checkExprs: string[] }> {
    const groups = new Map<string, ExtractedWire[]>();
    for (const w of outputWires) {
      const key = w.target.path.join(".");
      const arr = groups.get(key) ?? [];
      arr.push(w);
      groups.set(key, arr);
    }

    const toolSecondary = new Map<string, { primary: boolean; secondaryPaths: string[] }>();

    for (const [pathKey, wires] of groups) {
      if (wires.length <= 1) continue;
      for (let i = 0; i < wires.length; i++) {
        const w = wires[i]!;
        const toolTks = new Set<string>();
        this.collectToolRefs(w.sources[0]!.expr, toolTks);
        for (const tk of toolTks) {
          if (!this.tools.has(tk)) continue;
          let pos = toolSecondary.get(tk);
          if (!pos) { pos = { primary: false, secondaryPaths: [] }; toolSecondary.set(tk, pos); }
          if (i === 0) pos.primary = true;
          else pos.secondaryPaths.push(pathKey);
        }
      }
    }

    const forceKeys = new Set(this.forces.map((f) => `${f.module}:${f.type}:${f.field}:${f.instance ?? 1}`));
    const result = new Map<string, { checkExprs: string[] }>();

    for (const [tk, pos] of toolSecondary) {
      if (pos.primary || forceKeys.has(tk)) continue;
      // Check if tool has primary contributions on other paths
      let hasPrimaryElsewhere = false;
      for (const [, wires] of groups) {
        const firstToolTks = new Set<string>();
        this.collectToolRefs(wires[0]!.sources[0]!.expr, firstToolTks);
        if (firstToolTks.has(tk)) { hasPrimaryElsewhere = true; break; }
      }
      // Also check single-wire paths
      for (const w of outputWires) {
        const pathKey = w.target.path.join(".");
        const pathGroup = groups.get(pathKey)!;
        if (pathGroup.length === 1) {
          const wToolTks = new Set<string>();
          this.collectToolRefs(w.sources[0]!.expr, wToolTks);
          if (wToolTks.has(tk)) { hasPrimaryElsewhere = true; break; }
        }
      }
      if (hasPrimaryElsewhere) continue;

      const checkExprs: string[] = [];
      for (const pathKey of pos.secondaryPaths) {
        const wires = groups.get(pathKey)!;
        for (const w of wires) {
          const wToolTks = new Set<string>();
          this.collectToolRefs(w.sources[0]!.expr, wToolTks);
          if (wToolTks.has(tk)) break;
          if (this.wireCost(w) === 0) {
            checkExprs.push(this.exprToJs(w.sources[0]!.expr, "  "));
          }
        }
      }
      if (checkExprs.length > 0) result.set(tk, { checkExprs });
    }
    return result;
  }

  // ── Tool lookup expression ────────────────────────────────────────────

  private toolLookupExpr(fnName: string): string {
    if (!fnName.includes(".")) return `tools?.[${JSON.stringify(fnName)}]`;
    const parts = fnName.split(".");
    const nested = "tools" + parts.map((p) => `?.[${JSON.stringify(p)}]`).join("");
    const flat = `tools?.[${JSON.stringify(fnName)}]`;
    return `${nested} ?? ${flat}`;
  }

  private toolFnVar(fnName: string): string {
    let varName = this.toolFnVars.get(fnName);
    if (!varName) {
      varName = `__fn${++this.toolFnVarCounter}`;
      this.toolFnVars.set(fnName, varName);
    }
    return varName;
  }

  // ── Preamble ──────────────────────────────────────────────────────────

  private emitPreamble(lines: string[]): void {
    lines.push(`  const __BridgePanicError = __opts?.__BridgePanicError ?? class extends Error { constructor(m) { super(m); this.name = "BridgePanicError"; } };`);
    lines.push(`  const __BridgeAbortError = __opts?.__BridgeAbortError ?? class extends Error { constructor(m) { super(m ?? "Execution aborted by external signal"); this.name = "BridgeAbortError"; } };`);
    lines.push(`  const __BridgeTimeoutError = __opts?.__BridgeTimeoutError ?? class extends Error { constructor(n, ms) { super('Tool "' + n + '" timed out after ' + ms + 'ms'); this.name = "BridgeTimeoutError"; } };`);
    lines.push(`  const __BridgeRuntimeError = __opts?.__BridgeRuntimeError ?? class extends Error { constructor(message, options) { super(message, options && "cause" in options ? { cause: options.cause } : undefined); this.name = "BridgeRuntimeError"; this.bridgeLoc = options?.bridgeLoc; } };`);
    lines.push(`  const __signal = __opts?.signal;`);
    lines.push(`  const __timeoutMs = __opts?.toolTimeoutMs ?? 0;`);
    lines.push(`  const __ctx = { logger: __opts?.logger ?? {}, signal: __signal };`);
    lines.push(`  const __queueMicrotask = globalThis.queueMicrotask ?? ((fn) => Promise.resolve().then(fn));`);
    lines.push(`  const __batchQueues = new Map();`);
    lines.push(`  const __trace = __opts?.__trace;`);
    lines.push(`  function __toolExecutionLogLevel(fn) {`);
    lines.push(`    const log = fn?.bridge?.log;`);
    lines.push(`    if (log === false || log == null) return false;`);
    lines.push(`    if (log === true) return "info";`);
    lines.push(`    return log.execution === "info" ? "info" : log.execution ? "debug" : false;`);
    lines.push(`  }`);
    lines.push(`  function __toolErrorLogLevel(fn) {`);
    lines.push(`    const log = fn?.bridge?.log;`);
    lines.push(`    if (log === false) return false;`);
    lines.push(`    if (log == null || log === true) return "error";`);
    lines.push(`    return log.errors === false ? false : log.errors === "warn" ? "warn" : "error";`);
    lines.push(`  }`);
    lines.push(`  function __rethrowBridgeError(err, loc) {`);
    lines.push(`    if (err?.name === "BridgePanicError") throw __attachBridgeMeta(err, loc);`);
    lines.push(`    if (err?.name === "BridgeAbortError") throw err;`);
    lines.push(`    if (err?.name === "BridgeRuntimeError" && err.bridgeLoc != null) throw err;`);
    lines.push(`    throw new __BridgeRuntimeError(err instanceof Error ? err.message : String(err), { cause: err, bridgeLoc: loc });`);
    lines.push(`  }`);
    lines.push(`  function __wrapBridgeError(fn, loc) {`);
    lines.push(`    try { return fn(); } catch (err) { __rethrowBridgeError(err, loc); }`);
    lines.push(`  }`);
    lines.push(`  async function __wrapBridgeErrorAsync(fn, loc) {`);
    lines.push(`    try { return await fn(); } catch (err) { __rethrowBridgeError(err, loc); }`);
    lines.push(`  }`);
    lines.push(`  function __attachBridgeMeta(err, loc) {`);
    lines.push(`    if (err && (typeof err === "object" || typeof err === "function")) {`);
    lines.push(`      if (err.bridgeLoc === undefined) err.bridgeLoc = loc;`);
    lines.push(`    }`);
    lines.push(`    return err;`);
    lines.push(`  }`);
    lines.push(`  function __get(base, segment, accessSafe, allowMissingBase) {`);
    lines.push(`    if (base == null) {`);
    lines.push(`      if (allowMissingBase || accessSafe) return undefined;`);
    lines.push(`      throw new TypeError("Cannot read properties of " + base + " (reading '" + segment + "')");`);
    lines.push(`    }`);
    lines.push(`    const next = base[segment];`);
    lines.push(`    const isPrimitiveBase = base !== null && typeof base !== "object" && typeof base !== "function";`);
    lines.push(`    if (isPrimitiveBase && next === undefined) {`);
    lines.push(`      throw new TypeError("Cannot read properties of " + base + " (reading '" + segment + "')");`);
    lines.push(`    }`);
    lines.push(`    return next;`);
    lines.push(`  }`);
    lines.push(`  function __path(base, path, safe, allowMissingBase) {`);
    lines.push(`    let result = base;`);
    lines.push(`    for (let i = 0; i < path.length; i++) {`);
    lines.push(`      const segment = path[i];`);
    lines.push(`      const accessSafe = safe?.[i] ?? false;`);
    lines.push(`      if (result == null) {`);
    lines.push(`        if ((i === 0 && allowMissingBase) || accessSafe) { result = undefined; continue; }`);
    lines.push(`        throw new TypeError("Cannot read properties of " + result + " (reading '" + segment + "')");`);
    lines.push(`      }`);
    lines.push(`      const next = result[segment];`);
    lines.push(`      const isPrimitiveBase = result !== null && typeof result !== "object" && typeof result !== "function";`);
    lines.push(`      if (isPrimitiveBase && next === undefined) {`);
    lines.push(`        throw new TypeError("Cannot read properties of " + result + " (reading '" + segment + "')");`);
    lines.push(`      }`);
    lines.push(`      result = next;`);
    lines.push(`    }`);
    lines.push(`    return result;`);
    lines.push(`  }`);
    lines.push(`  function __callBatch(fn, input, toolDefName, fnName) {`);
    lines.push(`    if (__signal?.aborted) return Promise.reject(new __BridgeAbortError());`);
    lines.push(`    if (typeof fn !== "function") return Promise.reject(new __BridgeRuntimeError('No tool found for "' + fnName + '"'));`);
    lines.push(`    let queue = __batchQueues.get(fn);`);
    lines.push(`    if (!queue) {`);
    lines.push(`      queue = { items: [], scheduled: false, toolDefName, fnName, maxBatchSize: typeof fn?.bridge?.batch === "object" && fn?.bridge?.batch?.maxBatchSize > 0 ? Math.floor(fn.bridge.batch.maxBatchSize) : undefined };`);
    lines.push(`      __batchQueues.set(fn, queue);`);
    lines.push(`    }`);
    lines.push(`    return new Promise((resolve, reject) => {`);
    lines.push(`      queue.items.push({ input, resolve, reject });`);
    lines.push(`      if (queue.scheduled) return;`);
    lines.push(`      queue.scheduled = true;`);
    lines.push(`      __queueMicrotask(() => { void __flushBatch(fn, queue); });`);
    lines.push(`    });`);
    lines.push(`  }`);
    lines.push(`  async function __flushBatch(fn, queue) {`);
    lines.push(`    const pending = queue.items.splice(0, queue.items.length);`);
    lines.push(`    queue.scheduled = false;`);
    lines.push(`    if (pending.length === 0) return;`);
    lines.push(`    if (__signal?.aborted) { const err = new __BridgeAbortError(); for (const item of pending) item.reject(err); return; }`);
    lines.push(`    const chunkSize = queue.maxBatchSize && queue.maxBatchSize > 0 ? queue.maxBatchSize : pending.length;`);
    lines.push(`    for (let start = 0; start < pending.length; start += chunkSize) {`);
    lines.push(`      const chunk = pending.slice(start, start + chunkSize);`);
    lines.push(`      const inputs = chunk.map((item) => item.input);`);
    lines.push(`      const startTime = (__trace || __ctx.logger) ? performance.now() : 0;`);
    lines.push(`      try {`);
    lines.push(`        const batchPromise = fn(inputs, __ctx);`);
    lines.push(`        let result;`);
    lines.push(`        if (__timeoutMs > 0 && batchPromise && typeof batchPromise.then === "function") {`);
    lines.push(`          let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new __BridgeTimeoutError(queue.toolDefName, __timeoutMs)), __timeoutMs); });`);
    lines.push(`          try { result = await Promise.race([batchPromise, timeout]); } finally { clearTimeout(t); }`);
    lines.push(`        } else { result = await batchPromise; }`);
    lines.push(`        if (__trace && fn?.bridge?.trace !== false) __trace(queue.toolDefName, queue.fnName, startTime, performance.now(), inputs, result, null);`);
    lines.push(`        const __execLevel = __toolExecutionLogLevel(fn);`);
    lines.push(`        if (__execLevel) __ctx.logger?.[__execLevel]?.({ tool: queue.toolDefName, fn: queue.fnName, durationMs: Math.round((performance.now() - startTime) * 1000) / 1000 }, "[bridge] tool completed");`);
    lines.push(`        if (!Array.isArray(result)) throw new Error('Batch tool "' + queue.toolDefName + '" must return an array of results');`);
    lines.push(`        if (result.length !== chunk.length) throw new Error('Batch tool "' + queue.toolDefName + '" returned ' + result.length + ' results for ' + chunk.length + ' queued calls');`);
    lines.push(`        for (let i = 0; i < chunk.length; i++) { const value = result[i]; if (value instanceof Error) chunk[i].reject(value); else chunk[i].resolve(value); }`);
    lines.push(`      } catch (err) {`);
    lines.push(`        try { __rethrowBridgeError(err, undefined); } catch (_wrapped) { err = _wrapped; }`);
    lines.push(`        if (__trace && fn?.bridge?.trace !== false) __trace(queue.toolDefName, queue.fnName, startTime, performance.now(), inputs, null, err);`);
    lines.push(`        const __errorLevel = __toolErrorLogLevel(fn);`);
    lines.push(`        if (__errorLevel) __ctx.logger?.[__errorLevel]?.({ tool: queue.toolDefName, fn: queue.fnName, err: err instanceof Error ? err.message : String(err) }, "[bridge] tool failed");`);
    lines.push(`        for (const item of chunk) item.reject(err);`);
    lines.push(`      }`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  function __callSync(fn, input, toolDefName, fnName) {`);
    lines.push(`    if (__signal?.aborted) throw new __BridgeAbortError();`);
    lines.push(`    if (typeof fn !== "function") throw new __BridgeRuntimeError('No tool found for "' + fnName + '"');`);
    lines.push(`    const start = __trace ? performance.now() : 0;`);
    lines.push(`    try {`);
    lines.push(`      const result = fn(input, __ctx);`);
    lines.push(`      if (result && typeof result.then === "function") throw new Error("Tool \\"" + toolDefName + "\\" declared {sync:true} but returned a Promise");`);
    lines.push(`      if (__trace && fn?.bridge?.trace !== false) __trace(toolDefName, fnName, start, performance.now(), input, result, null);`);
    lines.push(`      const __execLevel = __toolExecutionLogLevel(fn);`);
    lines.push(`      if (__execLevel) __ctx.logger?.[__execLevel]?.({ tool: toolDefName, fn: fnName, durationMs: Math.round((performance.now() - start) * 1000) / 1000 }, "[bridge] tool completed");`);
    lines.push(`      return result;`);
    lines.push(`    } catch (err) {`);
    lines.push(`      if (__trace && fn?.bridge?.trace !== false) __trace(toolDefName, fnName, start, performance.now(), input, null, err);`);
    lines.push(`      const __errorLevel = __toolErrorLogLevel(fn);`);
    lines.push(`      if (__errorLevel) __ctx.logger?.[__errorLevel]?.({ tool: toolDefName, fn: fnName, err: err instanceof Error ? err.message : String(err) }, "[bridge] tool failed");`);
    lines.push(`      __rethrowBridgeError(err, undefined);`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  const __isLoopCtrl = (v) => (v?.__bridgeControl === "break" || v?.__bridgeControl === "continue") && Number.isInteger(v?.levels) && v.levels > 0;`);
    lines.push(`  const __nextLoopCtrl = (v) => ({ __bridgeControl: v.__bridgeControl, levels: v.levels - 1 });`);
    lines.push(`  async function __call(fn, input, toolDefName, fnName) {`);
    lines.push(`    if (__signal?.aborted) throw new __BridgeAbortError();`);
    lines.push(`    if (typeof fn !== "function") throw new __BridgeRuntimeError('No tool found for "' + fnName + '"');`);
    lines.push(`    const start = __trace ? performance.now() : 0;`);
    lines.push(`    try {`);
    lines.push(`      const p = fn(input, __ctx);`);
    lines.push(`      let result;`);
    lines.push(`      if (__timeoutMs > 0) {`);
    lines.push(`        let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new __BridgeTimeoutError(toolDefName, __timeoutMs)), __timeoutMs); });`);
    lines.push(`        try { result = await Promise.race([p, timeout]); } finally { clearTimeout(t); }`);
    lines.push(`      } else { result = await p; }`);
    lines.push(`      if (__trace && fn?.bridge?.trace !== false) __trace(toolDefName, fnName, start, performance.now(), input, result, null);`);
    lines.push(`      const __execLevel = __toolExecutionLogLevel(fn);`);
    lines.push(`      if (__execLevel) __ctx.logger?.[__execLevel]?.({ tool: toolDefName, fn: fnName, durationMs: Math.round((performance.now() - start) * 1000) / 1000 }, "[bridge] tool completed");`);
    lines.push(`      return result;`);
    lines.push(`    } catch (err) {`);
    lines.push(`      if (__trace && fn?.bridge?.trace !== false) __trace(toolDefName, fnName, start, performance.now(), input, null, err);`);
    lines.push(`      const __errorLevel = __toolErrorLogLevel(fn);`);
    lines.push(`      if (__errorLevel) __ctx.logger?.[__errorLevel]?.({ tool: toolDefName, fn: fnName, err: err instanceof Error ? err.message : String(err) }, "[bridge] tool failed");`);
    lines.push(`      __rethrowBridgeError(err, undefined);`);
    lines.push(`    }`);
    lines.push(`  }`);
    if (this.memoizedToolKeys.size > 0) {
      lines.push(`  const __toolMemoCache = new Map();`);
      lines.push(`  function __stableMemoizeKey(value) {`);
      lines.push(`    if (value === undefined) return "undefined";`);
      lines.push("    if (typeof value === \"bigint\") return `${value}n`;");
      lines.push(`    if (value === null || typeof value !== "object") { const serialized = JSON.stringify(value); return serialized ?? String(value); }`);
      lines.push("    if (Array.isArray(value)) { return `[${value.map((item) => __stableMemoizeKey(item)).join(\",\")}]`; }");
      lines.push(`    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));`);
      lines.push("    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${__stableMemoizeKey(entryValue)}`).join(\",\")}}`;");
      lines.push(`  }`);
      lines.push(`  function __callMemoized(fn, input, toolDefName, fnName, memoizeKey) {`);
      lines.push(`    let toolCache = __toolMemoCache.get(memoizeKey);`);
      lines.push(`    if (!toolCache) { toolCache = new Map(); __toolMemoCache.set(memoizeKey, toolCache); }`);
      lines.push(`    const cacheKey = __stableMemoizeKey(input);`);
      lines.push(`    const cached = toolCache.get(cacheKey);`);
      lines.push(`    if (cached !== undefined) return cached;`);
      lines.push(`    try {`);
      lines.push(`      const result = fn?.bridge?.batch ? __callBatch(fn, input, toolDefName, fnName) : fn?.bridge?.sync ? __callSync(fn, input, toolDefName, fnName) : __call(fn, input, toolDefName, fnName);`);
      lines.push(`      if (result && typeof result.then === "function") {`);
      lines.push(`        const pending = Promise.resolve(result).catch((error) => { toolCache.delete(cacheKey); throw error; });`);
      lines.push(`        toolCache.set(cacheKey, pending); return pending;`);
      lines.push(`      }`);
      lines.push(`      toolCache.set(cacheKey, result); return result;`);
      lines.push(`    } catch (error) { toolCache.delete(cacheKey); throw error; }`);
      lines.push(`  }`);
    }
  }

  // ── Tool lookups ──────────────────────────────────────────────────────

  private emitToolLookups(lines: string[], liveTools: Set<string>): void {
    const emitted = new Set<string>();
    for (const [tk, tool] of this.tools) {
      if (!liveTools.has(tk)) continue;
      const fnName = tool.toolName;
      if (emitted.has(fnName)) continue;
      emitted.add(fnName);
      const varName = this.toolFnVar(fnName);
      lines.push(`  const ${varName} = ${this.toolLookupExpr(fnName)};`);
    }
  }

  // ── Tool calls ────────────────────────────────────────────────────────

  private emitToolCalls(
    lines: string[],
    layers: string[][],
    conditionalTools: Map<string, { checkExprs: string[] }>,
    liveTools: Set<string>,
  ): void {
    for (const layer of layers) {
      const liveInLayer = layer.filter((tk) => liveTools.has(tk));
      if (liveInLayer.length === 0) continue;

      if (liveInLayer.length === 1) {
        this.emitSingleToolCall(lines, liveInLayer[0]!, conditionalTools);
      } else {
        const hasConditionals = liveInLayer.some((tk) => conditionalTools.has(tk));
        if (hasConditionals) {
          for (const tk of liveInLayer) this.emitSingleToolCall(lines, tk, conditionalTools);
        } else {
          const vars = liveInLayer.map((tk) => this.tools.get(tk)!.varName);
          lines.push(`  const [${vars.join(", ")}] = await Promise.all([`);
          for (let i = 0; i < liveInLayer.length; i++) {
            const tk = liveInLayer[i]!;
            const tool = this.tools.get(tk)!;
            const inputObj = this.buildToolInputObj(tk, "    ");
            const callExpr = this.buildToolCallExpr(tool, inputObj);
            const suffix = i < liveInLayer.length - 1 ? "," : "";
            lines.push(`    ${callExpr}${suffix}`);
          }
          lines.push(`  ]);`);
        }
      }
    }
  }

  private emitSingleToolCall(
    lines: string[],
    tk: string,
    conditionalTools: Map<string, { checkExprs: string[] }>,
  ): void {
    const tool = this.tools.get(tk)!;
    const inputObj = this.buildToolInputObj(tk, "  ");
    const callExpr = this.buildToolCallExpr(tool, inputObj);
    const cond = conditionalTools.get(tk);

    if (cond) {
      const check = cond.checkExprs.map((e) => `(${e}) == null`).join(" || ");
      lines.push(`  let ${tool.varName};`);
      lines.push(`  if (${check}) {`);
      if (this.catchGuardedTools.has(tk)) {
        lines.push(`    let _err_${tool.varName};`);
        lines.push(`    try { ${tool.varName} = await ${callExpr}; } catch (e) { _err_${tool.varName} = e; }`);
      } else {
        lines.push(`    ${tool.varName} = await ${callExpr};`);
      }
      lines.push(`  }`);
    } else if (this.catchGuardedTools.has(tk)) {
      lines.push(`  let ${tool.varName}, _err_${tool.varName};`);
      lines.push(`  try { ${tool.varName} = await ${callExpr}; } catch (e) { _err_${tool.varName} = e; }`);
    } else {
      lines.push(`  const ${tool.varName} = await ${callExpr};`);
    }
  }

  private buildToolInputObj(tk: string, indent: string): string {
    const wires = this.toolInputWires.get(tk) ?? [];
    const tool = this.tools.get(tk)!;
    const toolDefWires = this.getToolDefWires(tool.handleName);

    const allWires = new Map<string, ExtractedWire>();
    for (const w of toolDefWires) allWires.set(w.target.path.join("."), w);
    for (const w of wires) allWires.set(w.target.path.join("."), w);

    if (allWires.size === 0) return "{}";

    const entries: [string[], string][] = [];
    for (const [, w] of allWires) {
      const expr = this.sourceChainToJs(w.sources, w.catch, indent);
      entries.push([w.target.path, expr]);
    }
    return this.emitNestedObjectLiteral(entries);
  }

  private getToolDefWires(handleName: string): ExtractedWire[] {
    const resolved = this.resolveToolDef(handleName);
    const result: ExtractedWire[] = [];
    for (const td of resolved.chain) {
      if (!td.body) continue;
      this.collectToolDefBodyWires(td.body, [], result);
    }
    return result;
  }

  private collectToolDefBodyWires(body: Statement[], pathPrefix: string[], result: ExtractedWire[]): void {
    for (const stmt of body) {
      if (stmt.kind === "wire") {
        result.push({
          target: { ...stmt.target, path: [...pathPrefix, ...stmt.target.path] },
          sources: stmt.sources,
          catch: stmt.catch,
          loc: stmt.loc,
        });
      }
      if (stmt.kind === "scope") {
        this.collectToolDefBodyWires(stmt.body, [...pathPrefix, ...stmt.target.path], result);
      }
    }
  }

  private buildToolCallExpr(tool: ToolReg, inputObj: string): string {
    const fnVar = this.toolFnVar(tool.toolName);
    const defName = JSON.stringify(tool.handleName);
    const fnNameStr = JSON.stringify(tool.toolName);

    if (tool.memoize) {
      const memoKey = JSON.stringify(tool.trunkKey);
      return `__callMemoized(${fnVar}, ${inputObj}, ${defName}, ${fnNameStr}, ${memoKey})`;
    }
    return `(${fnVar}?.bridge?.batch ? __callBatch(${fnVar}, ${inputObj}, ${defName}, ${fnNameStr}) : ${fnVar}?.bridge?.sync ? __callSync(${fnVar}, ${inputObj}, ${defName}, ${fnNameStr}) : __call(${fnVar}, ${inputObj}, ${defName}, ${fnNameStr}))`;
  }

  private emitNestedObjectLiteral(entries: [string[], string][]): string {
    const byKey = new Map<string, [string[], string][]>();
    for (const [path, expr] of entries) {
      const key = path[0]!;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push([path.slice(1), expr]);
    }
    const parts: string[] = [];
    for (const [key, subEntries] of byKey) {
      if (subEntries.some(([p]) => p.length === 0)) {
        const leaf = subEntries.find(([p]) => p.length === 0)!;
        parts.push(`${JSON.stringify(key)}: ${leaf[1]}`);
      } else {
        parts.push(`${JSON.stringify(key)}: ${this.emitNestedObjectLiteral(subEntries)}`);
      }
    }
    return `{ ${parts.join(", ")} }`;
  }

  // ── Force statements ──────────────────────────────────────────────────

  private emitForceStatements(lines: string[], liveTools: Set<string>): void {
    for (const f of this.forces) {
      const tk = `${f.module}:${f.type}:${f.field}:${f.instance ?? 1}`;
      const tool = this.tools.get(tk);
      if (!tool) continue;
      if (f.catchError) {
        lines.push(`  try { await ${tool.varName}; } catch (_) {}`);
      } else {
        lines.push(`  await ${tool.varName};`);
      }
    }
  }

  // ── Output generation ─────────────────────────────────────────────────

  private emitOutput(lines: string[], outputWires: ExtractedWire[]): void {
    const rootWire = outputWires.find((w) => w.target.path.length === 0);

    if (rootWire && outputWires.length === 1 && this.spreads.length === 0) {
      const expr = this.sourceChainToJs(rootWire.sources, rootWire.catch, "  ");
      lines.push(`  return ${expr};`);
      return;
    }

    lines.push(`  const __output = {};`);

    for (const s of this.spreads) {
      const expr = this.sourceChainToJs(s.sources, s.catch, "  ");
      if (s.pathPrefix.length > 0) {
        const path = s.pathPrefix.map((p) => `[${JSON.stringify(p)}]`).join("");
        lines.push(`  if (__output${path} == null || typeof __output${path} !== "object") __output${path} = {};`);
        lines.push(`  Object.assign(__output${path}, ${expr});`);
      } else {
        lines.push(`  Object.assign(__output, ${expr});`);
      }
    }

    if (rootWire) {
      const expr = this.sourceChainToJs(rootWire.sources, rootWire.catch, "  ");
      lines.push(`  const __root = ${expr};`);
      lines.push(`  if (__root != null && typeof __root === "object") Object.assign(__output, __root);`);
    }

    const wiresByPath = new Map<string, ExtractedWire[]>();
    for (const w of outputWires) {
      if (w.target.path.length === 0) continue;
      const key = w.target.path.join(".");
      const arr = wiresByPath.get(key) ?? [];
      arr.push(w);
      wiresByPath.set(key, arr);
    }

    for (const [, wires] of wiresByPath) {
      const path = wires[0]!.target.path;
      for (let i = 1; i < path.length; i++) {
        const parentPath = path.slice(0, i).map((p) => `[${JSON.stringify(p)}]`).join("");
        lines.push(`  if (__output${parentPath} == null) __output${parentPath} = {};`);
      }
      const targetExpr = `__output${path.map((p) => `[${JSON.stringify(p)}]`).join("")}`;

      if (wires.length === 1) {
        const expr = this.sourceChainToJs(wires[0]!.sources, wires[0]!.catch, "  ");
        lines.push(`  ${targetExpr} = ${expr};`);
      } else {
        const varName = `__od_${path.join("_")}`;
        const firstExpr = this.sourceChainToJs(wires[0]!.sources, wires[0]!.catch, "  ");
        lines.push(`  let ${varName} = ${firstExpr};`);
        for (let i = 1; i < wires.length; i++) {
          const nextExpr = this.sourceChainToJs(wires[i]!.sources, wires[i]!.catch, "  ");
          lines.push(`  if (${varName} == null) ${varName} = ${nextExpr};`);
        }
        lines.push(`  ${targetExpr} = ${varName};`);
      }
    }

    lines.push(`  return __output;`);
  }

  // ── Expression compilation ────────────────────────────────────────────

  exprToJs(expr: Expression, indent: string, elementVar?: string): string {
    switch (expr.type) {
      case "ref": return this.refToJs(expr, elementVar);
      case "literal": return JSON.stringify(expr.value);
      case "ternary": {
        const cond = this.exprToJs(expr.cond, indent, elementVar);
        const then = this.exprToJs(expr.then, indent, elementVar);
        const elseE = this.exprToJs(expr.else, indent, elementVar);
        return `(${cond} ? ${then} : ${elseE})`;
      }
      case "and": {
        const left = expr.leftSafe ? this.safeExprToJs(expr.left, indent, elementVar) : this.exprToJs(expr.left, indent, elementVar);
        const right = (expr.right.type === "literal" && expr.right.value === true) ? null
          : (expr.rightSafe ? this.safeExprToJs(expr.right, indent, elementVar) : this.exprToJs(expr.right, indent, elementVar));
        if (right == null) return `Boolean(${left})`;
        return `(${left} ? Boolean(${right}) : false)`;
      }
      case "or": {
        const left = expr.leftSafe ? this.safeExprToJs(expr.left, indent, elementVar) : this.exprToJs(expr.left, indent, elementVar);
        const right = (expr.right.type === "literal" && expr.right.value === true) ? null
          : (expr.rightSafe ? this.safeExprToJs(expr.right, indent, elementVar) : this.exprToJs(expr.right, indent, elementVar));
        if (right == null) return `Boolean(${left})`;
        return `(${left} ? true : Boolean(${right}))`;
      }
      case "control": return this.controlFlowToJs(expr.control, expr.loc);
      case "binary": {
        const left = this.exprToJs(expr.left, indent, elementVar);
        const right = this.exprToJs(expr.right, indent, elementVar);
        switch (expr.op) {
          case "add": return `(Number(${left}) + Number(${right}))`;
          case "sub": return `(Number(${left}) - Number(${right}))`;
          case "mul": return `(Number(${left}) * Number(${right}))`;
          case "div": return `(Number(${left}) / Number(${right}))`;
          case "eq": return `(${left} === ${right})`;
          case "neq": return `(${left} !== ${right})`;
          case "gt": return `(Number(${left}) > Number(${right}))`;
          case "gte": return `(Number(${left}) >= Number(${right}))`;
          case "lt": return `(Number(${left}) < Number(${right}))`;
          case "lte": return `(Number(${left}) <= Number(${right}))`;
        }
        break;
      }
      case "unary": return `(!${this.exprToJs(expr.operand, indent, elementVar)})`;
      case "concat": {
        const parts = expr.parts.map((p) => {
          const js = this.exprToJs(p, indent, elementVar);
          return `(${js} == null ? "" : String(${js}))`;
        });
        return parts.join(" + ");
      }
      case "pipe": return this.pipeToJs(expr, indent, elementVar);
      case "array": return this.arrayToJs(expr, indent, elementVar);
    }
    return "undefined";
  }

  private safeExprToJs(expr: Expression, indent: string, elementVar?: string): string {
    const inner = this.exprToJs(expr, indent, elementVar);
    return `(() => { try { return ${inner}; } catch (_) { return undefined; } })()`;
  }

  private refToJs(expr: Extract<Expression, { type: "ref" }>, elementVar?: string): string {
    const ref = expr.ref;
    const safe = expr.safe;

    if (ref.element && elementVar) {
      if (ref.path.length === 0) return elementVar;
      return this.emitPathAccess(elementVar, ref.path, ref.pathSafe, false);
    }

    if (ref.module === SELF_MODULE && ref.type === this.bridge.type && ref.field === this.bridge.field && !ref.instance) {
      if (ref.path.length === 0) return "input";
      return this.emitPathAccess("input", ref.path, ref.pathSafe, false);
    }

    if (ref.module === SELF_MODULE && ref.type === "Context") {
      if (ref.path.length === 0) return "context";
      return this.emitPathAccess("context", ref.path, ref.pathSafe, false);
    }

    if (ref.module === SELF_MODULE && ref.type === "Const") {
      const constName = ref.path[0];
      if (constName && this.constDefs.has(constName)) {
        const raw = this.constDefs.get(constName)!;
        try {
          const parsed = JSON.parse(raw);
          if (ref.path.length === 1) return JSON.stringify(parsed);
          let val: any = parsed;
          for (let i = 1; i < ref.path.length; i++) val = val?.[ref.path[i]!];
          return JSON.stringify(val);
        } catch { return `JSON.parse(${JSON.stringify(raw)})`; }
      }
      return "undefined";
    }

    if (ref.module === "__local") {
      const aliasVar = `__alias_${ref.field}`;
      if (ref.path.length === 0) return aliasVar;
      return this.emitPathAccess(aliasVar, ref.path, ref.pathSafe, false);
    }

    if (ref.instance != null) {
      const tk = refTrunkKey(ref);
      const tool = this.tools.get(tk);
      if (!tool) return "undefined";
      const base = tool.varName;
      if (safe) {
        if (ref.path.length === 0) return base;
        return this.emitSafePathAccess(base, ref.path, ref.pathSafe, ref.rootSafe);
      }
      if (ref.path.length === 0) return base;
      return this.emitPathAccess(base, ref.path, ref.pathSafe, false);
    }

    return "undefined";
  }

  private emitPathAccess(base: string, path: string[], pathSafe?: boolean[], allowMissing?: boolean): string {
    if (path.length === 0) return base;
    if (path.length === 1 && !pathSafe?.[0]) {
      return `__get(${base}, ${JSON.stringify(path[0])}, false, ${allowMissing ?? false})`;
    }
    if (pathSafe && pathSafe.some(Boolean)) {
      return `__path(${base}, ${JSON.stringify(path)}, ${JSON.stringify(pathSafe)}, ${allowMissing ?? false})`;
    }
    let expr = base;
    for (const seg of path) expr = `__get(${expr}, ${JSON.stringify(seg)}, false, false)`;
    return expr;
  }

  private emitSafePathAccess(base: string, path: string[], pathSafe?: boolean[], rootSafe?: boolean): string {
    return `(() => { try { return ${this.emitPathAccess(base, path, pathSafe, rootSafe)}; } catch (_) { return undefined; } })()`;
  }

  private controlFlowToJs(ctrl: ControlFlowInstruction, loc?: SourceLocation): string {
    const locStr = loc ? JSON.stringify(loc) : "undefined";
    switch (ctrl.kind) {
      case "throw": return `(() => { throw new __BridgeRuntimeError(${JSON.stringify(ctrl.message)}, { bridgeLoc: ${locStr} }); })()`;
      case "panic": return `(() => { const e = new __BridgePanicError(${JSON.stringify(ctrl.message)}); e.bridgeLoc = ${locStr}; throw e; })()`;
      case "continue": return `({ __bridgeControl: "continue", levels: ${ctrl.levels ?? 1} })`;
      case "break": return `({ __bridgeControl: "break", levels: ${ctrl.levels ?? 1} })`;
    }
  }

  private pipeToJs(expr: Extract<Expression, { type: "pipe" }>, indent: string, elementVar?: string): string {
    const sourceJs = this.exprToJs(expr.source, indent, elementVar);
    const tk = this.findToolTkForHandle(expr.handle);
    let fnVar: string, defName: string, fnNameStr: string;
    if (tk) {
      const tool = this.tools.get(tk)!;
      fnVar = this.toolFnVar(tool.toolName);
      defName = JSON.stringify(tool.handleName);
      fnNameStr = JSON.stringify(tool.toolName);
    } else {
      fnVar = this.toolFnVar(expr.handle);
      defName = JSON.stringify(expr.handle);
      fnNameStr = JSON.stringify(expr.handle);
    }
    const pipeInput = expr.path ? this.emitNestedObjectLiteral([[expr.path, sourceJs]]) : `{ "in": ${sourceJs} }`;
    return `await (${fnVar}?.bridge?.sync ? __callSync(${fnVar}, ${pipeInput}, ${defName}, ${fnNameStr}) : __call(${fnVar}, ${pipeInput}, ${defName}, ${fnNameStr}))`;
  }

  private arrayToJs(expr: Extract<Expression, { type: "array" }>, indent: string, parentElementVar?: string): string {
    const sourceJs = this.exprToJs(expr.source, indent, parentElementVar);
    const iterVar = `__el_${expr.iteratorName}`;
    const hasElementTools = this.bodyHasElementTools(expr.body);
    const hasControlFlow = this.bodyHasControlFlow(expr.body);

    if (hasElementTools || hasControlFlow) {
      return this.arrayToJsAsync(sourceJs, iterVar, expr.body, indent, hasControlFlow);
    }
    return this.arrayToJsSync(sourceJs, iterVar, expr.body, indent);
  }

  private bodyHasElementTools(body: Statement[]): boolean {
    for (const s of body) {
      if (s.kind === "with" && s.binding.kind === "tool") return true;
      if (s.kind === "scope" && this.bodyHasElementTools(s.body)) return true;
      if (s.kind === "wire" || s.kind === "alias" || s.kind === "spread") {
        for (const src of s.sources) { if (this.exprHasPipeOrToolCall(src.expr)) return true; }
        if (s.catch && "expr" in s.catch) { if (this.exprHasPipeOrToolCall(s.catch.expr)) return true; }
      }
    }
    return false;
  }

  private exprHasPipeOrToolCall(expr: Expression): boolean {
    switch (expr.type) {
      case "pipe": return true;
      case "ternary": return this.exprHasPipeOrToolCall(expr.cond) || this.exprHasPipeOrToolCall(expr.then) || this.exprHasPipeOrToolCall(expr.else);
      case "and": case "or": return this.exprHasPipeOrToolCall(expr.left) || this.exprHasPipeOrToolCall(expr.right);
      case "binary": return this.exprHasPipeOrToolCall(expr.left) || this.exprHasPipeOrToolCall(expr.right);
      case "unary": return this.exprHasPipeOrToolCall(expr.operand);
      case "concat": return expr.parts.some((p) => this.exprHasPipeOrToolCall(p));
      case "array": return this.exprHasPipeOrToolCall(expr.source) || this.bodyHasElementTools(expr.body);
      default: return false;
    }
  }

  private bodyHasControlFlow(body: Statement[]): boolean {
    for (const s of body) {
      if (s.kind === "wire" || s.kind === "alias" || s.kind === "spread") {
        for (const src of s.sources) { if (this.exprHasControlFlow(src.expr)) return true; }
      }
      if (s.kind === "scope" && this.bodyHasControlFlow(s.body)) return true;
    }
    return false;
  }

  private exprHasControlFlow(expr: Expression): boolean {
    switch (expr.type) {
      case "control": return expr.control.kind === "continue" || expr.control.kind === "break";
      case "ternary": return this.exprHasControlFlow(expr.cond) || this.exprHasControlFlow(expr.then) || this.exprHasControlFlow(expr.else);
      case "and": case "or": return this.exprHasControlFlow(expr.left) || this.exprHasControlFlow(expr.right);
      case "binary": return this.exprHasControlFlow(expr.left) || this.exprHasControlFlow(expr.right);
      case "unary": return this.exprHasControlFlow(expr.operand);
      case "concat": return expr.parts.some((p) => this.exprHasControlFlow(p));
      default: return false;
    }
  }

  private arrayToJsSync(sourceJs: string, iterVar: string, body: Statement[], indent: string): string {
    const bodyExpr = this.arrayBodyToJs(body, iterVar, indent + "  ");
    return `(() => { const __src = ${sourceJs}; return __src == null ? null : __src.map((${iterVar}) => { ${bodyExpr} }); })()`;
  }

  private arrayToJsAsync(sourceJs: string, iterVar: string, body: Statement[], indent: string, hasControlFlow: boolean): string {
    const bodyExpr = this.arrayBodyToJs(body, iterVar, indent + "    ");
    if (hasControlFlow) {
      return `await (async () => { const __src = ${sourceJs}; if (__src == null) return null; const __result = []; for (const ${iterVar} of __src) { ${bodyExpr.replace("return {", "const __elem = {")} if (__isLoopCtrl(__elem)) { if (__elem.__bridgeControl === "continue") { if (__elem.levels <= 1) continue; return __nextLoopCtrl(__elem); } if (__elem.__bridgeControl === "break") { if (__elem.levels <= 1) break; return __nextLoopCtrl(__elem); } } __result.push(__elem); } return __result; })()`;
    }
    return `await (async () => { const __src = ${sourceJs}; if (__src == null) return null; return Promise.all(__src.map(async (${iterVar}) => { ${bodyExpr} })); })()`;
  }

  private arrayBodyToJs(body: Statement[], elementVar: string, indent: string): string {
    const elementOutputs: { path: string[]; expr: string }[] = [];
    const parts: string[] = [];

    for (const stmt of body) {
      if (stmt.kind === "with") {
        if (stmt.binding.kind === "tool") {
          const b = stmt.binding;
          const resolved = this.resolveToolDef(b.name);
          const fnName = resolved.fn ?? b.name;
          if (!this.toolFnVars.has(fnName)) this.toolFnVars.set(fnName, `__fn${++this.toolFnVarCounter}`);
        }
        continue;
      }
      if (stmt.kind === "alias") {
        const aliasExpr = this.sourceChainToJs(stmt.sources, stmt.catch, indent, elementVar);
        parts.push(`const __alias_${stmt.name} = ${aliasExpr};`);
        continue;
      }
      if (stmt.kind === "wire") {
        if (stmt.target.element) {
          const expr = this.sourceChainToJs(stmt.sources, stmt.catch, indent, elementVar);
          elementOutputs.push({ path: stmt.target.path, expr });
        }
        continue;
      }
    }

    if (elementOutputs.length === 0) return parts.join(" ") + " return {};";

    const rootOutput = elementOutputs.find((o) => o.path.length === 0);
    if (rootOutput && elementOutputs.length === 1) return parts.join(" ") + " return " + rootOutput.expr + ";";

    let hasCtrl = false;
    for (const stmt of body) {
      if (stmt.kind === "wire" && stmt.target.element) {
        for (const src of stmt.sources) { if (this.exprHasControlFlow(src.expr)) hasCtrl = true; }
      }
    }

    const objEntries = elementOutputs.filter((o) => o.path.length > 0)
      .map((o) => `${JSON.stringify(o.path[0])}: ${o.expr}`);

    if (hasCtrl) {
      const stmtLines: string[] = [];
      for (const o of elementOutputs.filter((x) => x.path.length > 0)) {
        const varName = `__f_${o.path.join("_")}`;
        stmtLines.push(`const ${varName} = ${o.expr};`);
        stmtLines.push(`if (__isLoopCtrl(${varName})) return ${varName};`);
      }
      const assignments = elementOutputs.filter((o) => o.path.length > 0)
        .map((o) => `${JSON.stringify(o.path[0])}: __f_${o.path.join("_")}`);
      stmtLines.push(`return { ${assignments.join(", ")} };`);
      return parts.join(" ") + " " + stmtLines.join(" ");
    }

    return parts.join(" ") + ` return { ${objEntries.join(", ")} };`;
  }

  // ── Source chain compilation ───────────────────────────────────────────

  sourceChainToJs(sources: WireSourceEntry[], catchHandler?: WireCatch, indent: string = "  ", elementVar?: string): string {
    if (sources.length === 0) return "undefined";

    let expr = this.exprToJs(sources[0]!.expr, indent, elementVar);

    for (let i = 1; i < sources.length; i++) {
      const fb = sources[i]!;
      const fbExpr = this.exprToJs(fb.expr, indent, elementVar);
      if (fb.gate === "nullish") expr = `(${expr}) ?? (${fbExpr})`;
      else if (fb.gate === "falsy") expr = `(${expr}) || (${fbExpr})`;
    }

    if (catchHandler) {
      const catchExpr = this.catchToJs(catchHandler, indent, elementVar);
      expr = `(() => { try { return ${expr}; } catch (__catchErr) { return ${catchExpr}; } })()`;
    }

    return expr;
  }

  private catchToJs(c: WireCatch, indent: string, elementVar?: string): string {
    if ("value" in c) return JSON.stringify(c.value);
    if ("control" in c) return this.controlFlowToJs(c.control, c.loc);
    if ("ref" in c) return this.refToJs({ type: "ref", ref: c.ref }, elementVar);
    if ("expr" in c) return this.exprToJs(c.expr, indent, elementVar);
    return "undefined";
  }
}
