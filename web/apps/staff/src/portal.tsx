import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CustomerPortalApp } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CustomerPortalApp />
  </StrictMode>
);
