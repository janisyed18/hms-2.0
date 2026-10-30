import "@testing-library/jest-dom/vitest";

// findBy*/waitFor wait up to this long for something that appears after an async step (a lazy workspace, a
// resolved request). The 1s default is shorter than a busy CI runner needs; a wrong result still fails at once.
import { configure } from "@testing-library/react";
configure({ asyncUtilTimeout: 5000 });

// The address bar is shared by every test in a file: each starts at the staff root.
import { afterEach } from "vitest";
afterEach(() => {
  window.history.replaceState(null, "", "/");
});
