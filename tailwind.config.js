/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    colors: {
      transparent: "transparent",
      current: "currentColor",
      black: "#000",
      surface: { 0: "#0E0E0F", 1: "#151516", 2: "#1C1C1E", 3: "#262628" },
      line: { DEFAULT: "#2A2A2D", strong: "#3A3A3E" },
      fg: { 1: "#EDEDEA", 2: "#A3A39E", 3: "#6E6E6A" },
      accent: { DEFAULT: "#E9A23B", hi: "#F2B354", dim: "rgba(233,162,59,0.14)", on: "#1A1204" },
      danger: "#E5645A",
      ok: "#6FBF8B",
    },
    fontFamily: {
      sans: ['"Geist Variable"', "Segoe UI", "system-ui", "sans-serif"],
      mono: ['"Geist Mono Variable"', "Consolas", "monospace"],
    },
    fontSize: {
      meta: ["12px", "16px"],
      body: ["13px", "18px"],
      section: ["15px", "20px"],
      page: ["20px", "28px"],
    },
    borderRadius: { none: "0", sm: "4px", DEFAULT: "6px", md: "6px", lg: "8px", xl: "12px", full: "9999px" },
    boxShadow: {
      float: "0 12px 32px rgba(0,0,0,.5)",
      none: "none",
    },
    extend: {
      transitionTimingFunction: { out: "cubic-bezier(.2,.7,.2,1)" },
      transitionDuration: { 120: "120ms", 150: "150ms", 180: "180ms" },
    },
  },
  plugins: [],
};
