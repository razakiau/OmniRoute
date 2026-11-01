/**
 * Homelab (ZAC-267): a keep-warm ping that names the connection it must use.
 *
 * The keep-warm plugin replays a chat's last request just before its prompt
 * cache expires. The cache is per account, so the ping must reach the exact
 * connection that served the chat, and only that one. Such a request skips the
 * model→combo mapping (a combo would fail over on the ping's empty answer and
 * log a 502) and never revives an inactive connection.
 *
 * Both headers are required: `x-omniroute-connection` alone keeps upstream's
 * meaning, and the marker alone is an unpinned ping.
 */
export const KEEPWARM_MARKER_HEADER = "x-omniroute-keepwarm";
export const CONNECTION_HEADER = "x-omniroute-connection";

export function pinnedKeepWarmConnection(headers: Headers | null | undefined): string | null {
  if (!headers || !headers.get(KEEPWARM_MARKER_HEADER)) return null;
  const id = headers.get(CONNECTION_HEADER)?.trim();
  return id ? id : null;
}
