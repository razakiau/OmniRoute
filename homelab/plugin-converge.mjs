// Converge OmniRoute plugins to the files Ansible put in the plugins directory
// (ZAC-94). Runs INSIDE the omniroute container on stdin:
//
//   docker exec -i -e PLUGINS="a b" -e MODE=apply omniroute \
//     node --input-type=module - < plugin-converge.mjs
//
// Reads live state from the management API each run and fixes whatever is off,
// so a half-finished earlier run is repaired, not skipped:
//   not registered            -> POST /api/plugins/scan, then activate
//   registered, not active    -> activate
//   active, files newer than  -> deactivate + activate (reload the code)
//     its activatedAt
//   manifest version differs  -> fail: the DB keeps the manifest it scanned,
//     from plugin.json           and the API cannot refresh it in place
//
// Auth: the loopback CLI machine token, the same one the image's own CLI uses.
// It never leaves the container and is never printed.
// Output: one line per plugin; "CHANGED" (apply) or "WOULD" (plan) marks a
// mutation, so Ansible can report changes honestly.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const mode = process.env.MODE === "plan" ? "plan" : "apply";
const names = (process.env.PLUGINS || "").split(/\s+/).filter(Boolean);
const root = "/home/node/.omniroute/plugins";
const base = `http://127.0.0.1:${process.env.PORT || 20128}`;
const CLI_TOKEN_HEADER = "x-omniroute-cli-token";

// 3.8.50 images ship the CLI's helper; 3.8.52 (ZAC-193) no longer copies
// bin/cli/utils into the image, so derive the token the way the server checks
// it (src/lib/machineToken.ts): HMAC-SHA256 keyed by the raw machine id over
// the salt from OMNIROUTE_CLI_SALT, else DATA_DIR/cli-token-salt.json (created
// the same way, with "wx", if the server has not written it yet).
async function cliToken() {
  const legacy = "/app/bin/cli/utils/cliToken.mjs";
  if (existsSync(legacy)) return (await import(legacy)).getCliToken();
  let salt = process.env.OMNIROUTE_CLI_SALT;
  if (!salt) {
    const file = join(process.env.DATA_DIR || "/app/data", "cli-token-salt.json");
    const read = () => {
      try {
        const s = JSON.parse(readFileSync(file, "utf8")).salt;
        return /^[0-9a-f]{64}$/.test(s) ? s : null;
      } catch { return null; }
    };
    salt = read();
    if (!salt) {
      try {
        writeFileSync(file, JSON.stringify({ salt: randomBytes(32).toString("hex") }), { flag: "wx", mode: 0o600 });
      } catch (e) { if (e.code !== "EEXIST") throw e; }
      salt = read();
    }
    if (!salt) throw new Error("no CLI salt in DATA_DIR");
  }
  const mid = createRequire("/app/package.json")("node-machine-id");
  const rawId = (mid.machineIdSync || mid.default?.machineIdSync)(true);
  return rawId ? createHmac("sha256", rawId).update(salt).digest("hex") : "";
}
const token = await cliToken();
if (!token) throw new Error("no CLI token: cannot authenticate to the plugin API");

async function api(method, path) {
  const res = await fetch(base + path, { method, headers: { [CLI_TOKEN_HEADER]: token } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 200) };
}
async function must(method, path) {
  const r = await api(method, path);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${r.text}`);
  return r;
}
const get = async (name) => {
  const r = await api("GET", `/api/plugins/${encodeURIComponent(name)}`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`GET plugin ${name} -> ${r.status} ${r.text}`);
  return r.json.plugin;
};

let failed = false;
for (const name of names) {
  const dir = join(root, name);
  if (!existsSync(join(dir, "plugin.json"))) {
    // Check mode: the copy task has not run, so the files are not there yet.
    if (mode === "plan") { console.log(`${name}: WOULD install (files not deployed yet)`); continue; }
    throw new Error(`${name}: ${dir}/plugin.json missing`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
  const newest = Math.max(...["plugin.json", manifest.main].map((f) => statSync(join(dir, f)).mtimeMs));
  const actions = [];

  let row = await get(name);
  if (!row) {
    actions.push("scan");
    if (mode === "apply") {
      await must("POST", "/api/plugins/scan");
      row = await get(name);
      if (!row) throw new Error(`${name}: scan did not register it (bad plugin.json?)`);
    }
  }
  if (row && row.version !== manifest.version) {
    console.log(`${name}: FAILED registered version ${row.version} != plugin.json ${manifest.version}. ` +
      `DELETE /api/plugins/${name} (removes the directory), then re-run the role.`);
    failed = true;
    continue;
  }
  const active = row && row.status === "active";
  const activatedAt = row && row.activatedAt ? Date.parse(row.activatedAt) : 0;
  if (active && activatedAt < newest) actions.push("reload");
  else if (!active) actions.push("activate");

  if (mode === "apply") {
    if (actions.includes("reload")) await must("POST", `/api/plugins/${encodeURIComponent(name)}/deactivate`);
    if (actions.includes("reload") || actions.includes("activate")) {
      await must("POST", `/api/plugins/${encodeURIComponent(name)}/activate`);
    }
    row = await get(name);
    if (!row || row.status !== "active") {
      console.log(`${name}: FAILED status ${row && row.status} ${row && row.errorMessage ? row.errorMessage : ""}`);
      failed = true;
      continue;
    }
  }
  const marker = actions.length ? (mode === "apply" ? "CHANGED" : "WOULD") : "ok";
  console.log(`${name}: ${marker} ${actions.join("+") || "active"} v${manifest.version}`);
}
process.exit(failed ? 1 : 0);
