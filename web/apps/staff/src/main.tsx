import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { MotionProvider } from "./motion/MotionProvider";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <MotionProvider>
      <App />
    </MotionProvider>
  </StrictMode>
);
