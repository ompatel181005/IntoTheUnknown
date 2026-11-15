import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../styles/theme.css";
import "../styles/base.css";
import { LearnPage } from "./LearnPage";

createRoot(document.getElementById("root")!).render(<StrictMode><LearnPage /></StrictMode>);
