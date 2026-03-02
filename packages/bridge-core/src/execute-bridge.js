import { ExecutionTree } from "./ExecutionTree.js";
import { TraceCollector } from "./tracing.js";
import { SELF_MODULE } from "./types.js";
import { std as bundledStd, STD_VERSION as BUNDLED_STD_VERSION, } from "@stackables/bridge-stdlib";
import { resolveStd, checkHandleVersions } from "./version-check.js";
/**
 * Execute a bridge operation without GraphQL.
 *
 * Runs a bridge file's data-wiring logic standalone — no schema, no server,
 * no HTTP layer required. Useful for CLI tools, background jobs, tests, and
 * any context where you want Bridge's declarative data-fetching outside of
 * a GraphQL server.
 *
 * @example
 * ```ts
 * import { parseBridge, executeBridge } from "@stackables/bridge";
 * import { readFileSync } from "node:fs";
 *
 * const document = parseBridge(readFileSync("my.bridge", "utf8"));
 * const { data } = await executeBridge({
 *   document,
 *   operation: "Query.myField",
 *   input: { city: "Berlin" },
 * });
 * console.log(data);
 * ```
 */
export async function executeBridge(options) {
    const { document: doc, operation, input = {}, context = {} } = options;
    const parts = operation.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid operation "${operation}" — expected "Type.field" (e.g. "Query.myField")`);
    }
    const [type, field] = parts;
    const trunk = { module: SELF_MODULE, type, field };
    const userTools = options.tools ?? {};
    // Resolve which std to use: bundled, or a versioned namespace from tools
    const { namespace: activeStd, version: activeStdVersion } = resolveStd(doc.version, bundledStd, BUNDLED_STD_VERSION, userTools);
    const allTools = { std: activeStd, ...userTools };
    // Verify all @version-tagged handles can be satisfied
    checkHandleVersions(doc.instructions, allTools, activeStdVersion);
    const tree = new ExecutionTree(trunk, doc, allTools, context);
    if (options.logger)
        tree.logger = options.logger;
    if (options.signal)
        tree.signal = options.signal;
    if (options.toolTimeoutMs !== undefined && Number.isFinite(options.toolTimeoutMs) && options.toolTimeoutMs >= 0) {
        tree.toolTimeoutMs = Math.floor(options.toolTimeoutMs);
    }
    if (options.maxDepth !== undefined && Number.isFinite(options.maxDepth) && options.maxDepth >= 0) {
        tree.maxDepth = Math.floor(options.maxDepth);
    }
    const traceLevel = options.trace ?? "off";
    if (traceLevel !== "off") {
        tree.tracer = new TraceCollector(traceLevel);
    }
    const data = await tree.run(input);
    return { data: data, traces: tree.getTraces() };
}
