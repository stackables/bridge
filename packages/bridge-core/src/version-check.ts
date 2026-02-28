import type { Instruction, VersionDecl } from "./types.ts";

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
