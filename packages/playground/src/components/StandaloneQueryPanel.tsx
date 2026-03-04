import { Editor } from "./Editor";
import { FieldSelector } from "./FieldSelector";
import type { BridgeOperation, OutputFieldNode } from "../engine";

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
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 shrink-0 w-16">
            Bridge
          </label>
          <select
            value={operation}
            onChange={(e) => onOperationChange(e.target.value)}
            className="flex-1 min-w-0 rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-slate-200 outline-none focus:border-sky-400 cursor-pointer"
          >
            {operations.length === 0 && (
              <option value="">No bridges found</option>
            )}
            {operations.map((op) => (
              <option key={op.label} value={op.label}>
                {op.label}
              </option>
            ))}
          </select>
        </div>

        {/* Output fields dropdown */}
        <div className="flex items-center gap-2">
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
