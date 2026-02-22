
type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
};

export function Editor({ label, value, onChange }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: "#475569",
        textTransform: "uppercase" as const,
        letterSpacing: "0.08em",
        padding: "0 0 6px 2px",
        flexShrink: 0,
      }}>
        {label}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        style={{
          flex: 1,
          minHeight: 0,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
          fontSize: 13,
          lineHeight: 1.6,
          padding: "10px 14px",
          background: "#0f172a",
          color: "#e2e8f0",
          border: "1px solid #1e293b",
          borderRadius: 8,
          resize: "none",
          outline: "none",
          caretColor: "#38bdf8",
          boxSizing: "border-box",
          width: "100%",
          overflowY: "auto",
        }}
        onFocus={(e) => { e.target.style.borderColor = "#38bdf8"; }}
        onBlur={(e) => { e.target.style.borderColor = "#1e293b"; }}
      />
    </div>
  );
}

