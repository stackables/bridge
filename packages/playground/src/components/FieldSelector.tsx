import { useCallback, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import type { OutputFieldNode } from "../engine";

type Props = {
  /** All possible output fields extracted from the bridge. */
  availableFields: OutputFieldNode[];
  /** Current comma-separated selected field paths (empty = all). */
  value: string;
  /** Called with updated comma-separated field paths. */
  onChange: (value: string) => void;
};

export function FieldSelector({ availableFields, value, onChange }: Props) {
  const selected = useMemo(() => {
    if (!value.trim()) return new Set<string>();
    return new Set(
      value
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean),
    );
  }, [value]);

  const isAllSelected = selected.size === 0;

  const toggleField = useCallback(
    (path: string) => {
      const next = new Set(selected);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      onChange([...next].join(","));
    },
    [selected, onChange],
  );

  const selectAll = useCallback(() => {
    onChange("");
  }, [onChange]);

  // Display label for the trigger
  const triggerLabel = isAllSelected
    ? "All fields"
    : selected.size === 1
      ? [...selected][0]!
      : `${selected.size} fields`;

  // If no fields available, fall back to a plain text input style
  if (availableFields.length === 0) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="All fields (or: name, price, legs.*)"
        className="flex flex-1 min-w-0 h-8 items-center rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-400"
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex flex-1 min-w-0 h-8 items-center justify-between gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 outline-none placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-400 cursor-pointer"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-64 overflow-y-auto w-(--radix-dropdown-menu-trigger-width)"
      >
        <DropdownMenuCheckboxItem
          checked={isAllSelected}
          onCheckedChange={selectAll}
          onSelect={(e) => e.preventDefault()}
          className="font-medium"
        >
          All fields
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {availableFields.map((field) => (
          <DropdownMenuCheckboxItem
            key={field.path}
            checked={selected.has(field.path)}
            onCheckedChange={() => toggleField(field.path)}
            onSelect={(e) => e.preventDefault()}
            className="font-mono"
            style={{ paddingLeft: `${field.depth * 16 + 32}px` }}
          >
            <span className={field.hasChildren ? "font-semibold" : ""}>
              {field.name}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
