import "./globals.css";

export const metadata = {
  title: "Milhouse — ETL Manager",
  description: "Config-driven ETL orchestrator (MVP)",
};

// Script inline para aplicar el tema antes del primer paint y evitar el flash.
const THEME_INIT_SCRIPT = `
  try {
    var t = localStorage.getItem('milhouse-theme');
    if (t !== 'light' && t !== 'dark') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
