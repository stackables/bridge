import type { ToolTrace } from "./tracing.ts";
import { TraceCollector } from "./tracing.ts";
import type { Logger, MaybePromise, Path, TreeContext, Trunk } from "./tree-types.ts";
import type { Bridge, BridgeDocument, Instruction, NodeRef, ToolDef, ToolMap, Wire } from "./types.ts";
export declare class ExecutionTree implements TreeContext {
    trunk: Trunk;
    private document;
    /**
     * User-supplied context object.
     * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
     */
    context?: Record<string, any> | undefined;
    /**
     * Parent tree (shadow-tree nesting).
     * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
     */
    parent?: ExecutionTree | undefined;
    state: Record<string, any>;
    bridge: Bridge | undefined;
    /**
     * Cache for resolved tool dependency promises.
     * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
     */
    toolDepCache: Map<string, Promise<any>>;
    /**
     * Cache for resolved ToolDef objects (null = not found).
     * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
     */
    toolDefCache: Map<string, ToolDef | null>;
    /**
     * Pipe fork lookup map — maps fork trunk keys to their base trunk.
     * Public to satisfy `SchedulerContext` — used by `scheduleTools.ts`.
     */
    pipeHandleMap: Map<string, NonNullable<Bridge["pipeHandles"]>[number]> | undefined;
    /**
     * Maps trunk keys to `@version` strings from handle bindings.
     * Populated in the constructor so `schedule()` can prefer versioned
     * tool lookups (e.g. `std.str.toLowerCase@999.1`) over the default.
     * Public to satisfy `SchedulerContext` — used by `scheduleTools.ts`.
     */
    handleVersionMap: Map<string, string>;
    /** Promise that resolves when all critical `force` handles have settled. */
    private forcedExecution?;
    /** Shared trace collector — present only when tracing is enabled. */
    tracer?: TraceCollector;
    /** Structured logger passed from BridgeOptions. Defaults to no-ops. */
    logger?: Logger;
    /** External abort signal — cancels execution when triggered. */
    signal?: AbortSignal;
    /**
     * Hard timeout for tool calls in milliseconds.
     * When set, tool calls that exceed this duration throw a `BridgeTimeoutError`.
     * Default: 15_000 (15 seconds). Set to `0` to disable.
     */
    toolTimeoutMs: number;
    /**
     * Maximum shadow-tree nesting depth.
     * Overrides `MAX_EXECUTION_DEPTH` when set.
     * Default: `MAX_EXECUTION_DEPTH` (30).
     */
    maxDepth: number;
    /**
     * Registered tool function map.
     * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
     */
    toolFns?: ToolMap;
    /** Shadow-tree nesting depth (0 for root). */
    private depth;
    /** Pre-computed `trunkKey({ ...this.trunk, element: true })`.  See docs/performance.md (#4). */
    private elementTrunkKey;
    constructor(trunk: Trunk, document: BridgeDocument, toolFns?: ToolMap, 
    /**
     * User-supplied context object.
     * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
     */
    context?: Record<string, any> | undefined, 
    /**
     * Parent tree (shadow-tree nesting).
     * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
     */
    parent?: ExecutionTree | undefined);
    /**
     * Accessor for the document's instruction list.
     * Public to satisfy `ToolLookupContext` — used by `toolLookup.ts`.
     */
    get instructions(): readonly Instruction[];
    /** Schedule resolution for a target trunk — delegates to `scheduleTools.ts`. */
    schedule(target: Trunk, pullChain?: Set<string>): MaybePromise<any>;
    /**
     * Invoke a tool function, recording both an OpenTelemetry span and (when
     * tracing is enabled) a ToolTrace entry.  All tool-call sites in the
     * engine delegate here so instrumentation lives in exactly one place.
     *
     * Public to satisfy `ToolLookupContext` — called by `toolLookup.ts`.
     */
    callTool(toolName: string, fnName: string, fnImpl: (...args: any[]) => any, input: Record<string, any>): MaybePromise<any>;
    shadow(): ExecutionTree;
    /**
     * Wrap raw array items into shadow trees, honouring `break` / `continue`
     * sentinels.  Shared by `pullOutputField`, `response`, and `run`.
     */
    private createShadowArray;
    /** Returns collected traces (empty array when tracing is disabled). */
    getTraces(): ToolTrace[];
    /**
     * Traverse `ref.path` on an already-resolved value, respecting null guards.
     * Extracted from `pullSingle` so the sync and async paths can share logic.
     */
    private applyPath;
    /**
     * Pull a single value.  Returns synchronously when already in state;
     * returns a Promise only when the value is a pending tool call.
     * See docs/performance.md (#10).
     *
     * Public to satisfy `TreeContext` — extracted modules call this via
     * the interface.
     */
    pullSingle(ref: NodeRef, pullChain?: Set<string>): MaybePromise<any>;
    push(args: Record<string, any>): void;
    /** Store the aggregated promise for critical forced handles so
     *  `response()` can await it exactly once per bridge execution. */
    setForcedExecution(p: Promise<void>): void;
    /** Return the critical forced-execution promise (if any). */
    getForcedExecution(): Promise<void> | undefined;
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
    executeForced(): Promise<any>[];
    /**
     * Resolve a set of matched wires — delegates to the extracted
     * `resolveWires` module.  See `resolveWires.ts` for the full
     * architecture comment (modifier layers, overdefinition, etc.).
     *
     * Public to satisfy `SchedulerContext` — used by `scheduleTools.ts`.
     */
    resolveWires(wires: Wire[], pullChain?: Set<string>): MaybePromise<any>;
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
    pullOutputField(path: string[], array?: boolean): Promise<unknown>;
    /**
     * Resolve pre-grouped wires on this shadow tree without re-filtering.
     * Called by the parent's `materializeShadows` to skip per-element wire
     * filtering.  Returns synchronously when the wire resolves sync (hot path).
     * See docs/performance.md (#8, #10).
     */
    resolvePreGrouped(wires: Wire[]): MaybePromise<unknown>;
    /**
     * Recursively resolve an output field at `prefix` — either via exact-match
     * wires (leaf) or by collecting sub-fields from deeper wires (nested object).
     *
     * Shared by `collectOutput()` and `run()`.
     */
    private resolveNestedField;
    /**
     * Materialise all output wires into a plain JS object.
     *
     * Used by the GraphQL adapter when a bridge field returns a scalar type
     * (e.g. `JSON`, `JSONObject`). In that case GraphQL won't call sub-field
     * resolvers, so we need to eagerly resolve every output wire and assemble
     * the result ourselves — the same logic `run()` uses for object output.
     */
    collectOutput(): Promise<unknown>;
    /**
     * Execute the bridge end-to-end without GraphQL.
     *
     * Injects `input` as the trunk arguments, runs forced wires, then pulls
     * and materialises every output field into a plain JS object (or array of
     * objects for array-mapped bridges).
     *
     * This is the single entry-point used by `executeBridge()`.
     */
    run(input: Record<string, unknown>): Promise<unknown>;
    /**
     * Recursively convert shadow trees into plain JS objects —
     * delegates to `materializeShadows.ts`.
     */
    private materializeShadows;
    response(ipath: Path, array: boolean): Promise<any>;
    /**
     * Find define output wires for a specific field path.
     *
     * Looks for whole-object define forward wires (`o <- defineHandle`)
     * at path=[] for this trunk, then searches the define's output wires
     * for ones matching the requested field path.
     */
    private findDefineFieldWires;
}
//# sourceMappingURL=ExecutionTree.d.ts.map