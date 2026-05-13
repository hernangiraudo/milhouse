"use client";

import type { StepInfo } from "@/lib/types";

export function StepDetails({ info }: { info: StepInfo }) {
  const spec = info.spec as Record<string, unknown>;
  const kind = info.kind;

  return (
    <div className="space-y-4 text-sm">
      <Section title="Identidad">
        <Field label="ID" value={<code className="text-accent">{info.id}</code>} />
        <Field label="Tipo" value={<KindBadge kind={kind} />} />
        {info.output_table && (
          <Field
            label="Tabla de salida"
            value={<code className="text-emerald-300">{info.output_table}</code>}
          />
        )}
        <Field
          label="Depende de"
          value={
            info.depends_on.length === 0 ? (
              <span className="text-slate-500 italic">— (raíz)</span>
            ) : (
              <div className="flex flex-wrap gap-1">
                {info.depends_on.map((d) => (
                  <code
                    key={d}
                    className="milhouse-chip"
                  >
                    {d}
                  </code>
                ))}
              </div>
            )
          }
        />
      </Section>

      <Section title="Definición">
        <KindSpecific kind={kind} spec={spec} />
      </Section>

      <details className="milhouse-codeblock-details">
        <summary>JSON crudo</summary>
        <pre className="milhouse-codeblock mt-2">
          <code>{JSON.stringify(spec, null, 2)}</code>
        </pre>
      </details>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wider text-slate-500 mb-2">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 items-start">
      <div className="text-slate-400">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const map: Record<string, string> = {
    sql_query: "bg-sky-500/20 text-sky-300 border-sky-700",
    sql_exec: "bg-blue-500/20 text-blue-300 border-blue-700",
    join: "bg-violet-500/20 text-violet-300 border-violet-700",
    lookup: "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-700",
    transform: "bg-amber-500/20 text-amber-300 border-amber-700",
    filter_and_subset: "bg-cyan-500/20 text-cyan-300 border-cyan-700",
    sort: "bg-teal-500/20 text-teal-300 border-teal-700",
    procedural: "bg-rose-500/20 text-rose-300 border-rose-700",
    export: "bg-lime-500/20 text-lime-300 border-lime-700",
  };
  return (
    <span
      className={`inline-block text-[11px] px-2 py-0.5 rounded border font-mono ${
        map[kind] ?? "bg-slate-500/20 text-slate-300 border-slate-700"
      }`}
    >
      {kind}
    </span>
  );
}

function KindSpecific({
  kind,
  spec,
}: {
  kind: string;
  spec: Record<string, unknown>;
}) {
  switch (kind) {
    case "sql_query":
      return (
        <>
          <Field
            label="Conexión"
            value={
              <code className="text-sky-300">
                {(spec.connection as string | null | undefined) ?? "default"}
              </code>
            }
          />
          <Field
            label="Consulta SQL"
            value={
              <CodeBlock lang="sql">{String(spec.query ?? "")}</CodeBlock>
            }
          />
        </>
      );

    case "sql_exec": {
      const query = String(spec.query ?? "");
      const stmts = query
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return (
        <>
          <Field
            label="Conexión"
            value={
              <code className="text-sky-300">
                {(spec.connection as string | null | undefined) ?? "default"}
              </code>
            }
          />
          <Field
            label={`Script SQL (${stmts.length} sentencia${stmts.length === 1 ? "" : "s"})`}
            value={<CodeBlock lang="sql">{query}</CodeBlock>}
          />
          <Explain>
            Ejecuta directamente en la conexión. <b>No</b> trae datos a
            Milhouse — los efectos (tablas creadas, filas insertadas/actualizadas,
            índices) viven en la base. Múltiples sentencias separadas por{" "}
            <code>;</code> se ejecutan en orden, sin transacción explícita.
            Si después necesitás los datos en memoria, agregá un{" "}
            <code>sql_query</code> que los lea.
          </Explain>
        </>
      );
    }

    case "join": {
      const left = String(spec.left ?? "");
      const right = String(spec.right ?? "");
      const leftOn = (spec.left_on as string[]) ?? [];
      const rightOn = (spec.right_on as string[]) ?? [];
      const how = (spec.how as string) ?? "inner";
      return (
        <>
          <Field
            label="Tipo de join"
            value={
              <code className="text-violet-300">{how.toUpperCase()}</code>
            }
          />
          <Field
            label="Izquierda"
            value={
              <span>
                <code className="text-emerald-300">{left}</code>{" "}
                <span className="text-slate-500">on</span>{" "}
                <code>{leftOn.join(", ")}</code>
              </span>
            }
          />
          <Field
            label="Derecha"
            value={
              <span>
                <code className="text-emerald-300">{right}</code>{" "}
                <span className="text-slate-500">on</span>{" "}
                <code>{rightOn.join(", ")}</code>
              </span>
            }
          />
          <Explain>
            Junta filas de <code>{left}</code> con <code>{right}</code>{" "}
            comparando {leftOn.length === 1 ? "la columna" : "las columnas"}{" "}
            {leftOn.map((c, i) => (
              <span key={c}>
                <code>{c}</code>
                {i < leftOn.length - 1 ? ", " : ""}
              </span>
            ))}
            {" "}contra{" "}
            {rightOn.map((c, i) => (
              <span key={c}>
                <code>{c}</code>
                {i < rightOn.length - 1 ? ", " : ""}
              </span>
            ))}
            .{" "}
            {how === "inner"
              ? "Las filas sin match en ambos lados se descartan."
              : "Las filas de la izquierda sin match se conservan con nulls a la derecha."}
          </Explain>
        </>
      );
    }

    case "lookup": {
      const input = String(spec.input ?? "");
      const master = String(spec.master ?? "");
      const key = String(spec.key ?? "");
      const masterKey = String(spec.master_key ?? "");
      const select = (spec.select as Array<{ from: string; as?: string }>) ?? [];
      return (
        <>
          <Field
            label="Tabla input"
            value={<code className="text-emerald-300">{input}</code>}
          />
          <Field
            label="Tabla maestra"
            value={<code className="text-emerald-300">{master}</code>}
          />
          <Field
            label="Clave"
            value={
              <span>
                <code>{key}</code>{" "}
                <span className="text-slate-500">↔</span>{" "}
                <code>{masterKey}</code>
              </span>
            }
          />
          <Field
            label="Trae"
            value={
              <ul className="space-y-0.5">
                {select.map((s, i) => (
                  <li key={i}>
                    <code className="text-slate-300">{s.from}</code>
                    {s.as && (
                      <>
                        <span className="text-slate-500"> → </span>
                        <code className="text-accent">{s.as}</code>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            }
          />
          <Explain>
            Enriquece cada fila de <code>{input}</code> con columnas de{" "}
            <code>{master}</code>, matcheando por <code>{key}</code>. Útil
            para resolver IDs a descripciones legibles.
          </Explain>
        </>
      );
    }

    case "transform": {
      const input = String(spec.input ?? "");
      const ops = (spec.operations as Array<Record<string, unknown>>) ?? [];
      return (
        <>
          <Field
            label="Tabla input"
            value={<code className="text-emerald-300">{input}</code>}
          />
          <Field
            label={`${ops.length} operacion${ops.length === 1 ? "" : "es"}`}
            value={
              <ol className="space-y-1 list-decimal list-inside">
                {ops.map((op, i) => (
                  <li key={i} className="text-slate-300">
                    {describeTransformOp(op)}
                  </li>
                ))}
              </ol>
            }
          />
        </>
      );
    }

    case "filter_and_subset": {
      const input = String(spec.input ?? "");
      const filter = (spec.filter as string | null | undefined) ?? null;
      const select = (spec.select as string[]) ?? [];
      return (
        <>
          <Field
            label="Tabla input"
            value={<code className="text-emerald-300">{input}</code>}
          />
          {filter && (
            <Field
              label="Filtro"
              value={<CodeBlock>{filter}</CodeBlock>}
            />
          )}
          {select.length > 0 && (
            <Field
              label={`${select.length} columnas`}
              value={
                <div className="flex flex-wrap gap-1">
                  {select.map((c) => (
                    <code
                      key={c}
                      className="milhouse-chip"
                    >
                      {c}
                    </code>
                  ))}
                </div>
              }
            />
          )}
        </>
      );
    }

    case "sort": {
      const input = String(spec.input ?? "");
      const by =
        (spec.by as Array<{ column: string; desc?: boolean }>) ?? [];
      return (
        <>
          <Field
            label="Tabla input"
            value={<code className="text-emerald-300">{input}</code>}
          />
          <Field
            label="Ordenar por"
            value={
              <ol className="space-y-0.5 list-decimal list-inside">
                {by.map((b, i) => (
                  <li key={i}>
                    <code>{b.column}</code>{" "}
                    <span
                      className={
                        b.desc ? "text-rose-300" : "text-emerald-300"
                      }
                    >
                      {b.desc ? "↓ desc" : "↑ asc"}
                    </span>
                  </li>
                ))}
              </ol>
            }
          />
        </>
      );
    }

    case "export": {
      const input = String(spec.input ?? "");
      const target = (spec.target as Record<string, unknown>) ?? {};
      const t = String(target.kind ?? "");
      return (
        <>
          <Field
            label="Tabla input"
            value={<code className="text-emerald-300">{input}</code>}
          />
          <Field
            label="Destino"
            value={
              t === "file" ? (
                <span>
                  Archivo{" "}
                  <code className="text-lime-300">
                    {String(target.format ?? "")}
                  </code>{" "}
                  en <code>{String(target.path ?? "")}</code>
                </span>
              ) : (
                <span>
                  Tabla DuckDB{" "}
                  <code className="text-lime-300">
                    {String(target.table ?? "")}
                  </code>
                  {target.replace ? (
                    <span className="text-rose-400"> (reemplaza)</span>
                  ) : null}
                </span>
              )
            }
          />
        </>
      );
    }

    case "procedural": {
      const input = String(spec.input ?? "");
      const engine = String(spec.engine ?? "");
      const fnName = spec.fn_name as string | null;
      const script = spec.script as string | null;
      const stateInit = spec.state_init;
      const params = spec.params;
      return (
        <>
          <Field
            label="Tabla input"
            value={<code className="text-emerald-300">{input}</code>}
          />
          <Field
            label="Motor"
            value={
              <span className="font-mono">
                {engine === "rust" ? (
                  <span className="text-orange-300">
                    🦀 Rust nativo (compilado)
                  </span>
                ) : (
                  <span className="text-sky-300">
                    🪄 Rhai (script interpretado)
                  </span>
                )}
              </span>
            }
          />
          {engine === "rust" && fnName && (
            <Field
              label="Función"
              value={<code className="text-orange-300">{fnName}</code>}
            />
          )}
          {engine === "rust" && params != null && (
            <Field
              label="Parámetros"
              value={
                <CodeBlock>{JSON.stringify(params, null, 2)}</CodeBlock>
              }
            />
          )}
          {engine === "rhai" && stateInit != null && (
            <Field
              label="Estado inicial"
              value={
                <CodeBlock>{JSON.stringify(stateInit, null, 2)}</CodeBlock>
              }
            />
          )}
          {engine === "rhai" && script && (
            <Field
              label="Script"
              value={<CodeBlock lang="rhai">{script}</CodeBlock>}
            />
          )}
          <Explain>
            Recorre fila por fila. {engine === "rust" ? "Ejecuta la función Rust compilada con acceso directo al DataFrame Polars (rápido y tipado)." : "Cada fila se pasa al script Rhai como un map mutable `row`, con un objeto `state` persistente entre filas para contadores y acumuladores."}
          </Explain>
        </>
      );
    }

    default:
      return (
        <pre className="milhouse-codeblock">
          <code>{JSON.stringify(spec, null, 2)}</code>
        </pre>
      );
  }
}

function describeTransformOp(op: Record<string, unknown>): React.ReactNode {
  const o = String(op.op ?? "");
  switch (o) {
    case "to_date":
      return (
        <>
          Convertir <code>{String(op.column)}</code> a <code>date</code>
          {op.format ? (
            <>
              {" "}usando formato <code>{String(op.format)}</code>
            </>
          ) : null}
          {op.as ? (
            <>
              {" "}→ <code className="text-accent">{String(op.as)}</code>
            </>
          ) : null}
        </>
      );
    case "cast":
      return (
        <>
          Castear <code>{String(op.column)}</code> a tipo{" "}
          <code>{String(op.to)}</code>
          {op.as ? (
            <>
              {" "}→ <code className="text-accent">{String(op.as)}</code>
            </>
          ) : null}
        </>
      );
    case "uppercase":
      return (
        <>
          Pasar <code>{String(op.column)}</code> a MAYÚSCULAS
        </>
      );
    case "lowercase":
      return (
        <>
          Pasar <code>{String(op.column)}</code> a minúsculas
        </>
      );
    case "rename":
      return (
        <>
          Renombrar <code>{String(op.column)}</code> →{" "}
          <code className="text-accent">{String(op.to)}</code>
        </>
      );
    case "add_constant":
      return (
        <>
          Agregar columna <code className="text-accent">{String(op.column)}</code>{" "}
          con valor constante <code>{JSON.stringify(op.value)}</code>
        </>
      );
    default:
      return <code>{JSON.stringify(op)}</code>;
  }
}

function CodeBlock({
  children,
  lang,
}: {
  children: React.ReactNode;
  lang?: string;
}) {
  return (
    <pre className="milhouse-codeblock">
      {lang && <div className="milhouse-codeblock-lang">{lang}</div>}
      <code>{children}</code>
    </pre>
  );
}

function Explain({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 text-xs text-slate-400 italic leading-relaxed pl-2 border-l-2 border-slate-700">
      {children}
    </div>
  );
}
