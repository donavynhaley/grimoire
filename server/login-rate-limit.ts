import type { IncomingMessage } from "node:http";

/**
 * How many sign-in failures a password form may produce before it has to wait.
 *
 * Two buckets answer two different questions, and they are deliberately not the same size.
 * The address bucket is the tight one: it is the only thing between an installation and
 * somebody working through a password list, and a person who genuinely mistypes their own
 * password six times in a minute is rare enough to be asked to pause. The account bucket is
 * the loose one, because it is the bucket an attacker can aim: anyone who knows a colleague's
 * email can spend that colleague's allowance on purpose, and a lockout cheap enough to trip
 * is a way to keep somebody out of their own board. It blunts a slow spread across many
 * source addresses; it is not the wall.
 */
export const LOGIN_ADDRESS_BURST = 6;
export const LOGIN_ADDRESS_PER_MINUTE = 6;
export const LOGIN_ACCOUNT_BURST = 20;
export const LOGIN_ACCOUNT_PER_MINUTE = 10;

/**
 * The most keys kept before refilled ones are dropped.
 *
 * Unlike an agent credential, the key here is chosen by whoever is knocking - a fresh email
 * or a fresh source address on every request would otherwise grow this map for as long as the
 * process runs. A bucket that has refilled completely is indistinguishable from one that was
 * never created, so those are the ones the sweep takes.
 */
const MAX_TRACKED_KEYS = 10_000;

type Bucket = { tokens: number; updatedAt: number };

/**
 * Failure-counting token buckets for the password form.
 *
 * Only failures spend allowance. Somebody signing in correctly is never turned away for having
 * signed in a moment ago, which is what separates this from metering the route: the thing being
 * rationed is guesses, and a right answer is not a guess.
 *
 * The counts are held in memory on purpose, exactly as agent write limits are. Persisting them
 * would mean a disk write per failed password, and what this prevents is a run of guesses
 * against a process that is up, not a patient attacker who can wait out a restart.
 */
export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limits: { burst: number; perMinute: number },
    private readonly maxKeys = MAX_TRACKED_KEYS,
  ) {}

  /** What a key would have right now, without spending any of it. */
  private refill(key: string, now: number): Bucket {
    const bucket = this.buckets.get(key) ?? { tokens: this.limits.burst, updatedAt: now };
    // Wall time steps backwards under NTP corrections and snapshot restores, and a negative
    // elapsed term would hold a bucket empty for the length of the step - which here means
    // locking people out of their own instance because the clock moved.
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const tokens = Math.min(this.limits.burst, bucket.tokens + elapsed * (this.limits.perMinute / 60_000));
    return { tokens, updatedAt: now };
  }

  /** Whether an attempt may be made at all, without counting it as one. */
  allows(key: string, now = Date.now()): boolean {
    return this.refill(key, now).tokens >= 1;
  }

  /** How long until this key is owed one more attempt, in whole seconds. */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const { tokens } = this.refill(key, now);
    if (tokens >= 1) return 0;
    return Math.max(1, Math.ceil(((1 - tokens) / this.limits.perMinute) * 60));
  }

  /** Charges one failed attempt against a key. */
  spend(key: string, now = Date.now()): void {
    const bucket = this.refill(key, now);
    this.buckets.set(key, { tokens: Math.max(0, bucket.tokens - 1), updatedAt: now });
    this.sweep(now);
  }

  /** Forgets a key entirely, which is what a correct password earns. */
  forget(key: string): void {
    this.buckets.delete(key);
  }

  /** How many keys are being remembered, so the sweep can be tested rather than trusted. */
  get tracked(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    if (this.buckets.size <= this.maxKeys) return;
    for (const key of [...this.buckets.keys()]) {
      if (this.refill(key, now).tokens >= this.limits.burst) this.buckets.delete(key);
    }
    // Still over the cap means every entry is live, which is the shape of an attack rather
    // than of use. The least recently touched go first, being the closest to refilled anyway.
    if (this.buckets.size > this.maxKeys) {
      const ordered = [...this.buckets].sort((left, right) => left[1].updatedAt - right[1].updatedAt);
      for (const [key] of ordered.slice(0, this.buckets.size - this.maxKeys)) this.buckets.delete(key);
    }
  }
}

/**
 * Who is knocking, for rate limiting purposes.
 *
 * A forwarded header is believed only when the operator says something in front of Grimoire is
 * writing it. Believing it unasked would make the limit free to step around - anyone may claim
 * any address - and never believing it would collapse every visitor behind a tunnel or a reverse
 * proxy into a single bucket, where the first person to mistype their password locks out the
 * rest of the team.
 */
export function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = header?.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? "unknown";
}
