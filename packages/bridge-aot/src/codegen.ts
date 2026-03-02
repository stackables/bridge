/**
 * AOT code generator — turns a Bridge AST into a standalone JavaScript function.
 *
 * Supports:
 *  - Pull wires (`target <- source`)
 *  - Constant wires (`target = "value"`)
 *  - Nullish coalescing (`?? fallback`)
 *  - Falsy fallback (`|| fallback`)
 *  - Conditional wires (ternary)
 *  - Array mapping (`[] as iter { }`)
 */

import type { BridgeDocument, Bridge, Wire, NodeRef } from "@stackables/bridge-core";

const SELF_MODULE = "_";

// ── Public API ──────────────────────────────────────────────────────────────

export interface CompileOptions {
  /** The operation to compile, e.g. "Query.livingStandard" */
  operation: string;
}

export interface CompileResult {
  /** Generated JavaScript source code */
  code: string;
  /** The exported function name */
  functionName: string;
}

/**
 * Compile a single bridge operation into a standalone async JavaScript function.
 *
 * The generated function has the signature:
 *   `async function <Type>_<field>(input, tools, context) → Promise<any>`
 *
 * It calls tools in topological dependency order and returns the output object.
 */
export function compileBridge(
  document: BridgeDocument,
  options: CompileOptions,
): CompileResult {
  const { operation } = options;
  const dotIdx = operation.indexOf(".");
  if (dotIdx === -1)
    throw new Error(
      `Invalid operation: "${operation}". Expected "Type.field".`,
    );
  const type = operation.substring(0, dotIdx);
  const field = operation.substring(dotIdx + 1);

  const bridge = document.instructions.find(
    (i): i is Bridge =>
      i.kind === "bridge" && i.type === type && i.field === field,
  );
  if (!bridge)
    throw new Error(`No bridge found for operation: ${operation}`);

  // Collect const definitions from the document
  const constDefs = new Map<string, string>();
  for (const inst of document.instructions) {
    if (inst.kind === "const") constDefs.set(inst.name, inst.value);
  }

  const ctx = new CodegenContext(bridge, constDefs);
  return ctx.compile();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function splitToolName(name: string): { module: string; fieldName: string } {
  const dotIdx = name.indexOf(".");
  if (dotIdx === -1) return { module: SELF_MODULE, fieldName: name };
  return {
    module: name.substring(0, dotIdx),
    fieldName: name.substring(dotIdx + 1),
  };
}

/** Build a trunk key from a NodeRef (same logic as bridge-core's trunkKey). */
function refTrunkKey(ref: NodeRef): string {
  if (ref.element)
    return `${ref.module}:${ref.type}:${ref.field}:*`;
  return `${ref.module}:${ref.type}:${ref.field}${ref.instance != null ? `:${ref.instance}` : ""}`;
}

/**
 * Emit a coerced constant value as a JavaScript literal.
 * Mirrors the runtime's `coerceConstant` semantics.
 */
function emitCoerced(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "true") return "true";
  if (trimmed === "false") return "false";
  if (trimmed === "null") return "null";
  // JSON-encoded string literal: '"hello"' → "hello"
  if (
    trimmed.length >= 2 &&
    trimmed.charCodeAt(0) === 0x22 &&
    trimmed.charCodeAt(trimmed.length - 1) === 0x22
  ) {
    return trimmed; // already a valid JS string literal
  }
  // Numeric literal
  const num = Number(trimmed);
  if (trimmed !== "" && !isNaN(num) && isFinite(num)) return String(num);
  // Fallback: raw string
  return JSON.stringify(raw);
}

// ── Code-generation context ─────────────────────────────────────────────────

interface ToolInfo {
  trunkKey: string;
  toolName: string;
  varName: string;
}

class CodegenContext {
  private bridge: Bridge;
  private constDefs: Map<string, string>;
  private selfTrunkKey: string;
  private varMap = new Map<string, string>();
  private tools = new Map<string, ToolInfo>();
  private toolCounter = 0;

  constructor(bridge: Bridge, constDefs: Map<string, string>) {
    this.bridge = bridge;
    this.constDefs = constDefs;
    this.selfTrunkKey = `${SELF_MODULE}:${bridge.type}:${bridge.field}`;

    for (const h of bridge.handles) {
      switch (h.kind) {
        case "input":
        case "output":
          // Input and output share the self trunk key; distinguished by wire direction
          break;
        case "context":
          this.varMap.set(`${SELF_MODULE}:Context:context`, "context");
          break;
        case "const":
          // Constants are inlined directly
          break;
        case "tool": {
          const { module, fieldName } = splitToolName(h.name);
          // Module-prefixed tools use the bridge's type; self-module tools use "Tools"
          const refType = module === SELF_MODULE ? "Tools" : bridge.type;
          const instance = this.findInstance(module, refType, fieldName);
          const tk = `${module}:${refType}:${fieldName}:${instance}`;
          const vn = `_t${++this.toolCounter}`;
          this.varMap.set(tk, vn);
          this.tools.set(tk, { trunkKey: tk, toolName: h.name, varName: vn });
          break;
        }
      }
    }
  }

  /** Find the instance number for a tool from the wires. */
  private findInstance(module: string, type: string, field: string): number {
    for (const w of this.bridge.wires) {
      if (
        w.to.module === module &&
        w.to.type === type &&
        w.to.field === field &&
        w.to.instance != null
      )
        return w.to.instance;
      if (
        "from" in w &&
        w.from.module === module &&
        w.from.type === type &&
        w.from.field === field &&
        w.from.instance != null
      )
        return w.from.instance;
    }
    return 1;
  }

  // ── Main compilation entry point ──────────────────────────────────────────

  compile(): CompileResult {
    const { bridge } = this;
    const fnName = `${bridge.type}_${bridge.field}`;

    // Separate wires into tool inputs vs. output
    const outputWires: Wire[] = [];
    const toolWires = new Map<string, Wire[]>();

    for (const w of bridge.wires) {
      // Element wires (from array mapping) target the output, not a tool
      const toKey = refTrunkKey(w.to);
      if (toKey === this.selfTrunkKey) {
        outputWires.push(w);
      } else {
        const arr = toolWires.get(toKey) ?? [];
        arr.push(w);
        toolWires.set(toKey, arr);
      }
    }

    // Topological sort of tool calls
    const toolOrder = this.topologicalSort(toolWires);

    // Build code lines
    const lines: string[] = [];
    lines.push(
      `// AOT-compiled bridge: ${bridge.type}.${bridge.field}`,
    );
    lines.push(`// Generated by @stackables/bridge-aot`);
    lines.push("");
    lines.push(
      `export default async function ${fnName}(input, tools, context) {`,
    );

    // Emit tool calls
    for (const tk of toolOrder) {
      const tool = this.tools.get(tk)!;
      const wires = toolWires.get(tk) ?? [];
      const inputObj = this.buildObjectLiteral(wires, (w) => w.to.path, 4);
      lines.push(
        `  const ${tool.varName} = await tools[${JSON.stringify(tool.toolName)}](${inputObj});`,
      );
    }

    // Emit output
    this.emitOutput(lines, outputWires);

    lines.push("}");
    lines.push("");
    return { code: lines.join("\n"), functionName: fnName };
  }

  // ── Output generation ────────────────────────────────────────────────────

  private emitOutput(lines: string[], outputWires: Wire[]): void {
    if (outputWires.length === 0) {
      lines.push("  return {};");
      return;
    }

    // Check for root passthrough (wire with empty path)
    const rootWire = outputWires.find((w) => w.to.path.length === 0);
    if (rootWire) {
      lines.push(`  return ${this.wireToExpr(rootWire)};`);
      return;
    }

    // Detect array iterators
    const arrayIterators = this.bridge.arrayIterators ?? {};
    const arrayFields = new Set(Object.keys(arrayIterators));

    // Separate element wires from scalar wires
    const elementWires = new Map<string, Wire[]>();
    const scalarWires: Wire[] = [];
    const arraySourceWires = new Map<string, Wire>();

    for (const w of outputWires) {
      const topField = w.to.path[0]!;
      if ("from" in w && w.from.element) {
        // Element wire — belongs to an array mapping
        const arr = elementWires.get(topField) ?? [];
        arr.push(w);
        elementWires.set(topField, arr);
      } else if (arrayFields.has(topField) && w.to.path.length === 1) {
        // Root wire for an array field
        arraySourceWires.set(topField, w);
      } else {
        scalarWires.push(w);
      }
    }

    lines.push("  return {");

    // Emit scalar fields
    for (const w of scalarWires) {
      const key = w.to.path[w.to.path.length - 1]!;
      lines.push(`    ${JSON.stringify(key)}: ${this.wireToExpr(w)},`);
    }

    // Emit array-mapped fields
    for (const [arrayField] of Object.entries(arrayIterators)) {
      const sourceW = arraySourceWires.get(arrayField);
      const elemWires = elementWires.get(arrayField) ?? [];

      if (!sourceW || elemWires.length === 0) continue;

      const arrayExpr = this.wireToExpr(sourceW);
      lines.push(
        `    ${JSON.stringify(arrayField)}: (${arrayExpr} ?? []).map((_el) => ({`,
      );

      for (const ew of elemWires) {
        // Element wire: from.path = ["srcField"], to.path = ["arrayField", "destField"]
        const destField = ew.to.path[ew.to.path.length - 1]!;
        const srcExpr = this.elementWireToExpr(ew);
        lines.push(
          `      ${JSON.stringify(destField)}: ${srcExpr},`,
        );
      }

      lines.push("    })),");
    }

    lines.push("  };");
  }

  // ── Wire → expression ────────────────────────────────────────────────────

  /** Convert a wire to a JavaScript expression string. */
  wireToExpr(w: Wire): string {
    // Constant wire
    if ("value" in w) return emitCoerced(w.value);

    // Pull wire
    if ("from" in w) {
      let expr = this.refToExpr(w.from);
      expr = this.applyFallbacks(w, expr);
      return expr;
    }

    // Conditional wire (ternary)
    if ("cond" in w) {
      const condExpr = this.refToExpr(w.cond);
      const thenExpr =
        w.thenRef !== undefined
          ? this.refToExpr(w.thenRef)
          : w.thenValue !== undefined
            ? emitCoerced(w.thenValue)
            : "undefined";
      const elseExpr =
        w.elseRef !== undefined
          ? this.refToExpr(w.elseRef)
          : w.elseValue !== undefined
            ? emitCoerced(w.elseValue)
            : "undefined";
      let expr = `(${condExpr} ? ${thenExpr} : ${elseExpr})`;
      expr = this.applyFallbacks(w, expr);
      return expr;
    }

    // Logical AND
    if ("condAnd" in w) {
      const { leftRef, rightRef, rightValue } = w.condAnd;
      const left = this.refToExpr(leftRef);
      let expr: string;
      if (rightRef) expr = `(${left} && ${this.refToExpr(rightRef)})`;
      else if (rightValue !== undefined)
        expr = `(${left} && ${emitCoerced(rightValue)})`;
      else expr = `Boolean(${left})`;
      expr = this.applyFallbacks(w, expr);
      return expr;
    }

    // Logical OR
    if ("condOr" in w) {
      const { leftRef, rightRef, rightValue } = w.condOr;
      const left = this.refToExpr(leftRef);
      let expr: string;
      if (rightRef) expr = `(${left} || ${this.refToExpr(rightRef)})`;
      else if (rightValue !== undefined)
        expr = `(${left} || ${emitCoerced(rightValue)})`;
      else expr = `Boolean(${left})`;
      expr = this.applyFallbacks(w, expr);
      return expr;
    }

    return "undefined";
  }

  /** Convert an element wire (inside array mapping) to an expression. */
  private elementWireToExpr(w: Wire): string {
    if ("value" in w) return emitCoerced(w.value);
    if ("from" in w) {
      // Element refs: from.element === true, path = ["srcField"]
      let expr =
        "_el" +
        w.from.path.map((p) => `?.[${JSON.stringify(p)}]`).join("");
      expr = this.applyFallbacks(w, expr);
      return expr;
    }
    return this.wireToExpr(w);
  }

  /** Apply falsy (||) and nullish (??) fallback chains to an expression. */
  private applyFallbacks(
    w: Wire,
    expr: string,
  ): string {
    // Falsy fallback chain (||)
    if ("falsyFallbackRefs" in w && w.falsyFallbackRefs?.length) {
      for (const ref of w.falsyFallbackRefs) {
        expr = `(${expr} || ${this.refToExpr(ref)})`;
      }
    }
    if ("falsyFallback" in w && w.falsyFallback != null) {
      expr = `(${expr} || ${emitCoerced(w.falsyFallback)})`;
    }

    // Nullish coalescing (??)
    if ("nullishFallbackRef" in w && w.nullishFallbackRef) {
      expr = `(${expr} ?? ${this.refToExpr(w.nullishFallbackRef)})`;
    } else if ("nullishFallback" in w && w.nullishFallback != null) {
      expr = `(${expr} ?? ${emitCoerced(w.nullishFallback)})`;
    }

    return expr;
  }

  // ── NodeRef → expression ──────────────────────────────────────────────────

  /** Convert a NodeRef to a JavaScript expression. */
  private refToExpr(ref: NodeRef): string {
    // Const access: inline the constant value
    if (
      ref.type === "Const" &&
      ref.field === "const" &&
      ref.path.length > 0
    ) {
      const constName = ref.path[0]!;
      const val = this.constDefs.get(constName);
      if (val != null) {
        if (ref.path.length === 1) return emitCoerced(val);
        // Nested access into a parsed constant
        const base = emitCoerced(val);
        const tail = ref.path
          .slice(1)
          .map((p) => `?.[${JSON.stringify(p)}]`)
          .join("");
        return `(${base})${tail}`;
      }
    }

    // Self-module input reference
    if (
      ref.module === SELF_MODULE &&
      ref.type === this.bridge.type &&
      ref.field === this.bridge.field &&
      !ref.element
    ) {
      if (ref.path.length === 0) return "input";
      return (
        "input" +
        ref.path.map((p) => `?.[${JSON.stringify(p)}]`).join("")
      );
    }

    // Tool result reference
    const key = refTrunkKey(ref);
    const varName = this.varMap.get(key);
    if (!varName)
      throw new Error(`Unknown reference: ${key} (${JSON.stringify(ref)})`);
    if (ref.path.length === 0) return varName;
    return (
      varName +
      ref.path.map((p) => `?.[${JSON.stringify(p)}]`).join("")
    );
  }

  // ── Nested object literal builder ─────────────────────────────────────────

  /**
   * Build a JavaScript object literal from a set of wires.
   * Handles nested paths by creating nested object literals.
   */
  private buildObjectLiteral(
    wires: Wire[],
    getPath: (w: Wire) => string[],
    indent: number,
  ): string {
    if (wires.length === 0) return "{}";

    // Build tree
    interface TreeNode {
      expr?: string;
      children: Map<string, TreeNode>;
    }
    const root: TreeNode = { children: new Map() };

    for (const w of wires) {
      const path = getPath(w);
      if (path.length === 0) return this.wireToExpr(w);
      let current = root;
      for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i]!;
        if (!current.children.has(seg)) {
          current.children.set(seg, { children: new Map() });
        }
        current = current.children.get(seg)!;
      }
      const lastSeg = path[path.length - 1]!;
      if (!current.children.has(lastSeg)) {
        current.children.set(lastSeg, { children: new Map() });
      }
      current.children.get(lastSeg)!.expr = this.wireToExpr(w);
    }

    return this.serializeTreeNode(root, indent);
  }

  private serializeTreeNode(
    node: { children: Map<string, { expr?: string; children: Map<string, unknown> }> },
    indent: number,
  ): string {
    const pad = " ".repeat(indent);
    const entries: string[] = [];

    for (const [key, child] of node.children) {
      if (child.children.size === 0) {
        entries.push(
          `${pad}${JSON.stringify(key)}: ${child.expr ?? "undefined"}`,
        );
      } else if (child.expr != null) {
        entries.push(`${pad}${JSON.stringify(key)}: ${child.expr}`);
      } else {
        const nested = this.serializeTreeNode(
          child as typeof node,
          indent + 2,
        );
        entries.push(`${pad}${JSON.stringify(key)}: ${nested}`);
      }
    }

    const innerPad = " ".repeat(indent - 2);
    return `{\n${entries.join(",\n")},\n${innerPad}}`;
  }

  // ── Dependency analysis & topological sort ────────────────────────────────

  /** Get all source trunk keys a wire depends on. */
  private getSourceTrunks(w: Wire): string[] {
    const trunks: string[] = [];
    const collectTrunk = (ref: NodeRef) => trunks.push(refTrunkKey(ref));

    if ("from" in w) {
      collectTrunk(w.from);
      if ("falsyFallbackRefs" in w && w.falsyFallbackRefs)
        w.falsyFallbackRefs.forEach(collectTrunk);
      if ("nullishFallbackRef" in w && w.nullishFallbackRef)
        collectTrunk(w.nullishFallbackRef);
      if ("catchFallbackRef" in w && w.catchFallbackRef)
        collectTrunk(w.catchFallbackRef);
    }
    if ("cond" in w) {
      collectTrunk(w.cond);
      if (w.thenRef) collectTrunk(w.thenRef);
      if (w.elseRef) collectTrunk(w.elseRef);
    }
    if ("condAnd" in w) {
      collectTrunk(w.condAnd.leftRef);
      if (w.condAnd.rightRef) collectTrunk(w.condAnd.rightRef);
    }
    if ("condOr" in w) {
      collectTrunk(w.condOr.leftRef);
      if (w.condOr.rightRef) collectTrunk(w.condOr.rightRef);
    }
    return trunks;
  }

  private topologicalSort(toolWires: Map<string, Wire[]>): string[] {
    const toolKeys = [...this.tools.keys()];
    const adj = new Map<string, Set<string>>();

    for (const key of toolKeys) {
      adj.set(key, new Set());
    }

    // Build adjacency: src → dst edges (deduplicated via Set)
    for (const key of toolKeys) {
      const wires = toolWires.get(key) ?? [];
      for (const w of wires) {
        for (const src of this.getSourceTrunks(w)) {
          if (this.tools.has(src) && src !== key) {
            adj.get(src)!.add(key);
          }
        }
      }
    }

    // Compute in-degree from the adjacency sets (avoids double-counting)
    const inDegree = new Map<string, number>();
    for (const key of toolKeys) inDegree.set(key, 0);
    for (const [, neighbors] of adj) {
      for (const n of neighbors) {
        inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [key, deg] of inDegree) {
      if (deg === 0) queue.push(key);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      for (const neighbor of adj.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    if (sorted.length !== toolKeys.length) {
      throw new Error("Circular dependency detected in tool calls");
    }

    return sorted;
  }
}
