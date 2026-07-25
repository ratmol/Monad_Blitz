import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    // Node environment: everything under test here is chain and agent logic, none
    // of which touches the DOM. Component tests, if they arrive, get their own project.
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
