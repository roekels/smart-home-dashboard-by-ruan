# Security model

> Outline. Filled in as the modules land.

- **Who gets in:** Cloudflare Access, per person, with a passkey. The Worker checks every request again.
- **Machines:** each uses its own Cloudflare Access service token; edge agents also sign every request.
- **Sensitive data:** Brain's sensitive tier, finance and health are encrypted with keys generated in the admin's
  browser. One key per module. A lost key means lost data.
- **Your AI:** uses a 7-day token for setup only, then a deploy token held by Cloudflare and an optional read-only
  token. It never sees an encryption key.
- **Nothing is deleted:** records are archived.
- **What this does not protect against:** someone who controls your Cloudflare or GitHub account, or your unlocked
  device. Turn on two-factor sign-in for both accounts.
