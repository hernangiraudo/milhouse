"use client";

export function ExecParamsPanel() {
  return (
    <section className="space-y-4">
      <header>
        <h2 className="font-semibold text-lg">Parámetros de Ejecución</h2>
        <p className="text-sm text-muted">
          Variables que se pasan al motor en cada ejecución (fechas relativas,
          flags de modo, límites, etc.).
        </p>
      </header>
      <div className="bg-panel border border-slate-800 rounded-xl p-8 text-center">
        <div className="text-6xl mb-3">🚧</div>
        <h3 className="text-lg font-semibold mb-1">Próximamente</h3>
        <p className="text-sm text-muted max-w-md mx-auto">
          Estamos diseñando cómo modelar parámetros tipados por proyecto
          (rangos de fechas, listas de cuentas, switches) y cómo inyectarlos en
          los SQL y scripts procedurales.
        </p>
        <p className="text-xs text-dim mt-4">
          ¿Tenés un caso de uso concreto? Anotalo y lo charlamos antes de
          empezar.
        </p>
      </div>
    </section>
  );
}
