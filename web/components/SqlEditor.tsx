"use client";

import dynamic from "next/dynamic";
import { useTheme } from "@/lib/useTheme";

// Monaco es pesado: lo cargamos solo en el client.
const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

export function SqlEditor({
  value,
  onChange,
  height = "240px",
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  height?: string;
  readOnly?: boolean;
}) {
  const theme = useTheme();
  return (
    <div className="border border-surface rounded-md overflow-hidden">
      <Editor
        height={height}
        defaultLanguage="sql"
        value={value}
        onChange={(v) => onChange(v ?? "")}
        theme={theme === "light" ? "vs" : "vs-dark"}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: "on",
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: "on",
          automaticLayout: true,
          readOnly,
          formatOnPaste: true,
          formatOnType: true,
        }}
      />
    </div>
  );
}
