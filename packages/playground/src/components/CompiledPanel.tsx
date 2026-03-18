import { useMemo } from "react";
import { Editor } from "./Editor";
import type { BridgeOperation } from "../engine";
import { compileOperation } from "../engine";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

type Props = {
  bridge: string;
  operations: BridgeOperation[];
  selectedOperation: string;
  onOperationChange: (op: string) => void;
  autoHeight?: boolean;
};

export function CompiledPanel({
  bridge,
  operations,
  selectedOperation,
  onOperationChange,
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
