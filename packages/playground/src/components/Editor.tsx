
import { cn } from "@/lib/utils";

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

export function Editor({ label, value, onChange }: Props) {
  return (
    <div className="flex flex-col h-full">
      {label && (
        <div className="shrink-0 pb-1.5 text-[11px] font-bold text-slate-600 uppercase tracking-widest">
          {label}
        </div>
      )}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={cn(
          "flex-1 min-h-0 w-full resize-none rounded-lg border border-slate-800 bg-slate-950",
          "px-3.5 py-2.5 font-mono text-[13px] leading-relaxed text-slate-200 caret-sky-400",
          "outline-none overflow-y-auto",
          "focus:border-sky-400",
        )}
      />
    </div>
  );
}


