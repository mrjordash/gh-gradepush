import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const LOGIN_TIMEOUT_MS = 10 * 60_000;

function parseJson(contents, message) {
  try { return JSON.parse(contents); } catch { throw new Error(message); }
}

function serverOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Gradepush requires HTTPS, except on localhost");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use the Gradepush server origin without a path, query, or credentials");
  return url.origin;
}

function configFile() {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Gradepush saved-session login requires macOS, Linux, or WSL. Native Windows credential storage is not supported yet.");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "gradepush", "session.json");
}

function privateDirectory(file, create = false) {
  const directory = path.dirname(file);
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error("Gradepush config directory must be owned by you with mode 700");
}

function readSession() {
  const file = configFile();
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  privateDirectory(file);
  if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error("Gradepush session file must be owned by you with mode 600");
  const session = parseJson(fs.readFileSync(file, "utf8"), "Invalid Gradepush session file");
  if (!session || !/^[a-f0-9]{64}$/.test(session.token) || typeof session.server !== "string" || typeof session.expiresAt !== "string" || !Number.isFinite(Date.parse(session.expiresAt))) throw new Error("Invalid Gradepush session file");
  return { ...session, server: serverOrigin(session.server) };
}

function saveSession(session) {
  const file = configFile();
  privateDirectory(file, true);
  const temporary = file + "." + randomBytes(8).toString("hex");
  try {
    fs.writeFileSync(temporary, JSON.stringify(session) + "\n", { mode: 0o600, flag: "wx" });
    // Publish without overwriting a session saved by another login process.
    fs.linkSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function request(server, route, { token, method = "GET", headers = {} } = {}) {
  let response;
  try {
    response = await fetch(new URL(route, serverOrigin(server)), {
      method,
      headers: { ...headers, ...(token ? { Authorization: "Bearer " + token } : {}) },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    let size = 0;
    const chunks = [];
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error("Response too large");
      chunks.push(chunk);
    }
    return { status: response.status, body: Buffer.concat(chunks).toString("utf8") };
  } catch {
    throw new Error("Cannot reach Gradepush or response was unsafe. Check the server URL and connection.");
  }
}

function openBrowser(url) {
  // The browser receives only the signed public challenge, never the CLI secret.
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", shell: false });
  child.on("error", () => {}); // The printed URL remains usable on headless systems.
  child.unref();
}

async function login(server, { browser = true } = {}) {
  const existing = readSession();
  if (existing) throw new Error("A Gradepush session is already saved. Run gh gradepush logout before signing in again.");
  const origin = serverOrigin(server || "https://gradepush.ca");
  const token = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(token).digest("hex");
  const started = await request(origin, "/api/cli/login", { method: "POST", headers: { "X-Gradepush-Challenge": challenge } });
  if (started.status !== 200) throw new Error("Could not start Gradepush sign-in. Check the server and extension versions.");
  const ticket = parseJson(started.body, "Invalid Gradepush login response")?.request;
  if (typeof ticket !== "string" || ticket.length > 256 || !/^[a-zA-Z0-9:._-]+$/.test(ticket)) throw new Error("Invalid Gradepush login response");
  const url = new URL("/cli/login", origin);
  url.searchParams.set("request", ticket);
  process.stdout.write("Open " + url.href + "\nConfirm this code in your browser: " + challenge.slice(0, 8).toUpperCase() + "\n");
  if (browser) openBrowser(url.href);
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await request(origin, "/api/cli/session", { token });
    if (response.status === 200) {
      const account = parseJson(response.body, "Invalid Gradepush session response");
      if (!account || typeof account.login !== "string" || !/^[a-zA-Z0-9-]{1,39}$/.test(account.login) || typeof account.expiresAt !== "string" || !Number.isFinite(Date.parse(account.expiresAt)) || Date.parse(account.expiresAt) <= Date.now()) throw new Error("Invalid Gradepush session response");
      try { saveSession({ server: origin, token, expiresAt: account.expiresAt }); }
      catch (error) {
        await request(origin, "/api/cli/session", { token, method: "DELETE" }).catch(() => {});
        throw error;
      }
      process.stdout.write("Signed in to " + origin + " as " + account.login + ". Session expires " + account.expiresAt + ".\n");
      return;
    }
    if (response.status !== 202) throw new Error("Gradepush sign-in expired or was rejected. Run gh gradepush login again.");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Sign-in timed out. Run gh gradepush login again.");
}

async function logout() {
  const session = readSession();
  if (!session) { process.stdout.write("Already signed out of Gradepush.\n"); return; }
  const response = await request(session.server, "/api/cli/session", { token: session.token, method: "DELETE" });
  if (response.status !== 204) throw new Error("Could not revoke the Gradepush session. Retry gh gradepush logout.");
  fs.unlinkSync(configFile());
  process.stdout.write("Signed out of Gradepush. This CLI session has been revoked.\n");
}

function activeSession() {
  const session = readSession();
  if (!session || Date.parse(session.expiresAt) <= Date.now()) throw new Error("Run gh gradepush login to sign in (logout first if your saved session expired).");
  return session;
}

async function download(target, capabilities = []) {
  const session = activeSession();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(target)) if (value !== undefined) query.set(key, value);
  const headers = capabilities.length ? { "X-Gradepush-Capabilities": capabilities.join(",") } : {};
  const response = await request(session.server, "/api/cli/download?" + query, { token: session.token, headers });
  if (response.status === 401) throw new Error("Gradepush sign-in expired or was revoked. Run gh gradepush logout, then gh gradepush login.");
  if (response.status === 409) throw new Error("More than one classroom matches. Add --workspace <workspace-slug>.");
  if (response.status !== 200) throw new Error("Classroom or assignment unavailable. Check the names and your teaching access in Gradepush.");
  return response.body;
}

const MAX_BUNDLE_BYTES = 250 * 1024 * 1024;
const BUNDLE_TIMEOUT_MS = 5 * 60_000;

// Streams one upload submission's Git bundle to a new private file. The
// credential is sent only to the saved server and never reaches Git.
async function downloadSubmissionBundle(submissionId, file, reserve = () => {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(submissionId)) throw new Error("Invalid submission id");
  const session = activeSession();
  let response;
  try {
    response = await fetch(new URL("/api/cli/submissions/" + submissionId + "/bundle", session.server), {
      headers: { Authorization: "Bearer " + session.token },
      redirect: "error",
      signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Cannot reach Gradepush or response was unsafe. Check the server URL and connection.");
  }
  if (response.status === 401) throw new Error("Gradepush sign-in expired or was revoked. Run gh gradepush logout, then gh gradepush login.");
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("upload download unavailable (HTTP " + response.status + "); check your teaching access in Gradepush");
  }
  // Gradepush states the bundle size in its own header: Content-Length may be
  // removed or changed by a proxy or compression, while fetch decodes the body.
  const declared = Number(response.headers.get("x-gradepush-bundle-size"));
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > MAX_BUNDLE_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new Error("upload download is missing a valid size or exceeds the 250 MiB limit");
  }
  reserve(declared);
  const handle = fs.openSync(file, "wx", 0o600);
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > declared) throw new Error("upload download exceeded its declared size");
      fs.writeSync(handle, chunk);
    }
  } catch (error) {
    throw error instanceof Error && error.message.startsWith("upload download") ? error : new Error("upload download was interrupted; retry the command");
  } finally {
    fs.closeSync(handle);
  }
  if (size !== declared) throw new Error("upload download was incomplete; retry the command");
}

export { serverOrigin, readSession, saveSession, request, login, logout, download, downloadSubmissionBundle };
