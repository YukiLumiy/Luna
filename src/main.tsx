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
import { Popup } from "./components/Popup";
import { applyTheme } from "./theme";

// The game card is a second, tiny window running this same page; Luna hands it its data first.
const popup = window.__LUNA_POPUP__;
if (popup) {
  applyTheme(popup.theme);
  document.documentElement.classList.add("popup-page");
} else {
  initSmoothScroll();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>{popup ? <Popup data={popup} /> : <App />}</ErrorBoundary>
  </React.StrictMode>,
);
