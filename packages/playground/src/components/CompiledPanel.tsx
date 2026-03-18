import { useMemo } from "react";
import type { BridgeOperation } from "../engine";
import { compileOperation } from "../engine";
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
  const compiledCode = useMemo(
    () => compileOperation(bridge, selectedOperation),
    [bridge, selectedOperation],
  );

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
