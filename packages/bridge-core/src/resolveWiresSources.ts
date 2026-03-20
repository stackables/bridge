/**
 * @deprecated This file is no longer exported and can be deleted.
 *
 * Expression evaluation was moved inline into execute-bridge.ts to allow
 * tighter integration with the execution scope (`requestedFields`, `pullPath`,
 * loop control signals, and error location metadata).
 *
 * Previously exported `evaluateExpression` has been removed from the public
 * API. It was never consumed by any downstream package.
 */
