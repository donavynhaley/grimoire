/** Validates the public site identifier before it can enter an HTML attribute. */
export function demoAnalyticsToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  if (!token) return undefined;
  if (!/^[a-f0-9]{32}$/i.test(token)) {
    throw new Error("GRIMOIRE_DEMO_ANALYTICS_TOKEN must be a 32-character hexadecimal site token");
  }
  return token;
}

/** Measures document visits only; editing the demo must not emit virtual page views. */
export function demoAnalyticsScript(token: string): string {
  return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${JSON.stringify({ token, spa: false })}'></script>`;
}
