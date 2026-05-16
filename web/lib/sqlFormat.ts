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

/**
 * Tokeniza un texto SQL preservando strings, comentarios y paréntesis.
 * Reduce el resto a tokens útiles para formateo (palabras, símbolos).
 */
type SqlToken =
  | { kind: "ws" }
  | { kind: "word"; text: string }
  | { kind: "string"; text: string } // incluye las comillas
  | { kind: "comment"; text: string } // -- o /* */ enteros
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "comma" }
  | { kind: "semicolon" }
  | { kind: "op"; text: string }; // operadores y otros símbolos

function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    // whitespace
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      out.push({ kind: "ws" });
      i = j;
      continue;
    }
    // comentarios
    if (ch === "-" && next === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n - 1 && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      const end = Math.min(j + 2, n);
      out.push({ kind: "comment", text: sql.slice(i, end) });
      i = end;
      continue;
    }
    // strings
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      out.push({ kind: "string", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && sql[j] !== '"') j++;
      const end = Math.min(j + 1, n);
      out.push({ kind: "string", text: sql.slice(i, end) });
      i = end;
      continue;
    }
    // estructurales
    if (ch === "(") {
      out.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      out.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (ch === ",") {
      out.push({ kind: "comma" });
      i++;
      continue;
    }
    if (ch === ";") {
      out.push({ kind: "semicolon" });
      i++;
      continue;
    }
    // palabra: letras/dígitos/_/./@/$ (alias y nombres tipo tabla.col)
    if (/[A-Za-z0-9_@$#\.\[\]]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_@$#\.\[\]]/.test(sql[j])) j++;
      out.push({ kind: "word", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    // operadores y resto
    // Capturamos secuencias cortas de símbolos pegados para que <= >= != etc
    // queden como un token.
    let j = i + 1;
    while (
      j < n &&
      /[<>=!+\-*\/%^&|~?:]/.test(sql[j]) &&
      // pero cortamos si encontramos uno de los estructurales
      sql[j] !== "(" &&
      sql[j] !== ")"
    ) {
      j++;
    }
    out.push({ kind: "op", text: sql.slice(i, j) });
    i = j;
  }
  return out;
}

const CLAUSE_WORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "VALUES",
  "INSERT",
  "UPDATE",
  "SET",
  "DELETE",
  "WITH",
]);

const JOIN_STARTERS = new Set([
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "OUTER",
  "JOIN",
]);

// Palabras que SÍ quieren espacio antes de `(` (operadores/cláusulas).
// El resto pega: COUNT(*), SUM(x), mi_funcion(...), IN(...), etc.
const WORDS_REQUIRING_SPACE_BEFORE_PAREN = new Set([
  "AND", "OR", "NOT", "WHERE", "ON", "HAVING", "WHEN", "THEN", "ELSE",
  "BETWEEN", "LIKE", "IS", "AS", "BY", "FROM", "SELECT",
]);

const RESERVED_UPPER = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "LIMIT",
  "OFFSET", "UNION", "ALL", "INTERSECT", "EXCEPT", "VALUES", "INSERT",
  "INTO", "UPDATE", "SET", "DELETE", "WITH", "AS", "ON", "AND", "OR",
  "NOT", "IN", "IS", "NULL", "LIKE", "BETWEEN", "EXISTS", "CASE", "WHEN",
  "THEN", "ELSE", "END", "DISTINCT", "INNER", "LEFT", "RIGHT", "FULL",
  "OUTER", "CROSS", "JOIN", "ASC", "DESC", "TRUE", "FALSE",
]);

interface Cursor {
  toks: SqlToken[];
  i: number;
}

function peekText(c: Cursor, offset = 0): string | null {
  let k = c.i + offset;
  while (k < c.toks.length && c.toks[k].kind === "ws") k++;
  const t = c.toks[k];
  if (!t) return null;
  if (t.kind === "word") return t.text.toUpperCase();
  return null;
}

function upperWord(s: string): string {
  return RESERVED_UPPER.has(s.toUpperCase()) ? s.toUpperCase() : s;
}

/**
 * Imprime el SQL "linealizado" usando los tokens, pero con saltos y sangrías
 * en lugares útiles:
 *  - SELECT/FROM/WHERE/JOIN/etc. arrancan línea.
 *  - Columnas del SELECT cada una en su línea (con sangría).
 *  - Cláusulas WHERE/HAVING/ON con AND/OR rompen a nueva línea cuando la
 *    expresión es larga o tiene paréntesis anidados.
 *  - Respetamos paréntesis: lo que está dentro de paréntesis no se rompe
 *    (salvo subqueries con SELECT adentro).
 */
function renderFormatted(tokens: SqlToken[]): string {
  // 1. Saltos de línea por cláusula y por coma de top-level (no dentro de
  //    paréntesis) en el SELECT.
  const baseIndent = "  ";
  let depth = 0;
  let out = "";
  let line = "";
  let inSelectList = false; // entre SELECT y FROM, top-level
  let inWhereLike = false; // WHERE/HAVING/ON top-level
  let wherePrefix = ""; // texto de la cláusula que abrió el bloque (para alinear)
  // BETWEEN x AND y → no rompemos en ese AND. Lo armo como contador:
  // tras BETWEEN, esperamos UN AND que es parte del between.
  let pendingBetweenAnds = 0;

  function pushLine() {
    if (line.length > 0) {
      out += line.trimEnd() + "\n";
      line = "";
    }
  }

  function appendTok(s: string, addSpace: boolean) {
    if (addSpace && line.length > 0 && !/[\s(]$/.test(line)) {
      line += " ";
    }
    line += s;
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "ws") continue;
    if (t.kind === "comment") {
      // Comentarios pegados al final de línea, o en su propia línea si nada hay.
      if (line.trim().length === 0) {
        line = t.text;
        pushLine();
      } else {
        appendTok(t.text, true);
      }
      continue;
    }

    // Detección de palabras clave de cláusula (solo top-level, depth==0)
    if (t.kind === "word" && depth === 0) {
      const up = t.text.toUpperCase();

      // Multi-palabra: "GROUP BY", "ORDER BY", "LEFT JOIN", etc.
      if (CLAUSE_WORDS.has(up) || JOIN_STARTERS.has(up) || up === "INSERT" || up === "UPDATE") {
        // Compactar palabras consecutivas de cláusula como "GROUP BY",
        // "LEFT OUTER JOIN", "UNION ALL", "INSERT INTO", "DELETE FROM"...
        const parts: string[] = [t.text.toUpperCase()];
        let j = i + 1;
        while (j < tokens.length) {
          while (j < tokens.length && tokens[j].kind === "ws") j++;
          const nxt = tokens[j];
          if (!nxt || nxt.kind !== "word") break;
          const nw = nxt.text.toUpperCase();
          const last = parts[parts.length - 1];
          if (
            (last === "GROUP" && nw === "BY") ||
            (last === "ORDER" && nw === "BY") ||
            (last === "INSERT" && nw === "INTO") ||
            (last === "DELETE" && nw === "FROM") ||
            (last === "UNION" && nw === "ALL") ||
            (last === "LEFT" && (nw === "OUTER" || nw === "JOIN")) ||
            (last === "RIGHT" && (nw === "OUTER" || nw === "JOIN")) ||
            (last === "FULL" && (nw === "OUTER" || nw === "JOIN")) ||
            (last === "INNER" && nw === "JOIN") ||
            (last === "CROSS" && nw === "JOIN") ||
            (last === "OUTER" && nw === "JOIN")
          ) {
            parts.push(nw);
            j++;
          } else {
            break;
          }
        }
        // Saltar líneas para cláusula
        pushLine();
        const clause = parts.join(" ");
        line = clause;
        // Avanzamos i hasta el último token consumido
        i = j - 1;

        if (clause === "SELECT") {
          inSelectList = true;
          inWhereLike = false;
        } else if (clause.startsWith("FROM") || clause.endsWith("JOIN")) {
          inSelectList = false;
          inWhereLike = false;
        } else if (clause === "WHERE" || clause === "HAVING") {
          inSelectList = false;
          inWhereLike = true;
          wherePrefix = clause;
        } else if (clause === "GROUP BY" || clause === "ORDER BY") {
          inSelectList = false;
          inWhereLike = false;
        } else {
          inSelectList = false;
          inWhereLike = false;
        }
        // Después del verbo, espacio
        line += " ";
        continue;
      }

      // ON dentro de un JOIN: top-level también, lo tratamos como cláusula
      // que rompe en su propia línea (alineada con el JOIN).
      if (up === "ON") {
        pushLine();
        line = baseIndent + "ON ";
        inWhereLike = true;
        wherePrefix = "ON";
        continue;
      }

      // AND / OR dentro de WHERE/HAVING/ON top-level → salto de línea,
      // SALVO que estemos esperando un AND del BETWEEN.
      if ((up === "AND" || up === "OR") && inWhereLike) {
        if (up === "AND" && pendingBetweenAnds > 0) {
          pendingBetweenAnds -= 1;
          appendTok("AND", true);
          continue;
        }
        pushLine();
        const indent = wherePrefix === "ON" ? baseIndent : "";
        line = indent + up + " ";
        continue;
      }

      // BETWEEN marca que el próximo AND es parte de la sintaxis.
      if (up === "BETWEEN") {
        pendingBetweenAnds += 1;
      }
    }

    // Comas en select list top-level → cada columna en su línea
    if (t.kind === "comma") {
      if (depth === 0 && inSelectList) {
        line += ",";
        pushLine();
        line = baseIndent;
      } else {
        // Comas en listas dentro de paréntesis: pegada a lo anterior + espacio
        if (line.endsWith(" ")) line = line.replace(/ +$/, "");
        line += ", ";
      }
      continue;
    }

    if (t.kind === "lparen") {
      depth += 1;
      // Detectamos la última "palabra" en la línea (lo que precede al `(`).
      // Si es una keyword lógica/de cláusula, mantenemos el espacio: `AND (`.
      // Si es una función o identificador, pegamos: `COUNT(`, `mi_tabla(`.
      const lastWordMatch = line.match(/([A-Za-z_][A-Za-z_0-9]*)\s*$/);
      const lastWord = lastWordMatch ? lastWordMatch[1].toUpperCase() : null;
      const wantsSpace = lastWord != null && WORDS_REQUIRING_SPACE_BEFORE_PAREN.has(lastWord);
      if (!wantsSpace && line.endsWith(" ")) {
        line = line.replace(/ +$/, "");
      } else if (wantsSpace && line.length > 0 && !line.endsWith(" ")) {
        line += " ";
      }
      line += "(";
      continue;
    }
    if (t.kind === "rparen") {
      depth = Math.max(0, depth - 1);
      // Sin espacio antes del paréntesis cierre
      if (line.endsWith(" ")) line = line.replace(/ +$/, "");
      line += ")";
      // Después del ) un espacio para que lo que sigue (operador o palabra)
      // quede separado.
      line += " ";
      continue;
    }
    if (t.kind === "semicolon") {
      line += ";";
      pushLine();
      // Limpiar contexto
      inSelectList = false;
      inWhereLike = false;
      wherePrefix = "";
      continue;
    }

    if (t.kind === "string") {
      appendTok(t.text, true);
      continue;
    }
    if (t.kind === "word") {
      appendTok(upperWord(t.text), true);
      continue;
    }
    if (t.kind === "op") {
      // Operadores: espacio antes y después salvo si pegado a un paren
      const op = t.text;
      const noLeadSpace = line.endsWith("(") || line.endsWith(" ") || line.length === 0;
      if (!noLeadSpace) line += " ";
      line += op;
      // Espacio después para que el siguiente token quede separado
      line += " ";
      continue;
    }
  }
  pushLine();
  // Indentar líneas que están en select-list: ya las indenté al armarlas con
  // baseIndent. Idem WHERE.
  // Para SELECT con la primera columna pegada en la misma línea
  // (e.g. "SELECT col1,") la dejamos así para minimizar cambios visuales.
  return out.trimEnd();
}

export function prettyFormatSql(sql: string): string {
  // Tokenizamos preservando strings y comentarios para no romperlos.
  const toks = tokenizeSql(sql);
  return renderFormatted(toks);
}
