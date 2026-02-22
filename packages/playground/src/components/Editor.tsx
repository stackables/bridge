
type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  height?: string;
  language?: string;
};

export function Editor({ label, value, onChange, height = "200px" }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        style={{
          height,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
          fontSize: 13,
          lineHeight: 1.6,
          padding: "10px 14px",
          background: "#0f172a",
          color: "#e2e8f0",
          border: "1px solid #1e293b",
          borderRadius: 8,
          resize: "vertical",
          outline: "none",
          caretColor: "#38bdf8",
          boxSizing: "border-box",
          width: "100%",
        }}
        onFocus={(e) => { e.target.style.borderColor = "#38bdf8"; }}
        onBlur={(e) => { e.target.style.borderColor = "#1e293b"; }}
      />
    </div>
  );
}
