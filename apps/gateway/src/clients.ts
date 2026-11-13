// Which apps may connect. OAuth lets any app register itself, so the redirect address is the gate: access is only
// ever sent to one of these hosts, or to an app on the same computer (loopback).
const HOSTS = /(^|\.)(claude\.ai|claude\.com|chatgpt\.com|openai\.com)$/;

export function allowedRedirect(u: string): boolean {
  try {
    const h = new URL(u);
    if (h.username || h.password) return false;
    return (h.protocol === "https:" && HOSTS.test(h.hostname)) || (h.protocol === "http:" && ["localhost", "127.0.0.1"].includes(h.hostname));
  } catch {
    return false;
  }
}
