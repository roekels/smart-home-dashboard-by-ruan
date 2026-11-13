// Access policies: one per application, made and kept current by the setup.
// An application for people names their emails. An application for machines names the exact service tokens that
// may pass, never "any valid service token": a token made for one door must not open another.
//   - tokens the setup makes (a module file's serviceTokens with "for" pointing at the application);
//   - for a serviceAuthPaths application also every token named <prefix>-agent-<machine>, which is how a
//     machine's own token is named.
// Until at least one such token exists the application has no policy, and Access lets nobody through.

/** The policy's include list for an application, given the account's service tokens. Empty = no policy yet. */
export function includeFor(a, tokens) {
  if (!a.tokens) return a.policy.include;
  return tokens
    .filter((t) => a.tokens.names.includes(t.name) || (a.tokens.prefix && t.name.startsWith(a.tokens.prefix)))
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((t) => ({ service_token: { token_id: t.id } }));
}

/** Makes the application's one policy match. `actions` gets what was done, in words. */
export async function syncPolicy({ cf, acct, app, a, tokens, actions }) {
  const policies = app.id === "dry-run" ? [] : await cf.list(`${acct}/access/apps/${app.id}/policies`);
  const mine = policies.find((p) => p.name === a.policy.name);
  const include = includeFor(a, tokens);
  for (const p of policies.filter((p) => p.name !== a.policy.name)) actions.push(`  note: policy "${p.name}" was not made by this setup and was left alone (${a.name})`);
  if (!include.length) {
    if (mine) { await cf.del(`${acct}/access/apps/${app.id}/policies/${mine.id}`); actions.push(`  remove policy "${a.policy.name}" from ${a.name}: its service tokens are gone, so nobody gets through`); }
    else actions.push(`  ${a.name} has no policy yet: closed to everyone until its service token exists`);
    return;
  }
  const want = { name: a.policy.name, decision: a.policy.decision, include };
  if (!mine) { await cf.post(`${acct}/access/apps/${app.id}/policies`, want); actions.push(`  add policy "${a.policy.name}" (${a.policy.decision}) to ${a.name}`); }
  else if (JSON.stringify(mine.include) !== JSON.stringify(include) || mine.decision !== a.policy.decision) {
    await cf.put(`${acct}/access/apps/${app.id}/policies/${mine.id}`, want);
    actions.push(`  update policy "${a.policy.name}" on ${a.name}`);
  }
}
