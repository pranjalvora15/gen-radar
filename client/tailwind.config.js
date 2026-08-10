export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#F2F3ED",
        paper: "#0E1512",
        cream: "#17211D",
        elevated: "#202D27",
        muted: "#9DACA4",
        moss: "#79B99A",
        acid: "#D9EE7B",
        line: "#304038"
      },
      boxShadow: {
        card: "0 20px 48px rgba(0, 0, 0, 0.28)"
      },
      fontFamily: {
        sans: ["Roboto", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ["Roboto", "ui-sans-serif", "system-ui", "sans-serif"]
      }
    }
  },
  plugins: []
};
