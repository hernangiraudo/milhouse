import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b1020",
        panel: "#111827",
        panel2: "#0f172a",
        accent: "#22d3ee",
      },
    },
  },
  plugins: [],
};
export default config;
