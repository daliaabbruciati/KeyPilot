const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LOG = path.join(os.tmpdir(), "keypilot.log");
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`;
  try { fs.appendFileSync(LOG, line); } catch {}
}

function cfg() { return vscode.workspace.getConfiguration("keypilot"); }

// Write a setting to BOTH user (global) and workspace scope,
// so no matter which one is inspected the same value is returned
async function setSetting(key, value) {
  await cfg().update(key, value, vscode.ConfigurationTarget.Global);
  await cfg().update(key, value, vscode.ConfigurationTarget.Workspace);
}

let statusBar, statsProvider;
let stats = { prompt: 0, completion: 0, total: 0, requests: 0 };

// --- Completion cache (LRU) + in-flight dedup + last suggestion tracking ---
const completionCache = new Map();
const CACHE_MAX = 40;
let inflight = null;          // { key, promise } — request currently running
let lastSuggestion = null;    // { uri, position, text } — for accept-next-word

function cacheKey(document, position) {
  return `${document.uri.toString()}|${document.offsetAt(position)}|${document.version}`;
}

function cacheGet(key) {
  const v = completionCache.get(key);
  if (v === undefined) return undefined;
  completionCache.delete(key);
  completionCache.set(key, v); // LRU touch
  return v;
}

function cacheSet(key, text) {
  completionCache.set(key, text);
  if (completionCache.size > CACHE_MAX) {
    completionCache.delete(completionCache.keys().next().value);
  }
}

function fmt(n) { return n.toLocaleString("en"); }
function updateStatusBar() {
  statusBar.text = `$(circuit-board) ${fmt(stats.total)} tok`;
  statusBar.tooltip = "KeyPilot — click to open stats";
}

function sleep(ms, token) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(true), ms);
    if (token) token.onCancellationRequested(() => { clearTimeout(t); resolve(false); });
  });
}

async function saveApiKey(key) {
  await setSetting("apiKey", key.trim());
  vscode.window.showInformationMessage("KeyPilot: API Key saved.");
}

async function promptForApiKey() {
  const input = await vscode.window.showInputBox({
    prompt: "Paste your API Key (Gemini / Groq / OpenAI-compatible)",
    placeHolder: "AIzaSy...",
    ignoreFocusOut: true,
    password: true
  });
  if (input?.trim()) { await saveApiKey(input); statsProvider?.refresh(); }
}

async function promptForModel() {
  const current = cfg().get("model") || "";
  const input = await vscode.window.showInputBox({
    prompt: "Model name (e.g. gemini-3.1-flash-lite, llama-3.3-70b-versatile)",
    placeHolder: current || "gemini-3.1-flash-lite",
    ignoreFocusOut: true,
    value: current
  });
  if (input?.trim() && input.trim() !== current) {
    await setSetting("model", input.trim());
    vscode.window.showInformationMessage(`KeyPilot: model set to ${input.trim()}.`);
    statsProvider?.refresh();
  }
}

// --- Error toasts (throttled: same error not repeated within cooldown) ---
const TOAST_COOLDOWN = 30000;
const lastToastAt = new Map();

function showError(key, message, ...actions) {
  const now = Date.now();
  if (now - (lastToastAt.get(key) ?? 0) < TOAST_COOLDOWN) return;
  lastToastAt.set(key, now);
  vscode.window.showErrorMessage(`KeyPilot: ${message}`, ...actions.map(a => a.label))
    .then(pick => actions.find(a => a.label === pick)?.run());
}

// Map HTTP status codes to user-friendly messages with quick-fix actions
function httpError(status, model) {
  switch (status) {
    case 401:
    case 403:
      return ["Invalid API Key. Check your credentials.", { label: "Change API Key", run: promptForApiKey }];
    case 404:
      return [`Model "${model}" not found. Check the exact model name for your provider.`, { label: "Change Model", run: promptForModel }];
    case 429:
      return ["Rate limit reached: quota exhausted. Wait or switch model / API Key.",
        { label: "Change API Key", run: promptForApiKey }, { label: "Change Model", run: promptForModel }];
    case 400:
      return ["Bad request: check the model name and endpoint URL.", { label: "Change Model", run: promptForModel }];
    case 500: case 502: case 503:
      return ["Provider is temporarily unavailable. Try again in a moment."];
    default:
      return [`Request failed (HTTP ${status}).`];
  }
}

async function promptForApiKeyStartup() {
  if (cfg().get("apiKey")?.trim()) return;
  const go = "Enter API Key", link = "Get one (AI Studio)";
  const sel = await vscode.window.showInformationMessage(
    "KeyPilot: add your API Key to enable completions.", go, link
  );
  if (sel === link) vscode.env.openExternal(vscode.Uri.parse("https://aistudio.google.com/"));
  if (sel === go || sel === link) await promptForApiKey();
}

// Compress whitespace to cut tokens sent to the model
function compress(s) {
  return s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n");
}

// Build an InlineCompletionItem with a range that covers any existing lines
// the model wants to edit (next-edit pattern detection)
function makeItem(document, position, text) {
  const lines = text.split("\n");
  const lineAfterCursor = document.lineAt(position.line).text.slice(position.character);

  let endLine = position.line;
  let endChar = lineAfterCursor.trim()
    ? document.lineAt(position.line).text.length  // replace rest of current line
    : position.character;

  for (let i = 1; i < lines.length; i++) {
    const docNum = position.line + i;
    if (docNum >= document.lineCount) break;
    const docText = document.lineAt(docNum).text;
    // Extend range only when completion clearly edits a non-empty existing line
    if (docText.trim() && lines[i] !== docText) {
      endLine = docNum;
      endChar = docText.length;
    }
  }

  return new vscode.InlineCompletionItem(
    text,
    new vscode.Range(position, new vscode.Position(endLine, endChar))
  );
}

async function getCompletion(document, position, ctx, token) {
  const c = cfg();
  if (!c.get("enabled")) return null;
  const apiKey = c.get("apiKey");
  if (!apiKey?.trim()) return null;

  // Instant response if we already completed this exact spot
  const key = cacheKey(document, position);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // Debounce rapid typing; manual triggers (Invoke) fire immediately
  const invoke = ctx?.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
  const ms = invoke ? 0 : (c.get("debounceMs") ?? 50);
  if (ms > 0 && !await sleep(ms, token)) return null;
  if (token?.isCancellationRequested) return null;

  const maxBefore = c.get("maxContextChars") || 3000;
  const maxAfter = Math.round(maxBefore / 5);

  const full = document.getText();
  const offset = document.offsetAt(position);
  const before = compress(full.slice(Math.max(0, offset - maxBefore * 2), offset)).slice(-maxBefore);
  const after  = compress(full.slice(offset, offset + maxAfter * 2)).slice(0, maxAfter);

  if (!before.trim() && !after.trim()) return null;

  const lang = document.languageId;
  const system = `You are an AI programming assistant like GitHub Copilot. Your role is to provide highly accurate and context-aware code completions. Carefully study the patterns, style, and structure of the surrounding code in the file. Infer the developer's intent and provide the exact code that should be inserted at <CURSOR>. Keep the ${lang} language and its conventions in mind. Output ONLY code—no markdown, no comments, no explanation. If lines after <CURSOR> follow the same pattern and need the same edit, include them verbatim then corrected.`;

  const controller = new AbortController();
  if (token) token.onCancellationRequested(() => controller.abort());

  let resp;
  try {
    resp = await fetch(c.get("endpoint"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: c.get("model"),
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${before}<CURSOR>${after}` }
        ],
        temperature: 0,
        max_tokens: 256,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === "AbortError") return null; // cancelled by a newer keystroke
    log("fetch error", e.name, e.message);
    showError("network", "Cannot reach the endpoint. Check your connection or the endpoint URL.");
    return null;
  }

  if (!resp.ok) {
    log("http error", resp.status, (await resp.text().catch(() => "")).slice(0, 200));
    const [message, ...actions] = httpError(resp.status, c.get("model"));
    showError(`http-${resp.status}`, message, ...actions);
    return null;
  }

  const data = await resp.json().catch(() => null);

  if (data?.usage) {
    stats.prompt     += data.usage.prompt_tokens     ?? 0;
    stats.completion += data.usage.completion_tokens ?? 0;
    stats.total      += data.usage.total_tokens      ?? 0;
    stats.requests++;
    updateStatusBar();
    statsProvider?.refresh();
  }

  let text = data?.choices?.[0]?.message?.content;
  if (!text) { log("empty", JSON.stringify(data).slice(0, 200)); return null; }

  text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");

  const lineEnd = document.lineAt(position.line).text.slice(position.character);
  if (lineEnd.trim() && text.startsWith(lineEnd.trim())) {
    text = text.slice(lineEnd.trim().length);
  }

  if (!text.trim()) return null;
  cacheSet(key, text);
  log("ok", text.slice(0, 80).replace(/\n/g, "\\n"));
  return text;
}

// Run a completion, deduplicating identical concurrent requests
async function requestCompletion(document, position, ctx, token) {
  const key = cacheKey(document, position);
  if (inflight && inflight.key === key) return inflight.promise;
  const p = getCompletion(document, position, ctx, token);
  inflight = { key, promise: p };
  try {
    return await p;
  } finally {
    if (inflight?.promise === p) inflight = null;
  }
}

// Extract the next word-sized chunk of the suggestion (Copilot-style partial accept)
function nextChunk(text) {
  const ws = text.match(/^\s+/)?.[0] ?? "";
  const rest = text.slice(ws.length);
  if (!rest) return ws;
  const word = rest.match(/^[\w$]+|^[^\s\w$]/)?.[0] ?? rest[0];
  const tail = rest.slice(word.length).match(/^[ \t]+/)?.[0] ?? "";
  return ws + word + tail;
}

async function makeDummyCall() {
  const c = cfg();
  const apiKey = c.get("apiKey");
  if (!apiKey?.trim()) {
    await promptForApiKey();
    return;
  }

  vscode.window.showInformationMessage("KeyPilot: Starting token test...");
  let resp;
  try {
    resp = await fetch(c.get("endpoint"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: c.get("model"),
        messages: [
          { role: "user", content: "Test" }
        ],
        temperature: 0,
        max_tokens: 10,
      }),
    });
  } catch (e) {
    vscode.window.showErrorMessage("KeyPilot: Error connecting to the model.");
    return;
  }

  if (!resp.ok) {
    if (resp.status === 429) {
      vscode.window.showWarningMessage("KeyPilot: Tokens exhausted (Limit reached). Please change the model or API Key.");
    } else {
      vscode.window.showErrorMessage(`KeyPilot: API Error (${resp.status}). Check your model and API Key.`);
    }
    return;
  }

  const data = await resp.json().catch(() => null);

  if (data?.usage) {
    stats.prompt     += data.usage.prompt_tokens     ?? 0;
    stats.completion += data.usage.completion_tokens ?? 0;
    stats.total      += data.usage.total_tokens      ?? 0;
    stats.requests++;
    updateStatusBar();
    statsProvider?.refresh();
    vscode.window.showInformationMessage(`KeyPilot: Test completed! Tokens used: ${data.usage.total_tokens ?? 0}`);
  } else {
    vscode.window.showWarningMessage("KeyPilot: Test completed, but no token info received.");
  }
}

// Real autocomplete test: runs an actual completion on the active editor
async function runCompletionTest() {
  const post = res => statsProvider?._view?.webview.postMessage(res);
  const ed = vscode.window.activeTextEditor;
  if (!ed) { post({ type: "testResult", ok: false, error: "Open a file first." }); return; }
  if (!cfg().get("apiKey")?.trim()) { post({ type: "testResult", ok: false, error: "API Key not set." }); return; }

  const t0 = Date.now();
  try {
    const text = await getCompletion(
      ed.document, ed.selection.active,
      { triggerKind: vscode.InlineCompletionTriggerKind.Invoke }, undefined
    );
    const ms = Date.now() - t0;
    if (text) post({ type: "testResult", ok: true, ms, preview: text.slice(0, 140) });
    else post({ type: "testResult", ok: false, ms: Date.now() - t0, error: "No suggestion returned. Check model name / key." });
  } catch (e) {
    post({ type: "testResult", ok: false, error: e.message });
  }
}

class StatsViewProvider {
  constructor(extensionUri) { this._view = null; this._extensionUri = extensionUri; }

  resolveWebviewView(view) {
    this._view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
    const logoUri = view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "logo-1.png"));
    view.webview.html = this._html(logoUri);
    view.webview.onDidReceiveMessage(async msg => {
      switch (msg.command) {
        case "setApiKey":   await promptForApiKey(); break;
        case "setModel":    await promptForModel(); break;
        case "setContext":  await setSetting("maxContextChars", Number(msg.value)); break;
        case "toggleEnabled": await setSetting("enabled", msg.value); break;
        case "resetTokens":
          stats = { prompt: 0, completion: 0, total: 0, requests: 0 };
          updateStatusBar(); this.refresh();
          break;
        case "dummyCall":
          await makeDummyCall();
          break;
        case "testCompletion":
          await runCompletionTest();
          break;
      }
    });
  }

  refresh() {
    if (!this._view) return;
    const c = cfg();
    const key = c.get("apiKey") || "";
    const masked = key.length > 8 ? `${key.slice(0, 6)}••••${key.slice(-2)}` : key ? "••••••" : "Not set";
    this._view.webview.postMessage({
      type: "update", stats, masked,
      model: c.get("model") ?? "",
      context: c.get("maxContextChars") ?? 3000,
      enabled: c.get("enabled") ?? true,
    });
  }

  _html(logoUri) {
    const c = cfg();
    const key = c.get("apiKey") || "";
    const masked = key.length > 8 ? `${key.slice(0, 6)}••••${key.slice(-2)}` : key ? "••••••" : "Not set";
    const context = c.get("maxContextChars") ?? 3000;
    const model = c.get("model") ?? "";
    const enabled = c.get("enabled") ?? true;
    const pct = stats.total ? Math.round(stats.completion / stats.total * 100) : 0;

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${logoUri};">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',var(--vscode-font-family),sans-serif;
  font-size:13px;
  color:var(--vscode-foreground);
  padding:20px 18px 24px;
  -webkit-font-smoothing:antialiased;
}

/* Header */
.header{
  display:flex;align-items:center;gap:8px;
  margin-bottom:28px;
}
.header-dot{
  width:8px;height:8px;border-radius:50%;
  background:#007AFF;
  box-shadow:0 0 6px rgba(0,122,255,.6);
  flex-shrink:0;
}
.header-title{
  font-size:11px;font-weight:600;
  letter-spacing:.1em;text-transform:uppercase;
  color:var(--vscode-descriptionForeground);
  opacity:.7;
}

/* Big number */
.stat-num{
  font-size:48px;font-weight:700;
  letter-spacing:-.03em;
  line-height:1;
  font-variant-numeric:tabular-nums;
  margin-bottom:4px;
}
.stat-sub{
  font-size:11px;
  color:var(--vscode-descriptionForeground);
  opacity:.55;
  letter-spacing:.02em;
  margin-bottom:16px;
}

/* Progress bar */
.bar-track{
  height:2px;
  background:rgba(128,128,128,.12);
  border-radius:999px;
  overflow:hidden;
  margin-bottom:20px;
}
.bar-fill{
  height:100%;
  background:linear-gradient(90deg,#007AFF,#34C8F5);
  border-radius:999px;
  transition:width .5s cubic-bezier(.4,0,.2,1);
}

/* Mini stat cards */
.cards{
  display:grid;grid-template-columns:1fr 1fr;
  gap:8px;margin-bottom:4px;
}
.card{
  background:rgba(128,128,128,.07);
  border-radius:10px;
  padding:11px 13px;
}
.card-label{
  font-size:10px;font-weight:600;
  letter-spacing:.08em;text-transform:uppercase;
  color:var(--vscode-descriptionForeground);
  opacity:.55;margin-bottom:5px;
}
.card-value{
  font-size:20px;font-weight:600;
  letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;
}

/* Separator */
.sep{
  height:.5px;
  background:var(--vscode-foreground);
  opacity:.08;
  margin:22px 0;
}

/* Section label */
.section-label{
  font-size:10px;font-weight:600;
  letter-spacing:.1em;text-transform:uppercase;
  color:var(--vscode-descriptionForeground);
  opacity:.55;
  margin-bottom:14px;
}

/* Setting rows */
.srow{
  display:flex;align-items:center;
  padding:9px 0;
  border-bottom:.5px solid rgba(128,128,128,.1);
}
.srow:last-child{border-bottom:none}
.srow-name{font-size:13px;flex:1}
.srow-val{
  font-size:12px;
  color:var(--vscode-descriptionForeground);
  opacity:.7;margin-right:10px;
  overflow:hidden;text-overflow:ellipsis;
  max-width:120px;white-space:nowrap;
}

/* Pill button */
.pill{
  background:rgba(0,122,255,.13);
  color:#007AFF;
  border:none;
  padding:5px 13px;
  font-size:12px;font-weight:500;
  cursor:pointer;
  border-radius:999px;
  white-space:nowrap;
  transition:background .15s;
  font-family:inherit;
}
.pill:hover{background:rgba(0,122,255,.22)}

/* Number input */
.num-input{
  background:rgba(128,128,128,.1);
  border:none;
  color:var(--vscode-foreground);
  padding:5px 9px;
  font-size:12px;
  width:70px;
  border-radius:7px;
  text-align:right;
  font-family:inherit;
}
.num-input:focus{
  outline:1.5px solid #007AFF;
}
.num-unit{
  font-size:11px;
  color:var(--vscode-descriptionForeground);
  opacity:.5;
  margin-left:5px;
}

/* Apple toggle */
.tog-wrap{display:flex;align-items:center;gap:8px;cursor:pointer}
.tog-track{
  width:36px;height:20px;
  background:rgba(128,128,128,.25);
  border-radius:999px;
  position:relative;
  transition:background .2s;
  cursor:pointer;flex-shrink:0;
}
.tog-track.on{background:#34C759}
.tog-track::after{
  content:'';position:absolute;
  width:16px;height:16px;
  background:#fff;
  border-radius:50%;
  top:2px;left:2px;
  transition:transform .22s cubic-bezier(.4,0,.2,1);
  box-shadow:0 1px 4px rgba(0,0,0,.35);
}
.tog-track.on::after{transform:translateX(16px)}
.tog-label{
  font-size:12px;
  color:var(--vscode-descriptionForeground);
  opacity:.6;
  transition:color .2s,opacity .2s;
}
.tog-label.on{color:#34C759;opacity:1}

/* Reset */
.reset{
  width:100%;
  background:transparent;
  color:var(--vscode-descriptionForeground);
  border:.5px solid rgba(128,128,128,.2);
  padding:9px;
  font-size:12px;font-weight:500;
  cursor:pointer;
  border-radius:9px;
  transition:background .15s,color .15s,border-color .15s;
  font-family:inherit;
  letter-spacing:.01em;
}
.reset:hover{
  background:rgba(255,59,48,.1);
  color:#FF3B30;
  border-color:rgba(255,59,48,.3);
}

/* Big autocomplete test button */
.test-btn{
  width:100%;
  margin-top:20px;
  background:linear-gradient(135deg,#007AFF,#34C8F5);
  color:#fff;
  border:none;
  padding:16px 18px;
  font-size:15px;font-weight:600;
  letter-spacing:.02em;
  cursor:pointer;
  border-radius:14px;
  font-family:inherit;
  text-align:left;
  position:relative;
  overflow:hidden;
  box-shadow:0 4px 16px rgba(0,122,255,.35);
  transition:transform .15s cubic-bezier(.4,0,.2,1),box-shadow .25s,opacity .2s;
}
.test-btn:hover{ transform:translateY(-2px); box-shadow:0 8px 24px rgba(0,122,255,.5); }
.test-btn:active{ transform:translateY(0) scale(.99); }
.test-btn:disabled{ opacity:.65; cursor:default; transform:none; }
.test-btn .sub{ display:block; font-size:11px; font-weight:400; opacity:.85; margin-top:3px; letter-spacing:.04em; }
.test-btn .icon{
  position:absolute; right:14px; top:50%; transform:translateY(-50%);
  font-size:22px; opacity:.9;
}
.test-btn.testing .icon{ animation:spin 1s linear infinite; display:inline-block; }
@keyframes spin{ to{ transform:translateY(-50%) rotate(360deg); } }
/* shimmer sweep while testing */
.test-btn::after{
  content:''; position:absolute; inset:0;
  background:linear-gradient(105deg,transparent 40%,rgba(255,255,255,.25) 50%,transparent 60%);
  transform:translateX(-100%);
}
.test-btn.testing::after{ animation:sweep 1.1s ease-in-out infinite; }
@keyframes sweep{ to{ transform:translateX(100%); } }

.test-result{
  margin-top:10px;
  background:rgba(128,128,128,.07);
  border-radius:10px;
  padding:10px 13px;
  font-size:12px;
  line-height:1.5;
  display:none;
  word-break:break-word;
}
.test-result.ok{ display:block; border-left:2.5px solid #34C759; }
.test-result.err{ display:block; border-left:2.5px solid #FF3B30; }
.test-result b{ font-weight:600; }
.test-result .prev{ opacity:.7; white-space:pre-wrap; }

</style></head><body>

<div class="header">
  <div class="header-dot" id="statusDot"></div>
  <span class="header-title">KeyPilot</span>
</div>

<div class="stat-num" id="total">${fmt(stats.total)}</div>
<div class="stat-sub" id="reqs">${stats.requests} request${stats.requests !== 1 ? "s" : ""} this session</div>

<div class="bar-track"><div class="bar-fill" id="bar" style="width:${pct}%"></div></div>

<div class="cards">
  <div class="card">
    <div class="card-label">Prompt</div>
    <div class="card-value" id="prompt">${fmt(stats.prompt)}</div>
  </div>
  <div class="card">
    <div class="card-label">Completion</div>
    <div class="card-value" id="compl">${fmt(stats.completion)}</div>
  </div>
</div>

<div class="sep"></div>

<div class="section-label">Settings</div>

<div class="srow">
  <span class="srow-name">API Key</span>
  <span class="srow-val" id="masked">${masked}</span>
  <button class="pill" onclick="p({command:'setApiKey'})">Change</button>
</div>

<div class="srow">
  <span class="srow-name">Model</span>
  <span class="srow-val" id="model">${model}</span>
  <button class="pill" onclick="p({command:'setModel'})">Change</button>
</div>

<div class="srow">
  <span class="srow-name">Context</span>
  <input class="num-input" type="number" id="ctx" value="${context}" min="500" max="50000" step="500"
    onchange="p({command:'setContext',value:this.value})">
  <span class="num-unit">chars</span>
</div>

<div class="srow">
  <span class="srow-name">Inline suggestions</span>
  <div class="tog-wrap" onclick="toggleEnabled()">
    <div class="tog-track ${enabled ? "on" : ""}" id="togTrack"></div>
    <span class="tog-label ${enabled ? "on" : ""}" id="togLabel">${enabled ? "On" : "Off"}</span>
  </div>
</div>

<div class="sep"></div>

<div style="display:flex; gap:8px;">
  <button class="reset" style="flex:1" onclick="p({command:'resetTokens'})">Reset session tokens</button>
  <button class="reset" style="flex:1" onclick="p({command:'dummyCall'})">Test Token Consumption</button>
</div>

<button class="test-btn" id="testBtn" onclick="runTest()">
  <span id="testLabel">Test Autocomplete</span>
  <span class="sub">Runs a real completion on the active file</span>
  <span class="icon" id="testIcon">⚡</span>
</button>
<div class="test-result" id="testResult"></div>

<script>
const vsc = acquireVsCodeApi();
function p(m){vsc.postMessage(m)}
function fmt(n){return n.toLocaleString('en')}

let _enabled = ${enabled};
function toggleEnabled(){
  _enabled = !_enabled;
  const t=document.getElementById('togTrack');
  const l=document.getElementById('togLabel');
  t.className='tog-track'+(_enabled?' on':'');
  l.className='tog-label'+(_enabled?' on':'');
  l.textContent=_enabled?'On':'Off';
  p({command:'toggleEnabled',value:_enabled});
}

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function runTest(){
  const b=document.getElementById('testBtn');
  const r=document.getElementById('testResult');
  b.disabled=true;
  b.classList.add('testing');
  document.getElementById('testLabel').textContent='Testing…';
  document.getElementById('testIcon').textContent='◌';
  r.className='test-result';
  p({command:'testCompletion'});
}

window.addEventListener('message',e=>{
  const m=e.data;
  if(m.type==='testResult'){
    const b=document.getElementById('testBtn');
    const r=document.getElementById('testResult');
    b.disabled=false;
    b.classList.remove('testing');
    document.getElementById('testLabel').textContent='Test Autocomplete';
    document.getElementById('testIcon').textContent='⚡';
    r.style.display='block';
    if(m.ok){
      r.className='test-result ok';
      r.innerHTML='<b>✓ Working</b> · '+m.ms+' ms<br><span class="prev">'+esc(m.preview)+'</span>';
    } else {
      r.className='test-result err';
      r.innerHTML='<b>✗ Failed</b>'+(m.ms?' · '+m.ms+' ms':'')+'<br><span class="prev">'+esc(m.error||'Unknown error')+'</span>';
    }
    return;
  }
  if(m.type!=='update')return;
  const s=m.stats;
  document.getElementById('total').textContent=fmt(s.total);
  document.getElementById('reqs').textContent=s.requests+' request'+(s.requests!==1?'s':'')+' this session';
  document.getElementById('prompt').textContent=fmt(s.prompt);
  document.getElementById('compl').textContent=fmt(s.completion);
  document.getElementById('bar').style.width=(s.total?Math.round(s.completion/s.total*100):0)+'%';
  document.getElementById('masked').textContent=m.masked;
  document.getElementById('model').textContent=m.model;
  document.getElementById('ctx').value=m.context;
  _enabled=m.enabled;
  document.getElementById('togTrack').className='tog-track'+(m.enabled?' on':'');
  document.getElementById('togLabel').className='tog-label'+(m.enabled?' on':'');
  document.getElementById('togLabel').textContent=m.enabled?'On':'Off';
  document.getElementById('statusDot').style.background=m.enabled?'#007AFF':'rgba(128,128,128,.4)';
  document.getElementById('statusDot').style.boxShadow=m.enabled?'0 0 6px rgba(0,122,255,.6)':'none';
});
</script>
</body></html>`;
  }
}

function activate(context) {
  log("=== activate ===");

  statsProvider = new StatsViewProvider(context.extensionUri);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "keypilot.openStats";
  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);

  promptForApiKeyStartup();

  const provider = {
    async provideInlineCompletionItems(document, position, ctx, token) {
      if (ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && position.character === 0) return null;
      const text = await requestCompletion(document, position, ctx, token);
      if (!text || token?.isCancellationRequested) return null;
      lastSuggestion = { uri: document.uri.toString(), position, text };
      return [makeItem(document, position, text)];
    },
  };

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.window.registerWebviewViewProvider("keypilot.statsView", statsProvider),
    vscode.commands.registerCommand("keypilot.openStats", () =>
      vscode.commands.executeCommand("workbench.view.extension.keypilot")),
    vscode.commands.registerCommand("keypilot.setApiKey", promptForApiKey),
    vscode.commands.registerCommand("keypilot.setModel", promptForModel),
    vscode.commands.registerCommand("keypilot.trigger", () =>
      vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")),
    vscode.commands.registerCommand("keypilot.acceptNextWord", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || !lastSuggestion) return;
      const pos = ed.selection.active;
      const s = lastSuggestion;
      if (s.uri !== ed.document.uri.toString() ||
          pos.line !== s.position.line || pos.character !== s.position.character) return;
      const chunk = nextChunk(s.text);
      if (!chunk) return;
      await ed.edit(eb => eb.insert(pos, chunk));
      const remaining = s.text.slice(chunk.length);
      lastSuggestion = remaining.trim()
        ? { uri: s.uri, position: pos.translate(0, chunk.length), text: remaining }
        : null;
    }),
    vscode.commands.registerCommand("keypilot.resetTokens", () => {
      stats = { prompt: 0, completion: 0, total: 0, requests: 0 };
      updateStatusBar();
      statsProvider?.refresh();
    }),
    vscode.commands.registerCommand("keypilot.test", async () => {
      if (!cfg().get("apiKey")?.trim()) { await promptForApiKey(); return; }
      const ed = vscode.window.activeTextEditor;
      if (!ed) { vscode.window.showErrorMessage("Open a file first."); return; }
      const text = await getCompletion(ed.document, ed.selection.active, undefined);
      if (text) vscode.window.showInformationMessage("OK: " + text.slice(0, 80));
      else vscode.window.showErrorMessage("Failed. Log: " + LOG);
    })
  );
}

module.exports = { activate, deactivate: () => {} };
