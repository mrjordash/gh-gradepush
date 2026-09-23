import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createServer } from "node:http";
import { request as gradepushRequest, readSession, saveSession } from "./cli-auth.mjs";

const extensionRoot = path.resolve("tools/gh-gradepush");
const cli = path.join(extensionRoot, "gh-gradepush");
const sha = "a".repeat(40);

function cloneManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-30T12:00:00Z",
    classroom: { id: "classroom-1", name: "Programming 1", slug: "programming-1" },
    assignments: [{
      id: "assignment-1",
      title: "Loops",
      slug: "loops",
      submissions: [{
        student: { login: "ada", identifier: "student-1" },
        source: "github",
        repoFullName: "school/loops-ada",
        lastSyncedSha: sha,
      }],
    }],
    ...overrides,
  };
}

function folder(assignment, submission) {
  const suffix = createHash("sha256")
    .update(assignment.id + "\0" + (submission.student.identifier || "") + "\0" + submission.repoFullName)
    .digest("hex")
    .slice(0, 12);
  const identifier = submission.student.identifier === null
    ? ""
    : submission.student.identifier
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
  return (identifier ? identifier + "-" : "") + submission.student.login.toLowerCase() + "--" + suffix;
}

function fixture() {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "gh-gradepush-"));
  const bin = path.join(temporary, "bin");
  const log = path.join(temporary, "commands.jsonl");
  mkdirSync(bin);
  const fake = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    "const name = path.basename(process.argv[1]);",
    "const args = process.argv.slice(2);",
    'const log = path.join(process.env.TMPDIR, "commands.jsonl");',
    'fs.appendFileSync(log, JSON.stringify({ name, args, environment: { lfs: process.env.GIT_LFS_SKIP_SMUDGE, gitPrompt: process.env.GIT_TERMINAL_PROMPT, ghPrompt: process.env.GH_PROMPT_DISABLED, path: process.env.PATH, home: process.env.HOME, user: process.env.USER, lang: process.env.LANG } }) + "\\n");',
    'if (args[0] === "--version") { console.log(name + " fake"); process.exit(0); }',
    'if (name === "gh") {',
    '  if (args[0] === "api") {',
    '    if (fs.existsSync(path.join(process.env.TMPDIR, "hang-api"))) { setInterval(() => {}, 1000); return; }',
    '    if (fs.existsSync(path.join(process.env.TMPDIR, "hang-api-with-child"))) {',
    '      const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    '      fs.writeFileSync(path.join(process.env.TMPDIR, "hanging-child-pid"), String(child.pid));',
    '      setInterval(() => {}, 1000);',
    '      return;',
    '    }',
    '    const sizeFile = path.join(process.env.TMPDIR, "api-size");',
    '    process.stdout.write(fs.existsSync(sizeFile) ? fs.readFileSync(sizeFile, "utf8") : "1\\n");',
    '    process.exit(0);',
    '  }',
    '  if (args[0] === "repo" && args[1] === "clone") {',
    "    const repo = args[2], destination = args[3];",
    '    if (!fs.existsSync(path.dirname(destination))) { console.error("parent was not created"); process.exit(91); }',
    "    fs.mkdirSync(destination);",
    '    fs.mkdirSync(path.join(destination, ".git"));',
    '    fs.writeFileSync(path.join(destination, ".origin"), "https://github.com/" + repo + ".git\\n");',
    "  }",
    "  process.exit(0);",
    "}",
    'if (args[0] === "-C") {',
    "  const destination = args[1], command = args.slice(2);",
    '  if (command[0] === "rev-parse") {',
    '    if (!fs.existsSync(path.join(destination, ".git"))) process.exit(1);',
    '    console.log("true");',
    '  } else if (command[0] === "remote") {',
    '    process.stdout.write(fs.readFileSync(path.join(destination, ".origin"), "utf8"));',
    '  } else if (command[0] === "status") {',
    '    if (fs.existsSync(path.join(destination, ".dirty"))) process.stdout.write(" M assignment.js\\n");',
    '  } else if (command[0] === "symbolic-ref") {',
    '    console.log("origin/main");',
    "  }",
    "}",
  ].join("\n");
  for (const name of ["gh", "git"]) {
    const executable = path.join(bin, name);
    writeFileSync(executable, fake);
    chmodSync(executable, 0o755);
  }
  return {
    temporary,
    commands() {
      return existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
    },
    run(args, extraEnvironment = {}) {
      return spawnSync(process.execPath, [cli, ...args], {
        cwd: temporary,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          HOME: path.join(temporary, "home"),
          XDG_CONFIG_HOME: path.join(temporary, "config"),
          USER: "gradepush-test",
          LANG: "en_CA.UTF-8",
          TMPDIR: temporary,
          ...extraEnvironment,
        },
      });
    },
    writeManifest(value) {
      const manifestPath = path.join(temporary, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(value));
      return manifestPath;
    },
    cleanup() { rmSync(temporary, { recursive: true, force: true }); },
  };
}

test("shows help and version without needing gh or git", () => {
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /gh gradepush clone/);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), "1.1.0");
});

test("empty classrooms complete without running Git or creating destination directories", () => {
  const f = fixture();
  try {
    const result = f.run(["clone", f.writeManifest(cloneManifest({ assignments: [] }))]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No assignments/);
    assert.equal(f.commands().length, 0);
    assert.equal(existsSync(path.join(f.temporary, "gradepush-submissions")), false);
  } finally { f.cleanup(); }
});

test("saved-session login fails closed on unsupported native Windows storage", () => {
  const f = fixture();
  try {
    const preload = path.join(f.temporary, "windows.cjs");
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32' });");
    const result = f.run(["login", "--no-browser"], { NODE_OPTIONS: `--require=${preload}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /macOS, Linux, or WSL/);
    assert.equal(existsSync(path.join(f.temporary, "config")), false);
  } finally { f.cleanup(); }
});

test("browser sign-in persists a private credential, named downloads reuse it, and logout revokes it", () => {
  const f = fixture();
  try {
    const preload = path.join(f.temporary, "login-fetch.cjs");
    const tokenRecord = path.join(f.temporary, "test-token");
    const sessionFile = path.join(f.temporary, "config", "gradepush", "session.json");
    writeFileSync(preload, `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      let challenge;
      global.fetch = async (url, options) => {
        assert.equal(url.origin, 'https://school.example');
        assert.equal(options.redirect, 'error');
        if (url.pathname === '/api/cli/login') {
          challenge = options.headers['X-Gradepush-Challenge'];
          assert.match(challenge, /^[a-f0-9]{64}$/);
          return Response.json({ request: 'cli-login:' + challenge + '.123.test' });
        }
        const token = options.headers.Authorization.slice(7);
        if (url.pathname === '/api/cli/session' && options.method === 'GET') {
          assert.equal(require('node:crypto').createHash('sha256').update(token).digest('hex'), challenge);
          fs.writeFileSync(${JSON.stringify(tokenRecord)}, token);
          return Response.json({ login: 'teacher', expiresAt: '2099-01-01T00:00:00.000Z' });
        }
        assert.equal(token, fs.readFileSync(${JSON.stringify(tokenRecord)}, 'utf8'));
        if (url.pathname === '/api/cli/session' && options.method === 'DELETE') return new Response(null, { status: 204 });
        assert.equal(url.pathname, '/api/cli/download');
        assert.equal(url.searchParams.get('organization'), 'school');
        assert.equal(url.searchParams.get('classroom'), 'programming-1');
        assert.equal(url.searchParams.get('assignment'), 'loops');
        assert.equal(url.searchParams.get('workspace'), 'staff');
        return Response.json(${JSON.stringify(cloneManifest())});
      };
    `);
    const environment = { NODE_OPTIONS: `--require=${preload}` };
    const loginResult = f.run(["login", "--server", "https://school.example", "--no-browser"], environment);
    assert.equal(loginResult.status, 0, loginResult.stderr);
    assert.match(loginResult.stdout, /Confirm this code/);
    assert.match(loginResult.stdout, /Signed in/);
    const token = readFileSync(tokenRecord, "utf8");
    assert.ok(!loginResult.stdout.includes(token));
    assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(sessionFile)).mode & 0o777, 0o700);
    const downloaded = f.run(["download", "school", "programming-1", "loops", "--workspace", "staff"], environment);
    assert.equal(downloaded.status, 0, downloaded.stderr);
    assert.match(downloaded.stdout, /1 cloned/);
    assert.ok(!JSON.stringify(f.commands()).includes(token));
    const loggedOut = f.run(["logout"], environment);
    assert.equal(loggedOut.status, 0, loggedOut.stderr);
    assert.equal(existsSync(sessionFile), false);
    assert.equal(f.run(["download", "school", "programming-1"]).status, 1);
  } finally { f.cleanup(); }
});

test("refuses unsafe sign-in hosts and malformed named download arguments", () => {
  const f = fixture();
  try {
    for (const server of ["http://school.example", "https://user:secret@school.example", "https://school.example/other", "https://school.example?x=y"]) {
      const result = f.run(["login", "--server", server, "--no-browser"]);
      assert.equal(result.status, 1);
      assert.ok(!result.stderr.includes("secret"));
    }
    assert.equal(f.run(["download", "school", "../bad"]).status, 1);
    assert.equal(f.run(["download", "school"]).status, 64);
    assert.equal(f.run(["download", "school", "class", "--workspace"]).status, 64);
    assert.equal(f.commands().length, 0);
  } finally { f.cleanup(); }
});

function savedSession(f) {
  const directory = path.join(f.temporary, "config", "gradepush");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "session.json");
  writeFileSync(file, JSON.stringify({ server: "https://school.example", token: "a".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" }), { mode: 0o600 });
  return file;
}

test("requires private session storage and retains credentials when server revocation fails", () => {
  const f = fixture();
  try {
    const file = savedSession(f);
    chmodSync(file, 0o644);
    const unsafe = f.run(["download", "school", "class"]);
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /mode 600/);
    chmodSync(file, 0o600);
    const preload = path.join(f.temporary, "failed-fetch.cjs");
    writeFileSync(preload, "global.fetch = async () => new Response('{}', { status: 503 });");
    const failed = f.run(["logout"], { NODE_OPTIONS: `--require=${preload}` });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Could not revoke/);
    assert.equal(existsSync(file), true);
    assert.equal(f.commands().length, 0);
  } finally { f.cleanup(); }
});

test("handles revoked, ambiguous and oversized named downloads without cloning or exposing secrets", () => {
  const f = fixture();
  try {
    savedSession(f);
    const preload = path.join(f.temporary, "denied-fetch.cjs");
    for (const [status, expected] of [[401, /revoked/], [409, /--workspace/], [404, /unavailable/], [200, /unsafe/]]) {
      writeFileSync(preload, `global.fetch = async () => new Response(${status === 200 ? "'x'.repeat(1024 * 1024 + 1)" : "'{}'"}, { status: ${status} });`);
      const result = f.run(["download", "school", "class"], { NODE_OPTIONS: `--require=${preload}` });
      assert.equal(result.status, 1);
      assert.match(result.stderr, expected);
      assert.ok(!result.stderr.includes("a".repeat(64)));
    }
    assert.equal(f.commands().length, 0);
  } finally { f.cleanup(); }
});

test("HTTP transport refuses redirects instead of forwarding the credential", async () => {
  let forwarded = false;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/secret" }); res.end(); }
    else { forwarded = true; res.end("{}"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(gradepushRequest(`http://127.0.0.1:${server.address().port}`, "/redirect", { token: "a".repeat(64) }), /unsafe/);
    assert.equal(forwarded, false);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("session publication never overwrites another login and malformed storage errors redact credentials", () => {
  const f = fixture();
  const oldConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(f.temporary, "config");
  try {
    const session = { server: "https://school.example", token: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" };
    saveSession(session);
    assert.throws(() => saveSession({ ...session, token: "c".repeat(64) }), { code: "EEXIST" });
    assert.equal(readSession().token, session.token);
    writeFileSync(path.join(process.env.XDG_CONFIG_HOME, "gradepush", "session.json"), '{"token":"' + session.token);
    assert.throws(() => readSession(), { message: "Invalid Gradepush session file" });
  } finally {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfigHome;
    f.cleanup();
  }
});

test("fetches a scoped clone URL with a bearer header, without persisting its credential", () => {
  const f = fixture();
  try {
    const preload = path.join(f.temporary, "fetch.cjs");
    writeFileSync(preload, `global.fetch = async (url, options) => {
      require('node:assert/strict').equal(String(url), 'https://gradepush.example/api/cli/clone');
      require('node:assert/strict').equal(options.headers.Authorization, 'Bearer scoped-test-ticket');
      require('node:assert/strict').equal(options.redirect, 'error');
      return new Response(${JSON.stringify(JSON.stringify(cloneManifest()))});
    };`);
    const result = f.run(["clone", "https://gradepush.example/api/cli/clone#scoped-test-ticket"], { NODE_OPTIONS: `--require=${preload}` });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 cloned/);
    assert.ok(!JSON.stringify(f.commands()).includes("scoped-test-ticket"));
    assert.ok(!(result.stdout + result.stderr).includes("scoped-test-ticket"));
  } finally { f.cleanup(); }
});

test("rejects insecure remote clone URLs and unexpected endpoints before using GitHub", () => {
  const f = fixture();
  try {
    for (const url of ["http://school.example/api/cli/clone#ticket", "https://school.example/other#ticket", "https://user:password@school.example/api/cli/clone#ticket"]) {
      const result = f.run(["clone", url]);
      assert.equal(result.status, 1);
      assert.equal(f.commands().length, 0);
      assert.ok(!result.stderr.includes("password"));
    }
  } finally { f.cleanup(); }
});

test("reports expired clone access without exposing the credential", () => {
  const f = fixture();
  try {
    const preload = path.join(f.temporary, "fetch.cjs");
    writeFileSync(preload, "global.fetch = async () => new Response('{}', { status: 401 });");
    const result = f.run(["clone", "https://school.example/api/cli/clone#private-ticket"], { NODE_OPTIONS: `--require=${preload}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Generate a new command/);
    assert.ok(!result.stderr.includes("private-ticket"));
    assert.equal(f.commands().length, 0);
  } finally { f.cleanup(); }
});

test("clones GitHub submissions into a deterministic safe hierarchy at the recorded SHA", () => {
  const testFixture = fixture();
  try {
    const value = cloneManifest();
    const result = testFixture.run(["clone", testFixture.writeManifest(value)]);
    const submission = value.assignments[0].submissions[0];
    const destination = path.join(testFixture.temporary, "gradepush-submissions", "programming-1", "loops", folder(value.assignments[0], submission));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(destination, ".git")), true);
    assert.match(result.stdout, /checked out a{40}/);
    const clone = testFixture.commands().find((entry) => entry.name === "gh" && entry.args[0] === "repo").args;
    assert.deepEqual(clone.slice(0, 3), ["repo", "clone", "school/loops-ada"]);
    assert.deepEqual(clone.slice(4), ["--", "--filter=blob:none"]);
    assert.equal(path.basename(clone[3]), path.basename(destination));
    assert.equal(existsSync(path.join(clone[3], ".git")), true);
    assert.equal(testFixture.commands().some((entry) => entry.name === "git" && entry.args.includes("--detach") && entry.args.includes(sha)), true);
    for (const command of testFixture.commands()) {
      assert.equal(command.environment.lfs, "1");
      assert.equal(command.environment.gitPrompt, "0");
      assert.equal(command.environment.ghPrompt, "1");
      assert.match(command.environment.path, /bin/);
      assert.equal(command.environment.home, path.join(testFixture.temporary, "home"));
      assert.equal(command.environment.user, "gradepush-test");
      assert.equal(command.environment.lang, "en_CA.UTF-8");
    }
  } finally {
    testFixture.cleanup();
  }
});

test("skips an unsynchronized GitHub submission by default without cloning it", () => {
  const testFixture = fixture();
  try {
    const value = cloneManifest();
    value.assignments[0].submissions[0].lastSyncedSha = null;
    const result = testFixture.run(["clone", testFixture.writeManifest(value)]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no recorded sync SHA; rerun with --latest/);
    assert.match(result.stdout, /0 cloned, 1 skipped, 0 failed/);
    assert.equal(testFixture.commands().some((entry) => entry.name === "gh" && entry.args[0] === "repo"), false);
  } finally {
    testFixture.cleanup();
  }
});

test("uses latest only when explicitly requested for an unsynchronized GitHub submission", () => {
  const testFixture = fixture();
  try {
    const value = cloneManifest();
    value.assignments[0].submissions[0].lastSyncedSha = null;
    value.assignments[0].submissions[0].student.identifier = null;
    value.assignments[0].submissions.push({
      student: { login: "grace", identifier: "student-2" },
      source: "upload",
    });
    const result = testFixture.run(["clone", testFixture.writeManifest(value), "--latest"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cloned latest default branch/);
    assert.match(result.stdout, /upload-backed submissions cannot be cloned/);
    assert.match(result.stdout, /1 cloned, 1 skipped, 0 failed/);
    assert.equal(testFixture.commands().some((entry) => entry.args.includes("--detach")), false);
    const clone = testFixture.commands().find((entry) => entry.name === "gh" && entry.args[0] === "repo");
    assert.match(path.basename(clone.args[3]), /^ada--[0-9a-f]{12}$/);
  } finally {
    testFixture.cleanup();
  }
});

test("rejects malicious repository and path values before invoking gh or git", () => {
  const testFixture = fixture();
  try {
    const maliciousRepo = cloneManifest();
    maliciousRepo.assignments[0].submissions[0].repoFullName = "school/repo;touch-owned";
    let result = testFixture.run(["clone", testFixture.writeManifest(maliciousRepo)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /owner\/repository GitHub full name/);
    assert.deepEqual(testFixture.commands(), []);

    const maliciousPath = cloneManifest();
    maliciousPath.classroom.slug = "../outside";
    result = testFixture.run(["clone", testFixture.writeManifest(maliciousPath)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /classroom\.slug must be a lowercase URL slug/);
    assert.deepEqual(testFixture.commands(), []);

    const retiredStudentField = cloneManifest();
    retiredStudentField.assignments[0].submissions[0].student.displayName = "Ada Lovelace";
    result = testFixture.run(["clone", testFixture.writeManifest(retiredStudentField)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /student has unexpected or missing fields/);
    assert.deepEqual(testFixture.commands(), []);
  } finally {
    testFixture.cleanup();
  }
});

test("rejects unused identity and repository fields in the strict manifest schema", () => {
  const testFixture = fixture();
  try {
    const displayName = cloneManifest();
    displayName.assignments[0].submissions[0].student.displayName = "Ada Lovelace";
    let result = testFixture.run(["clone", testFixture.writeManifest(displayName)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /student has unexpected or missing fields/);

    const uploadFields = cloneManifest();
    uploadFields.assignments[0].submissions[0] = {
      student: { login: "ada", identifier: "student-1" },
      source: "upload",
      repoFullName: "school/loops-ada",
    };
    result = testFixture.run(["clone", testFixture.writeManifest(uploadFields)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not contain repository fields for an upload submission/);
    assert.deepEqual(testFixture.commands(), []);
  } finally {
    testFixture.cleanup();
  }
});

test("rejects an oversized declared repository before any clone starts", () => {
  const testFixture = fixture();
  try {
    writeFileSync(path.join(testFixture.temporary, "api-size"), "256001\n");
    const result = testFixture.run(["clone", testFixture.writeManifest(cloneManifest())]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /school\/loops-ada exceeds the 250 MiB repository limit/);
    assert.equal(testFixture.commands().some((entry) => entry.name === "gh" && entry.args[0] === "repo"), false);
  } finally {
    testFixture.cleanup();
  }
});

test("rejects an aggregate declared size above 5 GiB before any clone starts", () => {
  const testFixture = fixture();
  try {
    const value = cloneManifest();
    for (let index = 2; index <= 21; index += 1) {
      value.assignments[0].submissions.push({
        student: { login: "student" + index, identifier: "student-" + index },
        source: "github",
        repoFullName: "school/loops-student" + index,
        lastSyncedSha: sha,
      });
    }
    writeFileSync(path.join(testFixture.temporary, "api-size"), "256000\n");
    const result = testFixture.run(["clone", testFixture.writeManifest(value)]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /declared GitHub repository sizes exceed the 5 GiB batch limit/);
    assert.equal(testFixture.commands().some((entry) => entry.name === "gh" && entry.args[0] === "repo"), false);
  } finally {
    testFixture.cleanup();
  }
});

test("rejects a batch that cannot fit with checkout overhead and the safety reserve", () => {
  const testFixture = fixture();
  try {
    writeFileSync(path.join(testFixture.temporary, "api-size"), "102400\n");
    const result = testFixture.run(
      ["clone", testFixture.writeManifest(cloneManifest())],
      { GRADEPUSH_GH_GRADEPUSH_TEST_FREE_BYTES: String(512 * 1024 * 1024) },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not have enough free space for the declared batch/);
    assert.equal(testFixture.commands().some((entry) => entry.name === "gh" && entry.args[0] === "repo"), false);
  } finally {
    testFixture.cleanup();
  }
});

test("times out a hanging GitHub API request before any clone starts", () => {
  const testFixture = fixture();
  try {
    writeFileSync(path.join(testFixture.temporary, "hang-api"), "yes\n");
    const result = testFixture.run(
      ["clone", testFixture.writeManifest(cloneManifest())],
      { GRADEPUSH_GH_GRADEPUSH_TEST_TIMEOUT_MS: "50" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gh timed out after 50ms/);
    assert.equal(testFixture.commands().some((entry) => entry.name === "gh" && entry.args[0] === "repo"), false);
  } finally {
    testFixture.cleanup();
  }
});

test("terminates a timed-out command's descendant process", { skip: process.platform === "win32" }, () => {
  const testFixture = fixture();
  try {
    writeFileSync(path.join(testFixture.temporary, "hang-api-with-child"), "yes\n");
    const result = testFixture.run(
      ["clone", testFixture.writeManifest(cloneManifest())],
      { GRADEPUSH_GH_GRADEPUSH_TEST_TIMEOUT_MS: "500" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gh timed out after 500ms/);
    const childPid = Number(readFileSync(path.join(testFixture.temporary, "hanging-child-pid"), "utf8"));
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  } finally {
    testFixture.cleanup();
  }
});

test("--update rejects mismatched origins and dirty worktrees, and continues after both failures", () => {
  const testFixture = fixture();
  try {
    const value = cloneManifest();
    value.assignments[0].submissions.push({
      student: { login: "linus", identifier: "student-3" },
      source: "github",
      repoFullName: "school/loops-linus",
      lastSyncedSha: sha,
    });
    const destinationRoot = path.join(testFixture.temporary, "reviews");
    const first = path.join(destinationRoot, "programming-1", "loops", folder(value.assignments[0], value.assignments[0].submissions[0]));
    const second = path.join(destinationRoot, "programming-1", "loops", folder(value.assignments[0], value.assignments[0].submissions[1]));
    mkdirSync(path.join(first, ".git"), { recursive: true });
    writeFileSync(path.join(first, ".origin"), "https://github.com/other/repository.git\n");
    mkdirSync(path.join(second, ".git"), { recursive: true });
    writeFileSync(path.join(second, ".origin"), "https://github.com/school/loops-linus.git\n");
    writeFileSync(path.join(second, ".dirty"), "yes\n");
    const result = testFixture.run(["clone", testFixture.writeManifest(value), "--destination", destinationRoot, "--update"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /origin that does not match school\/loops-ada/);
    assert.match(result.stderr, /has a dirty worktree/);
    assert.match(result.stdout, /0 cloned, 0 skipped, 2 failed/);
    assert.equal(testFixture.commands().some((entry) => entry.args.includes("fetch")), false);
  } finally {
    testFixture.cleanup();
  }
});

test("--update refuses to create a missing destination", () => {
  const testFixture = fixture();
  try {
    const result = testFixture.run(["clone", testFixture.writeManifest(cloneManifest()), "--update"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--update requires an existing Git worktree/);
    assert.equal(testFixture.commands().some((entry) => entry.name === "gh" && entry.args[0] === "repo"), false);
  } finally {
    testFixture.cleanup();
  }
});

test("rejects a classroom symlink that resolves outside the chosen destination", { skip: process.platform === "win32" }, () => {
  const testFixture = fixture();
  try {
    const destination = path.join(testFixture.temporary, "reviews");
    const outside = path.join(testFixture.temporary, "outside");
    mkdirSync(destination);
    mkdirSync(outside);
    symlinkSync(outside, path.join(destination, "programming-1"), "dir");
    const result = testFixture.run(["clone", testFixture.writeManifest(cloneManifest()), "--destination", destination]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /classroom directory resolves outside the selected destination/);
    assert.equal(testFixture.commands().some((entry) => entry.name === "gh" && entry.args[0] === "repo"), false);
  } finally {
    testFixture.cleanup();
  }
});
