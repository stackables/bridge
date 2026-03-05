import { Editor } from "./Editor";
import { FieldSelector } from "./FieldSelector";
import type { BridgeOperation, OutputFieldNode } from "../engine";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

type Props = {
  /** All bridge operations parsed from the current bridge text. */
  operations: BridgeOperation[];
  /** Currently selected operation e.g. "Query.getWeather". */
  operation: string;
  onOperationChange: (op: string) => void;
  /** All possible output fields for the selected operation. */
  availableFields: OutputFieldNode[];
  /** Comma-separated output field names (empty = all). */
  outputFields: string;
  onOutputFieldsChange: (fields: string) => void;
  /** JSON string for the input object. */
  inputJson: string;
  onInputJsonChange: (json: string) => void;
  /** When true, use auto-height sizing (mobile). */
  autoHeight?: boolean;
};

export function StandaloneQueryPanel({
  operations,
  operation,
  onOperationChange,
  availableFields,
  outputFields,
  onOutputFieldsChange,
  inputJson,
  onInputJsonChange,
  autoHeight = false,
}: Props) {
  return (
    <div className={autoHeight ? "space-y-3" : "flex flex-col h-full"}>
      {/* Bridge selector + output fields */}
      <div className="shrink-0 space-y-2 px-0.5">
        {/* Bridge operation dropdown */}
        {operations.length > 1 && (
          <div className="flex items-center gap-2">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 shrink-0 w-16">
              Bridge
            </label>
            <Select value={operation} onValueChange={onOperationChange}>
              <SelectTrigger className="w-full text-xs h-8">
                <SelectValue placeholder="Select bridge" />
              </SelectTrigger>
              <SelectContent>
                {operations.map((op) => (
                  <SelectItem key={op.label} value={op.label}>
                    {op.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Output fields dropdown */}
        <div className="flex items-center gap-2 pb-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 shrink-0 w-16">
            Fields
          </label>
          <FieldSelector
            availableFields={availableFields}
            value={outputFields}
            onChange={onOutputFieldsChange}
          />
        </div>
      </div>

      {/* Input JSON editor */}
      <div className={autoHeight ? "" : "flex-1 min-h-0"}>
        <Editor
          label=""
          value={inputJson}
          onChange={onInputJsonChange}
          language="json"
          autoHeight={autoHeight}
        />
      </div>
    </div>
  );
}
