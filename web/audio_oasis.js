// Audio Oasis -- mp3/wav loader, waveform chopper, sequential segment saver.
// Structure/classes/persistence follow the Oasis Suite pattern (Image Oasis /
// LTX2.3 Oasis / Video Oasis Viewer): one DOM widget whose getValue/setValue
// serializes the ENTIRE node state into workflow JSON under "audio_oasis_ui";
// the backend reads the same JSON at execute() time. GPL-3.0-or-later.
//
// Layout (suite-standard as of the v1.6 line): the waveform strip (canvas +
// scrub + transport/split tools) stays full width at the top; below it sits
// the IO/LTXO two-column body -- a fixed-width left column of collapsible
// sections (Track, Grid & Snap, Analysis, Help) with the Bypass bar pinned
// under it, and a right pane holding the Segments list (the node's output,
// so it takes the output-pane position, same as IO's viewer).
//
//  - Chopping / saving / BPM+key analysis all happen over plain fetch to
//    /audio_oasis/* routes while you edit -- no queued graph run, no
//    WebSocket. Only "which clip currently feeds the graph" needs execute().
//  - The waveform pane (canvas + chop handles + playhead) and the <audio>
//    element are built ONCE and mutated imperatively -- same reasoning as
//    LTX2.3 Oasis's player pane: an innerHTML rebuild would tear down
//    playback and force re-decoding the track on every keystroke elsewhere
//    in the node. The three slots (transport, left column, right pane)
//    re-render IO-style via innerHTML.
//  - Peaks/duration/channels/levels are read client-side via the Web Audio
//    API the instant a track loads -- free, instant, no server round trip.
//    BPM/key need librosa on the backend (optional dep; Analyze button).
//  - Saved segment sets survive ComfyUI restarts on disk (manifest.json
//    next to the files); "Load saved set" in the Track section restores a
//    set into a fresh node without re-chopping. See applyManifest().

import { app } from "../../scripts/app.js";

const SUPPORTED_EXTS = [".mp3", ".wav", ".flac", ".m4a", ".aac"];

// ONE AudioContext for the whole page, deliberately at module scope rather
// than per node instance. ComfyUI tears down and rebuilds DOM widgets on
// tab switches and workflow reloads (same lifecycle ltx23_oasis.js notes for
// its scene bar), so a per-instance context leaks one dead AudioContext per
// rebuild. Chrome hard-caps concurrent contexts at 6 and then throws
// NotSupportedError forever -- which shows up as the waveform mysteriously
// refusing to load after a handful of tab switches, fixed only by a browser
// refresh. Sharing one context across every instance makes that impossible.
let _AO_CTX = null;
function audioCtx() {
  if (_AO_CTX && _AO_CTX.state !== "closed") return _AO_CTX;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio API unavailable in this browser.");
  _AO_CTX = new Ctor();
  return _AO_CTX;
}

const CSS = `
.ao-widget{font-family:var(--io-sans,'DM Sans',sans-serif);background:var(--io-bg,#000);border:1px solid var(--io-bd,#3a3a3a);border-radius:6px;padding:0;width:100%;box-sizing:border-box;color:#ddd;overflow:hidden;display:flex;flex-direction:column;}
.ao-widget .ao-inner{padding:8px 10px 10px;display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;}
.ao-widget .ao-body{display:flex;gap:9px;flex:1;min-height:0;}
.ao-widget .ao-col-left-wrap{display:flex;flex-direction:column;flex:0 0 360px;min-height:0;min-width:0;overflow:hidden;}
.ao-widget .ao-col-left{display:flex;flex-direction:column;gap:9px;overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;min-width:0;}
.ao-widget .ao-col-left::-webkit-scrollbar{width:4px;}
.ao-widget .ao-col-left::-webkit-scrollbar-thumb{background:var(--io-bd,#3a3a3a);border-radius:2px;}
.ao-widget .ao-bypass-bar{flex:0 0 auto;padding-top:8px;margin-top:4px;border-top:1px solid var(--io-bd,#3a3a3a);}
.ao-widget .ao-bypass-btn{width:100%;box-sizing:border-box;height:30px;margin:0;border-radius:4px;border:1px solid var(--io-bd,#3a3a3a);background:#191919;color:#ddd;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;}
.ao-widget .ao-bypass-btn:hover{border-color:#777;color:#fff;}
.ao-widget .ao-bypass-btn.is-bypassed{background:var(--io-accent-dim,#4a5d82);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.ao-widget .ao-col-right{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:#161616;border:1px solid var(--io-bd,#3a3a3a);border-radius:5px;overflow:hidden;}
.ao-widget .ao-right-head{display:flex;align-items:center;gap:7px;padding:6px 9px;border-bottom:1px solid var(--io-bd,#3a3a3a);flex-shrink:0;}
.ao-widget .ao-right-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:8px 9px;display:flex;flex-direction:column;gap:7px;}
.ao-widget .ao-right-body::-webkit-scrollbar{width:4px;}
.ao-widget .ao-right-body::-webkit-scrollbar-thumb{background:var(--io-bd,#3a3a3a);border-radius:2px;}
.ao-widget .ao-section{background:var(--io-bg2,#2a2a2a);border:1px solid var(--io-bd,#3a3a3a);border-radius:5px;flex-shrink:0;}
.ao-widget .ao-sec-head{display:flex;align-items:center;gap:7px;padding:6px 9px;cursor:pointer;user-select:none;}
.ao-widget .ao-sec-title{flex:1;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;font-weight:700;letter-spacing:.07em;color:var(--io-accent,#6f8bbd);text-transform:uppercase;}
.ao-widget .ao-chevron{color:var(--io-dim,#888);transition:transform .15s;font-size:13px;}
.ao-widget .ao-chevron.open{transform:rotate(90deg);}
.ao-widget .ao-sec-body{padding:4px 9px 9px;display:flex;flex-direction:column;gap:7px;}
.ao-widget .ao-row{display:flex;align-items:center;gap:8px;}
.ao-widget .ao-label{font-size:10px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);flex-shrink:0;letter-spacing:.04em;}
.ao-widget .ao-mini{font-size:9px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);letter-spacing:.04em;}
.ao-widget .ao-input{flex:1;min-width:0;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#ddd;font-family:var(--io-sans,'DM Sans',sans-serif);font-size:11px;padding:4px 6px;outline:none;box-sizing:border-box;}
.ao-widget .ao-input:focus{border-color:var(--io-accent,#6f8bbd);}
.ao-widget .ao-btn{background:var(--io-accent-dim,#4a5d82);border:1px solid var(--io-accent,#6f8bbd);color:#fff;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;font-weight:700;padding:5px 8px;border-radius:4px;cursor:pointer;letter-spacing:.05em;}
.ao-widget .ao-btn:hover{background:var(--io-accent,#6f8bbd);}
.ao-widget .ao-btn:disabled{opacity:.4;cursor:default;background:var(--io-accent-dim,#4a5d82);}
.ao-widget .ao-btn-flat{background:#191919;border:1px solid var(--io-bd,#3a3a3a);color:#bbb;}
.ao-widget .ao-btn-flat:hover{border-color:#777;color:#fff;background:#191919;}
.ao-widget .ao-load-slot{display:flex;align-items:center;gap:8px;}
.ao-widget .ao-load-btn{flex:1;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;padding:6px 8px;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ao-widget .ao-load-slot.ao-drag-over .ao-load-btn{border-color:var(--io-accent,#6f8bbd);color:#fff;}
.ao-widget .ao-load-clear{background:none;border:none;color:var(--io-dim,#888);cursor:pointer;font-size:12px;flex-shrink:0;}
.ao-widget .ao-load-clear:hover{color:#fff;}
.ao-widget .ao-saved-list{display:flex;flex-direction:column;gap:4px;}
.ao-widget .ao-saved-row{display:flex;align-items:center;gap:8px;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;padding:4px 6px;cursor:pointer;}
.ao-widget .ao-saved-row:hover{border-color:var(--io-accent,#6f8bbd);}
.ao-widget .ao-saved-name{flex:1;min-width:0;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ao-widget .ao-facts{display:flex;flex-wrap:wrap;gap:4px 12px;}
.ao-widget .ao-fact{font-size:9px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);letter-spacing:.03em;}
.ao-widget .ao-fact b{color:#ddd;font-weight:700;}
.ao-widget .ao-wave-pane{position:relative;width:100%;height:120px;background:#111;border:1px solid var(--io-bd,#3a3a3a);border-radius:5px;overflow:hidden;flex-shrink:0;cursor:crosshair;user-select:none;}
.ao-widget .ao-wave-canvas{display:block;width:100%;height:100%;}
.ao-widget .ao-wave-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;letter-spacing:.05em;pointer-events:none;}
.ao-widget .ao-handle-layer{position:absolute;inset:0;pointer-events:none;}
.ao-widget .ao-handle{position:absolute;top:0;bottom:0;width:9px;margin-left:-4.5px;cursor:ew-resize;z-index:2;pointer-events:auto;}
.ao-widget .ao-handle::before{content:"";position:absolute;left:4px;top:0;bottom:0;width:1px;background:var(--io-go-bd,#4f7a56);}
.ao-widget .ao-handle::after{content:"";position:absolute;left:0;top:0;width:9px;height:9px;border-radius:2px;background:var(--io-go-bd,#4f7a56);}
.ao-widget .ao-handle:hover::before,.ao-widget .ao-handle.dragging::before{background:var(--io-accent,#6f8bbd);}
.ao-widget .ao-handle:hover::after,.ao-widget .ao-handle.dragging::after{background:var(--io-accent,#6f8bbd);}
.ao-widget .ao-playhead{position:absolute;top:0;bottom:0;width:1px;background:#fff;z-index:3;pointer-events:none;left:0;opacity:.85;}
.ao-widget .ao-scrub{position:relative;width:100%;height:14px;background:#161616;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;cursor:pointer;flex-shrink:0;overflow:hidden;}
.ao-widget .ao-scrub-fill{position:absolute;top:0;bottom:0;left:0;width:0;background:var(--io-accent-dim,#4a5d82);opacity:.6;}
.ao-widget .ao-transport{display:flex;align-items:center;gap:8px;flex-shrink:0;}
.ao-widget .ao-play-btn{width:26px;height:26px;flex-shrink:0;border-radius:4px;border:1px solid var(--io-accent,#6f8bbd);background:var(--io-accent-dim,#4a5d82);color:#fff;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0;}
.ao-widget .ao-play-btn:hover{background:var(--io-accent,#6f8bbd);}
.ao-widget .ao-play-btn:disabled{opacity:.4;cursor:default;}
.ao-widget .ao-time{font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;color:#ddd;letter-spacing:.03em;white-space:nowrap;}
.ao-widget .ao-split-tools{display:flex;align-items:center;gap:6px;}
.ao-widget .ao-split-tools .ao-input{flex:0 0 56px;text-align:center;}
.ao-widget .ao-seg-list{display:flex;flex-direction:column;gap:4px;}
.ao-widget .ao-seg-row{display:flex;align-items:center;gap:6px;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;padding:4px 6px;}
.ao-widget .ao-seg-row.ao-selected{border-color:var(--io-accent,#6f8bbd);background:#20263a;}
.ao-widget .ao-seg-row.ao-draggable{cursor:grab;}
.ao-widget .ao-seg-idx{font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;color:var(--io-dim,#888);width:20px;flex-shrink:0;}
.ao-widget .ao-seg-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;cursor:pointer;}
.ao-widget .ao-seg-times{font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;color:#ddd;}
.ao-widget .ao-frames{font-family:var(--io-mono,'Space Mono',monospace);font-size:9px;color:var(--io-go-bd,#4f7a56);margin-left:4px;}
.ao-widget .ao-frames-bad{color:#e0a050;}
.ao-widget .ao-seg-name{font-size:9px;color:var(--io-dim,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ao-widget .ao-seg-play{width:20px;height:20px;flex-shrink:0;border-radius:3px;border:1px solid var(--io-bd,#3a3a3a);background:#111;color:#bbb;cursor:pointer;font-size:9px;display:flex;align-items:center;justify-content:center;padding:0;}
.ao-widget .ao-seg-play:hover{border-color:#777;color:#fff;}
.ao-widget .ao-seg-grip{width:14px;flex-shrink:0;text-align:center;color:var(--io-dim,#888);font-size:11px;opacity:.6;cursor:grab;}
.ao-widget .ao-seg-del{background:none;border:none;color:var(--io-dim,#888);cursor:pointer;font-size:11px;flex-shrink:0;padding:0 2px;}
.ao-widget .ao-seg-del:hover{color:#e07050;}
.ao-widget .ao-unsaved-note{color:#c98;}
.ao-widget .ao-error-note{color:#e07050;}
.ao-widget .ao-ok-note{color:var(--io-go-bd,#4f7a56);}
.ao-widget .ao-empty-hint{font-size:9px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);letter-spacing:.03em;padding:4px 0;}
.ao-widget .ao-fulltrack{align-self:flex-start;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:6px 12px;cursor:pointer;transition:background .12s,border-color .12s,color .12s;}
.ao-widget .ao-fulltrack:hover{border-color:#777;color:#fff;}
.ao-widget .ao-fulltrack.active{background:var(--io-accent-dim,#4a5d82);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.ao-widget .ao-fulltrack.active:hover{background:var(--io-accent,#6f8bbd);border-color:var(--io-accent,#6f8bbd);}
.ao-widget .ao-fulltrack:disabled{opacity:.4;cursor:default;}
.ao-widget .ao-fulltrack:disabled:hover{border-color:var(--io-bd,#3a3a3a);color:var(--io-dim,#888);}
.ao-widget .ao-swatch{width:30px;height:26px;padding:0;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;background:#191919;cursor:pointer;flex-shrink:0;}
.ao-widget .ao-swatch::-webkit-color-swatch-wrapper{padding:2px;}
.ao-widget .ao-swatch::-webkit-color-swatch{border:none;border-radius:2px;}
.ao-widget .ao-hex{flex:0 0 76px;font-family:var(--io-mono,'Space Mono',monospace);text-transform:lowercase;}
.ao-widget .ao-theme-row{display:flex;align-items:center;gap:7px;padding:5px 8px;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;cursor:pointer;}
.ao-widget .ao-theme-row:hover{border-color:var(--io-accent,#6f8bbd);}
.ao-widget .ao-theme-row.active{border-color:var(--io-accent,#6f8bbd);box-shadow:inset 0 0 0 1px var(--io-accent-dim,#4a5d82);}
.ao-widget .ao-theme-chips{display:inline-flex;gap:2px;flex-shrink:0;}
.ao-widget .ao-theme-chip{width:11px;height:11px;border-radius:2px;border:1px solid rgba(255,255,255,.08);}
.ao-widget .ao-theme-nm{flex:1;min-width:0;font-family:var(--io-mono,'Space Mono',monospace);font-size:11px;font-weight:700;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ao-widget .ao-theme-meta{font-size:8px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);}
.ao-widget .ao-theme-del{background:none;border:none;color:var(--io-dim,#888);cursor:pointer;font-size:11px;flex-shrink:0;padding:0 2px;}
.ao-widget .ao-theme-del:hover{color:#e07050;}
.ao-widget .ao-help-body{height:300px;overflow-y:auto;padding:10px 12px;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#ddd;font-family:var(--io-sans,'DM Sans',sans-serif);font-size:12px;line-height:1.55;}
.ao-widget .ao-help-body > *:first-child{margin-top:0;}
.ao-widget .ao-help-body > *:last-child{margin-bottom:0;}
.ao-widget .ao-help-body h1{font-size:15px;margin:.4em 0 .35em;color:var(--io-accent,#6f8bbd);font-weight:700;letter-spacing:.02em;}
.ao-widget .ao-help-body h2{font-size:13px;margin:.9em 0 .25em;color:var(--io-accent,#6f8bbd);font-weight:700;}
.ao-widget .ao-help-body h3{font-size:12px;margin:.55em 0 .2em;color:#e6e6e6;font-weight:700;}
.ao-widget .ao-help-body h4{font-size:11px;margin:.4em 0 .15em;color:var(--io-dim,#888);text-transform:uppercase;letter-spacing:.05em;}
.ao-widget .ao-help-body p{margin:.4em 0;}
.ao-widget .ao-help-body ul,.ao-widget .ao-help-body ol{margin:.3em 0 .4em 1.3em;padding:0;}
.ao-widget .ao-help-body li{margin:.15em 0;}
.ao-widget .ao-help-body code{font-family:var(--io-mono,'Space Mono',monospace);font-size:11px;background:#0a0a0a;padding:1px 5px;border-radius:3px;color:#cfe5b9;}
.ao-widget .ao-help-body pre{background:#0a0a0a;border:1px solid var(--io-bd,#3a3a3a);border-radius:3px;padding:6px 8px;overflow-x:auto;margin:.4em 0;}
.ao-widget .ao-help-body pre code{background:none;padding:0;color:#cfe5b9;}
.ao-widget .ao-help-body a{color:var(--io-accent,#6f8bbd);text-decoration:none;}
.ao-widget .ao-help-body a:hover{text-decoration:underline;}
.ao-widget .ao-help-body hr{border:none;border-top:1px solid var(--io-bd,#3a3a3a);margin:.7em 0;}
.ao-widget .ao-help-body strong{color:#fff;}
.ao-widget .ao-help-body em{color:#c8d2e0;}
.ao-widget .ao-help-body blockquote{margin:.4em 0;padding:.2em 10px;border-left:3px solid var(--io-accent-dim,#4a5d82);background:rgba(0,0,0,.25);color:#d8d8d8;border-radius:0 3px 3px 0;}
.ao-widget .ao-help-body blockquote p{margin:.25em 0;}
`;

function injectCSS() {
  if (document.getElementById("ao-styles")) return;
  const s = document.createElement("style");
  s.id = "ao-styles";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fmtTime(s) {
  if (s == null || !isFinite(s)) return "--:--";
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1).padStart(4, "0");
  return `${m}:${rem}`;
}

function extOf(name) {
  const i = (name || "").lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function baseName(name) {
  const leaf = (name || "").split("/").pop() || "";
  const i = leaf.lastIndexOf(".");
  return i > 0 ? leaf.slice(0, i) : leaf;
}

function viewURL(filename, subfolder) {
  const p = new URLSearchParams({
    filename: (filename || "").split("/").pop(),
    subfolder: subfolder != null ? subfolder : ((filename || "").includes("/") ? filename.slice(0, filename.lastIndexOf("/")) : ""),
    type: "input", t: Date.now(),
  });
  return `${window.location.origin}/view?${p}`;
}

// ── In-node help ─────────────────────────────────────────────────────────
// Module-scope cache so audio_oasis_help_content.md is fetched once per
// page-load, not once per node. Listeners get notified on completion so any
// open node can re-render to swap the "Loading..." placeholder for content.
// Vendored from image_oasis.js (same converter, same rules) so Audio Oasis
// works standalone -- consistent with comfy_bridge_audio.py's reasoning.
let AO_HELP_HTML = "";
let AO_HELP_LOADING = null;
const AO_HELP_LISTENERS = new Set();

const loadHelpOnce = () => {
  if (AO_HELP_HTML || AO_HELP_LOADING) return;
  AO_HELP_LOADING = fetch("/audio_oasis/help")
    .then(r => r.text())
    .then(md => { AO_HELP_HTML = mdToHtml(md); AO_HELP_LISTENERS.forEach(fn => { try { fn(); } catch { } }); })
    .catch(e => { console.warn("[Audio Oasis] help fetch failed:", e); })
    .finally(() => { AO_HELP_LOADING = null; });
};

// Minimal Markdown -> HTML converter. Subset chosen to cover what the help
// file needs: headings (#..####), **bold**, *italic*, `code`, fenced code,
// [link](url), - / 1. lists, > blockquotes, --- hr, blank-line paragraph
// breaks. No nesting. Not a general-purpose parser.
function mdToHtml(md) {
  if (!md) return "";
  const escMd = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => {
    s = escMd(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    // Only http(s) hrefs become links; anything else (javascript:, data:,
    // relative junk) renders as plain text. The help file is repo-controlled
    // so this is defense in depth, not a live threat.
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt, href) =>
      /^https?:\/\//i.test(href) ? `<a href="${href}" target="_blank" rel="noopener">${txt}</a>` : txt);
    return s;
  };
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false, codeBuf = [];
  let listType = null;          // "ul" | "ol" | null
  let inQuote = false;
  let paraBuf = [];
  const flushPara = () => { if (paraBuf.length) { out.push(`<p>${inline(paraBuf.join(" "))}</p>`); paraBuf = []; } };
  const flushList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const flushQuote = () => { if (inQuote) { out.push("</blockquote>"); inQuote = false; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      flushAll();
      if (inCode) { out.push(`<pre><code>${escMd(codeBuf.join("\n"))}</code></pre>`); codeBuf = []; inCode = false; }
      else inCode = true;
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    if (/^---+\s*$/.test(raw)) { flushAll(); out.push("<hr/>"); continue; }
    let m;
    if ((m = raw.match(/^(#{1,4})\s+(.*)$/))) {
      flushAll();
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      continue;
    }
    if ((m = raw.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
      out.push(`<p>${inline(m[1])}</p>`);
      continue;
    }
    if ((m = raw.match(/^[-*]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (listType !== "ul") { flushList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = raw.match(/^\d+\.\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (listType !== "ol") { flushList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if (/^\s*$/.test(raw)) { flushAll(); continue; }
    flushList(); flushQuote();
    paraBuf.push(raw.trim());
  }
  flushAll();
  return out.join("\n");
}

// ── Theme machinery, independent of Image Oasis and LTX Oasis ────────────
//
// Audio Oasis owns its palette and named themes under /audio_oasis/theme*.
// Same approach LTX Oasis uses for its own palette: the override <style> is
// scoped to `.ao-widget` rather than `:root`, so IO's `:root` block and
// LTXO's `.iov-widget` block can all coexist on one canvas with different
// colors. We ALWAYS emit every var in the scoped block (not just the
// non-defaults) because IO writes its palette to `:root`, which would
// otherwise cascade into Audio Oasis for any var AO left unset.
//
// Variable NAMES stay `--io-*` across the suite (LTXO does the same); it is
// the scope that makes the palettes independent, not the naming.
const AO_THEME_VARS = [
  { k: "--io-accent", label: "Accent" },
  { k: "--io-accent-dim", label: "Accent (dim)" },
  { k: "--io-bg", label: "Background" },
  { k: "--io-bg2", label: "Panel" },
  { k: "--io-bd", label: "Border" },
  { k: "--io-dim", label: "Muted text" },
];
const AO_THEME_DEFAULTS = {
  "--io-accent": "#6f8bbd", "--io-accent-dim": "#4a5d82",
  "--io-bg": "#000000", "--io-bg2": "#2a2a2a", "--io-bd": "#3a3a3a", "--io-dim": "#888888",
};
// Chop handles, valid-length ticks, and the "saved" note read --io-go-bd.
// It is not user-editable here (the 6-var editor matches IO and LTXO), but
// it IS pinned in the scoped block for the same anti-bleed reason: IO's
// Background/Border sliders mirror into --io-go-bd at :root, and LTXO does
// the same in its own scope. Without this pin, theming Image Oasis would
// recolor Audio Oasis's waveform handles. (--io-go-fill is not pinned: no
// Audio Oasis rule reads it, since this node has no Generate button.)
const AO_GO_BD = "#4f7a56";

let AO_THEME = { ...AO_THEME_DEFAULTS };
// Editor instances register a redraw callback here so editing the theme on
// ONE Audio Oasis node repaints the swatches on ALL open ones.
const AO_THEME_LISTENERS = new Set();
let AO_NAMED_THEMES = [];

function applyTheme() {
  let el = document.getElementById("ao-theme-override");
  if (!el) { el = document.createElement("style"); el.id = "ao-theme-override"; }
  // ALWAYS re-append: injectCSS() runs at node creation and can land after
  // the module-scope theme load, and equal-specificity rules resolve by
  // document order. Re-appending re-asserts this block's winning position.
  document.head.appendChild(el);
  const decls = AO_THEME_VARS
    .map(v => `${v.k}:${AO_THEME[v.k] || AO_THEME_DEFAULTS[v.k]};`)
    .join("");
  el.textContent = `.ao-widget{${decls}--io-go-bd:${AO_GO_BD};}`;
}

// Fetch the saved palette once per page load. Called from each node's
// creation path, but only the FIRST call hits the backend: re-reading disk
// on every node add would clobber unsaved live edits (mid-tweak on node A,
// drop node B, colors snap back). On failure the flag stays false so the
// next add retries.
let AO_THEME_LOADED = false;
async function loadTheme() {
  if (AO_THEME_LOADED) { applyTheme(); return; }
  try {
    const saved = await (await fetch("/audio_oasis/theme")).json();
    AO_THEME = { ...AO_THEME_DEFAULTS, ...(saved || {}) };
    AO_THEME_LOADED = true;
  } catch (e) {
    console.warn("[Audio Oasis] theme load", e);
    AO_THEME = { ...AO_THEME_DEFAULTS };
  }
  applyTheme();
  AO_THEME_LISTENERS.forEach(fn => { try { fn(); } catch { } });
}

// Persist the active palette and repaint every open node. Only non-default
// values go to disk, so the CSS defaults stay the source of truth for
// anything untouched (an empty file means "all defaults").
async function saveTheme() {
  applyTheme();
  AO_THEME_LISTENERS.forEach(fn => { try { fn(); } catch { } });
  const payload = {};
  for (const { k } of AO_THEME_VARS) {
    if (AO_THEME[k] && AO_THEME[k] !== AO_THEME_DEFAULTS[k]) payload[k] = AO_THEME[k];
  }
  try {
    await fetch("/audio_oasis/theme", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) { console.warn("[Audio Oasis] theme save", e); }
}

// Parallel to the active palette above: a LIBRARY of named palettes the user
// can switch between. Applying one writes it into the active theme, so the
// choice survives restarts.
async function loadNamedThemes() {
  try {
    const r = await (await fetch("/audio_oasis/themes")).json();
    AO_NAMED_THEMES = Array.isArray(r) ? r : [];
  } catch (e) { console.warn("[Audio Oasis] named themes load", e); AO_NAMED_THEMES = []; }
}

// Sends the FULL set of six colors (not just non-defaults) so a named theme
// is a stable snapshot even if the defaults change in a later version.
async function saveNamedTheme(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return false;
  const colors = {};
  for (const { k } of AO_THEME_VARS) colors[k] = AO_THEME[k] || AO_THEME_DEFAULTS[k];
  try {
    const r = await fetch("/audio_oasis/save_named_theme", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed, colors }),
    });
    if (!r.ok) return false;
    await loadNamedThemes();
    // Save Theme also means "this is what I'm using now".
    await saveTheme();
    return true;
  } catch (e) { console.warn("[Audio Oasis] save named theme", e); return false; }
}

async function deleteNamedTheme(id) {
  try {
    await fetch(`/audio_oasis/themes/${id}`, { method: "DELETE" });
    await loadNamedThemes();
    AO_THEME_LISTENERS.forEach(fn => { try { fn(); } catch { } });
  } catch (e) { console.warn("[Audio Oasis] delete named theme", e); }
}

async function applyNamedTheme(id) {
  const t = AO_NAMED_THEMES.find(x => x.id === id);
  if (!t || !t.colors) return;
  AO_THEME = { ...AO_THEME_DEFAULTS, ...t.colors };
  await saveTheme();
}

// The palette is a per-install appearance preference, not a node feature, so
// fetch and apply as soon as the extension loads. That way a hard refresh
// restores the saved colors regardless of which workflow opens first. The
// per-node call remains as the retry path; the once-guard makes it cheap.
loadTheme();
loadNamedThemes();

app.registerExtension({
  name: "AudioOasis",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "AudioOasis") return;

    const _onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      if (_onCreated) _onCreated.apply(this, arguments);
      injectCSS();
      this.setSize([980, 720]);
      this.color = "#000000"; this.bgcolor = "#202020";
      this.serialize_widgets = true;
      const selfNode = this;

      // ── Persisted node state ──
      const defaultState = () => ({
        track_file: "",     // subfolder-qualified filename in ComfyUI's input dir
        track_name: "",     // save prefix, editable, defaults to the upload's basename
        duration: 0,        // seconds, filled in once the track decodes
        points: [],         // interior chop times (seconds), sorted, excludes 0 and duration
        segments: [],        // last-SAVED segment metadata from the backend
        saved_sig: "",        // boundary+fps signature at the time of the last successful save
        selected_file: "",     // qualified filename that feeds the AUDIO output
        analysis: null,          // {duration,sample_rate,channels,bpm,key} cached from /analyze
        fps: 25,                   // frame rate the chop grid is quantized to
        snap: "8n1",                 // "off" | "frame" | "8n1"
      });
      let st = defaultState();
      let uiState = { open: { load: true, grid: true, analysis: true, help: false, theme: false }, autoSplit: 8 };
      // Per-node draft text for the "save current palette as" field. Not
      // persisted: it's a transient input, not part of the node's state.
      let themeName = "";

      // ── Runtime-only (not persisted) ──
      let audioBuffer = null;     // decoded Web Audio buffer of the current track
      let peaks = null;           // {min:Float32Array,max:Float32Array,n} downsampled for drawing
      let stats = null;           // {peakDb,rmsDb} computed once per decode, NOT per render
      let dragIdx = -1;           // index into st.points currently being dragged, or -1
      let loading = false, loadError = "";
      let analyzing = false, analyzeError = "";
      let saving = false, saveError = "";
      let rafId = null;
      let savedSets = null;       // /audio_oasis/saved_tracks payload, fetched on demand
      let savedOpen = false, savedLoading = false, savedError = "";

      // The signature includes fps because the manifest's frame accounting is
      // derived from it: changing FPS after a save invalidates those numbers,
      // so the set must show as unsaved until re-saved. legacySig() accepts
      // the points-only format older workflows carry, so a set saved before
      // this change doesn't spuriously flip to "unsaved" on first load.
      const legacySig = () => JSON.stringify(st.points.map((p) => Math.round(p * 1000)));
      const boundarySig = () => JSON.stringify({ f: Math.round(fps() * 1000), p: st.points.map((p) => Math.round(p * 1000)) });
      const isSaved = () => !!st.segments.length
        && (st.saved_sig === boundarySig() || st.saved_sig === legacySig());
      const boundaries = () => [0, ...st.points, st.duration].filter((v, i, a) => i === 0 || v > a[i - 1]);

      // ── Frame grid / LTX 8n+1 quantization ───────────────────────────
      // LTX wants a frame count of 8n+1 per clip. If EVERY segment is 8n+1
      // then, chaining from boundary 0 at frame 0, boundary j must sit on a
      // frame ≡ j (mod 8). That makes each handle's legal positions a fixed
      // lattice of its own -- independent of where its neighbours currently
      // are -- so dragging one handle can never invalidate another.
      // st.points[i] is boundary i+1.
      const fps = () => Math.max(1, Number(st.fps) || 25);
      const toFrame = (t) => t * fps();
      const frameToTime = (f) => f / fps();
      const totalFrames = () => Math.floor(st.duration * fps() + 1e-6);
      const MIN_SEG_FRAMES = 9;   // 8*1+1; 8*0+1 is a single frame, useless
      const minGap = () => (st.snap === "8n1" ? MIN_SEG_FRAMES : 1);

      const snapFrame = (frame, bIndex) => {
        if (st.snap === "off") return frame;
        if (st.snap === "frame") return Math.round(frame);
        const target = ((bIndex % 8) + 8) % 8;
        const base = Math.round(frame);
        const delta = (((target - base) % 8) + 8) % 8;
        const up = base + delta, down = up - 8;
        return (Math.abs(up - frame) <= Math.abs(frame - down)) ? up : down;
      };

      // Snap a time onto boundary bIndex's lattice, kept clear of neighbours.
      // Returns null when the gap has no legal slot at all.
      const snapTime = (t, bIndex, loFrame, hiFrame) => {
        if (loFrame > hiFrame) return null;
        if (st.snap === "off") return Math.max(frameToTime(loFrame), Math.min(frameToTime(hiFrame), t));
        let f = snapFrame(toFrame(t), bIndex);
        const stride = st.snap === "8n1" ? 8 : 1;
        while (f < loFrame) f += stride;
        while (f > hiFrame) f -= stride;
        return f < loFrame ? null : frameToTime(f);
      };

      const segFrameLens = () => {
        const b = [0, ...st.points.map((p) => Math.round(toFrame(p))), totalFrames()];
        return b.slice(1).map((v, i) => v - b[i]);
      };
      const isValidLen = (L) => st.snap !== "8n1" || (L > 0 && L % 8 === 1);
      const nearest8n1 = (f) => 8 * Math.max(1, Math.round((f - 1) / 8)) + 1;

      // getValue() always reads the live `st`/`uiState` references on demand
      // (workflow save, queue-prompt serialize) -- there is nothing to push
      // eagerly. Matches ltx23_oasis.js's own save(), which is the same no-op.
      const save = () => {};

      // ── DOM skeleton (built once) ──
      // inner: [wavePane, scrub, transportSlot, body]
      // body:  [leftWrap(leftSlot + bypassBar), rightPane(rightHead + rightSlot)]
      const container = document.createElement("div");
      container.className = "ao-widget";
      container.tabIndex = 0;

      const inner = document.createElement("div");
      inner.className = "ao-inner";
      container.appendChild(inner);

      const wavePane = document.createElement("div");      // built once, persistent
      wavePane.className = "ao-wave-pane";
      const canvas = document.createElement("canvas");
      canvas.className = "ao-wave-canvas";
      canvas.width = 1200; canvas.height = 240;             // fixed backing store, CSS scales it
      wavePane.appendChild(canvas);
      const handleLayer = document.createElement("div");
      handleLayer.className = "ao-handle-layer";
      wavePane.appendChild(handleLayer);
      const playhead = document.createElement("div");
      playhead.className = "ao-playhead";
      wavePane.appendChild(playhead);
      const waveEmpty = document.createElement("div");
      waveEmpty.className = "ao-wave-empty";
      waveEmpty.textContent = "Load an audio file to see its waveform";
      wavePane.appendChild(waveEmpty);

      const scrub = document.createElement("div");
      scrub.className = "ao-scrub";
      const scrubFill = document.createElement("div");
      scrubFill.className = "ao-scrub-fill";
      scrub.appendChild(scrubFill);

      const transportSlot = document.createElement("div"); // transport + split tools (re-rendered)

      const body = document.createElement("div");
      body.className = "ao-body";
      const leftWrap = document.createElement("div");
      leftWrap.className = "ao-col-left-wrap";
      const leftSlot = document.createElement("div");      // sections (re-rendered)
      leftSlot.className = "ao-col-left";
      const bypassBar = document.createElement("div");     // built once, updated imperatively
      bypassBar.className = "ao-bypass-bar";
      const bypassBtn = document.createElement("button");
      bypassBtn.type = "button";
      bypassBtn.className = "ao-bypass-btn";
      bypassBar.appendChild(bypassBtn);
      leftWrap.appendChild(leftSlot);
      leftWrap.appendChild(bypassBar);

      const rightPane = document.createElement("div");
      rightPane.className = "ao-col-right";
      const rightHead = document.createElement("div");
      rightHead.className = "ao-right-head";
      const rightSlot = document.createElement("div");     // segment list (re-rendered)
      rightSlot.className = "ao-right-body";
      rightPane.appendChild(rightHead);
      rightPane.appendChild(rightSlot);

      body.appendChild(leftWrap);
      body.appendChild(rightPane);

      const audio = document.createElement("audio");
      audio.style.display = "none";
      audio.preload = "metadata";

      inner.appendChild(wavePane);
      inner.appendChild(scrub);
      inner.appendChild(transportSlot);
      inner.appendChild(body);
      container.appendChild(audio);

      // Same mode-4 toggle as Image Oasis's footer button (rgthree-style
      // bypass without leaving the node).
      const updateBypass = () => {
        const b = (selfNode.mode | 0) === 4;
        bypassBtn.classList.toggle("is-bypassed", b);
        bypassBtn.textContent = b ? "Activate Node" : "Bypass Node";
        bypassBtn.title = b
          ? "Node is bypassed (skipped at execution). Click to activate."
          : "Click to bypass this node (same as rgthree bypass / mode 4).";
      };
      bypassBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const MODE_ALWAYS = 0, MODE_BYPASS = 4;
        selfNode.mode = ((selfNode.mode | 0) === MODE_BYPASS) ? MODE_ALWAYS : MODE_BYPASS;
        app.graph?.setDirtyCanvas?.(true, true);
        updateBypass();
      });
      updateBypass();

      // ── Upload plumbing (identical convention to the other Oasis nodes) ──
      const uploadBlob = async (fileOrBlob, filename) => {
        const fname = filename || fileOrBlob.name || `audio_${Date.now()}.wav`;
        const body = new FormData();
        body.append("image", fileOrBlob, fname);
        body.append("overwrite", "true");
        const r = await (await fetch("/upload/image", { method: "POST", body })).json();
        if (!r || !r.name) throw new Error("upload returned no name");
        return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
      };

      const isSupported = (name) => SUPPORTED_EXTS.includes(extOf(name));

      // ── Track decode (Web Audio API, instant, client-side) ──
      // audioCtx() is module-level and shared; see the note at the top.
      const computePeaks = (buffer, buckets = 1200) => {
        const data = buffer.getChannelData(0); // peaks from channel 0 is enough for the display
        const min = new Float32Array(buckets), max = new Float32Array(buckets);
        const step = data.length / buckets;
        for (let i = 0; i < buckets; i++) {
          const s = Math.floor(i * step), e = Math.max(s + 1, Math.floor((i + 1) * step));
          let lo = 1, hi = -1;
          for (let j = s; j < e && j < data.length; j++) {
            const v = data[j];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          min[i] = lo; max[i] = hi;
        }
        return { min, max, n: buckets };
      };

      // Full-buffer scan: ~8M samples for a 3-minute track. Called ONCE per
      // decode and cached in `stats` -- recomputing it per render cost ~50ms
      // on every section toggle, chop-point commit, play and pause.
      const levelStats = (buffer) => {
        const data = buffer.getChannelData(0);
        let peak = 0, sumSq = 0;
        for (let j = 0; j < data.length; j++) {
          const a = Math.abs(data[j]);
          if (a > peak) peak = a;
          sumSq += data[j] * data[j];
        }
        const rms = Math.sqrt(sumSq / Math.max(1, data.length));
        const toDb = (v) => (v > 0 ? (20 * Math.log10(v)).toFixed(1) : "-inf");
        return { peakDb: toDb(peak), rmsDb: toDb(rms) };
      };

      const loadTrackIntoBuffer = async (qualifiedName) => {
        loading = true; loadError = ""; renderLeft();
        try {
          const resp = await fetch(viewURL(qualifiedName));
          if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
          const arr = await resp.arrayBuffer();
          audioBuffer = await audioCtx().decodeAudioData(arr);
          peaks = computePeaks(audioBuffer);
          stats = levelStats(audioBuffer);
          st.duration = audioBuffer.duration;
          st.points = st.points.filter((p) => p > 0 && p < st.duration);
          audio.src = viewURL(qualifiedName);
        } catch (e) {
          console.warn("[Audio Oasis] decode failed", e);
          loadError = `Could not decode this file in the browser: ${e?.message || e}`;
          audioBuffer = null; peaks = null; stats = null;
        } finally {
          loading = false;
          save(); renderAll();
        }
      };

      // ── Waveform drawing ──
      const drawWave = () => {
        const ctx = canvas.getContext("2d");
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        waveEmpty.style.display = peaks ? "none" : "flex";
        if (!peaks) return;
        const mid = h / 2;
        ctx.fillStyle = "#4a5d82";
        const colW = w / peaks.n;
        for (let i = 0; i < peaks.n; i++) {
          const x = i * colW;
          const yMin = mid + peaks.min[i] * mid * 0.92;
          const yMax = mid + peaks.max[i] * mid * 0.92;
          ctx.fillRect(x, Math.min(yMin, yMax), Math.max(1, colW - 0.5), Math.max(1, Math.abs(yMax - yMin)));
        }
        ctx.strokeStyle = "#3a3a3a";
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
      };

      // ── Chop handles (imperative, reconciled against st.points) ──
      const timeToFrac = (t) => (st.duration ? t / st.duration : 0);
      const fracToTime = (f) => Math.max(0, Math.min(st.duration, f * st.duration));

      const renderHandles = () => {
        const handleTitle = (t) => (st.snap === "off"
          ? `Chop point at ${fmtTime(t)} -- drag to move, double-click to remove`
          : `Chop point at ${fmtTime(t)} (frame ${Math.round(toFrame(t))}) -- drag to move, double-click to remove`);
        const els = handleLayer.querySelectorAll(".ao-handle");
        els.forEach((el) => el.remove());
        st.points.forEach((t, idx) => {
          const el = document.createElement("div");
          el.className = "ao-handle";
          el.style.left = `${timeToFrac(t) * 100}%`;
          el.title = handleTitle(t);
          el.addEventListener("pointerdown", (e) => {
            e.preventDefault(); e.stopPropagation();
            dragIdx = idx; el.classList.add("dragging");
            try { el.setPointerCapture(e.pointerId); } catch { /* capture unsupported; drag still tracks via pointermove */ }
          });
          el.addEventListener("pointermove", (e) => {
            if (dragIdx !== idx) return;
            const rect = wavePane.getBoundingClientRect();
            const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const gap = minGap();
            const loF = (idx > 0 ? Math.round(toFrame(st.points[idx - 1])) : 0) + gap;
            const hiF = (idx < st.points.length - 1
              ? Math.round(toFrame(st.points[idx + 1]))
              : totalFrames()) - gap;
            const snapped = snapTime(fracToTime(frac), idx + 1, loF, hiF);
            if (snapped == null) return;   // no legal frame in this gap
            st.points[idx] = snapped;
            el.style.left = `${timeToFrac(snapped) * 100}%`;
            el.title = handleTitle(snapped);
          });
          const commit = (e) => {
            if (dragIdx !== idx) return;
            dragIdx = -1; el.classList.remove("dragging");
            st.points.sort((a, b) => a - b);
            save(); renderRight(); renderHandles();
          };
          el.addEventListener("pointerup", commit);
          el.addEventListener("pointercancel", commit);
          el.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            st.points.splice(idx, 1); requantizeAll();
            save(); renderRight(); renderHandles();
          });
          el.addEventListener("contextmenu", (e) => {
            e.preventDefault(); e.stopPropagation();
            st.points.splice(idx, 1); requantizeAll();
            save(); renderRight(); renderHandles();
          });
          handleLayer.appendChild(el);
        });
      };

      // Inserting or removing a boundary shifts every LATER boundary's index
      // by one, which changes its required residue -- so the tail has to be
      // re-snapped. Points before the edit keep their index and residue, so
      // re-snapping them is a no-op; downstream ones move by at most a frame
      // or two. This is inherent to the 8n+1 chain, not avoidable.
      const requantizeAll = () => {
        if (st.snap === "off" || !st.duration) return;
        const gap = minGap(), total = totalFrames(), n = st.points.length;
        const out = [];
        let prevF = 0;
        st.points.forEach((t, i) => {
          const loF = prevF + gap;
          const hiF = total - gap * (n - i);
          const s = snapTime(t, out.length + 1, loF, hiF);
          if (s == null) return;               // no legal slot: drop it
          if (out.length && Math.round(toFrame(s)) === prevF) return;  // collapsed onto neighbour
          out.push(s);
          prevF = Math.round(toFrame(s));
        });
        st.points = out;
      };

      wavePane.addEventListener("click", (e) => {
        if (!audioBuffer || !st.duration || dragIdx !== -1) return;
        if (e.target.closest(".ao-handle")) return;
        const rect = wavePane.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const t = fracToTime(frac);
        if (st.points.some((p) => Math.abs(p - t) < Math.max(0.05, frameToTime(minGap())))) return;
        const at = st.points.filter((p) => p < t).length;
        st.points.splice(at, 0, t);
        requantizeAll();
        st.points.sort((a, b) => a - b);
        save(); renderRight(); renderHandles();
      });

      // ── Playback ──
      let rangeEnd = null;
      const onTimeUpdate = () => {
        if (rangeEnd != null && audio.currentTime >= rangeEnd - 0.02) {
          audio.pause();
          rangeEnd = null;
        }
      };
      audio.addEventListener("timeupdate", onTimeUpdate);
      audio.addEventListener("play", () => { renderTransport(); startPlayheadLoop(); });
      audio.addEventListener("pause", () => { renderTransport(); stopPlayheadLoop(); updatePlayheadNow(); });

      const playRange = (startS, endS) => {
        if (!st.track_file) return;
        rangeEnd = endS;
        audio.currentTime = Math.max(0, startS);
        audio.play().catch(() => {});
      };
      const togglePlayTrack = () => {
        if (!audio.paused) { audio.pause(); return; }
        rangeEnd = null;
        playRange(audio.currentTime || 0, st.duration);
      };

      const updatePlayheadNow = () => {
        const frac = st.duration ? (audio.currentTime / st.duration) : 0;
        playhead.style.left = `${Math.max(0, Math.min(1, frac)) * 100}%`;
        scrubFill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
        const timeEl = transportSlot.querySelector("[data-ao-time]");
        if (timeEl) timeEl.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(st.duration)}`;
      };
      const startPlayheadLoop = () => {
        stopPlayheadLoop();
        const step = () => { updatePlayheadNow(); rafId = requestAnimationFrame(step); };
        rafId = requestAnimationFrame(step);
      };
      const stopPlayheadLoop = () => { if (rafId) cancelAnimationFrame(rafId); rafId = null; };

      const seekFromEvent = (e) => {
        if (!st.duration) return;
        const rect = scrub.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        rangeEnd = null;
        audio.currentTime = frac * st.duration;
        updatePlayheadNow();
      };
      let scrubbing = false;
      scrub.addEventListener("pointerdown", (e) => { scrubbing = true; seekFromEvent(e); });
      scrub.addEventListener("pointermove", (e) => { if (scrubbing) seekFromEvent(e); });
      // Named so onRemoved can detach it -- an anonymous listener here leaked
      // one window-level handler per deleted node instance.
      const onWinPointerUp = () => { scrubbing = false; };
      window.addEventListener("pointerup", onWinPointerUp);

      // ── Track load / clear / drop ──
      const doUploadFile = async (file) => {
        if (!isSupported(file.name)) {
          loadError = `Unsupported type. Use ${SUPPORTED_EXTS.join(", ")}.`;
          renderLeft();
          return;
        }
        try {
          const qualified = await uploadBlob(file, file.name);
          st.track_file = qualified;
          st.track_name = baseName(file.name);
          st.points = []; st.segments = []; st.saved_sig = "";
          st.analysis = null; analyzeError = "";
          st.selected_file = qualified;
          save(); renderLeft();
          await loadTrackIntoBuffer(qualified);
        } catch (e) {
          console.warn("[Audio Oasis] upload failed", e);
          loadError = "Upload failed.";
          renderLeft();
        }
      };

      // Full defaults, not a hand-listed subset: an earlier version rebuilt
      // the state object here and dropped the fps/snap keys, leaving st.snap
      // undefined -- the snap dropdown rendered with no selection and every
      // snap comparison silently behaved as "off" until the user touched it.
      const clearTrack = () => {
        st = defaultState();
        audioBuffer = null; peaks = null; stats = null; analyzeError = ""; saveError = "";
        loadError = "";
        audio.pause(); audio.removeAttribute("src");
        save(); renderAll();
      };

      // ── Analysis ──
      const runAnalyze = async () => {
        if (!st.track_file || analyzing) return;
        analyzing = true; analyzeError = ""; renderLeft();
        try {
          const r = await (await fetch("/audio_oasis/analyze", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: st.track_file }),
          })).json();
          if (r.error) throw new Error(r.error);
          st.analysis = r; save();
        } catch (e) {
          analyzeError = String(e.message || e);
        } finally {
          analyzing = false; renderLeft();
        }
      };

      // ── Save segments ──
      const runSave = async () => {
        if (!st.track_file || saving) return;
        saving = true; saveError = ""; renderRight();
        try {
          const r = await (await fetch("/audio_oasis/save_segments", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: st.track_file, track_name: st.track_name, points: st.points, fps: fps() }),
          })).json();
          if (r.error) throw new Error(r.error);
          st.segments = r.segments || [];
          st.track_name = r.track_name || st.track_name;
          st.saved_sig = boundarySig();
          // Re-saving deletes the previous numbered set from disk. If the
          // selection pointed at a segment that no longer exists (e.g. seg005
          // when the new chop only produced three), the graph run would fail
          // at LoadAudio -- fall back to the full track.
          const valid = new Set([st.track_file, ...st.segments.map((s) => s.qualified)]);
          if (!valid.has(st.selected_file)) st.selected_file = st.track_file;
          save();
        } catch (e) {
          saveError = String(e.message || e);
        } finally {
          saving = false; renderRight();
        }
      };

      // ── Load a saved set from disk (manifest.json) ──
      const fetchSavedSets = async () => {
        savedLoading = true; savedError = ""; renderLeft();
        try {
          const r = await (await fetch("/audio_oasis/saved_tracks")).json();
          if (r.error) throw new Error(r.error);
          savedSets = r.sets || [];
        } catch (e) {
          savedError = String(e.message || e);
          savedSets = null;
        } finally {
          savedLoading = false; renderLeft();
        }
      };

      // Restore a saved set's full state from its manifest: track name, fps,
      // chop points (segment starts), segment list, selection. The source
      // track reloads into the waveform when it still exists in the input
      // folder; when it doesn't, the segments stay selectable and draggable
      // (they're real files on disk) with the waveform empty.
      const applyManifest = async (m, sourceExists) => {
        const segs = Array.isArray(m.segments) ? m.segments : [];
        if (!segs.length) { savedError = "Manifest has no segments."; renderLeft(); return; }
        st.track_name = m.track_name || st.track_name;
        if (m.fps) st.fps = m.fps;
        st.points = segs.slice(1)
          .map((s) => s.start)
          .filter((v) => typeof v === "number" && v > 0);
        st.segments = segs;
        st.track_file = m.source_filename || "";
        st.duration = segs[segs.length - 1].end || 0;
        st.analysis = null; analyzeError = ""; saveError = ""; loadError = "";
        st.saved_sig = boundarySig();
        st.selected_file = (sourceExists && st.track_file)
          ? st.track_file
          : ((segs.find((s) => s.exists !== false) || {}).qualified || "");
        audioBuffer = null; peaks = null; stats = null;
        audio.pause(); audio.removeAttribute("src");
        savedOpen = false;
        save(); renderAll();
        if (sourceExists && st.track_file) {
          await loadTrackIntoBuffer(st.track_file);
        } else {
          loadError = "Source track not found in the input folder. Waveform and "
            + "preview are unavailable, but the saved segments are still "
            + "selectable and draggable.";
          renderAll();
        }
      };

      const loadSavedSet = async (trackName) => {
        savedLoading = true; savedError = ""; renderLeft();
        try {
          const r = await (await fetch(`/audio_oasis/load_manifest?track=${encodeURIComponent(trackName)}`)).json();
          if (r.error) throw new Error(r.error);
          savedLoading = false;
          await applyManifest(r.manifest, !!r.source_exists);
        } catch (e) {
          savedLoading = false;
          savedError = String(e.message || e);
          renderLeft();
        }
      };

      // ── Transport strip (full width, under the scrub bar) ──
      const renderTransport = () => {
        const hasTrack = !!st.track_file;
        const stepFrames = st.snap === "8n1"
          ? nearest8n1((uiState.autoSplit || 8) * fps())
          : Math.max(1, Math.round((uiState.autoSplit || 8) * fps()));

        transportSlot.innerHTML = `
          <div class="ao-row ao-transport">
            <button class="ao-play-btn" data-play-track ${hasTrack ? "" : "disabled"}>${!audio.paused ? "\u23f8" : "\u25b6"}</button>
            <span class="ao-time" data-ao-time>${fmtTime(audio.currentTime || 0)} / ${fmtTime(st.duration)}</span>
            <div class="ao-split-tools" style="margin-left:auto">
              <span class="ao-mini">split every</span>
              <input class="ao-input" type="number" data-auto-split value="${uiState.autoSplit}" min="0.1" step="0.5"/>
              <span class="ao-mini">s${st.snap !== "off" ? ` \u2192 <b style="color:#ddd">${stepFrames}f</b> (${(stepFrames / fps()).toFixed(3)}s)` : ""}</span>
              <button class="ao-btn ao-btn-flat" data-apply-split ${hasTrack ? "" : "disabled"}>Apply</button>
              <button class="ao-btn ao-btn-flat" data-clear-points ${st.points.length ? "" : "disabled"}>Clear</button>
            </div>
          </div>`;

        transportSlot.querySelector("[data-play-track]")?.addEventListener("click", (e) => { e.stopPropagation(); togglePlayTrack(); });
        transportSlot.querySelector("[data-auto-split]")?.addEventListener("change", (e) => {
          uiState.autoSplit = Math.max(0.5, parseFloat(e.target.value) || 8);
          renderTransport();
        });
        transportSlot.querySelector("[data-apply-split]")?.addEventListener("click", (e) => {
          e.stopPropagation();
          const total = totalFrames();
          const pts = [];
          if (st.snap === "off") {
            const step = Math.max(0.1, uiState.autoSplit || 8);
            for (let t = step; t < st.duration - 0.05; t += step) pts.push(t);
          } else {
            // Exact frame stride, so every segment but the tail is identical
            // and (in 8n+1 mode) a legal LTX length.
            const stride = st.snap === "8n1"
              ? nearest8n1((uiState.autoSplit || 8) * fps())
              : Math.max(1, Math.round((uiState.autoSplit || 8) * fps()));
            for (let f = stride; f <= total - minGap(); f += stride) pts.push(frameToTime(f));
          }
          st.points = pts;
          save(); renderRight(); renderHandles();
        });
        transportSlot.querySelector("[data-clear-points]")?.addEventListener("click", (e) => {
          e.stopPropagation();
          st.points = []; save(); renderTransport(); renderRight(); renderHandles();
        });
        updatePlayheadNow();
      };

      // ── Left column: Track / Grid & Snap / Analysis / Help + bypass ──
      const sec = (key, title, bodyHtml) => `
        <div class="ao-section">
          <div class="ao-sec-head" data-sec="${key}">
            <span class="ao-sec-title">${title}</span>
            <span class="ao-chevron${uiState.open[key] ? " open" : ""}">\u203a</span>
          </div>
          ${uiState.open[key] ? `<div class="ao-sec-body">${bodyHtml}</div>` : ""}
        </div>`;

      const trackBody = () => {
        const savedList = () => {
          if (savedLoading) return `<div class="ao-mini">Loading saved sets\u2026</div>`;
          if (savedError) return `<div class="ao-mini ao-error-note">${esc(savedError)}</div>`;
          if (!savedSets || !savedSets.length) return `<div class="ao-mini">No saved sets found under input/audio_oasis/.</div>`;
          return `<div class="ao-saved-list">${savedSets.map((s) => `
            <div class="ao-saved-row" data-saved-load="${esc(s.track_name)}" title="Load this saved set">
              <span class="ao-saved-name">${esc(s.track_name)}</span>
              <span class="ao-mini">${s.segments} seg${s.segments === 1 ? "" : "s"}${s.saved_at ? ` \u00b7 ${new Date(s.saved_at * 1000).toLocaleDateString()}` : ""}${s.source_exists ? "" : " \u00b7 src missing"}</span>
            </div>`).join("")}</div>`;
        };
        return `
          <div class="ao-load-slot" data-drop-track title="Drop an mp3/wav/flac/m4a here, or click to browse">
            <button class="ao-load-btn" data-browse-track>${st.track_file ? esc(st.track_file) : "Upload audio (mp3/wav/flac/m4a)\u2026"}</button>
            ${st.track_file ? `<button class="ao-load-clear" data-clear-track title="Remove track">\u2715</button>` : ""}
          </div>
          ${st.track_file ? `<div class="ao-row">
            <span class="ao-label">Save as</span>
            <input class="ao-input" type="text" data-track-name value="${esc(st.track_name)}" placeholder="track name"/>
          </div>` : ""}
          ${loading ? `<div class="ao-mini">Decoding\u2026</div>` : ""}
          ${loadError ? `<div class="ao-mini ao-error-note">${esc(loadError)}</div>` : ""}
          <div class="ao-row">
            <button class="ao-btn ao-btn-flat" data-saved-toggle>${savedOpen ? "Hide saved sets" : "Load saved set\u2026"}</button>
          </div>
          ${savedOpen ? savedList() : ""}`;
      };

      const gridBody = () => {
        const facts = audioBuffer ? `
          <div class="ao-facts">
            <span class="ao-fact">ch <b>${audioBuffer.numberOfChannels}</b></span>
            <span class="ao-fact">sr <b>${audioBuffer.sampleRate}</b> Hz</span>
            <span class="ao-fact">dur <b>${fmtTime(st.duration)}</b></span>
            ${stats ? `<span class="ao-fact">peak <b>${stats.peakDb}</b> dB</span>` : ""}
            ${stats ? `<span class="ao-fact">rms <b>${stats.rmsDb}</b> dB</span>` : ""}
          </div>` : "";
        return `
          <div class="ao-row">
            <span class="ao-label">FPS</span>
            <input class="ao-input" style="flex:0 0 56px;text-align:center" type="number" data-fps value="${fps()}" min="1" max="240" step="1"/>
            <select class="ao-input" style="flex:1" data-snap>
              <option value="off"${st.snap === "off" ? " selected" : ""}>Snap: off</option>
              <option value="frame"${st.snap === "frame" ? " selected" : ""}>Snap: frames</option>
              <option value="8n1"${st.snap === "8n1" ? " selected" : ""}>Snap: 8n+1 (LTX)</option>
            </select>
          </div>
          <div class="ao-row">
            ${st.snap !== "off" && st.duration ? `<span class="ao-mini">1 frame = ${(1000 / fps()).toFixed(1)}ms \u00b7 track = ${totalFrames()}f</span>` : ""}
            <button class="ao-btn ao-btn-flat" style="margin-left:auto" data-fix-points ${st.points.length && st.snap !== "off" ? "" : "disabled"}>Re-snap</button>
          </div>
          ${facts}`;
      };

      const analysisBody = () => {
        const a = st.analysis;
        return `
          <div class="ao-row">
            <button class="ao-btn ao-btn-flat" data-analyze ${!st.track_file || analyzing ? "disabled" : ""}>${analyzing ? "Analyzing\u2026" : (a ? "Re-analyze" : "Analyze (BPM / key)")}</button>
            ${a ? `<span class="ao-mini">bpm <b style="color:#ddd">${a.bpm || "?"}</b> \u00b7 key <b style="color:#ddd">${esc(a.key || "?")}</b></span>` : ""}
          </div>
          ${analyzeError ? `<div class="ao-mini ao-error-note">${esc(analyzeError)}</div>` : ""}
          ${!analyzeError && analyzing ? `<div class="ao-mini">First run after a ComfyUI restart can take 10\u201330s (librosa warming up).</div>` : ""}`;
      };

      const helpBody = () => `
        <div class="ao-help-body">${AO_HELP_HTML || '<div class="ao-mini" style="opacity:.7">Loading help\u2026</div>'}</div>`;

      // One row per editable variable: a native color picker plus a hex field
      // (type or pick). Editing any row recolors every open Audio Oasis node
      // live, and only Audio Oasis nodes: the override is scoped to
      // .ao-widget, so IO and LTXO keep their own palettes on the same canvas.
      const themeRow = (v) => {
        const val = AO_THEME[v.k] || AO_THEME_DEFAULTS[v.k];
        return `<div class="ao-row">
          <span class="ao-label" style="flex:0 0 84px">${v.label}</span>
          <input class="ao-swatch" type="color" data-theme-pick="${v.k}" value="${esc(val)}"/>
          <input class="ao-input ao-hex" data-theme-hex="${v.k}" value="${esc(val)}" maxlength="7" spellcheck="false"/>
        </div>`;
      };

      // Which named theme (if any) exactly matches the live palette. Used to
      // flag that row as active in the library list.
      const activeNamedThemeId = () => {
        for (const t of AO_NAMED_THEMES) {
          const cs = t.colors || {};
          let match = true;
          for (const { k } of AO_THEME_VARS) {
            const a = AO_THEME[k] || AO_THEME_DEFAULTS[k];
            const b = cs[k] || AO_THEME_DEFAULTS[k];
            if (a !== b) { match = false; break; }
          }
          if (match) return t.id;
        }
        return null;
      };

      const namedThemesList = () => {
        if (!AO_NAMED_THEMES.length) {
          return `<div class="ao-mini" style="opacity:.6;padding:4px 2px">No saved themes yet. Tweak the colors above, type a name, and click Save Theme.</div>`;
        }
        const activeId = activeNamedThemeId();
        return AO_NAMED_THEMES.map((t) => {
          const cs = t.colors || {};
          const chips = AO_THEME_VARS.map((v) => {
            const c = cs[v.k] || AO_THEME_DEFAULTS[v.k];
            return `<span class="ao-theme-chip" style="background:${esc(c)}" title="${esc(v.label + ": " + c)}"></span>`;
          }).join("");
          const isActive = t.id === activeId;
          return `<div class="ao-theme-row${isActive ? " active" : ""}" data-theme-load="${esc(t.id)}" title="Click to apply">
            <span class="ao-theme-chips">${chips}</span>
            <span class="ao-theme-nm">${esc(t.name)}</span>
            ${isActive ? `<span class="ao-theme-meta">active</span>` : ""}
            <button class="ao-theme-del" data-theme-named-del="${esc(t.id)}" title="Delete theme">\u2715</button>
          </div>`;
        }).join("");
      };

      const themeBody = () => `
        ${AO_THEME_VARS.map(themeRow).join("")}
        <div class="ao-row">
          <input class="ao-input" data-theme-name placeholder="Save current as\u2026" maxlength="60" value="${esc(themeName)}"/>
          <button class="ao-btn" data-theme-save>Save Theme</button>
        </div>
        ${namedThemesList()}
        <div class="ao-row">
          <button class="ao-btn" data-theme-reset style="margin-top:0;flex:1">Reset to default</button>
        </div>
        <div class="ao-mini" style="opacity:.7">Audio Oasis keeps its own palette. Edits preview live across every Audio Oasis node and do not affect Image Oasis or LTX2.3 Oasis. Save Theme stores the current palette as a named entry; click any saved row to switch.</div>`;

      const renderLeft = () => {
        // Help body has its own scroll viewport; it gets destroyed and
        // recreated on each render, so preserve its position (and the
        // column's) or any toggle elsewhere yanks the reader back to the top.
        const leftTop = leftSlot.scrollTop;
        const helpEl = leftSlot.querySelector(".ao-help-body");
        const helpTop = helpEl ? helpEl.scrollTop : 0;

        if (uiState.open.help) loadHelpOnce();

        leftSlot.innerHTML = `
          ${sec("load", "Track", trackBody())}
          ${sec("grid", "Grid & Snap", gridBody())}
          ${sec("analysis", "Analysis", analysisBody())}
          ${sec("theme", "Theme", themeBody())}
          ${sec("help", "Help", helpBody())}`;

        leftSlot.querySelectorAll("[data-sec]").forEach((h) => {
          h.onclick = () => { const k = h.dataset.sec; uiState.open[k] = !uiState.open[k]; renderLeft(); };
        });
        leftSlot.querySelector("[data-browse-track]")?.addEventListener("click", (e) => {
          e.stopPropagation();
          const inp = document.createElement("input");
          inp.type = "file"; inp.accept = "audio/*," + SUPPORTED_EXTS.join(",");
          inp.onchange = () => { const f = inp.files?.[0]; if (f) doUploadFile(f); };
          inp.click();
        });
        leftSlot.querySelector("[data-clear-track]")?.addEventListener("click", (e) => { e.stopPropagation(); clearTrack(); });
        leftSlot.querySelector("[data-track-name]")?.addEventListener("change", (e) => {
          st.track_name = e.target.value; save();
        });
        leftSlot.querySelector("[data-saved-toggle]")?.addEventListener("click", (e) => {
          e.stopPropagation();
          savedOpen = !savedOpen;
          if (savedOpen) fetchSavedSets(); else renderLeft();
        });
        leftSlot.querySelectorAll("[data-saved-load]").forEach((el) => {
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            loadSavedSet(el.dataset.savedLoad);
          });
        });
        leftSlot.querySelector("[data-analyze]")?.addEventListener("click", (e) => { e.stopPropagation(); runAnalyze(); });
        leftSlot.querySelector("[data-fps]")?.addEventListener("change", (e) => {
          const v = Math.max(1, Math.min(240, parseFloat(e.target.value) || 25));
          st.fps = v; requantizeAll();
          save(); renderTransport(); renderLeft(); renderRight(); renderHandles();
        });
        leftSlot.querySelector("[data-snap]")?.addEventListener("change", (e) => {
          st.snap = e.target.value; requantizeAll();
          save(); renderTransport(); renderLeft(); renderRight(); renderHandles();
        });
        leftSlot.querySelector("[data-fix-points]")?.addEventListener("click", (e) => {
          e.stopPropagation(); requantizeAll();
          save(); renderRight(); renderHandles();
        });
        // ── Theme bindings ──
        // Swatch drags fire `input` continuously: recolor live off AO_THEME
        // and applyTheme() only. The debounced `change` is what persists, so
        // dragging a picker doesn't hammer the backend with a write per pixel.
        leftSlot.querySelectorAll("[data-theme-pick]").forEach((el) => {
          el.addEventListener("input", (e) => {
            AO_THEME[el.dataset.themePick] = e.target.value;
            applyTheme();
            const hex = leftSlot.querySelector(`[data-theme-hex="${el.dataset.themePick}"]`);
            if (hex) hex.value = e.target.value;
          });
          el.addEventListener("change", () => { saveTheme(); });
        });
        leftSlot.querySelectorAll("[data-theme-hex]").forEach((el) => {
          el.addEventListener("change", (e) => {
            let v = (e.target.value || "").trim().toLowerCase();
            if (!v.startsWith("#")) v = "#" + v;
            // Reject anything that isn't a 6-digit hex rather than writing a
            // value the color input can't display; snap the field back.
            if (!/^#[0-9a-f]{6}$/.test(v)) { renderLeft(); return; }
            AO_THEME[el.dataset.themeHex] = v;
            saveTheme();
            renderLeft();
          });
        });
        leftSlot.querySelector("[data-theme-name]")?.addEventListener("input", (e) => {
          themeName = e.target.value;
        });
        leftSlot.querySelector("[data-theme-save]")?.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!themeName.trim()) return;
          const ok = await saveNamedTheme(themeName);
          if (ok) themeName = "";
          renderLeft();
        });
        leftSlot.querySelectorAll("[data-theme-load]").forEach((el) => {
          el.addEventListener("click", async (e) => {
            e.stopPropagation();
            await applyNamedTheme(el.dataset.themeLoad);
            renderLeft();
          });
        });
        leftSlot.querySelectorAll("[data-theme-named-del]").forEach((el) => {
          el.addEventListener("click", async (e) => {
            // Stop the click reaching the row behind it, which would apply
            // the theme being deleted.
            e.stopPropagation();
            await deleteNamedTheme(el.dataset.themeNamedDel);
            renderLeft();
          });
        });
        leftSlot.querySelector("[data-theme-reset]")?.addEventListener("click", async (e) => {
          e.stopPropagation();
          AO_THEME = { ...AO_THEME_DEFAULTS };
          await saveTheme();
          renderLeft();
        });

        const dropZone = leftSlot.querySelector("[data-drop-track]");        if (dropZone) {
          dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("ao-drag-over"); });
          dropZone.addEventListener("dragleave", () => dropZone.classList.remove("ao-drag-over"));
          dropZone.addEventListener("drop", (e) => {
            e.preventDefault(); e.stopPropagation();
            dropZone.classList.remove("ao-drag-over");
            const f = e.dataTransfer?.files?.[0];
            if (f) doUploadFile(f);
          });
        }

        leftSlot.scrollTop = leftTop;
        const help2 = leftSlot.querySelector(".ao-help-body");
        if (help2 && helpTop) help2.scrollTop = helpTop;
        updateBypass();
      };
      AO_HELP_LISTENERS.add(renderLeft);
      // Editing the palette on any Audio Oasis node repaints the swatches on
      // every open one (it is a per-install setting, not per node). Also the
      // retry path for the module-scope load, cheap when it already succeeded.
      AO_THEME_LISTENERS.add(renderLeft);
      loadTheme();

      // ── Right pane: segments (the node's output) ──
      const renderRight = () => {
        const hasTrack = !!st.track_file;
        const bounds = boundaries();
        const previewSegs = [];
        for (let i = 0; i < bounds.length - 1; i++) previewSegs.push({ start: bounds[i], end: bounds[i + 1] });
        const saved = isSaved();
        const fLens = segFrameLens();
        const badCount = fLens.filter((L) => !isValidLen(L)).length;

        rightHead.innerHTML = `<span class="ao-sec-title">Segments (${previewSegs.length})</span>`;

        const segRows = previewSegs.map((seg, i) => {
          const savedSeg = saved ? st.segments[i] : null;
          // exists === false only ever comes from a loaded manifest whose
          // file was deleted from disk by hand; segments from a fresh save
          // don't carry the key and count as present.
          const fileOk = savedSeg ? savedSeg.exists !== false : false;
          const qualified = fileOk ? savedSeg.qualified : null;
          const selected = qualified ? st.selected_file === qualified : false;
          const L = fLens[i];
          const good = isValidLen(L);
          const frameTag = st.snap === "off" ? ""
            : `<span class="ao-frames${good ? "" : " ao-frames-bad"}" title="${good ? `8*${(L - 1) / 8}+1 frames` : "not 8n+1 -- LTX will reject this length"}">${L}f${st.snap === "8n1" ? (good ? " \u2713" : " \u26a0") : ""}</span>`;
          return `<div class="ao-seg-row${selected ? " ao-selected" : ""}${qualified ? " ao-draggable" : ""}" data-seg-row="${i}" ${qualified ? `draggable="true"` : ""}>
            <span class="ao-seg-idx">${i + 1}</span>
            <div class="ao-seg-main" data-seg-select="${i}">
              <span class="ao-seg-times">${fmtTime(seg.start)} \u2013 ${fmtTime(seg.end)} (${fmtTime(seg.end - seg.start)}) ${frameTag}</span>
              <span class="ao-seg-name">${savedSeg ? esc(savedSeg.filename) + (fileOk ? "" : " (file missing)") : "not saved yet"}</span>
            </div>
            <button class="ao-seg-play" data-seg-play="${i}" title="Play this segment">\u25b6</button>
            ${qualified ? `<span class="ao-seg-grip" title="Drag onto LTX2.3 Oasis's audio slot">\u22ee\u22ee</span>` : ""}
          </div>`;
        }).join("");

        const unsavedNote = hasTrack && !saved && st.points.length
          ? `<div class="ao-mini ao-unsaved-note">Unsaved changes \u2014 save to get real files you can drag out.</div>`
          : (hasTrack && !st.points.length
            ? `<div class="ao-mini">No chop points yet: saving keeps the whole track as one segment.</div>`
            : "");

        // The tail almost never lands on 8n+1 by luck -- the track just ends
        // where it ends. Flag it rather than silently trimming the user's audio.
        const badNote = (st.snap === "8n1" && badCount)
          ? `<div class="ao-mini ao-frames-bad">\u26a0 ${badCount} segment${badCount > 1 ? "s" : ""} not 8n+1 (usually the last one \u2014 the track just ends where it ends). Drag its handle, delete it, or leave it and don't feed that one to LTX.</div>`
          : "";

        const trackSelected = st.selected_file === st.track_file;

        rightSlot.innerHTML = `
          <button class="ao-fulltrack${trackSelected ? " active" : ""}" data-seg-track-row ${hasTrack ? "" : "disabled"} title="${trackSelected ? "The whole track feeds the AUDIO output. Click a segment below to switch." : "Send the whole track to the AUDIO output instead of a single segment."}">Use full track as output</button>
          <div class="ao-seg-list">${segRows || `<div class="ao-empty-hint">Load a track to see segments here.</div>`}</div>
          ${unsavedNote}
          ${badNote}
          ${saveError ? `<div class="ao-mini ao-error-note">${esc(saveError)}</div>` : ""}
          ${saved ? `<div class="ao-mini ao-ok-note">Saved \u2192 audio_oasis/${esc(st.track_name)}/</div>` : ""}
          <div class="ao-row" style="margin-top:auto;padding-top:4px">
            <button class="ao-btn" data-save-segments ${hasTrack && !saving ? "" : "disabled"}>${saving ? "Saving\u2026" : "Save segments"}</button>
          </div>`;

        rightSlot.querySelector("[data-save-segments]")?.addEventListener("click", (e) => { e.stopPropagation(); runSave(); });
        rightSlot.querySelector("[data-seg-track-row]")?.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!st.track_file) return;
          st.selected_file = st.track_file; save(); renderRight();
        });
        rightSlot.querySelectorAll("[data-seg-select]").forEach((el) => {
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            const i = Number(el.dataset.segSelect);
            const savedSeg = saved ? st.segments[i] : null;
            if (savedSeg && savedSeg.exists !== false) {
              st.selected_file = savedSeg.qualified; save(); renderRight();
            }
          });
        });
        rightSlot.querySelectorAll("[data-seg-play]").forEach((el) => {
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            const i = Number(el.dataset.segPlay);
            const seg = previewSegs[i];
            if (seg) playRange(seg.start, seg.end);
          });
        });
        // Custom in-app drag payload: dragging a saved segment chip onto ANY
        // node's file-drop target (e.g. LTX2.3 Oasis's audio slot) delivers
        // "application/x-oasis-audio" -> the qualified input-folder filename,
        // same convention as the frame-drag payload other Oasis nodes already
        // use for images. text/uri-list is required alongside it because
        // Chromium clears File items when any string type is added to the
        // drag data store. See ltx23_oasis.js's audio-drop patch.
        rightSlot.querySelectorAll("[data-seg-row]").forEach((row) => {
          row.addEventListener("dragstart", (e) => {
            const i = Number(row.dataset.segRow);
            const savedSeg = saved ? st.segments[i] : null;
            if (!savedSeg || savedSeg.exists === false) { e.preventDefault(); return; }
            e.dataTransfer.setData("application/x-oasis-audio", savedSeg.qualified);
            e.dataTransfer.setData("text/uri-list", viewURL(savedSeg.filename, savedSeg.subfolder));
            e.dataTransfer.setData("text/plain", savedSeg.qualified);
            e.dataTransfer.effectAllowed = "copy";
          });
        });
        updatePlayheadNow();
      };

      const renderAll = () => { renderTransport(); renderLeft(); renderRight(); drawWave(); renderHandles(); };

      // ── Teardown ──
      // Pause playback (a detached <audio> can keep playing), stop the rAF
      // loop, and detach the window-level listener and help listener so a
      // deleted node doesn't leak handlers.
      const prevOnRemoved = this.onRemoved;
      this.onRemoved = function () {
        try {
          audio.pause();
          audio.removeAttribute("src");
          stopPlayheadLoop();
          window.removeEventListener("pointerup", onWinPointerUp);
          AO_HELP_LISTENERS.delete(renderLeft);
          AO_THEME_LISTENERS.delete(renderLeft);
        } catch { /* best-effort cleanup */ }
        if (prevOnRemoved) prevOnRemoved.apply(this, arguments);
      };

      // ── Widget mount + persistence ──
      const auto = this.widgets?.findIndex((w) => w.name === "audio_oasis_ui");
      if (auto >= 0) this.widgets.splice(auto, 1);

      this.addDOMWidget("audio_oasis_ui", "div", container, {
        hideOnZoom: false,
        getValue: () => JSON.stringify({ version: 1, exec: st, ui: { open: uiState.open, autoSplit: uiState.autoSplit } }),
        setValue: (v) => {
          try {
            const o = JSON.parse(v);
            if (!o || typeof o !== "object") return;
            if (o.exec && typeof o.exec === "object") st = { ...st, ...o.exec };
            if (o.ui) {
              if (o.ui.open) uiState.open = { ...uiState.open, ...o.ui.open };
              if (o.ui.autoSplit) uiState.autoSplit = o.ui.autoSplit;
            }
            renderAll();
            if (st.track_file) loadTrackIntoBuffer(st.track_file);
          } catch { /* malformed payload -> keep defaults */ }
        },
      });

      renderAll();
    };
  },
});
