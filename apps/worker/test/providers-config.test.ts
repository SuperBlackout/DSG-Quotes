import { describe, expect, it } from "vitest";
import { buildProviders, silentLogger } from "../src/config";
import { ConsoleEmailProvider } from "../src/providers/fakes";

describe("buildProviders email selection", () => {
  it("refuses to start in production without a Postmark token", () => {
    expect(() => buildProviders({ NODE_ENV: "production" }, silentLogger)).toThrow(/POSTMARK_SERVER_TOKEN/);
  });
  it("EMAIL_LOG_ONLY=1 lets production start with a log-only email sink", () => {
    const { email } = buildProviders({ NODE_ENV: "production", EMAIL_LOG_ONLY: "1" }, silentLogger);
    expect(email).toBeInstanceOf(ConsoleEmailProvider);
  });
});
