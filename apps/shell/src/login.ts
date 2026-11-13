// /login: the public sign-in page. No script at all. "Sign in" opens /home, where Cloudflare Access asks for the
// email and passkey. Everything it loads sits under /login/, so one Access bypass covers it.
import type { Household } from "../../../packages/core/src/household.ts";
import { esc, securityHeaders } from "../../../packages/core/src/util.ts";

export function loginPage(h: Household, demo = false): Response {
  const name = esc(h.household);
  const body = `<!doctype html>
<html lang="${esc(h.language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex">
  <title>Sign in · ${name}</title>
  <meta name="description" content="${name}: a private home dashboard. Sign in to open.">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${name}">
  <meta property="og:description" content="A private home dashboard. Sign in to open.">
  <meta name="theme-color" content="#0c0e13">
  <link rel="apple-touch-icon" href="/login/icon-180.png">
  <link rel="icon" href="/login/mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/login/login.css">
</head>
<body>
  <main class="login">
    <img class="login__logo" src="/login/mark.svg" alt="" width="72" height="72">
    <h1>${name}</h1>
    <p class="login__sub">Home</p>
    <a class="login__btn" href="/home">${demo ? "Open the demo" : "Sign in"}</a>
    <p class="login__fine">${demo
      ? "Demo mode: a made-up family with made-up data. Nothing here is real."
      : "For this household only. You sign in with your email, then your passkey."}</p>
  </main>
</body>
</html>`;
  return new Response(body, {
    headers: { ...securityHeaders("'none'"), "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
