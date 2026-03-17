import type {
  Bridge,
  BridgeDocument,
  ConstDef,
  ControlFlowInstruction,
  DefineDef,
  Expression,
  HandleBinding,
  NodeRef,
  SourceChain,
  Statement,
  ToolDef,
  WireCatch,
} from "@stackables/bridge-core";
import { SELF_MODULE } from "@stackables/bridge-core";
import {
  parseBridgeChevrotain,
  type ParseBridgeOptions,
} from "./parser/index.ts";
export { parsePath } from "@stackables/bridge-core";

/**
 * Parse .bridge text — delegates to the Chevrotain parser.
 */
export function parseBridge(
  text: string,
  options: ParseBridgeOptions = {},
): BridgeDocument {
  return parseBridgeChevrotain(text, options);
}

const BRIDGE_VERSION = "1.5";

const RESERVED_BARE_VALUE_KEYWORDS = new Set([
  // Declaration keywords
  "version",
  "bridge",
  "tool",
  "define",
  "with",
  "input",
  "output",
  "context",
  "const",
  "from",
  "as",
  "alias",
  "on",
  "error",
  "force",
  "catch",
  // Control flow
  "continue",
  "break",
  "throw",
  "panic",
  "if",
  "pipe",
  // Boolean/logic operators
  "and",
  "or",
  "not",
]);

/** Serialize a ControlFlowInstruction to its textual form. */
function serializeControl(ctrl: ControlFlowInstruction): string {
  if (ctrl.kind === "throw") return `throw ${JSON.stringify(ctrl.message)}`;
  if (ctrl.kind === "panic") return `panic ${JSON.stringify(ctrl.message)}`;
  if (ctrl.kind === "continue") {
    return ctrl.levels && ctrl.levels > 1
      ? `continue ${ctrl.levels}`
      : "continue";
  }
  return ctrl.levels && ctrl.levels > 1 ? `break ${ctrl.levels}` : "break";
}

// ── Body-based serializer (Statement[] IR) ───────────────────────────────────

const BINARY_OP_SYMBOL: Record<string, string> = {
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  eq: "==",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};
const BINARY_OP_PREC: Record<string, number> = {
  "*": 4,
  "/": 4,
  "+": 3,
  "-": 3,
  "==": 2,
  "!=": 2,
  ">": 2,
  ">=": 2,
  "<": 2,
  "<=": 2,
  and: 1,
  or: 0,
};

/**
 * Context for the body-based serializer. Carries handle bindings collected
 * from WithStatements so that NodeRef can be resolved back to user-facing names.
 */
interface BodySerContext {
  /** Bridge or define type+field for matching self-module refs */
  type: string;
  field: string;
  /** Handle map: trunk key → handle alias */
  handleMap: Map<string, string>;
  /** Input handle alias (e.g. "i") */
  inputHandle?: string;
  /** Output handle alias (e.g. "o") */
  outputHandle?: string;
  /** Current element iterator name (inside array body) */
  iteratorName?: string;
  /** Stack of iterator names for nested arrays (innermost last) */
  iteratorStack: string[];
}

function buildBodySerContext(
  type: string,
  field: string,
  handles: HandleBinding[],
): BodySerContext {
  const handleMap = new Map<string, string>();
  const instanceCounters = new Map<string, number>();
  let inputHandle: string | undefined;
  let outputHandle: string | undefined;
  for (const h of handles) {
    switch (h.kind) {
      case "tool": {
        const lastDot = h.name.lastIndexOf(".");
        if (lastDot !== -1) {
          const mod = h.name.substring(0, lastDot);
          const fld = h.name.substring(lastDot + 1);
          const ik = `${mod}:${fld}`;
          const inst = (instanceCounters.get(ik) ?? 0) + 1;
          instanceCounters.set(ik, inst);
          handleMap.set(`${mod}:${type}:${fld}:${inst}`, h.handle);
        } else {
          const ik = `Tools:${h.name}`;
          const inst = (instanceCounters.get(ik) ?? 0) + 1;
          instanceCounters.set(ik, inst);
          handleMap.set(`${SELF_MODULE}:Tools:${h.name}:${inst}`, h.handle);
        }
        break;
      }
      case "input":
        inputHandle = h.handle;
        break;
      case "output":
        outputHandle = h.handle;
        break;
      case "context":
        handleMap.set(`${SELF_MODULE}:Context:context`, h.handle);
        break;
      case "const":
        handleMap.set(`${SELF_MODULE}:Const:const`, h.handle);
        break;
      case "define":
        handleMap.set(`__define_${h.handle}:${type}:${field}`, h.handle);
        handleMap.set(`__define_in_${h.handle}:${type}:${field}`, h.handle);
        handleMap.set(`__define_out_${h.handle}:${type}:${field}`, h.handle);
        break;
    }
  }
  return {
    type,
    field,
    handleMap,
    inputHandle,
    outputHandle,
    iteratorStack: [],
  };
}

/**
 * Resolve a NodeRef to its user-facing handle + path string.
 * `isFrom` indicates whether this ref is on the source (RHS) side of a wire.
 */
function serBodyRef(
  ref: NodeRef,
  ctx: BodySerContext,
  isFrom: boolean,
): string {
  // Element refs use the iterator name (elementDepth selects parent iterators)
  if (ref.element && ctx.iteratorName) {
    const depth = (ref as any).elementDepth ?? 0;
    const stack = ctx.iteratorStack;
    const name =
      depth > 0 && stack.length > depth
        ? stack[stack.length - 1 - depth]
        : ctx.iteratorName;
    const p = serPath(ref.path, ref.rootSafe, ref.pathSafe);
    return p ? `${name}.${p}` : name;
  }

  // Alias (local) refs: type "__local" → just alias name + path
  if (ref.type === "__local") {
    const p = serPath(ref.path, ref.rootSafe, ref.pathSafe);
    if (!p) return ref.field;
    const sep = ref.rootSafe ? "?." : ".";
    return `${ref.field}${sep}${p}`;
  }

  const hasSafe = ref.rootSafe || ref.pathSafe?.some((s) => s);
  const firstSep = hasSafe && ref.rootSafe ? "?." : ".";

  /** Join prefix + serialized path, respecting bracket indices */
  function joinHP(prefix: string, sep: string, pathStr: string): string {
    if (pathStr.startsWith("[")) return prefix + pathStr;
    return prefix + sep + pathStr;
  }

  // Bridge/define's own trunk (input/output)
  const isSelfTrunk =
    ref.module === SELF_MODULE &&
    ref.type === ctx.type &&
    ref.field === ctx.field &&
    !ref.instance &&
    !ref.element;

  if (isSelfTrunk) {
    if (isFrom && ctx.inputHandle) {
      return ref.path.length > 0
        ? joinHP(
            ctx.inputHandle,
            firstSep,
            serPath(ref.path, ref.rootSafe, ref.pathSafe),
          )
        : ctx.inputHandle;
    }
    if (isFrom && !ctx.inputHandle && ctx.outputHandle) {
      return ref.path.length > 0
        ? joinHP(
            ctx.outputHandle,
            firstSep,
            serPath(ref.path, ref.rootSafe, ref.pathSafe),
          )
        : ctx.outputHandle;
    }
    if (!isFrom && ctx.outputHandle) {
      return ref.path.length > 0
        ? joinHP(ctx.outputHandle, ".", serPath(ref.path))
        : ctx.outputHandle;
    }
    return serPath(ref.path, ref.rootSafe, ref.pathSafe);
  }

  // Lookup by trunk key
  const tk =
    ref.instance != null
      ? `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`
      : `${ref.module}:${ref.type}:${ref.field}`;
  const handle = ctx.handleMap.get(tk);
  if (handle) {
    if (ref.path.length === 0) return handle;
    return joinHP(
      handle,
      firstSep,
      serPath(ref.path, ref.rootSafe, ref.pathSafe),
    );
  }
  return serPath(ref.path, ref.rootSafe, ref.pathSafe);
}

/** Serialize an Expression to source text. */
function serBodyExpr(
  expr: Expression,
  ctx: BodySerContext,
  parentPrec?: number,
  indent?: string,
): string {
  switch (expr.type) {
    case "ref":
      return serBodyRef(expr.ref, ctx, true);
    case "literal":
      return JSON.stringify(expr.value);
    case "ternary": {
      const c = serBodyExpr(expr.cond, ctx);
      const t = serBodyExpr(expr.then, ctx);
      const e = serBodyExpr(expr.else, ctx);
      return `${c} ? ${t} : ${e}`;
    }
    case "and": {
      const l = serBodyExpr(expr.left, ctx, BINARY_OP_PREC["and"]);
      const r = serBodyExpr(expr.right, ctx, BINARY_OP_PREC["and"]);
      const s = `${l} and ${r}`;
      if (parentPrec != null && BINARY_OP_PREC["and"]! < parentPrec)
        return `(${s})`;
      return s;
    }
    case "or": {
      const l = serBodyExpr(expr.left, ctx, BINARY_OP_PREC["or"]);
      const r = serBodyExpr(expr.right, ctx, BINARY_OP_PREC["or"]);
      const s = `${l} or ${r}`;
      if (parentPrec != null && BINARY_OP_PREC["or"]! < parentPrec)
        return `(${s})`;
      return s;
    }
    case "control":
      return serializeControl(expr.control);
    case "binary": {
      const sym = BINARY_OP_SYMBOL[expr.op]!;
      const myPrec = BINARY_OP_PREC[sym]!;
      const l = serBodyExpr(expr.left, ctx, myPrec);
      const r = serBodyExpr(expr.right, ctx, myPrec);
      const s = `${l} ${sym} ${r}`;
      if (parentPrec != null && myPrec < parentPrec) return `(${s})`;
      return s;
    }
    case "unary":
      return `not ${serBodyExpr(expr.operand, ctx)}`;
    case "concat": {
      let result = "";
      for (const part of expr.parts) {
        if (part.type === "literal" && typeof part.value === "string") {
          result += (part.value as string)
            .replace(/\\/g, "\\\\")
            .replace(/\{/g, "\\{");
        } else {
          result += `{${serBodyExpr(part, ctx)}}`;
        }
      }
      return `"${result}"`;
    }
    case "pipe": {
      const source = serBodyExpr(expr.source, ctx);
      const handle = expr.path
        ? `${expr.handle}.${expr.path.join(".")}`
        : expr.handle;
      return `${handle}:${source}`;
    }
    case "array": {
      const source = serBodyExpr(expr.source, ctx);
      const innerCtx: BodySerContext = {
        ...ctx,
        iteratorName: expr.iteratorName,
        iteratorStack: [...ctx.iteratorStack, expr.iteratorName],
      };
      // Collect with statements from the array body for handle registration
      for (const s of expr.body) {
        if (s.kind === "with") registerWithBinding(s.binding, innerCtx);
      }
      const innerIndent = (indent ?? "  ") + "  ";
      const closingIndent = indent ?? "  ";
      const bodyLines = serializeBodyStatements(
        expr.body,
        innerCtx,
        true,
        innerIndent,
      );
      if (bodyLines.length === 0) {
        return `${source}[] as ${expr.iteratorName} {}`;
      }
      return `${source}[] as ${expr.iteratorName} {\n${bodyLines.join("\n")}\n${closingIndent}}`;
    }
    default: {
      const _: never = expr;
      return `<unknown expression: ${(_ as Expression).type}>`;
    }
  }
}

/** Register a HandleBinding into the context's handle map. */
function registerWithBinding(
  binding: HandleBinding,
  ctx: BodySerContext,
): void {
  switch (binding.kind) {
    case "tool": {
      const lastDot = binding.name.lastIndexOf(".");
      if (lastDot !== -1) {
        const mod = binding.name.substring(0, lastDot);
        const fld = binding.name.substring(lastDot + 1);
        // Find next available instance
        let inst = 1;
        while (ctx.handleMap.has(`${mod}:${ctx.type}:${fld}:${inst}`)) inst++;
        ctx.handleMap.set(`${mod}:${ctx.type}:${fld}:${inst}`, binding.handle);
      } else {
        let inst = 1;
        while (
          ctx.handleMap.has(`${SELF_MODULE}:Tools:${binding.name}:${inst}`)
        )
          inst++;
        ctx.handleMap.set(
          `${SELF_MODULE}:Tools:${binding.name}:${inst}`,
          binding.handle,
        );
      }
      break;
    }
    case "input":
      ctx.inputHandle = binding.handle;
      break;
    case "output":
      ctx.outputHandle = binding.handle;
      break;
    case "context":
      ctx.handleMap.set(`${SELF_MODULE}:Context:context`, binding.handle);
      break;
    case "const":
      ctx.handleMap.set(`${SELF_MODULE}:Const:const`, binding.handle);
      break;
    case "define":
      ctx.handleMap.set(
        `__define_${binding.handle}:${ctx.type}:${ctx.field}`,
        binding.handle,
      );
      ctx.handleMap.set(
        `__define_in_${binding.handle}:${ctx.type}:${ctx.field}`,
        binding.handle,
      );
      ctx.handleMap.set(
        `__define_out_${binding.handle}:${ctx.type}:${ctx.field}`,
        binding.handle,
      );
      break;
  }
}

/** Serialize a WireCatch to ` catch <value>` using the body context. */
function serBodyCatch(c: WireCatch | undefined, ctx: BodySerContext): string {
  if (!c) return "";
  if ("control" in c) return ` catch ${serializeControl(c.control)}`;
  if ("expr" in c) return ` catch ${serBodyExpr(c.expr, ctx)}`;
  if ("ref" in c) return ` catch ${serBodyRef(c.ref, ctx, true)}`;
  return ` catch ${JSON.stringify(c.value)}`;
}

/** Serialize a source chain (sources + catch) to the RHS of a wire. */
function serBodySourceChain(
  chain: SourceChain,
  ctx: BodySerContext,
  indent?: string,
): string {
  const parts: string[] = [];
  for (let i = 0; i < chain.sources.length; i++) {
    const s = chain.sources[i]!;
    let prefix = "";
    if (i > 0) {
      prefix = s.gate === "nullish" ? " ?? " : " || ";
    }
    parts.push(prefix + serBodyExpr(s.expr, ctx, undefined, indent));
  }
  return parts.join("") + serBodyCatch(chain.catch, ctx);
}

/**
 * Serialize a with statement to its textual form.
 */
function serWithStatement(binding: HandleBinding): string {
  switch (binding.kind) {
    case "tool": {
      const lastDot = binding.name.lastIndexOf(".");
      const defaultHandle =
        lastDot !== -1 ? binding.name.substring(lastDot + 1) : binding.name;
      const vTag = binding.version ? `@${binding.version}` : "";
      const memoize = binding.memoize ? " memoize" : "";
      if (binding.handle === defaultHandle && !vTag) {
        return `with ${binding.name}${memoize}`;
      }
      return `with ${binding.name}${vTag} as ${binding.handle}${memoize}`;
    }
    case "input":
      return binding.handle === "input"
        ? "with input"
        : `with input as ${binding.handle}`;
    case "output":
      return binding.handle === "output"
        ? "with output"
        : `with output as ${binding.handle}`;
    case "context":
      return binding.handle === "context"
        ? "with context"
        : `with context as ${binding.handle}`;
    case "const":
      return binding.handle === "const"
        ? "with const"
        : `with const as ${binding.handle}`;
    case "define":
      return `with ${binding.name} as ${binding.handle}`;
  }
}

/**
 * Serialize a wire target to its textual form.
 * Within scopes and array bodies, targets are emitted as relative
 * (dot-prefixed) paths.
 */
function serBodyTarget(
  target: NodeRef,
  ctx: BodySerContext,
  isElementScope: boolean,
): string {
  // Element-scoped targets (inside array body)
  if (target.element) {
    const p = serPath(target.path);
    return p ? `.${p}` : ".";
  }
  // Inside scope/array bodies, self-trunk refs are relative (dot-prefixed)
  if (isElementScope) {
    const isSelfTrunk =
      target.module === SELF_MODULE &&
      target.type === ctx.type &&
      target.field === ctx.field &&
      !target.instance;
    if (isSelfTrunk) {
      const p = serPath(target.path);
      return p ? `.${p}` : ".";
    }
  }
  return serBodyRef(target, ctx, false);
}

/**
 * Serialize a Statement[] body to indented lines.
 * `isElementScope` is true inside array body blocks.
 */
function serializeBodyStatements(
  stmts: Statement[],
  ctx: BodySerContext,
  isElementScope: boolean,
  indent: string = "  ",
): string[] {
  const lines: string[] = [];
  for (const stmt of stmts) {
    switch (stmt.kind) {
      case "with": {
        lines.push(`${indent}${serWithStatement(stmt.binding)}`);
        break;
      }
      case "wire": {
        const target = serBodyTarget(stmt.target, ctx, isElementScope);
        // Detect constant assignment: single literal source, no catch, no gate
        if (
          stmt.sources.length === 1 &&
          !stmt.catch &&
          stmt.sources[0]!.expr.type === "literal"
        ) {
          lines.push(
            `${indent}${target} = ${JSON.stringify(stmt.sources[0]!.expr.value)}`,
          );
        } else {
          const rhs = serBodySourceChain(stmt, ctx, indent);
          lines.push(`${indent}${target} <- ${rhs}`);
        }
        break;
      }
      case "alias": {
        const rhs = serBodySourceChain(stmt, ctx, indent);
        lines.push(`${indent}alias ${stmt.name} <- ${rhs}`);
        break;
      }
      case "spread": {
        const rhs = serBodySourceChain(stmt, ctx, indent);
        lines.push(`${indent}... <- ${rhs}`);
        break;
      }
      case "scope": {
        const target = serBodyTarget(stmt.target, ctx, isElementScope);
        const inner = serializeBodyStatements(
          stmt.body,
          ctx,
          true,
          indent + "  ",
        );
        if (inner.length === 0) {
          lines.push(`${indent}${target} {}`);
        } else {
          lines.push(`${indent}${target} {`);
          lines.push(...inner);
          lines.push(`${indent}}`);
        }
        break;
      }
      case "force": {
        const handleName =
          ctx.handleMap.get(
            stmt.instance != null
              ? `${stmt.module}:${stmt.type}:${stmt.field}:${stmt.instance}`
              : `${stmt.module}:${stmt.type}:${stmt.field}`,
          ) ?? stmt.handle;
        const catchStr = stmt.catchError ? " catch null" : "";
        lines.push(`${indent}force ${handleName}${catchStr}`);
        break;
      }
      default:
        stmt satisfies never;
        break;
    }
  }
  return lines;
}

/**
 * Serialize a bridge block from its `body: Statement[]` IR.
 * Returns the full bridge block text including header and closing brace.
 */
function serializeBridgeBlock(bridge: Bridge): string {
  if (bridge.passthrough) {
    return `bridge ${bridge.type}.${bridge.field} with ${bridge.passthrough}`;
  }

  const ctx = buildBodySerContext(bridge.type, bridge.field, bridge.handles);

  // Register handles from with statements in the body (may include
  // inner-scope tools that aren't in the top-level handles array)
  for (const s of bridge.body!) {
    if (s.kind === "with") registerWithBinding(s.binding, ctx);
  }

  const bodyLines = serializeBodyStatements(bridge.body!, ctx, false);

  // Separate with declarations from wire lines with a blank line
  let lastWithIdx = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i]!.trimStart().startsWith("with ")) lastWithIdx = i;
    else break;
  }
  if (lastWithIdx >= 0 && lastWithIdx < bodyLines.length - 1) {
    bodyLines.splice(lastWithIdx + 1, 0, "");
  }

  const lines: string[] = [];
  lines.push(`bridge ${bridge.type}.${bridge.field} {`);
  lines.push(...bodyLines);
  lines.push(`}`);
  return lines.join("\n");
}

/**
 * Serialize a define block from its `body: Statement[]` IR.
 */
function serializeDefineBlock(def: DefineDef): string {
  const ctx = buildBodySerContext("Define", def.name, def.handles);

  // Register handles from with statements in the body
  for (const s of def.body!) {
    if (s.kind === "with") registerWithBinding(s.binding, ctx);
  }

  const bodyLines = serializeBodyStatements(def.body!, ctx, false);

  let lastWithIdx = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i]!.trimStart().startsWith("with ")) lastWithIdx = i;
    else break;
  }
  if (lastWithIdx >= 0 && lastWithIdx < bodyLines.length - 1) {
    bodyLines.splice(lastWithIdx + 1, 0, "");
  }

  const lines: string[] = [];
  lines.push(`define ${def.name} {`);
  lines.push(...bodyLines);
  lines.push(`}`);
  return lines.join("\n");
}

/**
 * Serialize a tool block from its `body: Statement[]` IR.
 * In tool bodies, all targets reference the tool itself so they are dot-prefixed.
 */
function serializeToolBlock(tool: ToolDef): string {
  // Tool context: type=Tools, field=tool.name
  const ctx = buildBodySerContext("Tools", tool.name, tool.handles);

  // Register handles from with statements in the body
  for (const s of tool.body!) {
    if (s.kind === "with") registerWithBinding(s.binding, ctx);
  }

  // In tool bodies, everything is scope-relative (dot-prefixed)
  const bodyLines = serializeBodyStatements(tool.body!, ctx, true);

  // Separate with declarations from body
  let lastWithIdx = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i]!.trimStart().startsWith("with ")) lastWithIdx = i;
    else break;
  }
  if (lastWithIdx >= 0 && lastWithIdx < bodyLines.length - 1) {
    bodyLines.splice(lastWithIdx + 1, 0, "");
  }

  // on error — value or source reference
  if (tool.onError) {
    if ("value" in tool.onError) {
      bodyLines.push(`on error = ${tool.onError.value}`);
    } else {
      bodyLines.push(`on error <- ${tool.onError.source}`);
    }
  }

  const source = tool.extends ?? tool.fn;
  const lines: string[] = [];
  if (bodyLines.length > 0) {
    lines.push(`tool ${tool.name} from ${source} {`);
    lines.push(...bodyLines);
    lines.push(`}`);
  } else {
    lines.push(`tool ${tool.name} from ${source}`);
  }
  return lines.join("\n");
}

// ── Serializer ───────────────────────────────────────────────────────────────

export function serializeBridge(doc: BridgeDocument): string {
  const version = doc.version ?? BRIDGE_VERSION;
  const { instructions } = doc;
  if (instructions.length === 0) return "";

  const blocks: string[] = [];

  // Group consecutive const declarations into a single block
  let i = 0;
  while (i < instructions.length) {
    const instr = instructions[i]!;
    if (instr.kind === "const") {
      const constLines: string[] = [];
      while (i < instructions.length && instructions[i]!.kind === "const") {
        const c = instructions[i] as ConstDef;
        constLines.push(`const ${c.name} = ${c.value}`);
        i++;
      }
      blocks.push(constLines.join("\n"));
    } else if (instr.kind === "tool") {
      blocks.push(serializeToolBlock(instr as ToolDef));
      i++;
    } else if (instr.kind === "define") {
      blocks.push(serializeDefineBlock(instr as DefineDef));
      i++;
    } else {
      blocks.push(serializeBridgeBlock(instr as Bridge));
      i++;
    }
  }

  return `version ${version}\n\n` + blocks.join("\n\n") + "\n";
}

function serPath(
  path: string[],
  rootSafe?: boolean,
  pathSafe?: boolean[],
): string {
  let result = "";
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    const isSafe = i === 0 ? !!rootSafe : !!pathSafe?.[i];
    if (/^\d+$/.test(segment)) {
      result += `[${segment}]`;
    } else {
      if (result.length > 0) result += isSafe ? "?." : ".";
      result += segment;
    }
  }
  return result;
}
