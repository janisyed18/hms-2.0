import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CustomerPortalApp } from "./App";
import { MotionProvider } from "./motion/MotionProvider";
import "./styles.css";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/command-centre.css";
import "./styles/interaction.css";
import "./styles/scheduling.css";
import "./styles/responsive.css";
import "./styles/controls.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionProvider>
      <CustomerPortalApp />
    </MotionProvider>
  </StrictMode>
);
