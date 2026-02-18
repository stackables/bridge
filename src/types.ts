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
  /** Path into the data: ["items", "0", "position", "lat"] */
  path: string[];
};

/**
 * A wire connects a data source (from) to a data sink (to).
 * Execution is pull-based: when "to" is demanded, "from" is resolved.
 *
 * Constant wires (`=`) set a fixed value on the target.
 * Pull wires (`<-`) resolve the source at runtime.
 */
export type Wire =
  | { from: NodeRef; to: NodeRef }
  | { value: string; to: NodeRef };

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
};

/**
 * A handle binding — declares a named data source available in a bridge.
 *
 * Every wire reference in the bridge body must trace back to one of these.
 */
export type HandleBinding =
  | { handle: string; kind: "tool"; name: string }
  | { handle: string; kind: "input" }
  | { handle: string; kind: "config" };

/** Internal module identifier for the bridge's own trunk (input args + output fields) */
export const SELF_MODULE = "_";

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
  /** Dependencies declared via `with` inside the tool block */
  deps: ToolDep[];
  /** Wires: constants (`=`) and pulls (`<-`) defining the tool's input */
  wires: ToolWire[];
};

/**
 * A dependency declared inside a tool block.
 *
 *   with config                  — brings config into scope
 *   with authService as auth     — brings another tool's output into scope
 */
export type ToolDep =
  | { kind: "config"; handle: string }
  | { kind: "tool"; handle: string; tool: string };

/**
 * A wire in a tool block — either a constant value or a pull from a dependency.
 *
 * Examples:
 *   baseUrl = "https://api.sendgrid.com/v3"         → constant
 *   method = POST                                     → constant (unquoted)
 *   headers.Authorization <- config.sendgrid.token   → pull from config
 *   headers.Authorization <- auth.access_token       → pull from tool dep
 */
export type ToolWire =
  | { target: string; kind: "constant"; value: string }
  | { target: string; kind: "pull"; source: string };

/**
 * Tool call function — the signature for registered tool functions.
 *
 * Receives a fully-built nested input object and returns the response.
 * The engine builds the input from tool wires + bridge wires.
 *
 * Example (httpCall):
 *   input = { baseUrl: "https://...", method: "GET", path: "/geocode",
 *             headers: { apiKey: "..." }, q: "Berlin" }
 */
export type ToolCallFn = (
  input: Record<string, any>,
) => Promise<Record<string, any>>;

/** Union of all instruction types */
export type Instruction = Bridge | ToolDef;
