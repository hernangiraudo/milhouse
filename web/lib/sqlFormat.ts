// Split por `;` respetando strings y comentarios.
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let inStrSingle = false;
  let inStrDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      buf += ch;
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      buf += ch;
      if (ch === "*" && next === "/") {
        buf += next;
        i += 2;
        inBlockComment = false;
        continue;
      }
      i += 1;
      continue;
    }
    if (inStrSingle) {
      buf += ch;
      if (ch === "'") {
        // doble '' es escape
        if (next === "'") {
          buf += next;
          i += 2;
          continue;
        }
        inStrSingle = false;
      }
      i += 1;
      continue;
    }
    if (inStrDouble) {
      buf += ch;
      if (ch === '"') inStrDouble = false;
      i += 1;
      continue;
    }
    if (ch === "-" && next === "-") {
      inLineComment = true;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      buf += ch + next;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inStrSingle = true;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inStrDouble = true;
      buf += ch;
      i += 1;
      continue;
    }
    if (ch === ";") {
      const s = buf.trim();
      if (s.length > 0) out.push(s);
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

// Indentación muy básica de SQL: tokeniza palabras clave y mete saltos antes
// de las cláusulas mayúsculas estándar.
const CLAUSES = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "INNER JOIN",
  "LEFT JOIN",
  "LEFT OUTER JOIN",
  "RIGHT JOIN",
  "RIGHT OUTER JOIN",
  "FULL JOIN",
  "FULL OUTER JOIN",
  "JOIN",
  "ON",
  "UNION",
  "UNION ALL",
  "VALUES",
  "INSERT INTO",
  "UPDATE",
  "SET",
  "DELETE FROM",
];

export function prettyFormatSql(sql: string): string {
  // Normalizar espacios y mayúsculas de clausulas conocidas.
  let s = sql.replace(/\s+/g, " ").trim();
  // Convertir clausulas a mayúscula y meter \n antes.
  for (const c of CLAUSES.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${c.replace(/ /g, "\\s+")}\\b`, "gi");
    s = s.replace(re, (m) => `\n${c}`);
  }
  s = s.replace(/^\n+/, "");
  // Coma de columnas en SELECT: salto + indent.
  const lines: string[] = [];
  for (const line of s.split("\n")) {
    if (/^SELECT\b/i.test(line.trim())) {
      const inner = line.replace(/^SELECT\s*/i, "").trim();
      if (inner.includes(",")) {
        const cols = inner.split(",").map((x) => x.trim());
        lines.push("SELECT");
        cols.forEach((c, i) =>
          lines.push("  " + c + (i < cols.length - 1 ? "," : "")),
        );
        continue;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}
