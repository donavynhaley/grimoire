export const DEFAULT_SERVER_PORT = 8080;

export function resolveServerPort(environment: Record<string, string | undefined>): number {
  const configured = environment.GRIMOIRE_API_PORT ?? environment.PORT;
  if (configured === undefined) return DEFAULT_SERVER_PORT;

  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`Invalid Grimoire server port: ${configured}`);
  }
  return port;
}
