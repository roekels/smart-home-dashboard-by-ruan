// Makes an API key for one of the household's own programs (Alfred, a script). No dependencies.
//   node scripts/new-key.mjs <name> <scope> [<scope> …]
// The key is printed once, on stderr: store it in the password manager and as the secret of the program that uses it.
// The SQL on stdout holds only its SHA-256. Run it against the gateway's D1, for example:
//   node scripts/new-key.mjs alfred household.read > key.sql && npx wrangler d1 execute <prefix>-gateway --remote --file key.sql
import { createHash, randomBytes } from "node:crypto";

const [name, ...scopes] = process.argv.slice(2);
if (!name || !/^[a-z0-9-]{1,32}$/.test(name) || !scopes.length || scopes.some((s) => !/^[a-z][a-z0-9.-]*$/.test(s))) {
  console.error("usage: node scripts/new-key.mjs <name: a-z 0-9 -> <scope> [<scope> …]");
  process.exit(1);
}
const key = `hmcp_${name}_${randomBytes(32).toString("base64url")}`;
const sha = createHash("sha256").update(key).digest("hex");
console.error(`key (shown once, store it now): ${key}`);
console.log(`INSERT INTO api_keys (name, sha256, scopes, created) VALUES ('${name}', '${sha}', '${JSON.stringify(scopes)}', '${new Date().toISOString()}');`);
