import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/theme.css";
import "./styles/base.css";
import App from "./App";
import { apiSource } from "./data/source";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App source={apiSource} />
  </StrictMode>,
);
