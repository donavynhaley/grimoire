import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "../../server/login-rate-limit";
import { bootstrap, ownerAccount, startTestServer } from "./test-server";

/** One wrong guess at the owner's password, from a stated source address. */
function guess(
  server: Awaited<ReturnType<typeof startTestServer>>,
  address: string,
  password = "not the password",
) {
  return server.fetchRaw("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify({ email: ownerAccount.email, password }),
  });
}

describe("login rate limiting", () => {
  it("refuses further guesses from an address that has run out, and says how long to wait", async () => {
    const server = await startTestServer(undefined, { trustProxy: true });
    await bootstrap(server);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      statuses.push((await guess(server, "203.0.113.7")).status);
    }

    expect(statuses.slice(0, 6)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(statuses.slice(6)).toEqual([429, 429]);

    const refused = await guess(server, "203.0.113.7");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts guesses against the address they came from, not the whole installation", async () => {
    const server = await startTestServer(undefined, { trustProxy: true });
    await bootstrap(server);

    for (let attempt = 0; attempt < 8; attempt += 1) await guess(server, "203.0.113.7");
    expect((await guess(server, "203.0.113.7")).status).toBe(429);

    // A colleague behind the same tunnel is a different person and keeps their own allowance.
    expect((await guess(server, "198.51.100.4")).status).toBe(401);
  });

  it("still lets the right password through, and forgets the wrong ones it followed", async () => {
    const server = await startTestServer(undefined, { trustProxy: true });
    await bootstrap(server);
    await server.request("/api/auth/logout", { method: "POST" });

    for (let attempt = 0; attempt < 5; attempt += 1) await guess(server, "203.0.113.7");

    const signedIn = await server.request<{ user: { email: string } }>("/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ email: ownerAccount.email, password: ownerAccount.password }),
    });
    expect(signedIn.response.status).toBe(200);

    // Five wrong answers before a right one leave nothing owed, so the next mistake is cheap.
    expect((await guess(server, "203.0.113.7")).status).toBe(401);
  });

  it("ignores a forwarded address nobody said to trust", async () => {
    const server = await startTestServer();
    await bootstrap(server);

    // Every request claims a fresh address, and every one of them is counted as the socket
    // it actually arrived on, so the allowance still runs out.
    for (let attempt = 0; attempt < 8; attempt += 1) await guess(server, `203.0.113.${attempt}`);
    expect((await guess(server, "203.0.113.200")).status).toBe(429);
  });

  it("refills over time and survives a clock that steps backwards", () => {
    const limiter = new LoginRateLimiter({ burst: 2, perMinute: 60 });
    const start = 1_000_000;

    limiter.spend("someone", start);
    limiter.spend("someone", start);
    expect(limiter.allows("someone", start)).toBe(false);
    expect(limiter.retryAfterSeconds("someone", start)).toBe(1);

    // A second later one guess is owed again.
    expect(limiter.allows("someone", start + 1000)).toBe(true);

    // An NTP correction or a restored snapshot must not hold the bucket empty for the
    // length of the step; it simply does not refill while the clock is behind.
    limiter.spend("someone", start + 1000);
    expect(limiter.allows("someone", start - 60_000)).toBe(false);
  });

  it("drops keys that have refilled rather than remembering every address that ever knocked", () => {
    const limiter = new LoginRateLimiter({ burst: 1, perMinute: 60 }, 4);
    const start = 1_000_000;
    // The key is whatever the caller claims to be, so fifty of them is a rotation rather than
    // fifty people, and a map that kept them all would grow for as long as the process ran.
    for (let index = 0; index < 50; index += 1) limiter.spend(`address-${index}`, start + index * 5_000);

    expect(limiter.tracked).toBeLessThanOrEqual(5);
    expect(limiter.allows("address-0", start + 250_000)).toBe(true);
  });

  it("keeps the cap even when every key it holds is still spent", () => {
    const limiter = new LoginRateLimiter({ burst: 1, perMinute: 60 }, 4);
    const start = 1_000_000;
    // All at one instant, so nothing has refilled and there is nothing cheap to drop. The
    // cap still holds, because the alternative is letting a flood decide how much is kept.
    for (let index = 0; index < 20; index += 1) limiter.spend(`address-${index}`, start);

    expect(limiter.tracked).toBe(4);
    // The most recent guesser is one of the ones still being counted.
    expect(limiter.allows("address-19", start)).toBe(false);
  });
});
