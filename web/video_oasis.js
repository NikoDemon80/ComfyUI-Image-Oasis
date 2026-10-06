import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/* ==================================================================
 * Video Oasis Viewer -- frontend
 *
 * Full in-node video viewer + encode/save:
 *  - Player: play/scrub/frame-step, off→loop→cycle, mute, speed, lightbox
 *  - Frame drag: pause and drag the current frame onto any image input
 *    (Load Image, Image Oasis refs, LTX Start/guides, etc.)
 *  - Scene bar: thumbs, delete, long-press reorder, + load from output/
 *  - Clip (mark in/out) and Create Movie (concat saved clips)
 *  - Encode / Save section (LTXO-matching) + square Save on that bar via /video_oasis/save
 *
 * Architecture (Image Oasis pattern):
 *  - One DOM widget "video_oasis_ui" serializes config, io_id, history,
 *    and player prefs into workflow JSON.
 *  - Results routed by stable io_id over "video-oasis/result" WS.
 *  - Player pane built once (imperative); settings re-render IO-style.
 *  - Theme follows LTX2.3 Oasis palette (--io-* scoped onto .vo-widget).
 * ================================================================== */

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

const CSS = `
.vo-widget{font-family:var(--io-sans,'DM Sans',sans-serif);background:var(--io-bg,#000);border:1px solid var(--io-bd,#3a3a3a);border-radius:6px;padding:0;width:100%;height:100%;box-sizing:border-box;color:#ddd;overflow:hidden;display:flex;flex-direction:column;}
.vo-inner{padding:8px 10px 10px;display:flex;flex-direction:column;gap:8px;flex:1;overflow:hidden;min-height:0;}
.vo-sections{display:flex;flex-direction:column;gap:8px;flex-shrink:0;}
.vo-sec-row{--vo-encode-bar-h:34px;display:flex;align-items:flex-start;gap:6px;}
.vo-sec-row>.vo-section{flex:1;min-width:0;}
.vo-section{background:var(--io-bg2,#2a2a2a);border:1px solid var(--io-bd,#3a3a3a);border-radius:5px;overflow:visible;flex-shrink:0;}
.vo-sec-head{display:flex;align-items:center;gap:7px;box-sizing:border-box;height:calc(var(--vo-encode-bar-h,34px) - 2px);padding:0 9px;cursor:pointer;user-select:none;}
.vo-sec-title{flex:1;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;font-weight:700;letter-spacing:.07em;color:var(--io-accent,#6f8bbd);text-transform:uppercase;}
.vo-chevron{color:var(--io-dim,#888);transition:transform .15s;font-size:13px;line-height:1;}
.vo-chevron.open{transform:rotate(90deg);}
.vo-sec-body{padding:4px 9px 9px;display:flex;flex-direction:column;gap:7px;}
.vo-sec-row>.vo-icon-btn.vo-save{flex-shrink:0;box-sizing:border-box;width:var(--vo-encode-bar-h);height:var(--vo-encode-bar-h);margin:0;padding:0;font-size:15px;line-height:1;background:var(--io-accent-dim,#4a5d82);border:1px solid var(--io-accent,#6f8bbd);color:#fff;}
.vo-sec-row>.vo-icon-btn.vo-save:hover{background:var(--io-accent,#6f8bbd);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.vo-sec-row>.vo-icon-btn.vo-save.vo-saved-mark{color:var(--io-go-bd,#4f7a56);}
.vo-row{display:flex;align-items:center;gap:8px;}
.vo-row.vo-dim{opacity:.45;}
.vo-label{font-size:10px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);width:74px;flex-shrink:0;letter-spacing:.04em;}
.vo-mini{font-size:9px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);letter-spacing:.04em;}
.vo-select,.vo-input{flex:1;min-width:0;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#ddd;font-family:var(--io-sans,'DM Sans',sans-serif);font-size:11px;padding:4px 6px;outline:none;box-sizing:border-box;}
.vo-select:focus,.vo-input:focus{border-color:var(--io-accent,#6f8bbd);}
.vo-toggle-grp{display:flex;gap:0;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;overflow:hidden;flex:1;}
.vo-tog{flex:1;background:#191919;border:none;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;line-height:1.15;padding:5px 4px;cursor:pointer;letter-spacing:.04em;transition:all .12s;}
.vo-tog.active{background:var(--io-accent-dim,#4a5d82);color:#fff;font-weight:700;}
/* ── Player pane (mirrors io-col-right) ── */
.vo-pane{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:#161616;border:1px solid var(--io-bd,#3a3a3a);border-radius:5px;overflow:hidden;}
.vo-stage{position:relative;flex:1;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:9px;box-sizing:border-box;}
.vo-stage video{width:100%;height:100%;object-fit:contain;display:block;outline:none;background:#000;border-radius:4px;border:1px solid var(--io-bd,#3a3a3a);}
.vo-empty{color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;text-align:center;margin:auto;padding:20px;line-height:1.6;}
.vo-badge{position:absolute;top:14px;left:14px;background:rgba(0,0,0,.65);padding:2px 7px;border-radius:4px;font-size:10px;font-family:var(--io-mono,'Space Mono',monospace);pointer-events:none;transition:opacity .4s;z-index:3;}
.vo-badge.vo-hide{opacity:0;}
.vo-toast{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(20,20,20,.92);border:1px solid #555;padding:4px 12px;border-radius:5px;pointer-events:none;opacity:0;transition:opacity .25s;max-width:92%;text-align:center;font-size:11px;z-index:4;}
.vo-toast.vo-show{opacity:1;}
/* ── Scrub row ── */
.vo-scrubrow{display:flex;align-items:center;gap:8px;padding:5px 9px 2px;flex-shrink:0;}
.vo-scrub{flex:1;accent-color:var(--io-accent,#6f8bbd);height:14px;cursor:pointer;min-width:0;}
.vo-time{font-variant-numeric:tabular-nums;color:var(--io-dim,#888);white-space:nowrap;font-family:var(--io-mono,'Space Mono',monospace);font-size:9px;letter-spacing:.02em;}
/* ── Control bar along the bottom of the pane (io-preview-head as a footer) ── */
.vo-ctrlbar{display:flex;align-items:center;gap:6px;padding:6px 9px;border-top:1px solid var(--io-bd,#3a3a3a);flex-shrink:0;}
.vo-icon-btn{background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#bbb;cursor:pointer;flex-shrink:0;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:13px;line-height:1;}
.vo-icon-btn:hover{border-color:#777;color:#fff;}
.vo-icon-btn:disabled{opacity:.35;cursor:default;}
.vo-icon-btn.vo-on{background:var(--io-accent-dim,#4a5d82);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.vo-btn-save{background:var(--io-accent-dim,#4a5d82);border:1px solid var(--io-accent,#6f8bbd);border-radius:4px;color:#fff;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;font-weight:700;height:26px;padding:0 8px;cursor:pointer;letter-spacing:.05em;flex-shrink:0;display:inline-flex;align-items:center;gap:4px;}
.vo-btn-save:hover{background:var(--io-accent,#6f8bbd);}
.vo-btn-save:disabled{opacity:.35;cursor:default;}
.vo-btn-movie-audio{background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#bbb;font-family:var(--io-mono,'Space Mono',monospace);font-size:12px;font-weight:700;height:26px;padding:0 8px;cursor:pointer;letter-spacing:.05em;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;gap:4px;box-sizing:border-box;}
.vo-btn-movie-audio:hover{border-color:#777;color:#fff;}
.vo-btn-movie-audio.vo-on{background:var(--io-accent-dim,#4a5d82);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.vo-btn-movie-audio:disabled{opacity:.35;cursor:default;}
.vo-clip-mark{font-variant-numeric:tabular-nums;font-size:9px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);flex-shrink:0;min-width:0;}
.vo-clip-mark.on{color:var(--io-accent,#6f8bbd);}
.vo-speed{background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#bbb;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;height:26px;padding:0 3px;cursor:pointer;outline:none;flex-shrink:0;}
.vo-speed:focus{border-color:var(--io-accent,#6f8bbd);}
/* ── Info bar (io-info-bar) with history nav ── */
.vo-infobar{padding:3px 10px;font-family:var(--io-mono,'Space Mono',monospace);font-size:8px;color:var(--io-dim,#888);letter-spacing:.06em;background:rgba(0,0,0,.25);border-top:1px solid var(--io-bd,#3a3a3a);white-space:nowrap;overflow:hidden;flex-shrink:0;height:20px;line-height:14px;box-sizing:border-box;display:flex;align-items:center;gap:6px;}
.vo-info-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.vo-info-text.vo-warn{color:#e0a050;}
.vo-info-label{font-weight:700;color:var(--io-accent,#6f8bbd);}
.vo-nav{display:inline-flex;align-items:center;gap:4px;flex-shrink:0;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:9px;letter-spacing:.04em;}
.vo-nav-arrow{background:none;border:none;color:var(--io-dim,#888);cursor:pointer;font-size:14px;line-height:1;padding:0 4px;font-family:var(--io-mono,'Space Mono',monospace);}
.vo-nav-arrow:hover{color:var(--io-accent,#6f8bbd);}
/* ── History / scene bar (inside pane, matches LTXO) ── */
.vo-history{display:flex;gap:5px;overflow-x:auto;padding:4px 9px 6px;min-height:58px;flex-shrink:0;border-top:1px solid var(--io-bd,#3a3a3a);}
/* Scoped one level deeper than the element's own class, and with an explicit
   :hover twin. ComfyUI ships a global ::-webkit-scrollbar-thumb:hover rule;
   the :hover pseudo-class raises its specificity to a dead tie with a
   single-class rule of ours, and ties go to whichever stylesheet loaded last,
   which is ComfyUI's. The thumb then repaints in the menu color on hover and
   vanishes against the node body. The extra widget-class scope outranks it
   outright; the :hover twin makes it explicit so the next stylesheet change
   upstream can't quietly win it back. */
.vo-widget .vo-history::-webkit-scrollbar{height:6px;}
.vo-widget .vo-history::-webkit-scrollbar-thumb{background:var(--io-bd,#3a3a3a);border-radius:3px;}
.vo-widget .vo-history::-webkit-scrollbar-thumb:hover{background:var(--io-bd,#3a3a3a);}
.vo-thumb{position:relative;flex:0 0 auto;width:88px;height:50px;border-radius:4px;border:2px dashed var(--io-go-bd,#4f7a56);cursor:pointer;background:#000 center/cover no-repeat;box-sizing:border-box;transition:box-shadow .12s ease;}
.vo-thumb:hover{box-shadow:0 0 0 1px rgba(255,255,255,.18);}
.vo-thumb.vo-saved{border-style:solid;}
.vo-thumb.vo-active{border-color:var(--io-accent,#6f8bbd);}
.vo-thumb.vo-cycling{border-color:#e0a800;}
.vo-thumb-x{position:absolute;right:3px;top:3px;width:14px;height:14px;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.75);color:#eee;border-radius:50%;font-size:9px;line-height:1;font-weight:bold;cursor:pointer;border:1px solid rgba(255,255,255,.25);user-select:none;}
.vo-thumb:hover .vo-thumb-x{display:flex;}
.vo-thumb-x:hover{background:rgba(180,40,40,.9);color:#fff;border-color:rgba(255,255,255,.55);}
.vo-widget.vo-reorder-active .vo-thumb-x{display:none !important;}
.vo-thumb.vo-dragging{opacity:.35;}
.vo-thumb.vo-drop-before::before,
.vo-thumb.vo-drop-after::after{content:"";position:absolute;top:-3px;bottom:-3px;width:3px;background:var(--io-accent,#6f8bbd);border-radius:2px;pointer-events:none;}
.vo-thumb.vo-drop-before::before{left:-4px;}
.vo-thumb.vo-drop-after::after{right:-4px;}
.vo-thumb-add{position:relative;flex:0 0 auto;order:99;width:88px;height:50px;border-radius:4px;border:2px dashed var(--io-dim,#888);background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--io-dim,#888);font-size:22px;line-height:1;user-select:none;box-sizing:border-box;transition:border-color .12s,color .12s;}
.vo-thumb-add:hover{border-color:var(--io-accent,#6f8bbd);color:var(--io-accent,#6f8bbd);}
/* ── Load-from-disk picker (body overlay) ── */
.vo-picker-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;font-family:'DM Sans',sans-serif;}
.vo-picker{background:#2a2a2a;border:1px solid #3a3a3a;border-radius:8px;width:min(560px,90vw);max-height:80vh;display:flex;flex-direction:column;color:#ddd;}
.vo-picker-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #3a3a3a;}
.vo-picker-title{font-weight:600;}
.vo-picker-close{background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:2px 8px;border-radius:3px;}
.vo-picker-close:hover{color:#ddd;background:rgba(255,255,255,.06);}
.vo-picker-search{padding:8px 14px;border-bottom:1px solid #3a3a3a;}
.vo-picker-search input{width:100%;background:#191919;border:1px solid #3a3a3a;color:#ddd;padding:6px 10px;border-radius:4px;font-family:inherit;box-sizing:border-box;outline:none;}
.vo-picker-search input:focus{border-color:#6f8bbd;}
.vo-picker-list{flex:1;overflow-y:auto;padding:4px 0;}
.vo-picker-list::-webkit-scrollbar{width:6px;}
.vo-picker-list::-webkit-scrollbar-thumb{background:#3a3a3a;border-radius:3px;}
.vo-picker-row{padding:8px 14px;cursor:pointer;display:flex;justify-content:space-between;gap:12px;font-family:'Space Mono',monospace;font-size:11px;border-bottom:1px solid rgba(255,255,255,.03);}
.vo-picker-row:hover{background:rgba(255,255,255,.05);}
.vo-picker-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc;}
.vo-picker-meta{color:#888;flex-shrink:0;}
.vo-picker-empty{padding:24px;text-align:center;color:#888;font-size:12px;}
/* ── Frame drag (export current frame to other nodes' image slots) ── */
.vo-stage video.vo-frame-drag{cursor:grab;}
.vo-stage video.vo-frame-drag:active{cursor:grabbing;}
/* ── Lightbox ── */
.vo-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10000;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.vo-lightbox video{max-width:none;max-height:none;cursor:grab;transform-origin:center center;border:none;border-radius:0;}
.vo-lightbox .vo-lb-hint{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);color:#999;font-size:12px;font-family:var(--io-sans,'DM Sans',sans-serif);}
`;

function injectCSS() {
  if (document.getElementById("vo-styles")) return;
  const s = document.createElement("style");
  s.id = "vo-styles";
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function viewURL(entry) {
  const q = new URLSearchParams({
    filename: entry.filename,
    subfolder: entry.subfolder || "",
    type: entry.type || "temp",
    rand: entry.rand,
  });
  return api.apiURL(`/view?${q.toString()}`);
}

// ── Browser playback / preview copies ──
// FFV1 and ProRes never play in a browser; hevc depends on the browser and
// GPU. Entries the browser can't play are shown through a small h264 copy
// built by /video_oasis/proxy. Only the <video> element uses it: Save, Clip,
// frame drag and the LTX tail always read the real file.
const NEVER_PLAYABLE = ["ffv1", "prores"];
let HEVC_PLAYABLE = null;
const hevcPlayable = () => {
  if (HEVC_PLAYABLE === null) {
    try {
      const v = document.createElement("video");
      HEVC_PLAYABLE = ["hvc1.1.6.L93.B0", "hev1.1.6.L93.B0"].some(
        (c) => v.canPlayType(`video/mp4; codecs="${c}"`) === "probably");
    } catch { HEVC_PLAYABLE = false; }
  }
  return HEVC_PLAYABLE;
};
const needsProxy = (entry) => !!entry && (NEVER_PLAYABLE.includes(entry.codec) ||
  (entry.codec === "hevc" && !hevcPlayable()));
// URL the <video> element plays: the preview copy when there is one.
const playURL = (entry) => viewURL(entry.proxy ? { ...entry.proxy, rand: entry.rand } : entry);
const ensureProxy = (entry, gpu) => {
  if (entry.proxy) return Promise.resolve(entry.proxy);
  if (!entry._proxyP) {
    entry._proxyP = api.fetchApi("/video_oasis/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: entry.filename,
        subfolder: entry.subfolder || "",
        type: entry.type || "temp",
        gpu_encode: gpu !== false,
      }),
    }).then(async (r) => {
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      entry.proxy = { filename: d.filename, subfolder: d.subfolder || "", type: d.type || "temp" };
      return entry.proxy;
    }).catch((err) => {
      entry._proxyP = null;
      entry.proxyFailed = true;
      entry.proxyError = String(err?.message || err);
      throw err;
    });
  }
  return entry._proxyP;
};
// Scene-bar thumb for files the browser can't decode: a frame from the backend.
const frameThumbURL = (entry) => api.apiURL(`/video_oasis/frame?${new URLSearchParams({
  video: entry.filename, subfolder: entry.subfolder || "", type: entry.type || "temp",
  frame: "1", rand: entry.rand ?? "",
}).toString()}`);
const PROXY_NOTE = "Playing a browser-friendly preview copy. Save, Clip and frame drag use the original file.";

function fmtTime(t) {
  if (!isFinite(t)) return "0:00.00";
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes > 1024 * 1024) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}

function newRand() {
  return Math.random().toString(36).slice(2);
}

const FORMATS = ["auto", "mp4", "webm", "mkv", "mov"];
const CODECS = ["auto", "h264", "hevc", "vp9", "av1", "ffv1", "prores"];
const QUALITIES = ["balanced", "high", "small", "custom"];
const CODEC_HOME = {vp9:"webm", av1:"webm", ffv1:"mkv", prores:"mov"};
const CONTAINER_CODECS = {
  mp4:["h264","hevc","av1"], webm:["vp9","av1"],
  mkv:["h264","hevc","vp9","av1","ffv1","prores"],
  mov:["h264","hevc","prores"],
};
const LOSSLESS_CODECS = ["ffv1","prores"];
const snapEncodeCodec = (st, codec) => {
  st.codec = codec;
  const home = CODEC_HOME[codec];
  if (!home) return;
  const ok = st.format === "auto" || (CONTAINER_CODECS[st.format]||[]).includes(codec);
  if (!ok || st.format === "auto") st.format = home;
};
const encodeHint = (codec) => {
  if (codec === "ffv1")
    return "FFV1 + FLAC in mkv: true lossless of the decoded frames. The viewer plays a quick preview copy; Save copies the real file, no re-encode.";
  if (codec === "prores")
    return "ProRes 422 HQ + PCM in mov: NLE-friendly, visually lossless, much bigger. The viewer plays a quick preview copy; Save copies the real file, no re-encode.";
  return "webm takes VP9/AV1; mp4 takes h264/hevc/AV1; mkv takes anything including FFV1; mov takes ProRes. Save copies the preview losslessly \u2014 no re-encode.";
};
// NVENC (GPU encode) availability, probed once per page load. Resolves to
// the codecs the GPU can encode here; an empty list hides the toggle.
let VO_NVENC_PROMISE = null;
const loadNvencCodecs = () => {
  if (!VO_NVENC_PROMISE) {
    VO_NVENC_PROMISE = api.fetchApi("/video_oasis/nvenc")
      .then((r) => r.json())
      .then((d) => (Array.isArray(d?.codecs) ? d.codecs : []))
      .catch(() => []);
  }
  return VO_NVENC_PROMISE;
};
// "auto" encodes as h264 when GPU encode is on.
const gpuEncodeShown = (codec, codecs) =>
  Array.isArray(codecs) && codecs.includes(codec === "auto" ? "h264" : codec);
const qualityLabel = (entry) => {
  if (entry.codec === "auto") return "source";
  if (entry.crf == null) return entry.codec;
  return entry.encoder === "nvenc"
    ? `${entry.codec} nvenc cq ${entry.crf}`
    : `${entry.codec} crf ${entry.crf}`;
};
const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const HISTORY_CAP = 48;

/* ------------------------------------------------------------------ */
/* result routing (module scope, IO's stash-and-drain lifecycle)       */
/* ------------------------------------------------------------------ */

const VO_HANDLERS = new Map();        // io_id → addResults fn (live closure)
const VO_PENDING = new Map();         // io_id → results[] (off-tab stash)
api.addEventListener("video-oasis/result", ({ detail }) => {
  if (!detail?.io_id || !Array.isArray(detail?.results)) return;
  const handler = VO_HANDLERS.get(detail.io_id);
  if (handler) handler(detail.results);
  else VO_PENDING.set(detail.io_id,
    (VO_PENDING.get(detail.io_id) || []).concat(detail.results));
});

/* ------------------------------------------------------------------ */
/* extension                                                           */
/* ------------------------------------------------------------------ */

app.registerExtension({
  name: "VideoOasis.Viewer",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "VideoOasisPreview") return;

    const _onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      if (_onCreated) _onCreated.apply(this, arguments);
      injectCSS();
      this.setSize([570, 770]);
      this.color = "#000000"; this.bgcolor = "#202020";
      this.serialize_widgets = true;

      const selfNode = this;

      /* ── closure state (persisted via getValue/setValue) ── */
      let st = {
        format: "auto",
        codec: "auto",
        quality: "balanced",
        crf: 20,
        gpu_encode: true,
        save_prefix: "video/VideoOasis",
      };
      let open = { encode: false };
      let ioId = "";
      let history = [];     // strip entries (+ runtime thumbEl/rand/warned)
      let activeIdx = -1;
      let playMode = "loop";   // "off" | "loop" | "cycle"
      let muted = false, speed = 1;
      let movieAudio = true;
      let cycleQueue = null;
      let lightboxOpen = false;
      let clipInS = null, clipOutS = null;
      let nvencCodecs = [];   // filled by loadNvencCodecs(); empty = no GPU toggle

      /* ── static DOM (built ONCE -- the <video> must never be re-created
         by an innerHTML render, or playback restarts on every state
         change). Only the sections column re-renders IO-style. ── */
      const container = document.createElement("div");
      container.className = "vo-widget";
      container.tabIndex = 0;

      const inner = document.createElement("div");
      inner.className = "vo-inner";

      const sectionsEl = document.createElement("div");
      sectionsEl.className = "vo-sections";

      const pane = document.createElement("div");
      pane.className = "vo-pane";

      const stage = document.createElement("div");
      stage.className = "vo-stage";
      const empty = document.createElement("div");
      empty.className = "vo-empty";
      empty.textContent = "Run the workflow to preview video here";
      const video = document.createElement("video");
      video.loop = playMode === "loop";
      video.muted = muted;
      video.playsInline = true;
      video.style.display = "none";
      // Drag the paused/current frame onto any workflow image input (Load Image,
      // Image Oasis refs, LTX Start / beat guides, etc.).
      video.draggable = false;
      video.title = "";
      const captureCurrentFrameFile = () => {
        if (!video.videoWidth || video.style.display === "none") return null;
        const c = document.createElement("canvas");
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        c.getContext("2d").drawImage(video, 0, 0);
        const dataUrl = c.toDataURL("image/png");
        const b64 = dataUrl.split(",", 2)[1];
        if (!b64) return null;
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const frameN = Math.max(0, Math.round((video.currentTime || 0) * fps()));
        const file = new File([arr], `frame_${frameN}.png`, { type: "image/png" });
        const ghost = document.createElement("canvas");
        const gw = 120;
        ghost.width = gw;
        ghost.height = Math.max(1, Math.round(gw * c.height / c.width));
        ghost.getContext("2d").drawImage(c, 0, 0, ghost.width, ghost.height);
        return { file, dataUrl, ghost, frameN };
      };
      // Same-origin URL that re-serves this frame from the backend
      // (/video_oasis/frame). Stock ComfyUI drop targets (LoadImage and
      // every upload-widget node) only accept dataTransfer.files or a
      // same-origin text/uri-list -- and Chromium clears File items from
      // the drag store once any string type is added -- so this URL is what
      // makes drops on regular image nodes work. `filename` names the
      // upload on the receiving side; the source video is `video`.
      const frameDragURL = (frameN) => {
        const entry = current();
        if (!entry?.filename) return null;
        const q = new URLSearchParams({
          filename: `frame_${frameN}.png`,
          video: entry.filename,
          subfolder: entry.subfolder || "",
          type: entry.type || "temp",
          frame: String(frameN),
          rand: entry.rand ?? "",
        });
        return new URL(api.apiURL(`/video_oasis/frame?${q.toString()}`),
                       window.location.href).href;
      };
      const setFrameDragEnabled = (on) => {
        video.draggable = !!on;
        video.classList.toggle("vo-frame-drag", !!on);
        video.title = on
          ? "Drag the current frame onto an image input on the graph"
          : "";
      };
      video.addEventListener("dragstart", (e) => {
        // Lightbox owns pointer gestures (pan); HTML5 drag stays off there.
        if (lightboxOpen || !video.draggable) { e.preventDefault(); return; }
        const cap = captureCurrentFrameFile();
        if (!cap) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = "copy";
        // File first: Chromium clears File items from the drag store when
        // any string type is added afterwards, so the File may not survive
        // to the drop -- the string payloads below are what drop targets
        // actually see in that case. x-oasis-frame carries the exact
        // on-screen pixels for Oasis slots; text/uri-list carries a
        // same-origin re-extraction URL, which is the only payload stock
        // ComfyUI image nodes accept besides files. Never a data: URL in
        // uri-list -- ComfyUI fetches uri-list entries.
        e.dataTransfer.items.add(cap.file);
        try { e.dataTransfer.items.add(cap.dataUrl, "application/x-oasis-frame"); }
        catch { /* older engines */ }
        try {
          const u = frameDragURL(cap.frameN);
          if (u) e.dataTransfer.items.add(u, "text/uri-list");
        } catch { /* older engines */ }
        try { e.dataTransfer.setDragImage(cap.ghost, cap.ghost.width / 2, cap.ghost.height / 2); }
        catch { /* some engines reject off-DOM canvases */ }
      });
      const preloadVideo = document.createElement("video");
      preloadVideo.style.display = "none";
      preloadVideo.muted = true;
      preloadVideo.preload = "auto";
      const badge = document.createElement("div");
      badge.className = "vo-badge";
      badge.style.display = "none";
      const toast = document.createElement("div");
      toast.className = "vo-toast";
      stage.append(empty, video, preloadVideo, badge, toast);

      const scrubrow = document.createElement("div");
      scrubrow.className = "vo-scrubrow";
      const scrub = document.createElement("input");
      scrub.type = "range";
      scrub.className = "vo-scrub";
      scrub.min = 0; scrub.max = 1000; scrub.value = 0;
      const timeLabel = document.createElement("span");
      timeLabel.className = "vo-time";
      timeLabel.textContent = "0:00.00 / 0:00.00";
      scrubrow.append(scrub, timeLabel);

      const ctrlbar = document.createElement("div");
      ctrlbar.className = "vo-ctrlbar";
      const mkBtn = (label, title, fn, cls = "vo-icon-btn") => {
        const b = document.createElement("button");
        b.className = cls;
        b.textContent = label;
        b.title = title;
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        return b;
      };
      const playBtn = mkBtn("\u25b6", "Play/Pause (Space)", () => togglePlay());
      const backBtn = mkBtn("\u23ee", "Frame back (\u2190 · Shift+\u2190 = 1s)", () => step(-1));
      const fwdBtn = mkBtn("\u23ed", "Frame forward (\u2192 · Shift+\u2192 = 1s)", () => step(1));
      const loopBtn = mkBtn("\u{1f501}", "Playback mode", () => cyclePlayMode());
      const muteBtn = mkBtn("\u{1f50a}", "Mute", () => toggleMute());
      const speedSel = document.createElement("select");
      speedSel.className = "vo-speed";
      speedSel.title = "Playback speed";
      for (const s of SPEEDS) {
        const o = document.createElement("option");
        o.value = s; o.textContent = s + "\u00d7";
        speedSel.appendChild(o);
      }
      speedSel.value = String(speed);
      speedSel.onchange = () => { speed = +speedSel.value; video.playbackRate = speed; };
      speedSel.onclick = (e) => e.stopPropagation();
      const lbBtn = mkBtn("\u26f6", "Fullscreen lightbox (scroll = zoom, drag = pan)", () => openLightbox());
      let refreshClipUI = () => {};
      let clipCurrent = async () => {};
      const markInBtn = mkBtn("[", "Mark clip in at current frame", () => {
        if (!current()) return;
        clipInS = video.currentTime || 0;
        if (clipOutS != null && clipOutS <= clipInS) clipOutS = null;
        refreshClipUI();
      });
      const markOutBtn = mkBtn("]", "Mark clip out at current frame", () => {
        if (!current()) return;
        clipOutS = video.currentTime || 0;
        if (clipInS != null && clipOutS <= clipInS) clipInS = null;
        refreshClipUI();
      });
      const clipRangeLbl = document.createElement("span");
      clipRangeLbl.className = "vo-clip-mark";
      const clipBtn = mkBtn("Clip", "Clip current video to marked in/out frames", () => clipCurrent(), "vo-btn-save");
      const spacer = document.createElement("div");
      spacer.style.flex = "1";
      const prevBtn = mkBtn("\u2039", "Previous video (wraps around)", () => navBy(-1), "vo-nav-arrow");
      const counter = document.createElement("span");
      counter.className = "vo-nav";
      const nextBtn = mkBtn("\u203a", "Next video (wraps around)", () => navBy(1), "vo-nav-arrow");
      const nav = document.createElement("span");
      nav.className = "vo-nav";
      nav.style.display = "none";
      nav.append(prevBtn, counter, nextBtn);
      const movieAudioBtn = mkBtn("\u{1f50a}", "Movie audio", () => toggleMovieAudio(), "vo-btn-movie-audio");
      const createMovieBtn = mkBtn("\u{1f3ac} Movie", "Create Movie", () => createMovie(), "vo-btn-save");
      const saveHdrBtn = mkBtn("\u{1f4be}", "Copy this preview into your output directory", () => save(), "vo-icon-btn vo-save");
      saveHdrBtn.style.display = "none";
      ctrlbar.append(playBtn, backBtn, fwdBtn, loopBtn, muteBtn, speedSel, lbBtn,
        markInBtn, markOutBtn, clipRangeLbl, clipBtn,
        spacer, movieAudioBtn, createMovieBtn);

      const infobar = document.createElement("div");
      infobar.className = "vo-infobar";
      const infoText = document.createElement("span");
      infoText.className = "vo-info-text";
      infobar.append(infoText, nav);
      infobar.style.display = "none";

      const historyEl = document.createElement("div");
      historyEl.className = "vo-history";
      const addTile = document.createElement("div");
      addTile.className = "vo-thumb-add";
      addTile.textContent = "+";
      addTile.title = "Load a video from output/ into the scene bar";
      addTile.addEventListener("pointerdown", (e) => e.stopPropagation());
      addTile.addEventListener("click", (e) => { e.stopPropagation(); openPicker(); });
      historyEl.appendChild(addTile);

      pane.append(stage, scrubrow, ctrlbar, infobar, historyEl);
      inner.append(sectionsEl, pane);
      container.append(inner);

      // Keep node drag / canvas zoom from fighting the widget.
      for (const ev of ["pointerdown", "mousedown", "wheel"]) {
        container.addEventListener(ev, (e) => e.stopPropagation());
      }

      /* ── settings sections (IO's sec() + innerHTML render + bind) ── */

      const renderSections = () => {
        const body = `
            <div class="vo-row">
              <span class="vo-label">Format</span>
              <div class="vo-toggle-grp">${FORMATS.map((f) =>
                `<button class="vo-tog${st.format === f ? " active" : ""}" data-enc-format="${f}">${f}</button>`).join("")}</div>
            </div>
            <div class="vo-row">
              <span class="vo-label">Codec</span>
              <div class="vo-toggle-grp">${CODECS.map((c) =>
                `<button class="vo-tog${st.codec === c ? " active" : ""}" data-enc-codec="${c}">${c}</button>`).join("")}</div>
            </div>
            ${LOSSLESS_CODECS.includes(st.codec) ? "" : `
            <div class="vo-row">
              <span class="vo-label">Quality</span>
              <div class="vo-toggle-grp">${QUALITIES.map((q) =>
                `<button class="vo-tog${st.quality === q ? " active" : ""}" data-enc-quality="${q}">${q}</button>`).join("")}</div>
            </div>
            ${st.quality === "custom"
              ? `<div class="vo-row"><span class="vo-label">CRF</span><input class="vo-input" type="number" data-f="crf" value="${esc(st.crf)}" step="1" min="0" max="63"/></div>`
              : ""}
            `}
            ${gpuEncodeShown(st.codec, nvencCodecs) ? `
            <div class="vo-row" title="Encode on the NVIDIA GPU (NVENC). Big speedup on long or upscaled clips; files run slightly larger at the same quality. Falls back to the CPU automatically if the GPU encoder fails. Clip and Create Movie follow this setting.">
              <span class="vo-label">GPU Encode</span>
              <div class="vo-toggle-grp">
                <button class="vo-tog${st.gpu_encode !== false ? " active" : ""}" data-enc-gpu="on">On</button>
                <button class="vo-tog${st.gpu_encode === false ? " active" : ""}" data-enc-gpu="off">Off</button>
              </div>
            </div>` : ""}
            <div class="vo-row"><span class="vo-label">Save prefix</span><input class="vo-input" data-f="save_prefix" value="${esc(st.save_prefix)}"/></div>
            <div class="vo-mini" style="opacity:.7">${esc(encodeHint(st.codec))}</div>
          `;
        sectionsEl.innerHTML = `
          <div class="vo-sec-row">
            <div class="vo-section">
              <div class="vo-sec-head" data-sec="encode">
                <span class="vo-sec-title">Encode / Save</span>
                <span class="vo-chevron${open.encode ? " open" : ""}">\u203a</span>
              </div>
              ${open.encode ? `<div class="vo-sec-body">${body}</div>` : ""}
            </div>
          </div>`;
        sectionsEl.querySelector(".vo-sec-row")?.appendChild(saveHdrBtn);
        bindSections();
        updateSaveBtn();
      };

      const bindSections = () => {
        sectionsEl.querySelectorAll("[data-sec]").forEach((h) =>
          h.addEventListener("click", (e) => {
            e.stopPropagation();
            const k = h.dataset.sec;
            open[k] = !open[k];
            renderSections();
          }));
        sectionsEl.querySelectorAll("[data-enc-format]").forEach((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            st.format = b.dataset.encFormat;
            renderSections();
          }));
        sectionsEl.querySelectorAll("[data-enc-codec]").forEach((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            snapEncodeCodec(st, b.dataset.encCodec);
            renderSections();
          }));
        sectionsEl.querySelectorAll("[data-enc-gpu]").forEach((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            st.gpu_encode = b.dataset.encGpu === "on";
            renderSections();
          }));
        sectionsEl.querySelectorAll("[data-enc-quality]").forEach((b) =>
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            st.quality = b.dataset.encQuality;
            renderSections();
          }));
        sectionsEl.querySelectorAll("[data-f]").forEach((el) => {
          el.addEventListener("click", (e) => e.stopPropagation());
          el.addEventListener("change", (e) => {
            e.stopPropagation();
            const f = el.dataset.f;
            if (f === "crf") {
              const v = parseInt(el.value, 10);
              st.crf = isNaN(v) ? 20 : Math.min(63, Math.max(0, v));
            } else {
              st[f] = el.value;
            }
          });
        });
      };

      /* ── playback ── */

      const safePlay = () => {
        try { const p = video.play(); p?.catch?.(() => {}); } catch { /* jsdom / autoplay block */ }
      };
      const current = () => history[activeIdx] || null;
      const fps = () => current()?.fps || 24;

      const togglePlay = () => {
        if (!current()) return;
        video.paused ? safePlay() : video.pause();
      };

      const step = (nFrames) => {
        if (!current()) return;
        video.pause();
        const dt = nFrames / fps();
        video.currentTime = Math.min(
          Math.max(0, video.currentTime + dt),
          Math.max(0, (video.duration || 0) - 1e-4));
      };

      const PLAY_MODE_ORDER = ["off", "loop", "cycle"];
      const PLAY_MODE_ICON = { off: "\u{1f501}", loop: "\u{1f502}", cycle: "\u{1f501}" };
      const PLAY_MODE_TIP = {
        off: "Playback: no repeat (click: off \u2192 loop \u2192 cycle)",
        loop: "Playback: repeat current clip (click for cycle)",
        cycle: "Playback: cycle through the scene bar (click to disable)",
      };
      const refreshPlayModeBtn = () => {
        loopBtn.textContent = PLAY_MODE_ICON[playMode] || PLAY_MODE_ICON.off;
        loopBtn.title = PLAY_MODE_TIP[playMode] || PLAY_MODE_TIP.off;
        loopBtn.classList.toggle("vo-on", playMode !== "off");
      };
      const refreshCyclingClass = () => {
        for (const e of history) {
          e.thumbEl?.classList.toggle(
            "vo-cycling", playMode === "cycle" && e === history[activeIdx]);
        }
      };
      const warmPreload = () => {
        if (playMode !== "cycle" || !cycleQueue || !cycleQueue.length) {
          try { preloadVideo.removeAttribute("src"); preloadVideo.load(); } catch { /* */ }
          return;
        }
        const cur = history[activeIdx];
        const qi = cycleQueue.indexOf(cur);
        const n = cycleQueue.length;
        for (let i = 1; i <= n; i++) {
          const next = cycleQueue[((qi >= 0 ? qi : -1) + i + n) % n];
          if (history.indexOf(next) >= 0) {
            if (!next.proxy && needsProxy(next)) return;   // built on demand
            const url = playURL(next);
            if (preloadVideo.src !== url) preloadVideo.src = url;
            return;
          }
        }
      };
      const advanceCycle = () => {
        if (playMode !== "cycle" || !cycleQueue || !cycleQueue.length) return;
        const cur = history[activeIdx];
        const qi = cycleQueue.indexOf(cur);
        const n = cycleQueue.length;
        for (let i = 1; i <= n; i++) {
          const next = cycleQueue[((qi >= 0 ? qi : -1) + i + n) % n];
          const hi = history.indexOf(next);
          if (hi >= 0) {
            loadEntry(hi, { autoplay: true });
            warmPreload();
            return;
          }
        }
        setPlayMode("off");
        showToast("Cycle queue exhausted");
      };
      const setPlayMode = (mode) => {
        if (!PLAY_MODE_ORDER.includes(mode)) mode = "off";
        playMode = mode;
        video.loop = (playMode === "loop");
        if (playMode === "cycle") {
          cycleQueue = history.slice();
          if (activeIdx < 0 && history.length) loadEntry(0, { autoplay: true });
          warmPreload();
        } else {
          cycleQueue = null;
          warmPreload();
        }
        refreshPlayModeBtn();
        refreshCyclingClass();
      };
      const cyclePlayMode = () => {
        const cur = PLAY_MODE_ORDER.indexOf(playMode);
        setPlayMode(PLAY_MODE_ORDER[(cur + 1) % PLAY_MODE_ORDER.length]);
      };

      const toggleMute = () => {
        muted = !muted;
        video.muted = muted;
        muteBtn.textContent = muted ? "\u{1f507}" : "\u{1f50a}";
      };

      const syncPlayerPrefs = () => {
        video.loop = (playMode === "loop");
        video.muted = muted;
        video.playbackRate = speed;
        refreshPlayModeBtn();
        refreshMovieAudioBtn();
        muteBtn.textContent = muted ? "\u{1f507}" : "\u{1f50a}";
        speedSel.value = String(SPEEDS.includes(speed) ? speed : 1);
      };

      const syncTime = () => {
        const d = video.duration || 0;
        const t = video.currentTime || 0;
        if (d) scrub.value = Math.round((t / d) * 1000);
        const frame = Math.round(t * fps());
        const total = current()?.frames || Math.round(d * fps());
        timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(d)} \u00b7 f ${frame}/${total}`;
      };

      video.addEventListener("timeupdate", syncTime);
      video.addEventListener("loadedmetadata", syncTime);
      video.addEventListener("play", () => (playBtn.textContent = "\u23f8"));
      video.addEventListener("pause", () => (playBtn.textContent = "\u25b6"));
      // Click the video to play/pause. A real frame drag never fires click.
      // Off in the lightbox: there click/drag pans and double-click resets.
      video.addEventListener("click", (e) => {
        if (lightboxOpen) return;
        e.stopPropagation();
        togglePlay();
      });
      video.addEventListener("ended", () => {
        if (playMode === "cycle") advanceCycle();
      });
      video.addEventListener("error", () => {
        // A persisted temp ref whose file was cleared between sessions:
        // degrade to the empty state, never a broken player. (IO's onerror
        // pattern.) Only for the entry we're actually showing.
        const cur = current();
        if (!cur) return;
        // The browser couldn't decode it (e.g. hevc it claimed to support):
        // try a preview copy once before calling the file expired.
        if (!cur.proxy && !cur.proxyTried && cur.filename) {
          cur.proxyTried = true;
          if (cur.codec === "hevc") HEVC_PLAYABLE = false;
          showProxyWait(cur, true);
          return;
        }
        setFrameDragEnabled(false);
        video.style.display = "none";
        empty.style.display = "";
        empty.textContent = "Preview expired (temp is cleared on restart) \u2014 re-run the workflow";
      });
      scrub.addEventListener("input", () => {
        if (video.duration) video.currentTime = (scrub.value / 1000) * video.duration;
      });
      container.addEventListener("keydown", (e) => {
        if (e.code === "Space") { e.preventDefault(); togglePlay(); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -fps() : -1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? fps() : 1); }
      });
      stage.addEventListener("mouseenter", () => { if (current()) showBadge(); });

      /* ── badge / toast / info ── */

      let _badgeT = null;
      const showBadge = () => {
        badge.classList.remove("vo-hide");
        clearTimeout(_badgeT);
        if (!current()?.warning) {
          _badgeT = setTimeout(() => badge.classList.add("vo-hide"), 2500);
        }
      };

      let _toastT = null;
      const showToast = (msg) => {
        toast.textContent = msg;
        toast.classList.add("vo-show");
        clearTimeout(_toastT);
        _toastT = setTimeout(() => toast.classList.remove("vo-show"), 3200);
      };

      const renderInfo = () => {
        const e = current();
        if (!e) {
          infoText.textContent = "";
          infoText.classList.remove("vo-warn");
          infoText.title = "";
          nav.style.display = "none";
          infobar.style.display = "none";
          return;
        }
        infobar.style.display = "";
        const dims = `${e.width || "?"}\u00d7${e.height || "?"}`;
        infoText.innerHTML =
          (e.warning ? "\u26a0 " : "") +
          `<span class="vo-info-label">${dims}</span>` +
          ` \u00b7 ${e.fps || "?"} fps \u00b7 ` +
          `${e.frames ?? "?"} frames \u00b7 ${fmtSize(e.size_bytes)}` +
          (e.has_audio ? " \u00b7 audio" : "") +
          (e.proxy ? " \u00b7 preview copy" : "");
        infoText.classList.toggle("vo-warn", !!e.warning);
        infoText.title = e.warning || (e.proxy ? PROXY_NOTE : "");
        if (history.length > 1) {
          nav.style.display = "";
          counter.textContent = `${activeIdx + 1}/${history.length}`;
        } else {
          nav.style.display = "none";
        }
      };

      const refreshMovieAudioBtn = () => {
        movieAudioBtn.textContent = movieAudio ? "\u{1f50a}" : "\u{1f507}";
        movieAudioBtn.title = movieAudio
          ? "Movie audio: on \u2014 keep audio where present, silence for silent clips"
          : "Movie audio: off \u2014 strip audio from every clip";
        movieAudioBtn.classList.toggle("vo-on", movieAudio);
      };
      const toggleMovieAudio = () => {
        movieAudio = !movieAudio;
        refreshMovieAudioBtn();
      };

      /* ── history navigation -- IO's modulo wraparound ── */

      const navBy = (delta) => {
        if (history.length < 2) return;
        const n = history.length;
        loadEntry((activeIdx + delta + n) % n, { autoplay: true });
      };

      /* ── entries ── */

      const checkMovieCompat = () => {
        const saved = history.filter((e) => e.saved);
        if (saved.length < 2) {
          return {
            ok: false, saved, reason: saved.length === 0
              ? "Create Movie: save at least two clips first (temp clips are excluded)"
              : "Create Movie: need at least two saved clips (temp clips are excluded)",
          };
        }
        const ref = saved[0];
        for (const e of saved.slice(1)) {
          const w = (e.width || 0) !== (ref.width || 0);
          const h = (e.height || 0) !== (ref.height || 0);
          const fpsM = Math.abs((e.fps || 0) - (ref.fps || 0)) > 0.01;
          if (w || h || fpsM) {
            const bits = [
              (w || h) ? `${e.width}\u00d7${e.height} vs ${ref.width}\u00d7${ref.height}` : null,
              fpsM ? `${(e.fps || 0).toFixed(2)}fps vs ${(ref.fps || 0).toFixed(2)}fps` : null,
            ].filter(Boolean).join(", ");
            return {
              ok: false, saved,
              reason: `Create Movie disabled: saved clips must match size/fps. Mismatch: ${bits}`,
            };
          }
        }
        return { ok: true, saved };
      };

      const updateSaveBtn = () => {
        const e = current();
        const compat = checkMovieCompat();
        createMovieBtn.disabled = !compat.ok;
        createMovieBtn.title = compat.ok
          ? `Create Movie: concatenate ${compat.saved.length} saved clips into one file`
          : compat.reason;
        refreshClipUI();
        // IO parity: hide Save when the pane is empty (don't gray it out).
        if (!e) {
          saveHdrBtn.style.display = "none";
          saveHdrBtn.disabled = true;
          saveHdrBtn.textContent = "\u{1f4be}";
          saveHdrBtn.classList.remove("vo-saved-mark");
          saveHdrBtn.title = "Copy this preview into your output directory";
          return;
        }
        saveHdrBtn.style.display = "";
        saveHdrBtn.disabled = false;
        if (e.saved) {
          saveHdrBtn.textContent = "\u2713";
          saveHdrBtn.classList.add("vo-saved-mark");
          saveHdrBtn.title = "Saved to " + e.savedPath + " \u2014 click to save another copy";
        } else {
          saveHdrBtn.textContent = "\u{1f4be}";
          saveHdrBtn.classList.remove("vo-saved-mark");
          saveHdrBtn.title = "Copy this preview into your output directory";
        }
      };

      // Browser can't play this entry directly: park the player, build (or
      // reuse) the preview copy, then reload the entry if it's still showing.
      const showProxyWait = (entry, autoplay) => {
        setFrameDragEnabled(false);
        try { video.pause(); } catch { /* */ }
        video.removeAttribute("src");
        try { video.load(); } catch { /* */ }
        video.style.display = "none";
        empty.style.display = "";
        if (entry.proxyFailed) {
          empty.textContent = /Missing on disk/.test(entry.proxyError || "")
            ? "Preview expired (temp is cleared on restart). Re-run the workflow"
            : `Couldn't build a browser preview for this ${entry.codec || "video"} file. The file itself is fine.`;
          return;
        }
        empty.textContent = "Preparing browser preview\u2026";
        const reload = () => {
          const i = history.indexOf(entry);
          if (i >= 0 && i === activeIdx) loadEntry(i, { autoplay });
        };
        ensureProxy(entry, st.gpu_encode).then(reload, reload);
      };

      const loadEntry = (idx, { autoplay = true } = {}) => {
        if (idx < 0 || idx >= history.length) return;
        if (idx !== activeIdx) { clipInS = null; clipOutS = null; }
        activeIdx = idx;
        const entry = history[idx];
        if (!entry.proxy && needsProxy(entry)) {
          showProxyWait(entry, autoplay);
        } else {
          empty.style.display = "none";
          video.style.display = "";
          video.src = playURL(entry);
          setFrameDragEnabled(true);
          if (autoplay) safePlay(); else video.pause();
        }
        const q = qualityLabel(entry);
        badge.style.display = "";
        badge.textContent = (entry.warning ? "\u26a0 " : "") + `${entry.format} \u00b7 ${q}`;
        showBadge();
        if (entry.warning && !entry.warned) {
          entry.warned = true;
          showToast("\u26a0 " + entry.warning);
        }
        renderInfo();
        updateSaveBtn();
        for (const e of history) {
          e.thumbEl?.classList.toggle("vo-active", e === entry);
          e.thumbEl?.classList.toggle(
            "vo-cycling", playMode === "cycle" && e === entry);
        }
        entry.thumbEl?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        container.focus({ preventScroll: true });
        if (playMode === "cycle") warmPreload();
      };

      // Poster generation is queued sequentially: a hard-refresh restore of
      // a full strip would otherwise decode up to 24 videos at once.
      let thumbChain = Promise.resolve();
      const queuePoster = (entry) => {
        thumbChain = thumbChain.then(() => makePoster(entry)).catch(() => {});
      };
      const makePoster = (entry) => new Promise((resolve) => {
        const t = entry.thumbEl;
        if (!t) return resolve();
        if (!entry.proxy && needsProxy(entry)) {
          // Can't decode it here; ask the backend for a frame instead.
          const img = new Image();
          const done = () => resolve();
          img.onload = () => { t.style.backgroundImage = `url("${img.src}")`; done(); };
          img.onerror = done;
          img.src = frameThumbURL(entry);
          return;
        }
        const v = document.createElement("video");
        let released = false, cleaned = false;
        const release = () => {           // unblock the sequential queue
          if (!released) { released = true; resolve(); }
        };
        const cleanup = () => {           // drop the probe element's fetch
          if (cleaned) return;
          cleaned = true;
          clearTimeout(hardT);
          try { v.removeAttribute("src"); v.load(); } catch { /* jsdom */ }
          release();
        };
        const draw = () => {
          try {
            if (!v.videoWidth) return;
            const c = document.createElement("canvas");
            c.width = 176; c.height = 100;
            const ar = v.videoWidth / v.videoHeight;
            let w = c.width, h = w / ar;
            if (h > c.height) { h = c.height; w = h * ar; }
            c.getContext("2d").drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h);
            t.style.backgroundImage = `url(${c.toDataURL("image/jpeg", 0.7)})`;
          } catch { /* canvas unavailable -- thumb stays black */ }
        };
        // The queue must not stall behind one slow file, but aborting the
        // load on a timeout is how thumbs go permanently black: a fresh
        // large video is fetched by this probe WHILE the main player
        // streams the same URL, and the MP4 index sits at the file's tail,
        // so slow starts are normal. So: 5s releases the queue only; the
        // probe keeps loading and may still draw late. 60s hard-cleans a
        // probe that clearly isn't going anywhere.
        const softT = setTimeout(release, 5000);
        const hardT = setTimeout(cleanup, 60000);
        v.muted = true; v.preload = "auto"; v.src = playURL(entry);
        v.addEventListener("error", () => { clearTimeout(softT); cleanup(); });
        v.addEventListener("loadeddata", () => {
          // Phase 1: draw frame 0 the moment ANY frame is decodable, so the
          // thumb is never black while we wait for the seek.
          draw();
          // Phase 2: nudge off the very first frame (often a fade-in) and
          // redraw with the nicer one.
          try { v.currentTime = Math.min(0.04, (v.duration || 1) / 2); } catch { cleanup(); }
        });
        v.addEventListener("seeked", () => {
          draw();
          clearTimeout(softT);
          cleanup();
        }, { once: true });
      });

      // Long-press reorder on scene-bar thumbs (click = load).
      const HOLD_MS = 300, MOVE_THRESHOLD = 5;
      let dragEntry = null, holdTimer = null, pointerStart = null;

      const clearEmptyViewer = (msg) => {
        activeIdx = -1;
        clipInS = null; clipOutS = null;
        try { video.pause(); } catch { /* */ }
        video.removeAttribute("src");
        try { video.load(); } catch { /* */ }
        video.style.display = "none";
        setFrameDragEnabled(false);
        badge.style.display = "none";
        empty.style.display = "";
        empty.textContent = msg;
        scrub.value = 0;
        timeLabel.textContent = "0:00.00 / 0:00.00";
        playBtn.textContent = "\u25b6";
        renderInfo();
        updateSaveBtn();
      };

      const removeEntry = (entry) => {
        const idx = history.indexOf(entry);
        if (idx < 0) return;
        const wasActive = (idx === activeIdx);
        entry.thumbEl?.remove();
        history.splice(idx, 1);
        if (cycleQueue) {
          const qi = cycleQueue.indexOf(entry);
          if (qi >= 0) cycleQueue.splice(qi, 1);
        }
        if (!history.length) {
          clearEmptyViewer("Scene bar is empty \u2014 run the workflow to add a shot");
          return;
        }
        if (wasActive) {
          loadEntry(Math.min(idx, history.length - 1), { autoplay: playMode === "cycle" });
        } else if (idx < activeIdx) {
          activeIdx -= 1;
          renderInfo();
          updateSaveBtn();
        } else {
          updateSaveBtn();
        }
        if (playMode === "cycle") warmPreload();
      };

      const clearDropIndicators = () => {
        historyEl.querySelectorAll(".vo-drop-before,.vo-drop-after")
          .forEach((el) => el.classList.remove("vo-drop-before", "vo-drop-after"));
      };
      const computeDropTarget = (clientX) => {
        const others = history.filter((e) => e !== dragEntry && e.thumbEl);
        if (!others.length) return null;
        let best = null, bestDist = Infinity;
        for (const e of others) {
          const r = e.thumbEl.getBoundingClientRect();
          const mid = r.left + r.width / 2;
          const d = Math.abs(clientX - mid);
          if (d < bestDist) { bestDist = d; best = { entry: e, mid }; }
        }
        return { entry: best.entry, before: clientX < best.mid };
      };
      const updateInsertionCursor = (clientX) => {
        clearDropIndicators();
        const t = computeDropTarget(clientX);
        if (!t) return;
        t.entry.thumbEl.classList.add(t.before ? "vo-drop-before" : "vo-drop-after");
      };
      const beginDrag = (entry) => {
        dragEntry = entry;
        entry.thumbEl?.classList.add("vo-dragging");
        container.classList.add("vo-reorder-active");
      };
      const commitDrag = (clientX) => {
        const fromIdx = history.indexOf(dragEntry);
        const t = computeDropTarget(clientX);
        if (fromIdx < 0 || !t) return;
        const targetIdx = history.indexOf(t.entry);
        let insertAt = t.before ? targetIdx : targetIdx + 1;
        if (fromIdx < insertAt) insertAt -= 1;
        if (fromIdx === insertAt) return;
        const activeEntry = history[activeIdx] || null;
        const [moved] = history.splice(fromIdx, 1);
        history.splice(insertAt, 0, moved);
        for (const e of history) historyEl.appendChild(e.thumbEl);
        activeIdx = activeEntry ? history.indexOf(activeEntry) : -1;
        renderInfo();
      };
      const cleanupDrag = () => {
        clearDropIndicators();
        if (dragEntry) dragEntry.thumbEl?.classList.remove("vo-dragging");
        dragEntry = null;
        pointerStart = null;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        container.classList.remove("vo-reorder-active");
        document.removeEventListener("pointermove", onGlobalMove);
        document.removeEventListener("pointerup", onGlobalUp);
        document.removeEventListener("pointercancel", onGlobalCancel);
      };
      function onGlobalMove(ev) {
        if (!pointerStart) return;
        if (dragEntry) {
          updateInsertionCursor(ev.clientX);
        } else if (holdTimer) {
          const dx = ev.clientX - pointerStart.x;
          const dy = ev.clientY - pointerStart.y;
          if (Math.hypot(dx, dy) > MOVE_THRESHOLD) {
            clearTimeout(holdTimer); holdTimer = null;
          }
        }
      }
      function onGlobalUp(ev) {
        if (!pointerStart) return;
        const entry = pointerStart.entry;
        if (dragEntry) {
          commitDrag(ev.clientX);
        } else if (holdTimer) {
          clearTimeout(holdTimer); holdTimer = null;
          loadEntry(history.indexOf(entry), { autoplay: true });
        }
        cleanupDrag();
      }
      function onGlobalCancel() { cleanupDrag(); }

      const makeThumb = (entry) => {
        const t = document.createElement("div");
        t.className = "vo-thumb";
        if (entry.saved) t.classList.add("vo-saved");
        t.title = entry.filename;
        const x = document.createElement("div");
        x.className = "vo-thumb-x";
        x.textContent = "\u2715";
        x.title = "Remove from scene bar (does not delete the file)";
        x.addEventListener("pointerdown", (e) => e.stopPropagation());
        x.addEventListener("click", (e) => { e.stopPropagation(); removeEntry(entry); });
        t.appendChild(x);
        t.addEventListener("pointerdown", (ev) => {
          if (ev.button !== 0) return;
          ev.stopPropagation();
          if (pointerStart || dragEntry || holdTimer) cleanupDrag();
          pointerStart = { x: ev.clientX, y: ev.clientY, entry };
          holdTimer = setTimeout(() => {
            holdTimer = null;
            if (pointerStart && pointerStart.entry === entry) beginDrag(entry);
          }, HOLD_MS);
          document.addEventListener("pointermove", onGlobalMove);
          document.addEventListener("pointerup", onGlobalUp);
          document.addEventListener("pointercancel", onGlobalCancel);
        });
        entry.thumbEl = t;
        historyEl.appendChild(t);
        queuePoster(entry);
      };

      const addEntry = (info) => {
        const entry = { ...info, rand: newRand(), saved: !!info.saved };
        history.push(entry);
        while (history.length > HISTORY_CAP) {
          const dropped = history.shift();
          dropped.thumbEl?.remove();
        }
        makeThumb(entry);
        historyEl.scrollLeft = historyEl.scrollWidth;
        loadEntry(history.length - 1, { autoplay: true });
      };
      const addResults = (results) => { for (const info of results) addEntry(info); };

      const loadExternalVideo = async (item) => {
        try {
          const r = await api.fetchApi("/video_oasis/probe_video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: item.filename,
              subfolder: item.subfolder || "",
            }),
          });
          const meta = await r.json();
          if (!r.ok || meta.error) throw new Error(meta.error || `HTTP ${r.status}`);
          const savedPath = (item.subfolder ? item.subfolder + "/" : "") + item.filename;
          addEntry({
            filename: item.filename,
            subfolder: item.subfolder || "",
            type: "output",
            width: meta.width, height: meta.height,
            fps: meta.fps, frames: meta.frames,
            size_bytes: meta.size_bytes,
            codec: meta.codec, format: meta.format,
            crf: null,
            has_audio: !!meta.has_audio,
            saved: true,
            savedPath,
            external: true,
          });
          showToast(`Loaded ${item.filename}`);
        } catch (e) {
          showToast(`Load failed: ${e.message || e}`);
        }
      };

      const openPicker = async () => {
        const overlay = document.createElement("div");
        overlay.className = "vo-picker-overlay";
        overlay.innerHTML = `
          <div class="vo-picker">
            <div class="vo-picker-head">
              <div class="vo-picker-title">Load video into scene bar</div>
              <button class="vo-picker-close" title="Cancel (Esc)">\u2715</button>
            </div>
            <div class="vo-picker-search"><input type="text" placeholder="Search filename\u2026" spellcheck="false" autocomplete="off"/></div>
            <div class="vo-picker-list"><div class="vo-picker-empty">Loading\u2026</div></div>
          </div>`;
        document.body.appendChild(overlay);
        const searchEl = overlay.querySelector(".vo-picker-search input");
        const listEl = overlay.querySelector(".vo-picker-list");
        const closeModal = () => {
          overlay.remove();
          document.removeEventListener("keydown", escHandler);
        };
        function escHandler(e) { if (e.key === "Escape") { e.stopPropagation(); closeModal(); } }
        document.addEventListener("keydown", escHandler);
        overlay.querySelector(".vo-picker-close").onclick = closeModal;
        overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
        searchEl.focus();

        let items = [];
        try {
          const r = await api.fetchApi("/video_oasis/list_output_videos");
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          items = await r.json();
          if (!Array.isArray(items)) items = [];
        } catch (e) {
          listEl.innerHTML = `<div class="vo-picker-empty">Could not list output/: ${esc(e.message || e)}</div>`;
          return;
        }
        const renderList = (filter) => {
          const f = (filter || "").toLowerCase();
          const filtered = f
            ? items.filter((it) => {
                const path = (it.subfolder ? it.subfolder + "/" : "") + it.filename;
                return path.toLowerCase().includes(f);
              })
            : items;
          if (!filtered.length) {
            listEl.innerHTML = `<div class="vo-picker-empty">${items.length ? "No matches" : "No videos in output/ yet"}</div>`;
            return;
          }
          listEl.innerHTML = filtered.map((it) => {
            const path = (it.subfolder ? it.subfolder + "/" : "") + it.filename;
            const origIdx = items.indexOf(it);
            return `<div class="vo-picker-row" data-idx="${origIdx}">
              <span class="vo-picker-name" title="${esc(path)}">${esc(path)}</span>
              <span class="vo-picker-meta">${fmtSize(it.size_bytes)}</span>
            </div>`;
          }).join("");
          listEl.querySelectorAll(".vo-picker-row").forEach((row) => {
            row.onclick = () => {
              const idx = +row.dataset.idx;
              closeModal();
              loadExternalVideo(items[idx]);
            };
          });
        };
        renderList("");
        searchEl.oninput = () => renderList(searchEl.value);
      };

      /* ── expired-entry pruning ──
         After a server restart the temp dir is cleared: restored history
         entries may point at files that no longer exist. A dead entry is
         fully unrecoverable (can't play, and /video_oasis/save skips it),
         so keeping a black thumb around is a lie -- prune it. Detection is
         a 1-byte ranged fetch against /view rather than the <video> error
         event, because hevc entries fire DECODE errors while the file is
         intact and saveable. 404 → prune; any 2xx/206 → keep; network
         failure → uncertainty, keep (never prune on doubt). ── */
      const checkAlive = async (entry) => {
        try {
          const r = await fetch(viewURL(entry), { headers: { Range: "bytes=0-0" } });
          return r.status !== 404;
        } catch { return true; }
      };
      const pruneDead = async () => {
        const flags = await Promise.all(history.map(checkAlive));
        if (flags.every(Boolean)) return;
        const activeEntry = history[activeIdx] || null;
        history = history.filter((e, i) => {
          if (!flags[i]) e.thumbEl?.remove();
          return flags[i];
        });
        if (cycleQueue) {
          cycleQueue = cycleQueue.filter((e) => history.includes(e));
          if (!cycleQueue.length) cycleQueue = null;
        }
        if (!history.length) {
          clearEmptyViewer("Previous previews expired (temp is cleared on restart) \u2014 run the workflow");
          return;
        }
        const idx = history.indexOf(activeEntry);
        loadEntry(idx >= 0 ? idx : Math.min(Math.max(activeIdx, 0), history.length - 1),
                  { autoplay: false });
      };

      /* ── save ── */

      const saveEntries = async (entries) => {
        saveHdrBtn.disabled = true;
        try {
          const res = await api.fetchApi("/video_oasis/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              videos: entries.map((e) => ({
                filename: e.filename,
                subfolder: e.subfolder || "",
                type: e.type || "temp",
              })),
              save_prefix: st.save_prefix || "video/VideoOasis",
              width: entries[0].width || 0,
              height: entries[0].height || 0,
            }),
          });
          const data = await res.json();
          if (!res.ok && !data.saved?.length) {
            throw new Error(data.error || res.statusText);
          }
          const bySource = new Map(entries.map((e) => [e.filename, e]));
          let bytes = 0;
          for (const s of data.saved || []) {
            const e = bySource.get(s.source);
            if (!e) continue;
            e.saved = true;
            e.savedPath = s.path;
            e.type = "output";
            e.filename = s.filename || e.filename;
            e.subfolder = s.subfolder != null ? s.subfolder : e.subfolder;
            e.rand = newRand();
            bytes += (s.size_kb || 0) * 1024;
            e.thumbEl?.classList.add("vo-saved");
          }
          // Repoint the player at the output copy when the active entry moved.
          if (current()?.saved) {
            loadEntry(activeIdx, { autoplay: !video.paused });
          } else {
            updateSaveBtn();
          }
          const n = data.saved?.length || 0;
          const sk = data.skipped?.length || 0;
          let msg = n === 1
            ? "Saved \u2192 output/" + data.saved[0].path
            : `Saved ${n} videos \u2192 output/` + (data.saved[0]?.subfolder || "");
          if (bytes) msg += ` (${fmtSize(bytes)})`;
          if (sk) msg += ` \u00b7 ${sk} expired (re-run the workflow)`;
          showToast(msg);
        } catch (err) {
          showToast("Save failed: " + err.message);
        } finally {
          saveHdrBtn.disabled = !current();
          updateSaveBtn();
        }
      };
      const save = async () => { if (current()) await saveEntries([current()]); };

      /* ── Clip + Create Movie ── */

      const fmtClipMark = (s) => {
        if (s == null || !Number.isFinite(s)) return "--";
        const f = Math.max(0, Math.round(s * fps()));
        return `f${f}`;
      };
      refreshClipUI = () => {
        const has = current() != null;
        markInBtn.disabled = !has;
        markOutBtn.disabled = !has;
        const ready = has && clipInS != null && clipOutS != null && clipOutS > clipInS;
        clipBtn.disabled = !ready;
        if (clipInS == null && clipOutS == null) {
          clipRangeLbl.textContent = "";
          clipRangeLbl.classList.remove("on");
        } else {
          clipRangeLbl.textContent = `${fmtClipMark(clipInS)}\u2192${fmtClipMark(clipOutS)}`;
          clipRangeLbl.classList.toggle("on", ready);
        }
        clipBtn.title = ready
          ? `Clip current video from ${fmtClipMark(clipInS)} to ${fmtClipMark(clipOutS)}`
          : "Mark in ([) and out (]) on the scrubbed frame, then Clip";
      };
      clipCurrent = async () => {
        const entry = current();
        if (!entry || clipInS == null || clipOutS == null || clipOutS <= clipInS) {
          return showToast("Mark in ([) and out (]) before clipping");
        }
        clipBtn.disabled = true;
        const prevText = clipBtn.textContent;
        clipBtn.textContent = "\u2026";
        try {
          const r = await api.fetchApi("/video_oasis/clip_video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: entry.filename,
              subfolder: entry.subfolder || "",
              type: entry.type || "temp",
              start_s: clipInS,
              end_s: clipOutS,
              fps: fps(),
              gpu_encode: st.gpu_encode !== false,
            }),
          });
          const data = await r.json();
          if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
          await loadExternalVideo({
            filename: data.filename,
            subfolder: data.subfolder || "",
          });
          clipInS = null;
          clipOutS = null;
          refreshClipUI();
          const parts = [`Clipped \u2192 output/${data.path}`];
          if (data.frames != null) parts.push(`${data.frames}f`);
          if (data.duration_s) parts.push(`${data.duration_s.toFixed(2)}s`);
          showToast(parts.join(" \u00b7 "));
        } catch (err) {
          showToast("Clip failed: " + (err.message || err));
        } finally {
          clipBtn.textContent = prevText;
          refreshClipUI();
        }
      };

      const createMovie = async () => {
        const compat = checkMovieCompat();
        if (!compat.ok) return showToast(compat.reason);
        createMovieBtn.disabled = true;
        const prevText = createMovieBtn.textContent;
        createMovieBtn.textContent = "\u{1f3ac} \u2026";
        try {
          const r = await api.fetchApi("/video_oasis/create_movie", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              entries: compat.saved.map((e) => ({
                filename: e.filename,
                subfolder: e.subfolder || "",
              })),
              use_audio: !!movieAudio,
              gpu_encode: st.gpu_encode !== false,
            }),
          });
          const data = await r.json();
          if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
          // Land the finished movie in the scene bar, same as Clip does. It
          // is NOT excluded from the next Create Movie: concatenating a movie
          // with more clips is a deliberate workflow for runs longer than the
          // bar holds. Prune what you don't want with the thumb's X first.
          if (data.filename) {
            await loadExternalVideo({
              filename: data.filename,
              subfolder: data.subfolder || "",
            });
          }
          const parts = [`Movie \u2192 output/${data.path}`];
          if (data.size_bytes) parts.push(fmtSize(data.size_bytes));
          if (data.duration_s) parts.push(`${data.duration_s.toFixed(1)}s`);
          showToast(parts.join(" \u00b7 "));
        } catch (err) {
          showToast("Create Movie failed: " + (err.message || err));
        } finally {
          createMovieBtn.textContent = prevText;
          updateSaveBtn();
        }
      };

      /* ── lightbox ── */

      const openLightbox = () => {
        if (!current() || lightboxOpen) return;
        lightboxOpen = true;
        const dragWasOn = !!video.draggable;
        setFrameDragEnabled(false);
        const overlay = document.createElement("div");
        overlay.className = "vo-lightbox";
        overlay.tabIndex = -1;
        const hint = document.createElement("div");
        hint.className = "vo-lb-hint";
        hint.textContent = "scroll = zoom \u00b7 drag = pan \u00b7 double-click = reset \u00b7 space = play/pause \u00b7 Esc / click background = close";

        const placeholder = document.createComment("vo-video");
        video.parentNode.replaceChild(placeholder, video);
        overlay.appendChild(video);
        overlay.appendChild(hint);
        document.body.appendChild(overlay);

        const fit = Math.min(
          (window.innerWidth * 0.94) / (video.videoWidth || 640),
          (window.innerHeight * 0.94) / (video.videoHeight || 360));
        let scale = Math.max(fit, 0.05), tx = 0, ty = 0;
        const apply = () =>
          (video.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`);
        apply();
        video.style.cursor = "grab";

        overlay.addEventListener("wheel", (ev) => {
          ev.preventDefault();
          const f = Math.pow(1.0015, -ev.deltaY);
          scale = Math.min(Math.max(scale * f, 0.05), 16);
          apply();
        }, { passive: false });

        let dragging = false, lx = 0, ly = 0, activePtr = null;
        overlay.addEventListener("pointerdown", (ev) => {
          if (ev.target !== video) return;
          ev.preventDefault();
          dragging = true; lx = ev.clientX; ly = ev.clientY; activePtr = ev.pointerId;
          try { video.setPointerCapture(ev.pointerId); } catch { /* */ }
          video.style.cursor = "grabbing";
        });
        const onMove = (ev) => {
          if (!dragging) return;
          tx += ev.clientX - lx; ty += ev.clientY - ly;
          lx = ev.clientX; ly = ev.clientY;
          apply();
        };
        const endDrag = (ev) => {
          if (activePtr != null && ev && ev.pointerId !== activePtr) return;
          dragging = false; activePtr = null;
          video.style.cursor = "grab";
        };
        window.addEventListener("pointermove", onMove);
        overlay.addEventListener("pointerup", endDrag);
        overlay.addEventListener("pointercancel", endDrag);
        overlay.addEventListener("dblclick", (ev) => {
          if (ev.target !== video && ev.target !== overlay) return;
          scale = fit; tx = ty = 0; apply();
        });

        const close = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("keydown", onKey);
          video.style.transform = "";
          video.style.cursor = "";
          placeholder.parentNode.replaceChild(video, placeholder);
          overlay.remove();
          lightboxOpen = false;
          setFrameDragEnabled(dragWasOn && !!current());
        };
        const onKey = (ev) => {
          if (ev.key === "Escape") { ev.preventDefault(); close(); }
          else if (ev.code === "Space") { ev.preventDefault(); togglePlay(); }
          else if (ev.key === "ArrowLeft") { ev.preventDefault(); step(-1); }
          else if (ev.key === "ArrowRight") { ev.preventDefault(); step(1); }
        };
        window.addEventListener("keydown", onKey);
        overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
        try { overlay.focus({ preventScroll: true }); } catch { /* */ }
      };

      /* ── io_id lifecycle (verbatim IO pattern) ──
         LiteGraph calls onAdded BEFORE node.configure() → setValue. So on
         a rebuild, onAdded runs while ioId is still "" (the saved id is
         only restored by setValue moments later). Registration and drain
         therefore live in registerIoHandler(), called from BOTH onAdded
         (fresh node -- setValue never fires) and the END of setValue
         (rebuild path -- after preview state is restored, so drained
         results append after the restored history). registeredIoId tracks
         the key actually in VO_HANDLERS so a re-call with a different
         ioId cleans up the stale registration. ── */
      let registeredIoId = null;
      const ensureIoId = () => {
        if (!ioId) ioId = (crypto?.randomUUID?.() ?? ("vo-" + Date.now() + "-" + newRand()));
        return ioId;
      };
      const registerIoHandler = () => {
        ensureIoId();
        // Paste-duplicate: ComfyUI deep-copies widget state, so another LIVE
        // closure may already own this id. Mint our own instead of stealing.
        const existing = VO_HANDLERS.get(ioId);
        if (existing && existing !== addResults) {
          ioId = "";
          ensureIoId();
        }
        if (registeredIoId && registeredIoId !== ioId) VO_HANDLERS.delete(registeredIoId);
        VO_HANDLERS.set(ioId, addResults);
        registeredIoId = ioId;
        // Drain results that landed while this closure was torn down
        // (off-tab completion during a workflow switch).
        if (VO_PENDING.has(ioId)) {
          const pending = VO_PENDING.get(ioId);
          VO_PENDING.delete(ioId);
          addResults(pending);
        }
      };

      /* ── widget mount + persistence ──
         The Python side declares "video_oasis_ui" as an optional STRING
         input; the frontend auto-creates a text widget for it. Remove
         that and mount the DOM widget UNDER THE SAME NAME so its
         getValue is what serializes into the prompt (backend reads it
         via _read_widget_state) and into workflow JSON (survives tab
         switches and hard refreshes; setValue restores). ── */
      const auto = this.widgets?.findIndex((w) => w.name === "video_oasis_ui");
      if (auto >= 0) this.widgets.splice(auto, 1);

      this.addDOMWidget("video_oasis_ui", "div", container, {
        hideOnZoom: false,
        getValue: () => JSON.stringify({
          version: 1,
          // Stable per-node UUID for side-channel result routing (read by
          // Python from the JSON top-level, used to key the
          // "video-oasis/result" WS event back to the originating node).
          io_id: ensureIoId(),
          exec: st,
          uiState: { open, playMode, muted, speed, movieAudio },
          // Persist the preview history as raw {filename,subfolder,type}
          // refs + known metadata, not pixels; the <video> re-resolves via
          // /view. A temp file cleared between sessions 404s and degrades
          // to the empty state. Runtime-only fields (thumbEl, rand,
          // warned) are stripped; posters regenerate on restore rather
          // than bloating the workflow JSON with dataURLs.
          preview: {
            history: history.map(({ thumbEl, rand, warned, proxy, _proxyP, proxyFailed, proxyTried, proxyError, ...keep }) => keep),
            activeIdx,
          },
        }),
        setValue: (v) => { try {
          const o = JSON.parse(v);
          if (!o || typeof o !== "object") return;
          if (typeof o.io_id === "string" && o.io_id) ioId = o.io_id;
          if (o.exec && typeof o.exec === "object") st = { ...st, ...o.exec };
          const ui = o.uiState || {};
          // Legacy workflows had separate Encode + Output sections.
          if (ui.open && typeof ui.open === "object") {
            open = { encode: !!(ui.open.encode || ui.open.output) };
          }
          // Migrate older binary `loop` → playMode.
          if (typeof ui.playMode === "string" && ["off", "loop", "cycle"].includes(ui.playMode)) {
            playMode = ui.playMode;
          } else if (typeof ui.loop === "boolean") {
            playMode = ui.loop ? "loop" : "off";
          }
          if (typeof ui.muted === "boolean") muted = ui.muted;
          if (typeof ui.speed === "number" && SPEEDS.includes(ui.speed)) speed = ui.speed;
          if (typeof ui.movieAudio === "boolean") movieAudio = ui.movieAudio;
          syncPlayerPrefs();
          if (o.preview && Array.isArray(o.preview.history) && o.preview.history.length) {
            for (const e of history) e.thumbEl?.remove();
            history = o.preview.history.map((e) => ({
              ...e, rand: newRand(), saved: !!e.saved,
            }));
            for (const e of history) makeThumb(e);
            let idx = typeof o.preview.activeIdx === "number" ? o.preview.activeIdx | 0 : history.length - 1;
            idx = Math.min(history.length - 1, Math.max(0, idx));
            // Restore is passive: show the video paused rather than
            // surprise-autoplaying (with audio) on page load.
            loadEntry(idx, { autoplay: false });
          }
          renderSections();
          // Re-key the result handler to the restored io_id and drain any
          // off-tab result. MUST run after the history restore above so
          // drained results append after the restored strip.
          registerIoHandler();
          // Validate restored entries against the server in the background;
          // anything whose temp file was cleared gets pruned from the strip.
          if (history.length) pruneDead();
        } catch (err) { console.warn("[Video Oasis] state restore failed:", err); } },
      });

      /* ── lifecycle hooks (instance level) ── */

      // Registry scanner false-positive hygiene (Image Oasis v1.4.1).
      const _origAdded = selfNode.onAdded;
      selfNode.onAdded = function () {
        if (_origAdded) _origAdded.apply(this, arguments);
        // Fresh-node path: no saved widget value → setValue never fires
        // and this is the only registration. Rebuild path: setValue runs
        // after this, restores the saved io_id, and re-keys (the paste-
        // duplicate check also lands here: if the copied id is live in
        // VO_HANDLERS under another closure, registerIoHandler mints a
        // fresh one instead of stealing the stream).
        registerIoHandler();
      };
      const _origRemoved = selfNode.onRemoved;
      selfNode.onRemoved = function () {
        // Unregister so future results stash into VO_PENDING instead of
        // calling into this dead closure; the next closure's registration
        // drains them.
        if (registeredIoId) { VO_HANDLERS.delete(registeredIoId); registeredIoId = null; }
        clearTimeout(_badgeT);
        clearTimeout(_toastT);
        if (_origRemoved) _origRemoved.apply(this, arguments);
      };

      // Belt-and-suspenders: nothing on the backend returns ui.images for
      // this node, but if anything ever assigns node.imgs, the canvas
      // paint hook stays a no-op (no image smeared under the node).
      selfNode.onDrawBackground = function () {};

      /* ── first paint ── */
      renderSections();
      loadNvencCodecs().then((codecs) => { nvencCodecs = codecs; renderSections(); });
      syncPlayerPrefs();
      renderInfo();
      updateSaveBtn();
      refreshClipUI();
    };
  },
});
