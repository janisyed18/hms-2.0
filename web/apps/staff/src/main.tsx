import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { MotionProvider } from "./motion/MotionProvider";
import "./styles.css";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/command-centre.css";
import "./styles/responsive.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <MotionProvider>
      <App />
    </MotionProvider>
  </StrictMode>
);
