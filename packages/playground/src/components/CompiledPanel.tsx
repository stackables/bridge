import { useMemo } from "react";
import type { BridgeOperation } from "../engine";
import { parseBridgeDiagnostics } from "@stackables/bridge";
import { compileBridge } from "@stackables/bridge-compiler";
import { Editor } from "./Editor";

type Props = {
  bridge: string;
  operations: BridgeOperation[];
  selectedOperation: string;
  onOperationChange: (op: string) => void;
  autoHeight?: boolean;
};

export function CompiledPanel({
  bridge,
  selectedOperation,
  autoHeight = false,
}: Props) {
  const compiledCode = useMemo(() => {
    if (!selectedOperation) return "// Select a bridge operation to compile.";
    try {
      const { document } = parseBridgeDiagnostics(bridge, {
        filename: "playground.bridge",
      });
      const result = compileBridge(document, { operation: selectedOperation });
      return result.code;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `// Error: ${msg}`;
    }
  }, [bridge, selectedOperation]);

  return (
    <div className={autoHeight ? "space-y-3" : "flex flex-col h-full"}>
      {/* Compiled JS output */}
      <div className={autoHeight ? "" : "flex-1 min-h-0"}>
        <Editor
          label=""
          value={compiledCode}
          onChange={() => {}}
          language="javascript"
          readOnly
          autoHeight={autoHeight}
        />
      </div>
    </div>
  );
}
