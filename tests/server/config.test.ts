import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_PORT, resolveServerPort } from "../../shared/config";

describe("server port configuration", () => {
  it("uses port 8080 by default", () => {
    expect(DEFAULT_SERVER_PORT).toBe(8080);
    expect(resolveServerPort({})).toBe(8080);
  });

  it("allows the Grimoire-specific port to override PORT", () => {
    expect(resolveServerPort({ GRIMOIRE_API_PORT: "8090", PORT: "8085" })).toBe(8090);
    expect(resolveServerPort({ PORT: "8085" })).toBe(8085);
  });

  it("rejects invalid ports before the server starts", () => {
    expect(() => resolveServerPort({ PORT: "not-a-port" })).toThrow("Invalid Grimoire server port");
    expect(() => resolveServerPort({ PORT: "70000" })).toThrow("Invalid Grimoire server port");
  });
});
