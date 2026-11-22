import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./palettes"; // applies the saved palette before the first paint
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/motion.css";
import "./styles/themes.css";
import "./styles/palettes.css";
import { initSmoothScroll } from "./smoothScroll";

initSmoothScroll();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
