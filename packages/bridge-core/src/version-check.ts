import type {
  Bridge,
  BridgeDocument,
  DefineDef,
  Instruction,
  ToolDef,
  ToolMap,
} from "./types.ts";

/**
 * Extract the declared bridge version from a document.
 * Returns `undefined` if no version was declared.
 */
export function getBridgeVersion(doc: BridgeDocument): string | undefined {
  return doc.version;
}

/**
 * Verify that the standard library satisfies the bridge file's declared version.
 *
 * The bridge `version X.Y` header acts as a minimum-version constraint:
 *  - Same major  → compatible (only major bumps introduce breaking changes)
 *  - Bridge minor ≤ std minor → OK (std is same or newer)
 *  - Bridge minor > std minor → ERROR (bridge needs features not in this std)
 *  - Different major → ERROR (user must provide a compatible std explicitly)
 *
 * @throws Error with an actionable message when the std is incompatible.
 */
export function checkStdVersion(
  version: string | undefined,
  stdVersion: string,
): void {
  if (!version) return; // no version declared — nothing to check

  const bParts = version.split(".").map(Number);
  const sParts = stdVersion.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = bParts;
  const [sMajor = 0, sMinor = 0] = sParts;

  if (bMajor !== sMajor) {
    throw new Error(
      `Bridge version ${version} requires a ${bMajor}.x standard library, ` +
        `but the provided std is ${stdVersion} (major version ${sMajor}). ` +
        `Provide a compatible std as "std@${version}" in the tools map.`,
    );
  }

  if (bMinor > sMinor) {
    throw new Error(
      `Bridge version ${version} requires standard library ≥ ${bMajor}.${bMinor}, ` +
        `but the installed @stackables/bridge-stdlib is ${stdVersion}. ` +
        `Update @stackables/bridge-stdlib to ${bMajor}.${bMinor}.0 or later.`,
    );
  }
}

// ── Std resolution from tools map ───────────────────────────────────────────

/**
 * Resolve the standard library namespace and version to use.
 *
 * Checks the bundled std first.  When the bridge file targets a different
 * major version (e.g. `version 1.5` vs bundled `2.0.0`), scans the
 * user-provided tools map for a versioned namespace key like `"std@1.5"`.
 *
 * @returns The resolved std namespace and its version string.
 * @throws Error with an actionable message when no compatible std is found.
 */
export function resolveStd(
  version: string | undefined,
  bundledStd: ToolMap,
  bundledStdVersion: string,
  userTools: ToolMap = {},
): { namespace: ToolMap; version: string } {
  if (!version) {
    return { namespace: bundledStd, version: bundledStdVersion };
  }

  const [bMajor = 0, bMinor = 0] = version.split(".").map(Number);
  const [sMajor = 0, sMinor = 0] = bundledStdVersion.split(".").map(Number);

  // Bundled std satisfies the bridge version
  if (bMajor === sMajor && sMinor >= bMinor) {
    return { namespace: bundledStd, version: bundledStdVersion };
  }

  // Scan tools for a versioned std namespace key (e.g. "std@1.5")
  for (const key of Object.keys(userTools)) {
    const match = key.match(/^std@(.+)$/);
    if (match) {
      const ver = match[1]!;
      const parts = ver.split(".").map(Number);
      const [vMajor = 0, vMinor = 0] = parts;
      if (vMajor === bMajor && vMinor >= bMinor) {
        const ns = userTools[key];
        if (ns != null && typeof ns === "object" && !Array.isArray(ns)) {
          const fullVersion = parts.length <= 2 ? `${ver}.0` : ver;
          return { namespace: ns as ToolMap, version: fullVersion };
        }
      }
    }
  }

  // No compatible std found — produce actionable error
  if (bMajor !== sMajor) {
    throw new Error(
      `Bridge version ${version} requires a ${bMajor}.x standard library, ` +
        `but the bundled std is ${bundledStdVersion} (major version ${sMajor}). ` +
        `Provide a compatible std as "std@${version}" in the tools map.`,
    );
  }

  throw new Error(
    `Bridge version ${version} requires standard library ≥ ${bMajor}.${bMinor}, ` +
      `but the installed @stackables/bridge-stdlib is ${bundledStdVersion}. ` +
      `Update @stackables/bridge-stdlib to ${bMajor}.${bMinor}.0 or later.`,
  );
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
      for (const h of (inst as ToolDef).handles) {
        if (h.kind === "tool" && h.version) {
          result.push({ name: h.name, version: h.version });
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
 * Check whether a versioned dotted tool name can be resolved.
 *
 * In addition to the standard checks (namespace traversal, flat key),
 * this also checks **versioned namespace keys** in the tool map:
 *   - `"std.str.toLowerCase@999.1"` as a flat key
 *   - `"std.str@999.1"` as a namespace key containing `toLowerCase`
 *   - `"std@999.1"` as a namespace key, traversing to `str.toLowerCase`
 */
export function hasVersionedToolFn(
  toolFns: ToolMap,
  name: string,
  version: string,
): boolean {
  const versionedKey = `${name}@${version}`;

  // 1. Flat key or direct namespace traversal
  if (hasToolFn(toolFns, versionedKey)) return true;

  // 2. Versioned namespace key lookup
  //    For "std.str.toLowerCase" @ "999.1", try:
  //      toolFns["std.str@999.1"]?.toLowerCase
  //      toolFns["std@999.1"]?.str?.toLowerCase
  if (name.includes(".")) {
    const parts = name.split(".");
    for (let i = parts.length - 1; i >= 1; i--) {
      const nsKey = parts.slice(0, i).join(".") + "@" + version;
      const remainder = parts.slice(i);
      let ns: any = (toolFns as any)[nsKey];
      if (ns != null && typeof ns === "object") {
        for (const part of remainder) {
          if (ns == null || typeof ns !== "object") {
            ns = undefined;
            break;
          }
          ns = ns[part];
        }
        if (typeof ns === "function") return true;
      }
    }
  }

  return false;
}

/**
 * Validate that all versioned tool handles can be satisfied at runtime.
 *
 * For each handle with `@version`:
 * 1. A versioned key or versioned namespace in the tool map → satisfied
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
    // 1. Flat key, namespace traversal, or versioned namespace key
    if (hasVersionedToolFn(toolFns, name, version)) continue;

    // 2. For std.* tools, check if the active std satisfies the version
    if (name.startsWith("std.")) {
      const sParts = stdVersion.split(".").map(Number);
      const vParts = version.split(".").map(Number);
      const [sMajor = 0, sMinor = 0] = sParts;
      const [vMajor = 0, vMinor = 0] = vParts;

      if (sMajor === vMajor && sMinor >= vMinor) continue;

      throw new Error(
        `Tool "${name}@${version}" requires standard library ≥ ${vMajor}.${vMinor}, ` +
          `but the installed @stackables/bridge-stdlib is ${stdVersion}. ` +
          `Either update the stdlib or provide the tool as ` +
          `"${name}@${version}" in the tools map.`,
      );
    }

    // 3. Non-std tool — must be provided with a versioned key or namespace
    throw new Error(
      `Tool "${name}@${version}" is not available. ` +
        `Provide it as "${name}@${version}" in the tools map.`,
    );
  }
}
