import "@testing-library/jest-dom/vitest";

// The address bar is shared by every test in a file: each starts at the staff root.
import { afterEach } from "vitest";
afterEach(() => {
  window.history.replaceState(null, "", "/");
});
