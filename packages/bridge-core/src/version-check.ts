import type {
  Bridge,
  DefineDef,
  Instruction,
  ToolDef,
  ToolMap,
  VersionDecl,
} from "./types.ts";

/**
 * Extract the declared bridge version from an instruction set.
 * Returns `undefined` if no VersionDecl instruction is present.
 */
export function getBridgeVersion(
  instructions: Instruction[],
): string | undefined {
  const decl = instructions.find((i): i is VersionDecl => i.kind === "version");
  return decl?.version;
}

/**
 * Verify that the standard library satisfies the bridge file's declared version.
 *
 * The bridge `version X.Y` header acts as a minimum-version constraint:
 *  - Same major  → compatible (only major bumps introduce breaking changes)
 *  - Bridge minor ≤ std minor → OK (std is same or newer)
 *  - Bridge minor > std minor → ERROR (bridge needs features not in this std)
 *
 * @throws Error with an actionable message when the std is too old.
 */
export function checkStdVersion(
  instructions: Instruction[],
  stdVersion: string,
): void {
  const bridgeVersion = getBridgeVersion(instructions);
  if (!bridgeVersion) return; // no version declared — nothing to check

  const bParts = bridgeVersion.split(".").map(Number);
  const sParts = stdVersion.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = bParts;
  const [sMajor = 0, sMinor = 0] = sParts;

  if (bMajor !== sMajor) {
    throw new Error(
      `Bridge version mismatch: bridge requires version ${bridgeVersion} ` +
        `but the standard library is ${stdVersion} (different major version). ` +
        `Update @stackables/bridge-stdlib to a ${bMajor}.x release.`,
    );
  }

  if (bMinor > sMinor) {
    throw new Error(
      `Bridge version ${bridgeVersion} requires standard library ≥ ${bMajor}.${bMinor}, ` +
        `but the installed @stackables/bridge-stdlib is ${stdVersion}. ` +
        `Update @stackables/bridge-stdlib to ${bMajor}.${bMinor}.0 or later.`,
    );
  }
}

// ── Versioned handle validation ─────────────────────────────────────────────

/**
 * Collect every tool reference that carries an `@version` tag from handles
 * (bridge/define blocks) and deps (tool blocks).
 */
export function collectVersionedHandles(
  instructions: Instruction[],
): Array<{ name: string; version: string }> {
  const result: Array<{ name: string; version: string }> = [];
  for (const inst of instructions) {
    if (inst.kind === "bridge" || inst.kind === "define") {
      for (const h of (inst as Bridge | DefineDef).handles) {
        if (h.kind === "tool" && h.version) {
          result.push({ name: h.name, version: h.version });
        }
      }
    }
    if (inst.kind === "tool") {
      for (const dep of (inst as ToolDef).deps) {
        if (dep.kind === "tool" && dep.version) {
          result.push({ name: dep.tool, version: dep.version });
        }
      }
    }
  }
  return result;
}

/**
 * Check whether a dotted tool name resolves to a function in the tool map.
 * Supports both namespace traversal (std.str.toUpperCase) and flat keys.
 */
function hasToolFn(toolFns: ToolMap, name: string): boolean {
  if (name.includes(".")) {
    const parts = name.split(".");
    let current: any = toolFns;
    for (const part of parts) {
      if (current == null || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (typeof current === "function") return true;
    // flat key fallback
    return typeof (toolFns as any)[name] === "function";
  }
  return typeof (toolFns as any)[name] === "function";
}

/**
 * Validate that all versioned tool handles can be satisfied at runtime.
 *
 * For each handle with `@version`:
 * 1. A versioned key (`name@version`) in the tool map → satisfied
 * 2. A `std.*` tool whose STD_VERSION ≥ the requested version → satisfied
 * 3. Otherwise → throws with an actionable error message
 *
 * Call this **before** constructing the ExecutionTree to fail early.
 *
 * @throws Error when a versioned tool cannot be satisfied.
 */
export function checkHandleVersions(
  instructions: Instruction[],
  toolFns: ToolMap,
  stdVersion: string,
): void {
  const versioned = collectVersionedHandles(instructions);
  for (const { name, version } of versioned) {
    // 1. Explicitly provided versioned tool key (e.g. "std.str.toLowerCase@999.1")
    const versionedKey = `${name}@${version}`;
    if (hasToolFn(toolFns, versionedKey)) continue;

    // 2. For std.* tools, check if the bundled std satisfies the version
    if (name.startsWith("std.")) {
      const sParts = stdVersion.split(".").map(Number);
      const vParts = version.split(".").map(Number);
      const [sMajor = 0, sMinor = 0] = sParts;
      const [vMajor = 0, vMinor = 0] = vParts;

      if (sMajor === vMajor && sMinor >= vMinor) continue;

      throw new Error(
        `Tool "${name}@${version}" requires standard library ≥ ${vMajor}.${vMinor}, ` +
          `but the installed @stackables/bridge-stdlib is ${stdVersion}. ` +
          `Either update the stdlib or provide the tool as "${versionedKey}" in the tools map.`,
      );
    }

    // 3. Non-std tool — must be provided with the versioned key
    throw new Error(
      `Tool "${name}@${version}" is not available. ` +
        `Provide it as "${versionedKey}" in the tools map.`,
    );
  }
}
