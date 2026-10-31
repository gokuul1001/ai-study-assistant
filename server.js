import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

const scrypt = promisify(scryptCallback);
const root = fileURLToPath(new URL(".", import.meta.url));
const dataDirectory = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(root, "data");
const storePath = join(dataDirectory, "store.json");
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production" || process.argv.includes("--serve-client");
const secureCookies = process.env.NODE_ENV === "production";
const sessionDuration = 7 * 24 * 60 * 60 * 1000;
const defaultSettings = {
  smartSuggestions: true,
  autoSave: true,
  notifications: true
};

let store = { users: [], sessions: [], notes: [], chats: [], settings: [] };
let writeQueue = Promise.resolve();
const authAttempts = new Map();

async function persistStore() {
  writeQueue = writeQueue.then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    const temporaryPath = `${storePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    await rename(temporaryPath, storePath);
  });
  return writeQueue;
}

async function loadStore() {
  try {
    store = { ...store, ...JSON.parse(await readFile(storePath, "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await persistStore();
  }
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function getCookie(request, name) {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : "";
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function currentUser(request) {
  const token = getCookie(request, "study_session");
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = store.sessions.find((item) => item.tokenHash === tokenHash && item.expiresAt > Date.now());
  if (!session) return null;
  return store.users.find((user) => user.id === session.userId) || null;
}

function sessionCookie(token, maxAge) {
  return `study_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookies ? "; Secure" : ""}`;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function rateLimit(request) {
  const address = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recentAttempts = (authAttempts.get(address) || []).filter((timestamp) => now - timestamp < 60_000);
  if (recentAttempts.length >= 8) return false;
  recentAttempts.push(now);
  authAttempts.set(address, recentAttempts);
  return true;
}

async function makePasswordHash(password, salt = randomBytes(16).toString("hex")) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString("hex") };
}

async function verifyPassword(password, user) {
  const actual = await scrypt(password, user.passwordSalt, 64);
  const expected = Buffer.from(user.passwordHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validateText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw Object.assign(new Error(`${label} is required and must be under ${maxLength} characters.`), { status: 400 });
  }
  return value.trim();
}

function findRelevantNotes(question, notes) {
  const terms = question.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return notes.map((note) => {
    const searchable = `${note.title} ${note.content} ${note.category}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (searchable.includes(term) ? 1 : 0), 0);
    return { note, score };
  }).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((entry) => entry.note);
}

async function generateAnswer(question, notes, history) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    const endpoint = `${(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
    const noteContext = notes.slice(0, 40).map((note) => `Title: ${note.title}\nCategory: ${note.category}\nContent: ${note.content}`).join("\n\n");
    const messages = [
      { role: "system", content: `You are a clear, supportive study assistant. Use the user's saved notes when relevant, distinguish note facts from general knowledge, and say when notes do not contain the answer.\n\nSaved notes:\n${noteContext || "No notes saved yet."}` },
      ...history.slice(-10).map(({ role, content }) => ({ role, content })),
      { role: "user", content: question }
    ];
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", messages, temperature: 0.4 }),
      signal: AbortSignal.timeout(45_000)
    });
    if (!response.ok) {
      const details = await response.text();
      console.error(`AI provider returned ${response.status}: ${details.slice(0, 500)}`);
      throw Object.assign(new Error("The AI provider could not complete this request. Check the server configuration and try again."), { status: 502 });
    }
    const result = await response.json();
    const answer = result.choices?.[0]?.message?.content?.trim();
    if (!answer) throw Object.assign(new Error("The AI provider returned an empty answer."), { status: 502 });
    return { answer, mode: "provider", sources: findRelevantNotes(question, notes).map(({ id, title }) => ({ id, title })) };
  }

  const relevantNotes = findRelevantNotes(question, notes);
  if (!relevantNotes.length) {
    return {
      answer: notes.length
        ? "I couldn't find a matching note for that question yet. Try a topic or phrase from your library, or add a note first. You can connect an AI provider by setting OPENAI_API_KEY in the server environment for general-purpose answers."
        : "Your knowledge library is empty, so I don't have study material to reference yet. Add a note, then ask me about its concepts. For general-purpose AI answers, configure OPENAI_API_KEY on the server.",
      mode: "local",
      sources: []
    };
  }
  const excerpts = relevantNotes.map((note) => `• ${note.title}: ${note.content}`).join("\n\n");
  return {
    answer: `I found ${relevantNotes.length} relevant ${relevantNotes.length === 1 ? "note" : "notes"} in your library:\n\n${excerpts}\n\nThis local answer is grounded in your saved material. Add OPENAI_API_KEY to enable generated explanations and broader study help.`,
    mode: "local",
    sources: relevantNotes.map(({ id, title }) => ({ id, title }))
  };
}

async function serveStatic(pathname, response) {
  const publicDirectory = join(root, "dist");
  const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const safePath = normalize(requestedPath).replace(/^([/\\])+/, "");
  let filePath = join(publicDirectory, safePath);
  const relativePath = relative(publicDirectory, filePath);
  if (relativePath.startsWith("..") || relativePath.startsWith("/")) filePath = join(publicDirectory, "index.html");
  try {
    const contents = await readFile(filePath);
    const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": extname(filePath) === ".html" ? "no-store" : "public, max-age=31536000, immutable"
    });
    response.end(contents);
  } catch {
    const contents = await readFile(join(publicDirectory, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(contents);
  }
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/health") {
    return sendJson(response, 200, { ok: true, aiConfigured: Boolean(process.env.OPENAI_API_KEY) });
  }
  if (request.method === "GET" && pathname === "/api/auth/me") {
    const user = await currentUser(request);
    return sendJson(response, 200, { user: user ? publicUser(user) : null });
  }

  if (["/api/auth/register", "/api/auth/login"].includes(pathname) && request.method === "POST") {
    if (!rateLimit(request)) return sendJson(response, 429, { error: "Too many attempts. Please wait a minute and try again." });
    const body = await readBody(request);
    const email = validateText(body.email, "Email", 254).toLowerCase();
    const password = validateText(body.password, "Password", 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(response, 400, { error: "Enter a valid email address." });
    if (pathname.endsWith("register")) {
      const name = validateText(body.name, "Name", 80);
      if (password.length < 8) return sendJson(response, 400, { error: "Password must be at least 8 characters." });
      if (store.users.some((user) => user.email === email)) return sendJson(response, 409, { error: "An account with this email already exists." });
      const passwordData = await makePasswordHash(password);
      const user = { id: randomUUID(), name, email, passwordSalt: passwordData.salt, passwordHash: passwordData.hash, createdAt: new Date().toISOString() };
      store.users.push(user);
      store.settings.push({ userId: user.id, ...defaultSettings });
      const token = randomBytes(32).toString("base64url");
      store.sessions.push({ userId: user.id, tokenHash: hashToken(token), expiresAt: Date.now() + sessionDuration });
      await persistStore();
      return sendJson(response, 201, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(token, sessionDuration / 1000) });
    }
    const user = store.users.find((item) => item.email === email);
    if (!user || !(await verifyPassword(password, user))) return sendJson(response, 401, { error: "Email or password is incorrect." });
    const token = randomBytes(32).toString("base64url");
    store.sessions = store.sessions.filter((session) => session.expiresAt > Date.now());
    store.sessions.push({ userId: user.id, tokenHash: hashToken(token), expiresAt: Date.now() + sessionDuration });
    await persistStore();
    return sendJson(response, 200, { user: publicUser(user) }, { "Set-Cookie": sessionCookie(token, sessionDuration / 1000) });
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const token = getCookie(request, "study_session");
    store.sessions = store.sessions.filter((session) => session.tokenHash !== hashToken(token));
    await persistStore();
    return sendJson(response, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }

  const user = await currentUser(request);
  if (!user) return sendJson(response, 401, { error: "Please sign in to continue." });

  if (pathname === "/api/notes" && request.method === "GET") {
    const notes = store.notes.filter((note) => note.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sendJson(response, 200, { notes });
  }
  if (pathname === "/api/notes" && request.method === "POST") {
    const body = await readBody(request);
    const note = {
      id: randomUUID(), userId: user.id,
      title: validateText(body.title, "Title", 160),
      content: validateText(body.content, "Content", 20_000),
      category: typeof body.category === "string" && body.category.trim() ? body.category.trim().slice(0, 50) : "General",
      createdAt: new Date().toISOString()
    };
    store.notes.push(note);
    await persistStore();
    const publicNote = Object.fromEntries(Object.entries(note).filter(([key]) => key !== "userId"));
    return sendJson(response, 201, { note: publicNote });
  }
  const noteMatch = pathname.match(/^\/api\/notes\/([0-9a-f-]+)$/i);
  if (noteMatch && request.method === "DELETE") {
    const before = store.notes.length;
    store.notes = store.notes.filter((note) => !(note.id === noteMatch[1] && note.userId === user.id));
    if (store.notes.length === before) return sendJson(response, 404, { error: "Note not found." });
    await persistStore();
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === "/api/settings" && request.method === "GET") {
    const settings = store.settings.find((item) => item.userId === user.id) || { userId: user.id, ...defaultSettings };
    return sendJson(response, 200, { settings: Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "userId")) });
  }
  if (pathname === "/api/settings" && request.method === "PATCH") {
    const body = await readBody(request);
    let settings = store.settings.find((item) => item.userId === user.id);
    if (!settings) {
      settings = { userId: user.id, ...defaultSettings };
      store.settings.push(settings);
    }
    for (const key of Object.keys(defaultSettings)) {
      if (typeof body[key] === "boolean") settings[key] = body[key];
    }
    await persistStore();
    return sendJson(response, 200, { settings: Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "userId")) });
  }

  if (pathname === "/api/chat" && request.method === "GET") {
    const messages = store.chats.filter((message) => message.userId === user.id)
      .map((message) => Object.fromEntries(Object.entries(message).filter(([key]) => key !== "userId")));
    return sendJson(response, 200, { messages, aiMode: process.env.OPENAI_API_KEY ? "provider" : "local" });
  }
  if (pathname === "/api/chat" && request.method === "DELETE") {
    store.chats = store.chats.filter((message) => message.userId !== user.id);
    await persistStore();
    return sendJson(response, 200, { ok: true });
  }
  if (pathname === "/api/chat" && request.method === "POST") {
    const body = await readBody(request);
    const question = validateText(body.message, "Message", 4000);
    const notes = store.notes.filter((note) => note.userId === user.id);
    const history = store.chats.filter((message) => message.userId === user.id);
    const generated = await generateAnswer(question, notes, history);
    const timestamp = new Date().toISOString();
    const userMessage = { id: randomUUID(), role: "user", content: question, createdAt: timestamp, userId: user.id };
    const assistantMessage = { id: randomUUID(), role: "assistant", content: generated.answer, createdAt: new Date().toISOString(), sources: generated.sources, userId: user.id };
    store.chats.push(userMessage, assistantMessage);
    await persistStore();
    const message = Object.fromEntries(Object.entries(assistantMessage).filter(([key]) => key !== "userId"));
    return sendJson(response, 200, { message, aiMode: generated.mode });
  }

  return sendJson(response, 404, { error: "API endpoint not found." });
}

await loadStore();
const server = createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    if (isProduction) return await serveStatic(url.pathname, response);
    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    if (error.status) return sendJson(response, error.status, { error: error.message });
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: "Something went wrong. Please try again." });
  }
});

server.listen(port, host, () => {
  console.log(`Study assistant listening at http://localhost:${port}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        console.log(`Network access: http://${address.address}:${port}`);
      }
    }
  }
  console.log(`AI provider: ${process.env.OPENAI_API_KEY ? "configured" : "local notes mode"}`);
});
