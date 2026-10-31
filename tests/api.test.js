import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";

let serverProcess;
let baseUrl;
let dataDirectory;

before(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "knowflow-api-test-"));
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const { port } = portProbe.address();
  await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["--env-file-if-exists=.env", new URL("../server.js", import.meta.url).pathname], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDirectory, OPENAI_API_KEY: "", NODE_ENV: "test" },
    stdio: "ignore"
  });

  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      ready = response.ok;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.ok(ready, "API server did not start in time");
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

async function request(path, options = {}, cookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers
    }
  });
  const body = await response.json();
  const sessionCookie = response.headers.get("set-cookie")?.split(";")[0];
  const secureCookie = response.headers.get("set-cookie")?.toLowerCase().includes("; secure") || false;
  return { response, body, sessionCookie, secureCookie };
}

function json(method, value) {
  return { method, body: JSON.stringify(value) };
}

test("account data, preferences, chat, and session are isolated and persistent", async () => {
  const firstRegistration = await request("/api/auth/register", json("POST", {
    name: "Taylor Student",
    email: "taylor@example.com",
    password: "study-pass-123"
  }));
  assert.equal(firstRegistration.response.status, 201);
  assert.equal(firstRegistration.body.user.name, "Taylor Student");
  const firstCookie = firstRegistration.sessionCookie;
  assert.ok(firstCookie);
  assert.equal(firstRegistration.secureCookie, false, "HTTP development sessions must work on LAN IP addresses");

  const duplicate = await request("/api/auth/register", json("POST", {
    name: "Taylor Student",
    email: "taylor@example.com",
    password: "study-pass-123"
  }));
  assert.equal(duplicate.response.status, 409);

  const saved = await request("/api/notes", json("POST", {
    title: "Cell Biology",
    category: "Biology",
    content: "Mitochondria produce ATP through cellular respiration."
  }), firstCookie);
  assert.equal(saved.response.status, 201);
  assert.equal(saved.body.note.category, "Biology");
  assert.equal("userId" in saved.body.note, false);

  const updatedSettings = await request("/api/settings", json("PATCH", { notifications: false }), firstCookie);
  assert.equal(updatedSettings.body.settings.notifications, false);

  const answer = await request("/api/chat", json("POST", { message: "What do mitochondria produce?" }), firstCookie);
  assert.equal(answer.response.status, 200);
  assert.equal(answer.body.aiMode, "local");
  assert.match(answer.body.message.content, /produce ATP/);

  const history = await request("/api/chat", {}, firstCookie);
  assert.deepEqual(history.body.messages.map((message) => message.role), ["user", "assistant"]);
  const notes = await request("/api/notes", {}, firstCookie);
  assert.equal(notes.body.notes.length, 1);
  const settings = await request("/api/settings", {}, firstCookie);
  assert.equal(settings.body.settings.notifications, false);

  const secondRegistration = await request("/api/auth/register", json("POST", {
    name: "Morgan Learner",
    email: "morgan@example.com",
    password: "another-pass-456"
  }));
  assert.equal(secondRegistration.response.status, 201);
  const secondCookie = secondRegistration.sessionCookie;
  assert.equal((await request("/api/notes", {}, secondCookie)).body.notes.length, 0);
  assert.equal((await request("/api/chat", {}, secondCookie)).body.messages.length, 0);
  assert.equal((await request(`/api/notes/${saved.body.note.id}`, { method: "DELETE" }, secondCookie)).response.status, 404);

  assert.equal((await request("/api/chat", { method: "DELETE" }, firstCookie)).response.status, 200);
  assert.equal((await request("/api/chat", {}, firstCookie)).body.messages.length, 0);
  assert.equal((await request("/api/auth/logout", { method: "POST" }, firstCookie)).response.status, 200);
  const signedOut = await request("/api/auth/me", {}, firstCookie);
  assert.equal(signedOut.response.status, 200);
  assert.equal(signedOut.body.user, null);

  const login = await request("/api/auth/login", json("POST", { email: "taylor@example.com", password: "study-pass-123" }));
  assert.equal(login.response.status, 200);
  assert.equal((await request("/api/notes", {}, login.sessionCookie)).body.notes.length, 1);
});
