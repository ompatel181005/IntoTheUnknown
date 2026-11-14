// DEV ONLY entry (dev.html). Same app, synthetic data source.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../styles/theme.css";
import "../styles/base.css";
import App from "../App";
import { installCatalogFixture } from "./catalogFixture";
import { fixtureSource } from "./fixtureSource";

installCatalogFixture();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App source={fixtureSource} />
  </StrictMode>,
);
