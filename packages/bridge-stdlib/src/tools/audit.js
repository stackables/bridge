/**
 * Built-in audit tool — logs all inputs via the engine logger.
 *
 * Designed for use with `force` — wire any number of inputs,
 * force the handle, and every key-value pair is logged.
 *
 * The logger comes from the engine's `ToolContext` (configured via
 * `BridgeOptions.logger`).  When no logger is configured the engine's
 * default no-op logger applies — nothing is logged.
 *
 * Structured logging style: data object first, message tag last.
 *
 * The log level defaults to `info` but can be overridden via `level` input:
 * ```bridge
 * audit.level = "warn"
 * ```
 *
 * ```bridge
 * bridge Mutation.createOrder {
 *   with std.audit as audit
 *   with orderApi as api
 *   with input as i
 *   with output as o
 *
 *   api.userId <- i.userId
 *   audit.action = "createOrder"
 *   audit.userId <- i.userId
 *   audit.orderId <- api.id
 *   force audit
 *   o.id <- api.id
 * }
 * ```
 */
export function audit(input, context) {
    const { level = "info", ...data } = input;
    const log = context?.logger?.[level];
    log?.(data, "[bridge:audit]");
    return input;
}
