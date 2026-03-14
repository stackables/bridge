import type { SourceLocation } from "@stackables/bridge-types";

/**
 * Structured node reference — identifies a specific data point in the execution graph.
 *
 * Every wire has a "from" and "to", each described by a NodeRef.
 * The trunk (module + type + field + instance) identifies the node,
 * while path drills into its data.
 */
export type NodeRef = {
  /** Module identifier: "hereapi", "sendgrid", "zillow", or SELF_MODULE */
  module: string;
  /** GraphQL type ("Query" | "Mutation") or "Tools" for tool functions */
  type: string;
  /** Field or function name: "geocode", "search", "centsToUsd" */
  field: string;
  /** Instance number for tool calls (1, 2, ...) */
  instance?: number;
  /** References the current array element in a shadow tree (for per-element mapping) */
  element?: boolean;
  /** How many shadow-tree levels above the current element this ref targets. */
  elementDepth?: number;
  /** Path into the data: ["items", "0", "position", "lat"] */
  path: string[];
  /** True when the first `?.` is right after the root (e.g., `api?.data`) */
  rootSafe?: boolean;
  /** Per-segment safety flags (same length as `path`); true = `?.` before that segment */
  pathSafe?: boolean[];
};

/**
 * A wire connects a data source (from) to a data sink (to).
 *
 * Unified shape: every wire has an ordered list of source entries and an
 * optional catch handler. The first source entry is always evaluated; subsequent
 * entries have a gate (`||` for falsy, `??` for nullish) that determines whether
 * to fall through to them.
 *
 * Constant wires have a single literal source entry.
 * Ternary/boolean wires have a single ternary/and/or expression entry.
 * Pipe wires (`pipe: true`) route data through declared tool handles.
 * Spread wires (`spread: true`) merge source object properties into the target.
 */
export type Wire = {
  to: NodeRef;
  sources: WireSourceEntry[];
  catch?: WireCatch;
  pipe?: true;
  spread?: true;
  loc?: SourceLocation;
};

/**
 * Bridge definition — wires one GraphQL field to its data sources.
 */
export type Bridge = {
  kind: "bridge";
  /** GraphQL type: "Query" | "Mutation" */
  type: string;
  /** GraphQL field name */
  field: string;
  /** Declared data sources and their wire handles */
  handles: HandleBinding[];
  /** Connection wires */
  wires: Wire[];
  /**
   * When set, this bridge was declared with the passthrough shorthand:
   * `bridge Type.field with <name>`. The value is the define/tool name.
   */
  passthrough?: string;
  /** Handles to eagerly evaluate (e.g. side-effect tools).
   *  Critical by default — a forced handle that throws aborts the bridge.
   *  Add `catchError: true` (written as `force <handle> ?? null`) to
   *  swallow the error for fire-and-forget side-effects. */
  forces?: Array<{
    handle: string;
    module: string;
    type: string;
    field: string;
    instance?: number;
    /** When true, errors from this forced handle are silently caught (`?? null`). */
    catchError?: true;
  }>;
  arrayIterators?: Record<string, string>;
  pipeHandles?: Array<{
    key: string;
    handle: string;
    baseTrunk: {
      module: string;
      type: string;
      field: string;
      instance?: number;
    };
  }>;
};

/**
 * A handle binding — declares a named data source available in a bridge.
 *
 * Every wire reference in the bridge body must trace back to one of these.
 */
export type HandleBinding =
  | {
      handle: string;
      kind: "tool";
      name: string;
      version?: string;
      memoize?: true;
      /** True when this tool is declared inside an array-mapping block. */
      element?: true;
    }
  | { handle: string; kind: "input" }
  | { handle: string; kind: "output" }
  | { handle: string; kind: "context" }
  | { handle: string; kind: "const" }
  | { handle: string; kind: "define"; name: string };

/** Internal module identifier for the bridge's own trunk (input args + output fields) */
export const SELF_MODULE = "_";

/* c8 ignore start — pure TypeScript type declarations: no executable lines */

/**
 * Tool definition — a declared tool with wires, dependencies, and optional inheritance.
 *
 * Tool blocks define reusable, composable API call configurations:
 *   tool hereapi httpCall        — root tool with function name
 *   tool hereapi.geocode extends hereapi  — child inherits parent wires
 *
 * The engine resolves extends chains, merges wires, and calls the
 * registered tool function with the fully-built input object.
 */
export type ToolDef = {
  kind: "tool";
  /** Tool name: "hereapi", "sendgrid.send", "authService" */
  name: string;
  /** Function name — looked up in the tools map. Omitted when extends is used. */
  fn?: string;
  /** Parent tool name — inherits fn, deps, and wires */
  extends?: string;
  /** Declared handles — same as Bridge/Define handles (tools, context, const, etc.)
   *  Tools cannot declare `input` or `output` handles. */
  handles: HandleBinding[];
  /** Connection wires — same format as Bridge/Define wires */
  wires: Wire[];
  /** Synthetic fork handles for expressions, string interpolation, etc. */
  pipeHandles?: Bridge["pipeHandles"];
  /** Error fallback for the tool call — replaces the result when the tool throws. */
  onError?: { value: string } | { source: string };
};

/**
 * Context passed to every tool function as the second argument.
 *
 * Provides access to engine services (logger, etc.) without polluting the
 * input object.  Tools that don't need it simply ignore the second arg.
 */
// Re-exported from @stackables/bridge-types to break circular dependency
// with bridge-stdlib while maintaining backward-compatible imports.
export type {
  BatchToolCallFn,
  BatchToolFn,
  ToolContext,
  ScalarToolCallFn,
  ScalarToolFn,
  ToolCallFn,
  ToolMap,
  ToolMetadata,
  CacheStore,
  SourceLocation,
} from "@stackables/bridge-types";

/**
 * Explicit control flow instruction — used on the right side of fallback
 * gates (`||`, `??`, `catch`) to influence execution.
 *
 *   - `throw`    — raises a standard Error with the given message
 *   - `panic`    — raises a BridgePanicError that bypasses all error boundaries
 *   - `continue` — skips the current array element (sentinel value)
 *   - `break`    — halts array iteration (sentinel value)
 */
export type ControlFlowInstruction =
  | { kind: "throw"; message: string }
  | { kind: "panic"; message: string }
  | { kind: "continue"; levels?: number }
  | { kind: "break"; levels?: number };

// ── Wire Expression Model ───────────────────────────────────────────────────
//
// Every wire is an ordered list of source entries + an optional catch handler.
// Source entries contain recursive Expression trees that evaluate to values.

/**
 * A recursive expression tree that evaluates to a single value within one
 * source entry.
 *
 * This captures everything that can appear as the "value-producing"
 * component of a wire: refs, literals, ternaries, boolean short-circuit
 * operators, and control flow instructions.
 *
 * Note: Bridge `||` and `??` are wire-level fallback gates (sequential
 * "try this source, if the gate opens try the next one"). They are NOT
 * expression operators. They live on `WireSourceEntry.gate`.
 */
export type Expression =
  | {
      /** Pull a data source reference */
      type: "ref";
      ref: NodeRef;
      safe?: true;
      refLoc?: SourceLocation;
      loc?: SourceLocation;
    }
  | {
      /** JSON-encoded constant: "\"hello\"", "42", "true", "null" */
      type: "literal";
      value: string;
      loc?: SourceLocation;
    }
  | {
      /** Ternary: `cond ? then : else` */
      type: "ternary";
      cond: Expression;
      then: Expression;
      else: Expression;
      condLoc?: SourceLocation;
      thenLoc?: SourceLocation;
      elseLoc?: SourceLocation;
      loc?: SourceLocation;
    }
  | {
      /** Short-circuit logical AND: `left && right` → boolean */
      type: "and";
      left: Expression;
      right: Expression;
      leftSafe?: true;
      rightSafe?: true;
      loc?: SourceLocation;
    }
  | {
      /** Short-circuit logical OR: `left || right` → boolean */
      type: "or";
      left: Expression;
      right: Expression;
      leftSafe?: true;
      rightSafe?: true;
      loc?: SourceLocation;
    }
  | {
      /** Loop/error control: throw, panic, continue, break */
      type: "control";
      control: ControlFlowInstruction;
      loc?: SourceLocation;
    };

/**
 * One entry in the wire's ordered fallback chain.
 *
 * The first entry has no gate (always evaluated); subsequent entries have a
 * gate that opens when the running value meets the condition.
 *
 * `gate` corresponds to `||` (falsy) and `??` (nullish) in bridge source.
 * These are wire-level sequencing, not expression-level operators.
 */
export interface WireSourceEntry {
  /** The expression to evaluate for this source */
  expr: Expression;
  /**
   * When to try this entry:
   * - absent  → always (first entry — the primary source)
   * - "falsy" → previous value was falsy (0, "", false, null, undefined)
   * - "nullish" → previous value was null or undefined
   */
  gate?: "falsy" | "nullish";
  loc?: SourceLocation;
}

/**
 * Unified catch handler — replaces the legacy triple of catchFallback /
 * catchFallbackRef / catchControl.
 */
export type WireCatch =
  | { ref: NodeRef; loc?: SourceLocation }
  | { value: string; loc?: SourceLocation }
  | { control: ControlFlowInstruction; loc?: SourceLocation };

/**
 * Named constant definition — a reusable value defined in the bridge file.
 *
 * Constants are available in bridge blocks via `with const as c` and in tool
 * blocks via `with const`. The engine collects all ConstDef instructions into
 * a single namespace object keyed by name.
 *
 * Examples:
 *   const fallbackGeo = { "lat": 0, "lon": 0 }
 *   const defaultCurrency = "EUR"
 */
export type ConstDef = {
  kind: "const";
  /** Constant name — used as the key in the const namespace */
  name: string;
  /** Raw JSON string — parsed at runtime when accessed */
  value: string;
};

/**
 * Version declaration — records the bridge file's declared language version.
 *
 * Emitted by the parser as the first instruction. Used at runtime to verify
 * that the standard library satisfies the bridge's minimum version requirement.
 *
 * Example:  `version 1.5`  →  `{ kind: "version", version: "1.5" }`
 */
export type VersionDecl = {
  kind: "version";
  /** Declared version string, e.g. "1.5" */
  version: string;
};

/** Union of all instruction types (excludes VersionDecl — version lives on BridgeDocument) */
export type Instruction = Bridge | ToolDef | ConstDef | DefineDef;

/**
 * Parsed bridge document — the structured output of the compiler.
 *
 * Wraps the instruction array with document-level metadata (version) and
 * provides a natural home for future pre-computed optimisations.
 */
export interface BridgeDocument {
  /** Declared language version (from `version X.Y` header). */
  version?: string;
  /** Original Bridge source text that produced this document. */
  source?: string;
  /** Optional logical filename associated with the source text. */
  filename?: string;
  /** All instructions: bridge, tool, const, and define blocks. */
  instructions: Instruction[];
}

/**
 * Define block — a reusable named subgraph (pipeline / macro).
 *
 * At parse time a define is stored as a template.  When a bridge declares
 * `with <define> as <handle>`, the define's handles and wires are inlined
 * into the bridge with namespaced identifiers for isolation.
 *
 * Example:
 *   define secureProfile {
 *     with userApi as api
 *     with input as i
 *     with output as o
 *     api.id <- i.userId
 *     o.name <- api.login
 *   }
 */
export type DefineDef = {
  kind: "define";
  /** Define name — referenced in bridge `with` declarations */
  name: string;
  /** Declared handles (tools, input, output, etc.) */
  handles: HandleBinding[];
  /** Connection wires (same format as Bridge wires) */
  wires: Wire[];
  /** Array iterators (same as Bridge) */
  arrayIterators?: Record<string, string>;
  /** Pipe fork registry (same as Bridge) */
  pipeHandles?: Bridge["pipeHandles"];
};
/* c8 ignore stop */
