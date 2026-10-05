// LTX2.3 Oasis — Image Oasis–style AIO node with in-pane video player.
// Structure, classes, persistence, presets, LoRA stack, theme, help, timer
// and QoL follow IO where possible; no compare slider. GPL-3.0-or-later.
//
//  - One DOM widget named "ltx23_oasis_ui": getValue/setValue serialize
//    the ENTIRE node state (flat IO-style execState + io_id + preview
//    history + player prefs + open sections) into workflow JSON; the
//    backend reads execState + io_id from the same JSON.
//  - Results routed by stable io_id over "video-oasis/result" (module-level
//    HANDLER/PENDING maps, IO's stash-and-drain lifecycle).
//  - Fixed initial node size; CSS owns the interior. NO computeSize
//    overrides, no onResize hooks (the runaway-Y class of bug).
//  - Left column re-renders IO-style (innerHTML). The player pane is built
//    ONCE and mutated imperatively — innerHTML would destroy the <video>
//    and restart playback.
//  - Palette is LTX Oasis's own (stored under /ltx23_oasis/theme*), CSS-scoped
//    to `.iov-widget` so IO's `:root` block can't leak in. The prompt
//    enhancer is still shared with Image Oasis (/ltx23_oasis/enhance
//    route reuses IO's resident LLM + lock via sys.modules).

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const CSS = `
.iov-widget{font-family:var(--io-sans,'DM Sans',sans-serif);background:var(--io-bg,#000);border:1px solid var(--io-bd,#3a3a3a);border-radius:6px;padding:0;width:100%;box-sizing:border-box;color:#ddd;overflow:hidden;display:flex;flex-direction:column;}
.iov-widget .io-inner{padding:8px 10px 10px;display:flex;flex-direction:column;gap:8px;flex:1;overflow:hidden;min-height:0;}
.iov-widget .io-section{background:var(--io-bg2,#2a2a2a);border:1px solid var(--io-bd,#3a3a3a);border-radius:5px;overflow:visible;flex-shrink:0;}
.iov-widget .io-sec-head{display:flex;align-items:center;gap:7px;padding:6px 9px;cursor:pointer;user-select:none;}
.iov-widget .io-sec-title{flex:1;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;font-weight:700;letter-spacing:.07em;color:var(--io-accent,#6f8bbd);text-transform:uppercase;}
.iov-widget .io-chevron{color:var(--io-dim,#888);transition:transform .15s;font-size:13px;}
.iov-widget .io-chevron.open{transform:rotate(90deg);}
.iov-widget .io-sec-body{padding:4px 9px 9px;display:flex;flex-direction:column;gap:7px;}
.iov-widget .io-row{display:flex;align-items:center;gap:8px;}
.iov-widget .io-label{font-size:10px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);width:74px;flex-shrink:0;letter-spacing:.04em;}
.iov-widget .io-label.dim{opacity:.5;}
.iov-widget .io-select,.iov-widget .io-input{flex:1;min-width:0;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#ddd;font-family:var(--io-sans,'DM Sans',sans-serif);font-size:11px;padding:4px 6px;outline:none;}
.iov-widget .io-select:focus,.iov-widget .io-input:focus{border-color:var(--io-accent,#6f8bbd);}
.iov-widget .io-select:disabled{opacity:.4;}
.iov-widget .io-ta-wrap{position:relative;width:100%;display:flex;flex-direction:column;}
.iov-widget .io-ta{width:100%;box-sizing:border-box;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px 4px 0 0;color:#ddd;font-family:var(--io-sans,'DM Sans',sans-serif);font-size:11px;padding:5px 7px;outline:none;resize:none;overflow-y:auto;line-height:1.4;display:block;}
.iov-widget .io-ta:focus{border-color:var(--io-accent,#6f8bbd);}
.iov-widget .io-ta-handle{height:9px;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-top:none;border-radius:0 0 4px 4px;cursor:ns-resize;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.iov-widget .io-ta-handle::before{content:"";width:24px;height:0;border-top:2px dotted var(--io-dim,#888);}
.iov-widget .io-ta-handle:hover::before{border-color:#999;}
.iov-widget .io-ta.io-ta-ignored{opacity:.45;}
.iov-widget .io-neg-ignored-note{font-size:9px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);letter-spacing:.04em;margin-top:-3px;}
.iov-widget .io-toggle-grp{display:flex;gap:0;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;overflow:hidden;flex:1;}
.iov-widget .io-tog{flex:1;background:#191919;border:none;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;line-height:1.15;padding:5px 4px;cursor:pointer;letter-spacing:.04em;transition:all .12s;}
.iov-widget .io-tog.active{background:var(--io-accent-dim,#4a5d82);color:#fff;font-weight:700;}
.iov-widget .io-subsec{border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;background:#1a1a1a;margin-top:4px;}
.iov-widget .io-subsec-head{display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;user-select:none;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;color:var(--io-dim,#888);letter-spacing:.07em;text-transform:uppercase;}
.iov-widget .io-subsec-head:hover{color:#ddd;}
.iov-widget .io-subsec-title{flex:1;}
.iov-widget .io-subsec-body{padding:7px 8px 8px;display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--io-bd,#3a3a3a);}
.iov-widget .io-rec-label{font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;color:var(--io-dim,#888);letter-spacing:.04em;white-space:nowrap;}
.iov-widget .io-warn-tip{font-family:var(--io-mono,'Space Mono',monospace);font-size:9px;color:#c98;letter-spacing:.03em;line-height:1.3;padding:2px 0;}
.iov-widget .io-icon-btn{background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#bbb;font-size:12px;cursor:pointer;padding:3px 7px;flex-shrink:0;}
.iov-widget .io-icon-btn:hover{border-color:#777;color:#fff;}
.iov-widget .io-icon-btn:disabled{opacity:.35;cursor:default;}
.iov-widget .io-icon-btn.io-dice{background:var(--io-accent-dim,#4a5d82);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.iov-widget .io-icon-btn.io-dice:hover{background:var(--io-accent,#6f8bbd);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.iov-widget .io-icon-btn.io-go{background:var(--io-go-fill,#3a5a3f);border-color:var(--io-go-bd,#4f7a56);color:#fff;}
.iov-widget .io-icon-btn.io-go:hover{background:var(--io-go-bd,#4f7a56);border-color:var(--io-go-bd,#4f7a56);color:#fff;}
.iov-widget .io-icon-btn.io-save{background:var(--io-accent-dim,#4a5d82);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.iov-widget .io-icon-btn.io-save:hover{background:var(--io-accent,#6f8bbd);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.iov-widget .io-icon-btn.io-stop{background:#5a3a3a;border-color:#7a4f4f;color:#fff;}
.iov-widget .io-icon-btn.io-stop:hover{background:#7a4f4f;border-color:#8f5c5c;color:#fff;}
.iov-widget .io-icon-btn.io-sm{box-sizing:border-box;width:24px;height:24px;padding:0;font-size:11px;line-height:1;display:inline-flex;align-items:center;justify-content:center;}
.iov-widget .io-icon-btn.io-hdr{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:13px;line-height:1;}
.iov-widget .io-chk{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:10px;color:#ddd;font-family:var(--io-mono,'Space Mono',monospace);flex:1;}
.iov-widget .io-chk-box{width:14px;height:14px;border:1px solid var(--io-bd,#3a3a3a);border-radius:3px;background:#191919;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;flex-shrink:0;}
.iov-widget .io-chk-box.on{background:var(--io-accent-dim,#4a5d82);border-color:var(--io-accent,#6f8bbd);}
.iov-widget .io-half{display:flex;gap:8px;}
.iov-widget .io-half>div{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}
.iov-widget .io-mini{font-size:9px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);letter-spacing:.04em;}
.iov-widget .io-badge{font-size:8px;background:#5a5a5a;color:#eee;border-radius:3px;padding:1px 4px;font-family:var(--io-mono,'Space Mono',monospace);font-weight:700;margin-left:5px;}
.iov-widget .io-body{display:flex;gap:9px;flex:1;min-height:0;overflow:hidden;}
.iov-widget .io-col-left-wrap{display:flex;flex-direction:column;flex:0 0 360px;min-height:0;min-width:0;overflow:hidden;}
.iov-widget .io-col-left{display:flex;flex-direction:column;gap:9px;overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;min-width:0;}
.iov-widget .io-col-left::-webkit-scrollbar{width:4px;}
.iov-widget .io-col-left::-webkit-scrollbar-thumb{background:var(--io-bd,#3a3a3a);border-radius:2px;}
.iov-widget .io-col-left::-webkit-scrollbar-thumb:hover{background:var(--io-bd,#3a3a3a);}
.iov-widget .io-bypass-bar{flex:0 0 auto;padding-top:8px;margin-top:4px;border-top:1px solid var(--io-bd,#3a3a3a);}
.iov-widget .io-bypass-btn{width:100%;box-sizing:border-box;height:30px;margin:0;border-radius:4px;border:1px solid var(--io-bd,#3a3a3a);background:#191919;color:#ddd;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;}
.iov-widget .io-bypass-btn:hover{border-color:#777;color:#fff;}
.iov-widget .io-bypass-btn.is-bypassed{background:var(--io-accent-dim,#4a5d82);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.iov-widget .io-lora-civit{flex:0 0 56px;height:22px;padding:0 2px;margin:0;border-radius:3px;border:1px solid var(--io-bd,#3a3a3a);background:#191919;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:8px;font-weight:700;letter-spacing:.02em;cursor:pointer;text-align:center;box-sizing:border-box;}
.iov-widget .io-lora-civit:hover{border-color:var(--io-accent,#6f8bbd);color:#fff;}
.iov-widget .io-lora-civit:disabled{opacity:.35;cursor:default;}
.iov-widget .io-lora-civit-trail{flex:0 0 18px;}
.iov-widget .io-col-right{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:#161616;border:1px solid var(--io-bd,#3a3a3a);border-radius:5px;overflow:hidden;}
.iov-widget .io-preview-head{position:relative;display:flex;align-items:center;gap:8px;font-family:var(--io-mono,'Space Mono',monospace);font-size:9px;font-weight:700;letter-spacing:.08em;color:var(--io-accent,#6f8bbd);text-transform:uppercase;padding:6px 9px;border-bottom:1px solid var(--io-bd,#3a3a3a);flex-shrink:0;}
@keyframes io-timer-pulse{0%,100%{text-shadow:0 0 8px var(--io-accent,#6f8bbd);}50%{text-shadow:0 0 14px var(--io-accent,#6f8bbd);}}
.iov-widget .io-timer{position:absolute;left:50%;top:50%;transform:translate(calc(-50% + 20px),-50%);pointer-events:none;font-family:'Orbitron','Space Mono',monospace;font-size:22px;font-weight:700;letter-spacing:.04em;color:var(--io-dim,#888);font-variant-numeric:tabular-nums;white-space:nowrap;min-width:9ch;text-align:left;transition:color .4s ease;}
.iov-widget .io-timer.running{color:var(--io-accent,#6f8bbd);animation:io-timer-pulse 2.4s infinite ease-in-out;}
.iov-widget .io-lora-row{display:flex;align-items:center;gap:5px;}
.iov-widget .io-lora-str{flex:0 0 56px;text-align:center;padding:4px 3px;}
.iov-widget .io-lora-row.off{opacity:.42;}
.iov-widget .io-lora-en{flex:0 0 20px;background:none;border:none;color:var(--io-dim,#888);font-size:21px;line-height:1;cursor:pointer;padding:0;}
.iov-widget .io-lora-en.on{color:var(--io-accent,#6f8bbd);}
.iov-widget .io-lora-drag,.iov-widget .io-preset-drag{flex:0 0 14px;display:grid;grid-template-columns:repeat(3,3px);grid-template-rows:repeat(3,3px);gap:2px;cursor:grab;padding:2px 0;opacity:.45;transition:opacity .12s;align-content:center;justify-content:center;}
.iov-widget .io-lora-drag:hover,.iov-widget .io-preset-head:hover .io-preset-drag{opacity:1;}
.iov-widget .io-lora-drag:active,.iov-widget .io-preset-drag:active{cursor:grabbing;}
.iov-widget .io-lora-drag-dot,.iov-widget .io-preset-drag-dot{width:3px;height:3px;border-radius:50%;background:var(--io-dim,#888);}
.iov-widget .io-lora-row.io-lora-dragging{opacity:.35;}
.iov-widget .io-lora-row.io-lora-drop-above{box-shadow:0 -2px 0 0 var(--io-accent,#6f8bbd);}
.iov-widget .io-lora-row.io-lora-drop-below{box-shadow:0 2px 0 0 var(--io-accent,#6f8bbd);}
.iov-widget .io-lora-trigger-row{display:flex;align-items:center;gap:5px;margin:2px 0 4px 0;}
.iov-widget .io-lora-trigger-row .io-lora-trigger-spacer{flex:0 0 39px;}
.iov-widget .io-lora-trigger-row input{flex:1;font-size:11px;padding:3px 5px;}
.iov-widget .io-refslot{display:flex;align-items:center;gap:8px;}
.iov-widget .io-refslot.io-refslot-dim{opacity:.45;}
.iov-widget .io-ref-mid{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:2px;}
.iov-widget .io-ref-mid .io-ref-btn{width:100%;flex:0 0 auto;}
.iov-widget .io-ref-info{font-size:10px;opacity:.75;display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden;min-height:14px;padding-left:2px;}
.iov-widget .io-ref-size-btn{background:none;border:1px solid var(--io-bd,#3a3a3a);border-radius:3px;color:inherit;font-size:10px;line-height:1;padding:1px 4px;cursor:pointer;}
.iov-widget .io-ref-size-btn:hover{background:var(--io-accent,#6f8bbd);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.iov-widget .io-ref-thumb{width:44px;height:44px;border-radius:4px;border:1px solid var(--io-bd,#3a3a3a);object-fit:cover;background:#191919;flex-shrink:0;}
.iov-widget .io-ref-thumb-empty{width:44px;height:44px;border-radius:4px;border:1px dashed var(--io-bd,#3a3a3a);background:#191919;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--io-dim,#888);font-size:9px;font-family:var(--io-mono,'Space Mono',monospace);}
.iov-widget .io-ref-thumb,.iov-widget .io-ref-thumb-empty{outline:none;}
.iov-widget .io-ref-thumb.io-drop,.iov-widget .io-ref-thumb-empty.io-drop,
.iov-widget .io-ref-thumb:focus,.iov-widget .io-ref-thumb-empty:focus{border-color:var(--io-accent,#6f8bbd);box-shadow:0 0 0 2px var(--io-accent-dim,#4a5d82);}
.iov-widget .io-ref-btn{flex:1;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;padding:5px 6px;cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.iov-widget .io-ref-btn:hover{border-color:#777;color:#ddd;}
.iov-widget .io-ref-clear{background:none;border:none;color:var(--io-dim,#888);cursor:pointer;font-size:11px;flex-shrink:0;}
.iov-widget .io-ref-clear:hover{color:#e07050;}
.iov-widget .io-beat{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-top:1px solid rgba(255,255,255,.04);}
.iov-widget .io-beat:first-of-type{border-top:none;padding-top:2px;}
.iov-widget .io-beat-body{display:flex;gap:7px;align-items:flex-start;}
.iov-widget .io-beat-guide{display:flex;flex-direction:column;align-items:center;gap:3px;flex:0 0 44px;}
.iov-widget .io-beat-guide-wrap{position:relative;width:44px;height:44px;flex-shrink:0;}
.iov-widget .io-beat-guide-wrap .io-ref-thumb,
.iov-widget .io-beat-guide-wrap .io-ref-thumb-empty{width:44px;height:44px;display:block;}
.iov-widget .io-beat-guide-wrap .io-ref-thumb-empty{font-size:16px;line-height:44px;text-align:center;cursor:pointer;padding:0;}
.iov-widget .io-beat-guide-x{position:absolute;top:1px;right:1px;width:14px;height:14px;padding:0;border:none;border-radius:3px;background:rgba(0,0,0,.72);color:#ddd;font-size:10px;line-height:14px;text-align:center;cursor:pointer;opacity:0;transition:opacity .12s;z-index:2;}
.iov-widget .io-beat-guide-wrap:hover .io-beat-guide-x,
.iov-widget .io-beat-guide-wrap:focus-within .io-beat-guide-x{opacity:1;}
.iov-widget .io-beat-guide-x:hover{background:#e07050;color:#fff;}
.iov-widget .io-beat-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.iov-widget .io-beat-str{width:44px;box-sizing:border-box;padding:2px 3px;font-size:10px;text-align:center;flex-shrink:0;}
.iov-widget .io-beat-sum{margin-top:4px;letter-spacing:.03em;}
.iov-widget .io-beat-sum.ok{color:var(--io-go-bd,#4f7a56);opacity:1;}
.iov-widget .io-beat-sum.short{color:#c98;opacity:1;}
.iov-widget .io-beat-sum.over{color:#e07050;opacity:1;}
.iov-widget .io-mode-bar{min-height:30px;}
.iov-widget .io-mode-bar .io-toggle-grp{height:30px;align-self:stretch;}
.iov-widget .io-mode-bar .io-tog{padding:0 4px;height:100%;display:inline-flex;align-items:center;justify-content:center;}
.iov-widget .io-btn.io-btn-bar{height:30px;margin-top:0;padding:0 8px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;}
.iov-widget .io-subsec.io-subsec-bar > .io-subsec-head{min-height:30px;box-sizing:border-box;}
.iov-widget .vo-btn-movie-audio{background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#bbb;font-family:var(--io-mono,'Space Mono',monospace);font-size:12px;font-weight:700;height:26px;padding:0 8px;cursor:pointer;letter-spacing:.05em;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;gap:4px;box-sizing:border-box;}
.iov-widget .vo-btn-movie-audio:hover{border-color:#777;color:#fff;}
.iov-widget .vo-btn-movie-audio.vo-on{background:var(--io-accent-dim,#4a5d82);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.iov-widget .vo-btn-movie-audio:disabled{opacity:.35;cursor:default;}
.iov-widget .vo-clip-mark{font-variant-numeric:tabular-nums;font-size:9px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);flex-shrink:0;min-width:0;}
.iov-widget .vo-clip-mark.on{color:var(--io-accent,#6f8bbd);}
.iov-widget .io-preset-card{background:var(--io-bg2,#2a2a2a);border:1px solid var(--io-bd,#3a3a3a);border-radius:5px;overflow:hidden;flex-shrink:0;transition:box-shadow .1s;}
.iov-widget .io-preset-card.io-preset-drop-above{box-shadow:0 -2px 0 0 var(--io-accent,#6f8bbd);}
.iov-widget .io-preset-card.io-preset-drop-below{box-shadow:0 2px 0 0 var(--io-accent,#6f8bbd);}
.iov-widget .io-preset-card.io-preset-dragging{opacity:.35;}
.iov-widget .io-preset-head{display:flex;align-items:center;gap:7px;padding:6px 9px;cursor:pointer;user-select:none;}
.iov-widget .io-preset-nm{flex:1;font-family:var(--io-mono,'Space Mono',monospace);font-size:11px;font-weight:700;color:var(--io-accent,#6f8bbd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.iov-widget .io-preset-meta{font-size:8px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);}
.iov-widget .io-preset-del{background:none;border:none;color:var(--io-dim,#888);cursor:pointer;font-size:11px;flex-shrink:0;padding:0 2px;}
.iov-widget .io-preset-del:hover{color:#e07050;}
.iov-widget .io-preset-detail{padding:4px 9px 9px;display:flex;flex-direction:column;gap:4px;}
.iov-widget .io-kv{display:flex;gap:6px;font-size:10px;}
.iov-widget .io-kv-k{color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);width:60px;flex-shrink:0;}
.iov-widget .io-kv-v{color:#ddd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
.iov-widget .io-btn{background:var(--io-accent-dim,#4a5d82);border:1px solid var(--io-accent,#6f8bbd);color:#fff;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;font-weight:700;padding:5px 8px;border-radius:4px;cursor:pointer;letter-spacing:.05em;margin-top:3px;}
.iov-widget .io-btn:hover{background:var(--io-accent,#6f8bbd);}
.iov-widget .io-empty{color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;text-align:center;padding:14px;line-height:1.6;}
.iov-widget .io-swatch{width:30px;height:26px;padding:0;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;background:#191919;cursor:pointer;flex-shrink:0;}
.iov-widget .io-swatch::-webkit-color-swatch-wrapper{padding:2px;}
.iov-widget .io-swatch::-webkit-color-swatch{border:none;border-radius:2px;}
.iov-widget .io-hex{flex:0 0 76px;font-family:var(--io-mono,'Space Mono',monospace);text-transform:lowercase;}
.iov-widget .io-theme-row{display:flex;align-items:center;gap:7px;padding:5px 8px;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;cursor:pointer;}
.iov-widget .io-theme-row:hover{border-color:var(--io-accent,#6f8bbd);}
.iov-widget .io-theme-row.active{border-color:var(--io-accent,#6f8bbd);box-shadow:inset 0 0 0 1px var(--io-accent-dim,#4a5d82);}
.iov-widget .io-theme-chips{display:inline-flex;gap:2px;flex-shrink:0;}
.iov-widget .io-theme-chip{width:11px;height:11px;border-radius:2px;border:1px solid rgba(255,255,255,.08);}
.iov-widget .io-theme-nm{flex:1;font-family:var(--io-mono,'Space Mono',monospace);font-size:11px;font-weight:700;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.iov-widget .io-theme-meta{font-size:8px;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);}
.iov-widget .io-help-body{height:300px;overflow-y:auto;padding:10px 12px;background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#ddd;font-family:var(--io-sans,'DM Sans',sans-serif);font-size:12px;line-height:1.55;}
.iov-widget .io-help-body > *:first-child{margin-top:0;}
.iov-widget .io-help-body h1{font-size:15px;margin:.4em 0 .35em;color:var(--io-accent,#6f8bbd);font-weight:700;letter-spacing:.02em;}
.iov-widget .io-help-body h2{font-size:13px;margin:.9em 0 .25em;color:var(--io-accent,#6f8bbd);font-weight:700;}
.iov-widget .io-help-body h3{font-size:12px;margin:.55em 0 .2em;color:#e6e6e6;font-weight:700;}
.iov-widget .io-help-body p{margin:.4em 0;}
.iov-widget .io-help-body ul,.iov-widget .io-help-body ol{margin:.3em 0 .4em 1.3em;padding:0;}
.iov-widget .io-help-body li{margin:.15em 0;}
.iov-widget .io-help-body code{font-family:var(--io-mono,'Space Mono',monospace);font-size:11px;background:#0a0a0a;padding:1px 5px;border-radius:3px;color:#cfe5b9;}
.iov-widget .io-help-body strong{color:#fff;}
.iov-widget .io-help-body em{color:#c8d2e0;}
.iov-widget .io-help-body hr{border:none;border-top:1px solid var(--io-bd,#3a3a3a);margin:.7em 0;}
.iov-widget .io-help-body blockquote{margin:.4em 0;padding:.2em 10px;border-left:3px solid var(--io-accent-dim,#4a5d82);background:rgba(0,0,0,.25);color:#d8d8d8;border-radius:0 3px 3px 0;}
/* ── Player pane internals (shared player classes) ── */
.iov-widget .vo-stage{position:relative;flex:1;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:9px;box-sizing:border-box;}
.iov-widget .vo-stage video{width:100%;height:100%;object-fit:contain;display:block;outline:none;background:#000;border-radius:4px;border:1px solid var(--io-bd,#3a3a3a);}
.iov-widget .vo-stage video.vo-frame-drag{cursor:grab;}
.iov-widget .vo-stage video.vo-frame-drag:active{cursor:grabbing;}
.iov-widget .vo-empty{color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;text-align:center;margin:auto;padding:20px;line-height:1.6;}
.iov-widget .vo-badge{position:absolute;top:14px;left:14px;background:rgba(0,0,0,.65);padding:2px 7px;border-radius:4px;font-size:10px;font-family:var(--io-mono,'Space Mono',monospace);pointer-events:none;transition:opacity .4s;z-index:3;}
.iov-widget .vo-badge.vo-hide{opacity:0;}
.iov-widget .vo-toast{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(20,20,20,.92);border:1px solid #555;padding:4px 12px;border-radius:5px;pointer-events:none;opacity:0;transition:opacity .25s;max-width:92%;text-align:center;font-size:11px;z-index:4;}
.iov-widget .vo-toast.vo-show{opacity:1;}
.iov-widget .vo-scrubrow{display:flex;align-items:center;gap:8px;padding:5px 9px 2px;flex-shrink:0;}
.iov-widget .vo-scrub{flex:1;accent-color:var(--io-accent,#6f8bbd);height:14px;cursor:pointer;min-width:0;}
.iov-widget .vo-time{font-variant-numeric:tabular-nums;color:var(--io-dim,#888);white-space:nowrap;font-family:var(--io-mono,'Space Mono',monospace);font-size:9px;letter-spacing:.02em;}
.iov-widget .vo-ctrlbar{display:flex;align-items:center;gap:6px;padding:6px 9px;border-top:1px solid var(--io-bd,#3a3a3a);flex-shrink:0;}
.iov-widget .vo-icon-btn{background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#bbb;cursor:pointer;flex-shrink:0;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;padding:0;font-size:13px;line-height:1;}
.iov-widget .vo-icon-btn:hover{border-color:#777;color:#fff;}
.iov-widget .vo-icon-btn:disabled{opacity:.35;cursor:default;}
.iov-widget .vo-icon-btn.vo-on{background:var(--io-accent-dim,#4a5d82);border-color:var(--io-accent,#6f8bbd);color:#fff;}
.iov-widget .vo-btn-save{background:var(--io-accent-dim,#4a5d82);border:1px solid var(--io-accent,#6f8bbd);border-radius:4px;color:#fff;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;font-weight:700;height:26px;padding:0 8px;cursor:pointer;letter-spacing:.05em;flex-shrink:0;display:inline-flex;align-items:center;gap:4px;}
.iov-widget .vo-btn-save:hover{background:var(--io-accent,#6f8bbd);}
.iov-widget .vo-btn-save:disabled{opacity:.35;cursor:default;}
.iov-widget .io-icon-btn.io-save.io-saved-mark{color:var(--io-go-bd,#4f7a56);}
.iov-widget .vo-speed{background:#191919;border:1px solid var(--io-bd,#3a3a3a);border-radius:4px;color:#bbb;font-family:var(--io-mono,'Space Mono',monospace);font-size:10px;height:26px;padding:0 3px;cursor:pointer;outline:none;flex-shrink:0;}
.iov-widget .vo-infobar{padding:3px 10px;font-family:var(--io-mono,'Space Mono',monospace);font-size:8px;color:var(--io-dim,#888);letter-spacing:.06em;background:rgba(0,0,0,.25);border-top:1px solid var(--io-bd,#3a3a3a);white-space:nowrap;overflow:hidden;flex-shrink:0;height:20px;line-height:14px;box-sizing:border-box;display:flex;align-items:center;gap:6px;}
.iov-widget .vo-info-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}
.iov-widget .vo-info-text.vo-warn{color:#e0a050;}
.iov-widget .vo-nolatent{color:#e0a050;}
.iov-widget .vo-info-label{font-weight:700;color:var(--io-accent,#6f8bbd);}
.iov-widget .vo-nav{display:inline-flex;align-items:center;gap:4px;flex-shrink:0;color:var(--io-dim,#888);font-family:var(--io-mono,'Space Mono',monospace);font-size:9px;letter-spacing:.04em;}
.iov-widget .vo-nav-arrow{background:none;border:none;color:var(--io-dim,#888);cursor:pointer;font-size:14px;line-height:1;padding:0 4px;font-family:var(--io-mono,'Space Mono',monospace);}
.iov-widget .vo-nav-arrow:hover{color:var(--io-accent,#6f8bbd);}
.iov-widget .vo-history{display:flex;gap:5px;overflow-x:auto;padding:4px 9px 6px;min-height:58px;flex-shrink:0;border-top:1px solid var(--io-bd,#3a3a3a);}
.iov-widget .vo-history::-webkit-scrollbar{height:6px;}
.iov-widget .vo-history::-webkit-scrollbar-thumb{background:var(--io-bd,#3a3a3a);border-radius:3px;}
/* Explicit :hover twin. The two-class scope already outranks ComfyUI's global
   ::-webkit-scrollbar-thumb:hover rule, which is why this strip never had the
   vanishing-thumb problem IO and VOV did; stating it keeps that immunity from
   depending on a specificity margin nobody can see. */
.iov-widget .vo-history::-webkit-scrollbar-thumb:hover{background:var(--io-bd,#3a3a3a);}
/* Two-tier thumb state:
 *   base (temp)     : dashed green border  — preview, not persisted on restart
 *   .vo-saved       : solid  green border  — copied to output/, survives restart
 *   .vo-active      : accent color         — currently loaded in the viewer
 *   .vo-cycling     : amber                — currently playing under Cycle mode
 * Cycling wins over active by source order. Hover uses box-shadow so it
 * doesn't stomp the state color. */
.iov-widget .vo-thumb{position:relative;flex:0 0 auto;width:88px;height:50px;border-radius:4px;border:2px dashed var(--io-go-bd,#4f7a56);cursor:pointer;background:#000 center/cover no-repeat;box-sizing:border-box;transition:box-shadow .12s ease;}
.iov-widget .vo-thumb:hover{box-shadow:0 0 0 1px rgba(255,255,255,.18);}
.iov-widget .vo-thumb.vo-saved{border-style:solid;}
.iov-widget .vo-thumb.vo-active{border-color:var(--io-accent,#6f8bbd);}
.iov-widget .vo-thumb.vo-cycling{border-color:#e0a800;}
/* Delete ✕: hover-reveal top-right. Suppressed while a reorder drag is in
 * flight so a mid-drag hover on some other thumb doesn't flash phantom X's. */
.iov-widget .vo-thumb-x{position:absolute;right:3px;top:3px;width:14px;height:14px;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.75);color:#eee;border-radius:50%;font-size:9px;line-height:1;font-weight:bold;cursor:pointer;border:1px solid rgba(255,255,255,.25);user-select:none;}
.iov-widget .vo-thumb:hover .vo-thumb-x{display:flex;}
.iov-widget .vo-thumb-x:hover{background:rgba(180,40,40,.9);color:#fff;border-color:rgba(255,255,255,.55);}
.iov-widget.vo-reorder-active .vo-thumb-x{display:none !important;}
/* Long-press drag: source dims, insertion cursor renders as a thin accent
 * bar on the appropriate side of the target thumb. Pseudo-elements sit just
 * outside the border so they read as gaps, not overlays. */
.iov-widget .vo-thumb.vo-dragging{opacity:.35;}
.iov-widget .vo-thumb.vo-drop-before::before,
.iov-widget .vo-thumb.vo-drop-after::after{content:"";position:absolute;top:-3px;bottom:-3px;width:3px;background:var(--io-accent,#6f8bbd);border-radius:2px;pointer-events:none;}
.iov-widget .vo-thumb.vo-drop-before::before{left:-4px;}
.iov-widget .vo-thumb.vo-drop-after::after{right:-4px;}
/* "+" tile: sits at the end of the strip regardless of thumb order via
 * flex order:99. Not a member of history[]; reorder/delete logic just
 * never sees it. */
.iov-widget .vo-thumb-add{position:relative;flex:0 0 auto;order:99;width:88px;height:50px;border-radius:4px;border:2px dashed var(--io-dim,#888);background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--io-dim,#888);font-size:22px;line-height:1;user-select:none;box-sizing:border-box;transition:border-color .12s, color .12s;}
.iov-widget .vo-thumb-add:hover{border-color:var(--io-accent,#6f8bbd);color:var(--io-accent,#6f8bbd);}
/* Load-from-disk picker. Follows the .vog-lightbox pattern — appended
 * to document.body so LiteGraph z-index doesn't fight us, styled with
 * a global .vog- prefix (not scoped to .iov-widget). */
.vog-picker-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;font-family:'DM Sans',sans-serif;}
.vog-picker{background:#2a2a2a;border:1px solid #3a3a3a;border-radius:8px;width:min(560px,90vw);max-height:80vh;display:flex;flex-direction:column;color:#ddd;}
.vog-picker-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #3a3a3a;}
.vog-picker-title{font-weight:600;}
.vog-picker-close{background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:2px 8px;border-radius:3px;}
.vog-picker-close:hover{color:#ddd;background:rgba(255,255,255,.06);}
.vog-picker-search{padding:8px 14px;border-bottom:1px solid #3a3a3a;}
.vog-picker-search input{width:100%;background:#191919;border:1px solid #3a3a3a;color:#ddd;padding:6px 10px;border-radius:4px;font-family:inherit;box-sizing:border-box;outline:none;}
.vog-picker-search input:focus{border-color:#6f8bbd;}
.vog-picker-list{flex:1;overflow-y:auto;padding:4px 0;}
.vog-picker-list::-webkit-scrollbar{width:6px;}
.vog-picker-list::-webkit-scrollbar-thumb{background:#3a3a3a;border-radius:3px;}
.vog-picker-row{padding:8px 14px;cursor:pointer;display:flex;justify-content:space-between;gap:12px;font-family:'Space Mono',monospace;font-size:11px;border-bottom:1px solid rgba(255,255,255,.03);}
.vog-picker-row:hover{background:rgba(255,255,255,.05);}
.vog-picker-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ccc;}
.vog-picker-meta{color:#888;flex-shrink:0;}
.vog-picker-empty{padding:24px;text-align:center;color:#888;font-size:12px;}
.vog-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:10000;display:flex;align-items:center;justify-content:center;overflow:hidden;}
.vog-lightbox video{max-width:none;max-height:none;cursor:grab;transform-origin:center center;border:none;border-radius:0;}
.vog-lightbox .vo-lb-hint{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);color:#999;font-size:12px;font-family:var(--io-sans,'DM Sans',sans-serif);}
`;

function injectCSS(){
  if(document.getElementById("iov-styles"))return;
  const s=document.createElement("style"); s.id="iov-styles"; s.textContent=CSS;
  document.head.appendChild(s);
  if(!document.getElementById("io-orbitron-font")){
    const f=document.createElement("link"); f.id="io-orbitron-font"; f.rel="stylesheet";
    f.href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&display=swap";
    document.head.appendChild(f);
  }
}

// ── Theme machinery — independent of Image Oasis. LTX Oasis owns its palette and
// named-themes under /ltx23_oasis/theme*. The <style> override
// is scoped to `.iov-widget` and `.vo-widget` (not :root) so IO's palette can
// coexist on the same canvas; Video Oasis Viewer shares this palette. We ALWAYS
// emit every var in the scoped block (not just non-defaults) so IO's :root
// block — which would otherwise cascade in — can't override VO's defaults.
const VO_THEME_VARS = [
  {k:"--io-accent",     label:"Accent"},
  {k:"--io-accent-dim", label:"Accent (dim)"},
  {k:"--io-bg",         label:"Background"},
  {k:"--io-bg2",        label:"Panel"},
  {k:"--io-bd",         label:"Border"},
  {k:"--io-dim",        label:"Muted text"},
];
const VO_THEME_DEFAULTS = {
  "--io-accent":"#6f8bbd", "--io-accent-dim":"#4a5d82",
  "--io-bg":"#000000", "--io-bg2":"#2a2a2a", "--io-bd":"#3a3a3a", "--io-dim":"#888888",
};
let VO_THEME = {...VO_THEME_DEFAULTS};
const VO_THEME_LISTENERS = new Set();
let VO_NAMED_THEMES = [];

function applyTheme(){
  let el = document.getElementById("vo-theme-override");
  if(!el){ el=document.createElement("style"); el.id="vo-theme-override"; }
  document.head.appendChild(el);   // ALWAYS re-append: keeps VO's block last
  // Always emit ALL vars so IO's :root declarations can't bleed through
  // (`.iov-widget` / `.vo-widget` beat `:root` by specificity when present).
  // Video Oasis Viewer shares this palette — it is LTXO's companion viewer.
  const decls = VO_THEME_VARS.map(v=>`${v.k}:${VO_THEME[v.k]||VO_THEME_DEFAULTS[v.k]};`).join("");
  // Generate-button mirror vars, always emitted for the same reason.
  const bg = VO_THEME["--io-bg"] || VO_THEME_DEFAULTS["--io-bg"];
  const bd = VO_THEME["--io-bd"] || VO_THEME_DEFAULTS["--io-bd"];
  const mirror = `--io-go-fill:${bg};--io-go-bd:${bd};`;
  el.textContent = `.iov-widget,.vo-widget{${decls}${mirror}}`;
}
let VO_THEME_LOADED = false;
async function loadTheme(){
  if(VO_THEME_LOADED){ applyTheme(); return; }
  try{
    const saved = await (await fetch("/ltx23_oasis/theme")).json();
    VO_THEME = {...VO_THEME_DEFAULTS, ...(saved||{})};
    VO_THEME_LOADED = true;
  }catch(e){ console.warn("[LTX Oasis] theme load",e); VO_THEME={...VO_THEME_DEFAULTS}; }
  applyTheme();
  VO_THEME_LISTENERS.forEach(fn=>{ try{fn();}catch{} });
}
loadTheme();
function refreshTheme(){
  applyTheme();
  VO_THEME_LISTENERS.forEach(fn=>{ try{fn();}catch{} });
}
async function saveTheme(){
  refreshTheme();
  const payload = {};
  for(const {k} of VO_THEME_VARS){ if(VO_THEME[k] && VO_THEME[k]!==VO_THEME_DEFAULTS[k]) payload[k]=VO_THEME[k]; }
  try{ await fetch("/ltx23_oasis/theme",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}); }
  catch(e){ console.warn("[LTX Oasis] theme save",e); }
}
async function loadNamedThemes(){
  try{
    const r = await (await fetch("/ltx23_oasis/themes")).json();
    VO_NAMED_THEMES = Array.isArray(r) ? r : [];
  }catch(e){ VO_NAMED_THEMES=[]; }
}
async function saveNamedTheme(name){
  const trimmed = (name||"").trim();
  if(!trimmed) return false;
  const colors = {};
  for(const {k} of VO_THEME_VARS){ colors[k] = VO_THEME[k] || VO_THEME_DEFAULTS[k]; }
  try{
    const r = await fetch("/ltx23_oasis/save_named_theme",{
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({name:trimmed, colors}),
    });
    if(!r.ok) return false;
    await loadNamedThemes();
    await saveTheme();
    VO_THEME_LISTENERS.forEach(fn=>{ try{fn();}catch{} });
    return true;
  }catch(e){ return false; }
}
async function deleteNamedTheme(id){
  try{
    await fetch(`/ltx23_oasis/themes/${id}`,{method:"DELETE"});
    await loadNamedThemes();
    VO_THEME_LISTENERS.forEach(fn=>{ try{fn();}catch{} });
  }catch(e){ console.warn("[LTX Oasis] delete named theme",e); }
}
async function applyNamedTheme(id){
  const t = VO_NAMED_THEMES.find(x=>x.id===id);
  if(!t || !t.colors) return;
  VO_THEME = {...VO_THEME_DEFAULTS, ...t.colors};
  await saveTheme();
}

// ── In-node help (module cache, IO pattern; served by our own backend) ──
let IO_HELP_HTML = "";
let IO_HELP_LOADING = null;
const IO_HELP_LISTENERS = new Set();
const loadHelpOnce = () => {
  if (IO_HELP_HTML || IO_HELP_LOADING) return;
  IO_HELP_LOADING = fetch("/ltx23_oasis/help")
    .then(r => r.text())
    .then(md => { IO_HELP_HTML = mdToHtml(md); IO_HELP_LISTENERS.forEach(fn => { try{ fn(); }catch{} }); })
    .catch(e => { console.warn("[LTX Oasis] help fetch failed:", e); })
    .finally(() => { IO_HELP_LOADING = null; });
};
function mdToHtml(md){
  if(!md) return "";
  const escx = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const inline = (s) => {
    s = escx(s);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt, href) =>
      /^https?:\/\//i.test(href) ? `<a href="${href}" target="_blank" rel="noopener">${txt}</a>` : txt);
    return s;
  };
  const lines = md.replace(/\r\n/g,"\n").split("\n");
  const out = [];
  let inCode = false, codeBuf = [];
  let listType = null, inQuote = false, paraBuf = [];
  const flushPara = () => { if(paraBuf.length){ out.push(`<p>${inline(paraBuf.join(" "))}</p>`); paraBuf=[]; } };
  const flushList = () => { if(listType){ out.push(`</${listType}>`); listType=null; } };
  const flushQuote = () => { if(inQuote){ out.push("</blockquote>"); inQuote=false; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  for(const raw of lines){
    if(/^```/.test(raw)){
      flushAll();
      if(inCode){ out.push(`<pre><code>${escx(codeBuf.join("\n"))}</code></pre>`); codeBuf=[]; inCode=false; }
      else inCode=true;
      continue;
    }
    if(inCode){ codeBuf.push(raw); continue; }
    if(/^---+\s*$/.test(raw)){ flushAll(); out.push("<hr/>"); continue; }
    let m;
    if((m = raw.match(/^(#{1,4})\s+(.*)$/))){
      flushAll(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue;
    }
    if((m = raw.match(/^>\s?(.*)$/))){
      flushPara(); flushList();
      if(!inQuote){ out.push("<blockquote>"); inQuote=true; }
      out.push(`<p>${inline(m[1])}</p>`); continue;
    }
    if((m = raw.match(/^[-*]\s+(.*)$/))){
      flushPara(); flushQuote();
      if(listType !== "ul"){ flushList(); out.push("<ul>"); listType="ul"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if((m = raw.match(/^\d+\.\s+(.*)$/))){
      flushPara(); flushQuote();
      if(listType !== "ol"){ flushList(); out.push("<ol>"); listType="ol"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if(/^\s*$/.test(raw)){ flushAll(); continue; }
    flushList(); flushQuote();
    paraBuf.push(raw.trim());
  }
  flushAll();
  return out.join("\n");
}

const esc = (s) => String(s ?? "")
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

// ── Video/player helpers ──
function viewURL(entry){
  const q = new URLSearchParams({
    filename: entry.filename, subfolder: entry.subfolder || "",
    type: entry.type || "temp", rand: entry.rand,
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
function fmtTime(t){
  if (!isFinite(t)) return "0:00.00";
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}
function fmtSize(bytes){
  if (!bytes) return "";
  if (bytes > 1024 * 1024) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(0) + " KB";
}
function newRand(){ return Math.random().toString(36).slice(2); }

const SOURCES = ["diffusion","gguf"];
const SOURCE_LABELS = {diffusion:"Diffusion", gguf:"GGUF"};
const WEIGHT_DTYPES = ["default","fp8_e4m3fn","fp8_e4m3fn_fast","fp8_e5m2"];
const MODE_LABELS = {t2v:"Text \u2192 Video", i2v:"Image \u2192 Video"};
const RATIOS = ["1:1","2:3","3:4","9:16","16:9","4:3","3:2"];
const RATIO_MIRROR = {"1:1":"1:1","2:3":"3:2","3:2":"2:3","3:4":"4:3","4:3":"3:4","9:16":"16:9","16:9":"9:16"};
const SEED_CONTROLS = ["fixed","increment","decrement","randomize"];
const FORMATS = ["auto","mp4","webm","mkv","mov"];
const CODECS = ["auto","h264","hevc","vp9","av1","ffv1","prores"];
const QUALITIES = ["balanced","high","small","custom"];
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
let VOG_NVENC_PROMISE = null;
const loadNvencCodecs = () => {
  if (!VOG_NVENC_PROMISE) {
    VOG_NVENC_PROMISE = api.fetchApi("/ltx23_oasis/nvenc")
      .then(r => r.json())
      .then(d => (Array.isArray(d?.codecs) ? d.codecs : []))
      .catch(() => []);
  }
  return VOG_NVENC_PROMISE;
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
const SPEEDS = [0.25,0.5,1,1.5,2];
const VSR_QUALITIES = ["LOW","MEDIUM","HIGH","ULTRA"];
const VSR_RESIZE = [
  {id:"scale by multiplier", label:"\u00d7 Scale"},
  {id:"target dimensions", label:"Target"},
];
const HISTORY_CAP = 48;
const MAX_SEED = 1125899906842624;

// Registry fallback until /ltx23_oasis/models responds (kept if it never
// does). The route serves the real thing straight from registry_video.py.
let VOG_ARCHS = [
  {key:"ltx23", label:"LTX 2.3 22B (Distilled)", modes:["t2v","i2v"],
   model_slots:["model"], clip_slots:2, vae_slots:["video","audio"],
   frame_quantum:8, fps_default:25, defaults:{width:1280,height:720,frames:121},
   sampling:{kind:"distilled_manual_sigmas",cfg:1,sampler:"euler_ancestral",
             sigmas:"1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"},
   prompt_relay:true,
   guides:{from_beats:true}, audio:true, sage:true,
   upscale_native:{label:"Spatial Upsample (x2)", kind:"latent_upsample",
                   latent_upsampler:"", sigmas:"0.85, 0.7250, 0.4219, 0.0",
                   cfg:1, sampler:"euler"}},
];
const MODEL_SLOT_LABELS = {model:"Model"};

// ── io_id result routing (VO's event, IO's stash-and-drain lifecycle) ──
const VOG_HANDLERS = new Map();
const VOG_PENDING = new Map();
api.addEventListener("video-oasis/result", ({ detail }) => {
  if (!detail?.io_id || !Array.isArray(detail?.results)) return;
  const handler = VOG_HANDLERS.get(detail.io_id);
  if (handler) handler(detail.results);
  else VOG_PENDING.set(detail.io_id,
    (VOG_PENDING.get(detail.io_id) || []).concat(detail.results));
});

app.registerExtension({
  name: "LTX23Oasis",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "LTX23Oasis") return;

    const _onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      if (_onCreated) _onCreated.apply(this, arguments);
      injectCSS();
      this.setSize([960, 770]);
      this.color = "#000000"; this.bgcolor = "#202020";
      this.serialize_widgets = true;

      const selfNode = this;
      const container = document.createElement("div");
      container.className = "iov-widget";
      container.tabIndex = 0;
      // Delegated ⤢ use-this-size handler (attached once — info divs get
      // swapped asynchronously after fetches; a container-level listener
      // survives every render without stacking).
      container.addEventListener("click", (e) => {
        const b = e.target.closest("[data-use-size]");
        if(!b || !container.contains(b)) return;
        e.stopPropagation();
        const [w, h] = b.dataset.useSize.split("x").map(Number);
        if(!w || !h) return;
        st.width = snapRes(w); st.height = snapRes(h);
        st.aspect_lock = "";
        save(); render();
      });

      // ── Flat IO-style exec state (serialized as execState; the backend
      //    adapter reads these keys directly) ──
      const archOf = (key) => VOG_ARCHS.find(a=>a.key===key) || VOG_ARCHS[0];
      const archSeed = (a) => ({
        mode: a.modes[0],
        frames: a.defaults.frames, fps: a.fps_default,
        cfg: a.sampling.cfg ?? 1,
        sigmas: a.sampling.sigmas || "",
        sampler_name: a.sampling.sampler || "euler",
        audio_mode: "off",
        enable_upscale: false,
        upscale_upsampler: a.upscale_native?.latent_upsampler || "",
        upscale_polish: false,
        upscale_sigmas: a.upscale_native?.sigmas || "",
        upscale_cfg: a.upscale_native?.cfg ?? 1,
        upscale_sampler: a.upscale_native?.sampler || "euler",
      });
      let st = {
        architecture:"ltx23", source_type:"diffusion",
        model_file:"",
        clip_file:"", clip_file_2:"", vae_file:"", vae_audio_file:"",
        weight_dtype:"default",
        loras:[],
        user_prompt:"", positive:"", negative:"",
        relay_segments:[],
        start_image:"",
        audio_file:"",
        continue_last:false, context_frames:0,
        width:1280, height:720, aspect_lock:"",
        seed:0, seed_control:"randomize",
        sage:true,
        enable_vsr:false, vsr_resize_type:"scale by multiplier",
        vsr_scale:2.0, vsr_width:1920, vsr_height:1080, vsr_quality:"ULTRA",
        format:"auto", codec:"auto", quality:"balanced", crf:20, gpu_encode:true,
        save_prefix:"video/LTX23Oasis",
        ...archSeed(VOG_ARCHS[0]),
      };
      let open = { presets:false, model:false, loras:false, refs:false, prompt:false,
                   beats:false, video:false, sampling:false, upscale:false, encode:false,
                   theme:false, help:false };
      let taHeights = { user_prompt:72, positive:72, negative:44 };
      let presets = [];
      let presetName = "";
      let expandedPresets = new Set();
      let themeName = "";
      let ioId = "";
      let nvencCodecs = [];   // filled by loadNvencCodecs(); empty = no GPU toggle
      let allModels = {diffusion:[],gguf_unet:[],clip_std:[],clip_gguf:[],
                       vaes:[],latent_upsamplers:[],loras:[],rtx_vsr:false};
      let llmModels = [], llmModel = "", wandBusy = false;
      let llmSettingsOpen = false, llmAutoLayers = true, llmGpuLayers = -1;
      let llmContext = 8192, llmMaxTokens = 2048;
      let llmRecommended = null, llmRecommendedBusy = false;
      let samplers = ["euler","euler_ancestral","dpmpp_2m","dpmpp_2m_sde","ddim","uni_pc","lcm","res_multistep"];
      // Player state
      let history = [], activeIdx = -1;
      let muted = false, speed = 1;
      // Movie-audio toggle for Create Movie. Persisted in uiState.
      //   true  → keep audio where present, synthesize silence for gaps
      //   false → strip audio, video-only output
      let movieAudio = true;
      // Playback mode is three-state:
      //   "off"   — video plays once, then stops
      //   "loop"  — native <video>.loop, current clip repeats forever
      //   "cycle" — on `ended`, advance to the next entry in the queue
      //             (wrap around); queue is snapshot on toggle-on and
      //             does not gain new generations mid-cycle
      let playMode = "loop";
      // Frozen snapshot of `history` at the moment cycle mode was turned
      // on. Entries deleted from history are skipped by advanceCycle via
      // an alive-check against `history[]`; reorder/new generations do
      // NOT affect this queue (intentional — order is predictable).
      let cycleQueue = null;
      // Scene-bar reorder state (long-press to enter drag). Closure-only;
      // never serialized. dragEntry non-null means a drag is in flight.
      let dragEntry = null, holdTimer = null, pointerStart = null;
      // Continue-from-viewed: which entry the server currently has
      // registered under _TAIL_SRC[io_id]. Fresh generations and thumb
      // clicks both trigger a debounced register; the server decodes the
      // tail off disk at generate time. Null on first load / after restart.
      let tailSourceEntry = null, _tailDebounceT = null;
      const TAIL_DEBOUNCE_MS = 400;
      // Timer state (IO's closure pattern)
      let timerRunning = false, timerStart = 0, timerElapsedMs = 0, timerInterval = null;

      const arch = () => archOf(st.architecture);
      const snapFrames = (f) => {
        const q = arch().frame_quantum || 4;
        return Math.max(q + 1, Math.round(((Number(f)||0) - 1) / q) * q + 1);
      };
      const modelListFor = (t) =>
        t==="diffusion" ? allModels.diffusion : allModels.gguf_unet;
      const clipList = () => [...allModels.clip_std, ...allModels.clip_gguf].sort();
      const opt = (list,val) => list.map(m=>`<option value="${esc(m)}"${m===val?" selected":""}>${esc(m)}</option>`).join("");
      const optBlank = (list,val,ph) => `<option value="">${ph}</option>`+opt(list,val);

      const sec = (key,title,bodyHTML) => `
        <div class="io-section">
          <div class="io-sec-head" data-sec="${key}">
            <span class="io-sec-title">${title}</span>
            <span class="io-chevron${open[key]?" open":""}">\u203a</span>
          </div>
          ${open[key]?`<div class="io-sec-body">${bodyHTML}</div>`:""}
        </div>`;
      // Motion-context windows, in PIXEL frames. These are 8n+1 counts like
      // every other LTX length: the first latent frame of a sequence decodes
      // to ONE pixel frame and each later one to 8, so 17 real frames is 3
      // latent frames. The window is sampled in front of the delivered clip
      // and dropped after decode, which costs 8*latent extra frames.
      const CONTEXT_WINDOWS = [0, 9, 17, 25, 33, 41, 49];
      const ctxLatent = (px) => px > 0 ? Math.floor((px - 1) / 8) + 1 : 0;
      const ctxOverhead = (px) => 8 * ctxLatent(px);
      const chk = (field,label) => `
        <label class="io-chk" data-chk="${field}">
          <span class="io-chk-box${st[field]?" on":""}">${st[field]?"\u2713":""}</span>${label}
        </label>`;
      const num = (field,label,step,min,max,tip) => `
        <div${tip?` title="${tip}"`:""}><span class="io-mini">${label}</span>
        <input class="io-input" type="number" data-f="${field}" value="${esc(st[field])}" step="${step}" ${min!=null?`min="${min}"`:""} ${max!=null?`max="${max}"`:""}/></div>`;
      const selCol = (field,label,list) => `
        <div><span class="io-mini">${label}</span>
        <select class="io-select" data-f="${field}">${opt(list,st[field])}</select></div>`;
      const taBlock = (field,ph) => `
        <div class="io-ta-wrap">
          <textarea class="io-ta" data-f="${field}" placeholder="${ph}" style="height:${taHeights[field]||72}px">${esc(st[field])}</textarea>
          <div class="io-ta-handle" data-ta-handle="${field}"></div>
        </div>`;

      // ── Model section ──
      const modelSection = () => {
        const A = arch();
        const modelRows = (A.model_slots||["model"]).map((slot)=>`<div class="io-row">
            <span class="io-label">${MODEL_SLOT_LABELS[slot]||slot}</span>
            <select class="io-select" data-f="model_file">${optBlank(modelListFor(st.source_type),st.model_file,"\u2014 select model \u2014")}</select>
          </div>`).join("");
        return sec("model","Model", `
          <div class="io-row">
            <span class="io-label">Source</span>
            <div class="io-toggle-grp">${SOURCES.map(s=>`<button class="io-tog${st.source_type===s?" active":""}" data-src="${s}">${SOURCE_LABELS[s]}</button>`).join("")}</div>
          </div>
          ${modelRows}
          <div class="io-row"><span class="io-label">Weight</span><select class="io-select" data-f="weight_dtype">${WEIGHT_DTYPES.map(d=>`<option value="${d}"${d===st.weight_dtype?" selected":""}>${d}</option>`).join("")}</select></div>
          <div class="io-row">
            <span class="io-label">CLIP</span>
            <select class="io-select" data-f="clip_file">${optBlank(clipList(),st.clip_file,"\u2014 select CLIP \u2014")}</select>
          </div>
          ${(A.clip_slots||1)>=2?`<div class="io-row">
            <span class="io-label">CLIP 2</span>
            <select class="io-select" data-f="clip_file_2">${optBlank(clipList(),st.clip_file_2,"\u2014 none \u2014")}</select>
          </div>`:""}
          <div class="io-row">
            <span class="io-label">VAE</span>
            <select class="io-select" data-f="vae_file">${optBlank(allModels.vaes,st.vae_file,"\u2014 select VAE \u2014")}</select>
          </div>
          ${A.audio?`<div class="io-row">
            <span class="io-label${st.audio_mode!=="off"?"":" dim"}">Audio VAE</span>
            <select class="io-select" data-f="vae_audio_file">${optBlank(allModels.vaes,st.vae_audio_file,"\u2014 select audio VAE \u2014")}</select>
          </div>`:""}
        `);
      };

      // ── LoRA section — IO stack verbatim + Lightning toggle ──
      const loraSection = () => {
        const A = arch();
        const list = st.loras||[];
        const rows = list.map((l,i)=>{
          const on = l.enabled!==false;
          const grip = `<div class="io-lora-drag" draggable="true" data-lora-drag="${i}" title="Drag to reorder">${'<div class="io-lora-drag-dot"></div>'.repeat(9)}</div>`;
          return `
          <div class="io-lora-row${on?"":" off"}" data-lora-row-idx="${i}">
            ${grip}
            <button class="io-lora-en${on?" on":""}" data-lora-en="${i}" title="${on?"Enabled \u2014 click to disable":"Disabled \u2014 click to enable"}">${on?"\u25cf":"\u25cb"}</button>
            <select class="io-select" data-lora-name="${i}">${optBlank(allModels.loras||[], l.name||"", "\u2014 select LoRA \u2014")}</select>
            <input class="io-input io-lora-str" type="number" data-lora-sm="${i}" value="${esc(l.strength_model)}" step="0.05" title="LoRA strength. Video LoRAs adapt the transformer; text-encoder strength is mirrored from this value behind the scenes."/>
            <button class="io-ref-clear" data-lora-del="${i}" title="Remove" style="flex:0 0 18px;padding:0;text-align:center">\u2715</button>
          </div>
          ${on ? `<div class="io-lora-trigger-row" data-lora-trigger-row="${i}">
            <span class="io-lora-trigger-spacer"></span>
            <input class="io-input" type="text" data-lora-trigger="${i}" placeholder="trigger words\u2026" value="${esc(l.trigger_words||"")}" title="Optional trigger word or phrase. Prepended to the positive prompt (in stack order, comma-separated) when this LoRA is enabled."/>
            <button class="io-lora-civit" data-lora-civit="${i}" ${l.name?"":"disabled"} title="Open this LoRA's CivitAI page (hash lookup)">CivitAI</button>
            <span class="io-lora-civit-trail" aria-hidden="true"></span>
          </div>` : ""}`;
        }).join("");
        const head = list.length
          ? `<div class="io-lora-row"><span style="width:39px;flex:0 0 39px"></span><span class="io-mini" style="flex:1">LoRA</span><span class="io-mini io-lora-str">Model</span><span style="flex:0 0 18px"></span></div>`
          : "";
        return sec("loras","LoRAs", `
          ${head}
          ${rows||`<div class="io-mini" style="opacity:.6">No LoRAs. Stacked top-to-bottom; drag the grip to reorder.</div>`}
          <button class="io-btn" data-lora-add style="margin-top:4px">+ Add LoRA</button>`);
      };

      // ── Reference slots (IO slot pattern; video-specific roles) ──
      const refInfoCache = {};
      const fmtBytes = (b) => b >= 1048576 ? (b/1048576).toFixed(1)+" MB" : b >= 1024 ? Math.round(b/1024)+" KB" : b+" B";
      const refInfoHtml = (fn) => {
        const d = refInfoCache[fn];
        const body = (d && d !== "pending" && d !== "err")
          ? `${d.width} x ${d.height} \u00b7 ${fmtBytes(d.size)}
             <button class="io-ref-size-btn" data-use-size="${d.width}x${d.height}" title="Set Width/Height to this image's size (snapped to /32)">\u2922</button>`
          : "";
        return `<div class="io-ref-info" data-ref-info="${esc(fn)}">${body}</div>`;
      };
      const fetchRefInfo = (fn) => {
        if(!fn || refInfoCache[fn]) return;
        refInfoCache[fn] = "pending";
        (async()=>{
          try{
            const r = await fetch(`/ltx23_oasis/input_info?filename=${encodeURIComponent(fn)}`);
            const d = await r.json();
            refInfoCache[fn] = (r.ok && d.width) ? d : "err";
          }catch{ refInfoCache[fn] = "err"; }
          container.querySelectorAll("[data-ref-info]").forEach(el=>{
            if(el.dataset.refInfo !== fn) return;
            const tmp = document.createElement("div");
            tmp.innerHTML = refInfoHtml(fn);
            el.replaceWith(tmp.firstElementChild);
          });
        })();
      };
      const imgInputURL = (fn) => {
        const p = new URLSearchParams({filename:fn.split("/").pop(), subfolder:fn.includes("/")?fn.slice(0,fn.lastIndexOf("/")):"", type:"input", t:Date.now()});
        return `${window.location.origin}/view?${p}`;
      };
      // File slots STORE the subfolder-qualified name, because that is what
      // /view and the backend both need. Printing the whole thing in a
      // one-line button pushes the actual filename off the right edge under
      // the CSS ellipsis, so a file dragged in from Audio Oasis
      // (audio_oasis/<track>/<track>_seg003.wav) reads as an unidentifiable
      // folder path. Show the leaf, keep the full path on the hover title,
      // print the folder on its own line where there is room for it.
      const leafOf = (fn) => String(fn || "").split("/").pop();
      const dirOf = (fn) => {
        const s = String(fn || "");
        const i = s.lastIndexOf("/");
        return i > 0 ? s.slice(0, i) : "";
      };
      const refSlot = (field, label, dim, extraHTML="") => {
        const fn = st[field];
        const tt = `title="Drop an image here, or click and paste (Ctrl+V)"`;
        const thumb = fn
          ? `<img class="io-ref-thumb" data-ref-thumb="${field}" tabindex="0" ${tt} src="${esc(imgInputURL(fn))}"/>`
          : `<div class="io-ref-thumb-empty" data-ref-thumb="${field}" tabindex="0" ${tt}>${label}</div>`;
        if(fn) fetchRefInfo(fn);
        return `<div class="io-refslot${dim?" io-refslot-dim":""}">
          ${thumb}
          <div class="io-ref-mid">
            <button class="io-ref-btn" data-ref-upload="${field}"${fn?` title="${esc(fn)}"`:""}>${fn?esc(leafOf(fn)):("Upload "+label.toLowerCase()+" image\u2026")}</button>
            ${fn?refInfoHtml(fn):""}
          </div>
          ${fn?`<button class="io-ref-clear" data-ref-clear="${field}">\u2715</button>`:""}
        </div>${extraHTML}`;
      };
      const refsSection = () => {
        const startLive = st.mode !== "t2v" || st.continue_last;
        return sec("refs","Start Frame", `
          <div class="io-mini" style="margin-bottom:2px">Start Frame</div>
          ${refSlot("start_image","Start", !startLive)}
          ${!startLive?`<div class="io-mini" style="opacity:.6">Ignored: Text \u2192 Video generates from the prompt alone. Switch to Image \u2192 Video in Prompt Enhancer to use a start image.</div>`:""}
          <div class="io-row" style="margin-top:2px">${chk("continue_last","\u21bb Continue from viewed video (the clip in the viewer seeds the next run)")}</div>
          ${st.continue_last?`<div class="io-mini" style="opacity:.7">Whatever's playing in the right pane is the tail source. Generated clips pin from a cached latent (no h264 round-trip). Clips loaded from disk, Clip, or Create Movie fall back to decoding the file. Overrides the Start slot. First run of a session with nothing loaded generates as plain T2V.</div>`:""}
          ${st.continue_last?`<div class="io-row" style="margin-top:4px">
            <span class="io-label" title="How much of the previous clip to pin in front of the timeline as motion reference. A single frame gives the model a pose but no direction or speed, which is why chained clips can start moving the wrong way. These frames sit outside your clip and are cropped off after decode, so you get back exactly the frames and audio length you asked for. On Generate audio, the previous clip's tail sound is pinned under the context too, so the soundtrack carries across the join. On File audio, your track is never trimmed or shifted: the context window gets silence and your file starts on frame 1.">Motion context</span>
            <select class="io-select" data-f="context_frames">${CONTEXT_WINDOWS.map(n=>`<option value="${n}"${Number(st.context_frames)===n?" selected":""}>${n===0?"Last frame only":`${n} frames \u00b7 ${(n/(Number(st.fps)||25)).toFixed(2)}s`}</option>`).join("")}</select>
          </div>`:""}
          ${st.continue_last&&Number(st.context_frames)>0?`<div class="io-mini" style="opacity:.7">Sampling ${Number(st.frames)+ctxOverhead(Number(st.context_frames))} frames to deliver ${Number(st.frames)}. Frames, audio, and the delivered length are unchanged \u2014 the context is extra work in front, not a shorter clip.</div>`:""}
        `);
      };

      // ── Prompt Enhancer: mode (pipeline + enhancer), wand, neg, settings.
      //    Prompt Beats is its own top-level section. ──
      const modeToggle = () => {
        const A = arch();
        return `<div class="io-row io-mode-bar">
          <div class="io-toggle-grp" style="flex:1" title="Pipeline mode and prompt-enhancer style (same control)">${A.modes.map(m=>`<button class="io-tog${st.mode===m?" active":""}" data-mode="${m}" title="${m==="t2v"?"Text \u2192 Video: generate from the prompt alone":"Image \u2192 Video: animate from the start frame"}">${MODE_LABELS[m]||m}</button>`).join("")}</div>
        </div>`;
      };
      const wandRow = () => {
        const hasModels = llmModels.length > 0;
        const modelOpts = hasModels
          ? optBlank(llmModels, llmModel, "- enhancer model -")
          : `<option value="">- no models in models/LLM -</option>`;
        const wandDisabled = wandBusy || timerRunning;
        const enhanceLabel = wandBusy ? "\u2026" : "\u2728 Enhance";
        return `
          <div class="io-row">
            <span class="io-label" style="width:auto">Model</span>
            <select class="io-select" data-llm-model ${hasModels?"":"disabled"}>${modelOpts}</select>
          </div>
          <div class="io-row">
            <button class="io-btn io-btn-bar" data-wand-go style="width:100%" ${wandDisabled?"disabled":""} title="${timerRunning?"Unavailable while a video is generating":(st.mode==="i2v"?"Enhance for Image \u2192 Video (describes motion from the start frame)":"Enhance for Text \u2192 Video")}">${enhanceLabel}</button>
          </div>`;
      };
      const enhancerSettingsBlock = () => {
        let recText;
        if (llmRecommendedBusy || !llmRecommended) recText = "Recommended: -";
        else if (llmRecommended.all) {
          const total = llmRecommended.total;
          recText = total ? `Recommended: All (${total})` : "Recommended: All";
        } else recText = `Recommended: ${llmRecommended.layers}/${llmRecommended.total}`;
        const head = `
          <div class="io-subsec-head" data-subsec="enhancer_settings">
            <span class="io-subsec-title">Enhancer Settings</span>
            <span class="io-chevron${llmSettingsOpen?" open":""}">\u203a</span>
          </div>`;
        if (!llmSettingsOpen) return `<div class="io-subsec io-subsec-bar">${head}</div>`;
        const layersDisabled = llmAutoLayers ? "disabled" : "";
        const layersValue = llmAutoLayers ? (llmRecommended ? llmRecommended.layers : -1) : llmGpuLayers;
        return `<div class="io-subsec">
          ${head}
          <div class="io-subsec-body">
            <div class="io-row" style="align-items:center">
              <label class="io-chk" data-llm-auto-layers>
                <span class="io-chk-box${llmAutoLayers?" on":""}">${llmAutoLayers?"\u2713":""}</span>Auto GPU layers
              </label>
              <span class="io-rec-label">${recText}</span>
            </div>
            <div class="io-warn-tip">\u26a0 Only disable Auto GPU Layers if you know what you're doing.</div>
            <div class="io-row"><span class="io-label">GPU layers</span>
              <input class="io-input" type="number" data-llm-gpu-layers value="${layersValue}" step="1" ${layersDisabled}/></div>
            <div class="io-row"><span class="io-label">Context</span>
              <input class="io-input" type="number" data-llm-context value="${llmContext}" step="512" min="512"/></div>
            <div class="io-row"><span class="io-label">Max tokens</span>
              <input class="io-input" type="number" data-llm-max-tokens value="${llmMaxTokens}" step="64" min="64"/></div>
          </div>
        </div>`;
      };
      const beatFrameSummary = () => {
        const segs = st.relay_segments || [];
        const video = Number(st.frames) || 0;
        if (!segs.length) return { text: "", tone: "", sum: 0, anySet: false };
        const raw = segs.map(s => Math.max(0, Number(s.frames) || 0));
        const anySet = raw.some(x => x > 0);
        if (!anySet) {
          return {
            text: `Even split \u00b7 ${segs.length} beat${segs.length===1?"":"s"} \u2192 ${video||"?"} video frames`,
            tone: "",
            sum: 0,
            anySet: false,
          };
        }
        const sum = raw.reduce((a, b) => a + b, 0);
        let tone = "";
        let note = "";
        if (video) {
          if (sum === video) { tone = "ok"; note = " \u00b7 match"; }
          else if (sum < video) { tone = "short"; note = ` \u00b7 ${video - sum} short`; }
          else { tone = "over"; note = ` \u00b7 ${sum - video} over`; }
        }
        return {
          text: `Beats ${sum} / Video ${video || "?"}${note}`,
          tone,
          sum,
          anySet: true,
        };
      };
      const snapFramesQuantum = (n) => {
        const q = Number(arch().frame_quantum) || 8;
        const raw = Math.max(q + 1, Math.round(Number(n) || 0));
        return Math.floor((raw - 1) / q) * q + 1;
      };
      const beatsSection = () => {
        const A = arch();
        if(!A.prompt_relay && !A.guides) return "";

        // Pixel-frame starts for guide pin hints (mirrors backend even-split).
        const segs = st.relay_segments || [];
        const total = Number(st.frames) || 0;
        const n = segs.length;
        const rawLens = segs.map(s => Math.max(0, Number(s.frames) || 0));
        let lengths;
        if (n && rawLens.some(x => x > 0)) {
          lengths = [];
          let cursor = 0;
          for (const L of rawLens) {
            const end = Math.min(cursor + L, total || cursor + L);
            lengths.push(Math.max(end - cursor, 0));
            cursor = end;
          }
        } else if (n) {
          const step = total ? Math.ceil(total / n) : 0;
          lengths = [];
          let cursor = 0;
          for (let i = 0; i < n; i++) {
            const end = total ? Math.min(cursor + step, total) : 0;
            lengths.push(Math.max(end - cursor, 0));
            cursor = end;
          }
        } else {
          lengths = [];
        }
        const starts = [];
        { let c = 0; for (const L of lengths) { starts.push(c); c += L; } }
        const sumInfo = beatFrameSummary();

        const rows = segs.map((sg,i)=>{
          const fn = (sg.guide_image || "").trim();
          if (fn) fetchRefInfo(fn);
          const pin = starts[i] != null ? `@${starts[i]}` : "";
          const hKey = `relay_seg_${i}`;
          const thumb = fn
            ? `<img class="io-ref-thumb" data-relay-guide-thumb="${i}" tabindex="0" title="Guide at frame ${starts[i] ?? 0}. Drop/paste to replace; hover \u2715 to clear." src="${esc(imgInputURL(fn))}"/>`
            : `<div class="io-ref-thumb-empty" data-relay-guide-thumb="${i}" tabindex="0" title="Optional guide image: drop, paste, or click to add. Pinned at the start of this beat.">+</div>`;
          const guideCol = `<div class="io-beat-guide">
              <div class="io-beat-guide-wrap">
                ${thumb}
                ${fn?`<button type="button" class="io-beat-guide-x" data-relay-guide-clear="${i}" title="Remove guide">\u2715</button>`:""}
              </div>
              ${fn?`<input class="io-input io-beat-str" type="number" data-relay-guide-str="${i}" value="${esc(sg.guide_strength ?? 1)}" step="0.05" min="0" max="1" title="Guide strength (1 = match, lower = looser)"/>`:""}
            </div>`;
          return `<div class="io-beat" data-beat-idx="${i}">
            <div class="io-row" style="margin-bottom:0">
              <span class="io-mini" style="flex:1">Beat ${i+1}${fn?` <span style="opacity:.55">${pin}</span>`:""}</span>
              <input class="io-input" type="number" data-relay-frames="${i}" value="${esc(sg.frames||0)}" step="1" min="0" style="flex:0 0 62px" title="Frames this beat lasts. Leave 0 on every beat to split the video evenly."/>
              <button class="io-ref-clear" data-relay-del="${i}" title="Remove beat" style="flex:0 0 18px;padding:0;text-align:center">\u2715</button>
            </div>
            <div class="io-beat-body">
              ${A.guides?guideCol:""}
              <div class="io-beat-main">
                <div class="io-ta-wrap">
                  <textarea class="io-ta" data-relay-text="${i}" placeholder="What happens during beat ${i+1}\u2026" style="height:${taHeights[hKey]||44}px">${esc(sg.text||"")}</textarea>
                  <div class="io-ta-handle" data-ta-handle="${hKey}"></div>
                </div>
              </div>
            </div>
          </div>`;
        }).join("");

        return sec("beats","Prompt Beats", `
            <div class="io-mini" style="opacity:.7">Enhanced prompt = subject &amp; look. Each beat = a stretch of time: optional local text and/or a guide image (pinned at the beat&rsquo;s start). Add as many as you need.</div>
            ${rows || `<div class="io-mini" style="opacity:.55">No beats yet: prompt behaves normally. Guides and multi-prompt text both live here.</div>`}
            ${segs.length?`<div class="io-row" style="align-items:center;gap:8px;margin-top:4px">
              <div class="io-mini io-beat-sum${sumInfo.tone?` ${sumInfo.tone}`:""}" data-beat-frame-sum style="flex:1;margin:0">${esc(sumInfo.text)}</div>
              ${sumInfo.anySet?`<button class="io-btn" data-beat-match-frames ${sumInfo.sum===total?"disabled":""} style="margin-top:0;padding:0 8px;height:22px;font-size:9px" title="Set Video frames to the beat sum (snapped to the LTX grid)">Match frames</button>`:""}
            </div>`:""}
            <button class="io-btn" data-relay-add style="margin-top:6px">+ Add beat</button>
        `);
      };
      const promptSection = () => {
        return sec("prompt","Prompt Enhancer", `
        ${modeToggle()}
        <div class="io-mini" style="margin:6px 0 2px 0">User Prompt</div>
        ${taBlock("user_prompt","Your short prompt to enhance")}
        <div class="io-mini" style="margin:6px 0 2px 0">Enhanced Prompt</div>
        ${taBlock("positive","Enhanced prompt (drives generation)")}
        ${wandRow()}
        <div class="io-mini" style="margin:6px 0 2px 0">Negative Prompt</div>
        ${taBlock("negative","What to avoid (optional)")}
        <div class="io-neg-ignored-note">CFG &gt;1: standard guidance \u00b7 CFG 1 (distilled): applied via NAG (needs ComfyUI-KJNodes)</div>
        ${enhancerSettingsBlock()}
      `);
      };

      // ── Video section (IO's Latent, with frames/fps) ──
      const snapRes = (n) => Math.max(64, Math.round((Number(n)||0)/32)*32);  // LTX wants /32
      const ratioWH = (r) => { const [a,b]=r.split(":").map(Number); return a/b; };
      const applyRatioFromWidth = () => { if(st.aspect_lock) st.height = snapRes(st.width / ratioWH(st.aspect_lock)); };
      const applyRatioFromHeight = () => { if(st.aspect_lock) st.width = snapRes(st.height * ratioWH(st.aspect_lock)); };
      // Audio-file slot: duration is probed client-side via an <audio>
      // element against the /view URL, cached per filename.
      const audioDurCache = {};
      const probeAudioDur = (fn) => {
        if (!fn || audioDurCache[fn] != null) return;
        audioDurCache[fn] = "pending";
        const el = document.createElement("audio");
        el.preload = "metadata";
        el.onloadedmetadata = () => {
          audioDurCache[fn] = el.duration || 0;
          refreshAudioMeter();
        };
        el.onerror = () => { audioDurCache[fn] = 0; };
        el.src = imgInputURL(fn);
      };
      const audioMeterInfo = () => {
        const fn = (st.audio_file || "").trim();
        const vid = (st.frames && st.fps) ? st.frames / st.fps : 0;
        const d = audioDurCache[fn];
        if (!fn || d == null || d === "pending" || !vid)
          return { text: "", tone: "" };
        if (!d) return { text: "Could not read audio duration", tone: "over" };
        const diff = d - vid;
        if (Math.abs(diff) <= 0.25)
          return { text: `Audio ${d.toFixed(1)}s / Video ${vid.toFixed(1)}s \u00b7 match`, tone: "ok" };
        if (diff < 0)
          return { text: `Audio ${d.toFixed(1)}s / Video ${vid.toFixed(1)}s \u00b7 last ${(-diff).toFixed(1)}s generated`, tone: "short" };
        return { text: `Audio ${d.toFixed(1)}s / Video ${vid.toFixed(1)}s \u00b7 trimmed to video`, tone: "over" };
      };
      const refreshAudioMeter = () => {
        const el = container.querySelector("[data-audio-meter]");
        if (!el) return;
        const info = audioMeterInfo();
        el.textContent = info.text;
        el.className = `io-mini io-beat-sum${info.tone ? ` ${info.tone}` : ""}`;
      };
      const audioSlot = () => {
        const fn = (st.audio_file || "").trim();
        if (fn) probeAudioDur(fn);
        const info = audioMeterInfo();
        const dir = dirOf(fn);
        return `
          <div class="io-row" data-audio-drop title="Audio file that DRIVES the video \u2014 lip sync, singing, music-timed motion. Drop a file or click to browse.">
            <button class="io-ref-btn" data-audio-upload style="flex:1"${fn ? ` title="${esc(fn)}"` : ""}>${fn ? esc(leafOf(fn)) : "Upload audio (mp3/wav/flac)\u2026"}</button>
            ${fn ? `<button class="io-ref-clear" data-audio-clear>\u2715</button>` : ""}
          </div>
          ${dir ? `<div class="io-mini" style="opacity:.55">in ${esc(dir)}/</div>` : ""}
          ${fn ? `<div class="io-mini io-beat-sum${info.tone ? ` ${info.tone}` : ""}" data-audio-meter>${esc(info.text)}</div>` : ""}
          <div class="io-mini" style="opacity:.65">The file is kept as-is (masked from sampling) and the video is generated to match it. Shorter than the video = the tail gets generated audio.</div>`;
      };
      const videoSection = () => {
        const A = arch();
        const q = A.frame_quantum;
        const dur = (st.frames && st.fps) ? (st.frames / st.fps).toFixed(2) : "?";
        return sec("video","Video / Audio", `
          <div class="io-half">${num("width","Width",32,64,8192)}<button class="io-icon-btn io-sm" data-wh-swap title="Swap width and height" style="align-self:flex-end">\u2194</button>${num("height","Height",32,64,8192)}</div>
          <div class="io-row">
            <span class="io-label">Ratio</span>
            <div class="io-toggle-grp">${RATIOS.map(r=>`<button class="io-tog${st.aspect_lock===r?" active":""}" data-ratio="${r}" title="Lock aspect ratio ${r} (click again to unlock)">${r}</button>`).join("")}</div>
          </div>
          <div class="io-half">${num("frames","Frames",q,q+1,100000,`Snapped to the ${A.label} grid: ${q}n+1 frames.`)}${num("fps","FPS",1,1,240)}</div>
          <div class="io-mini" style="opacity:.7"><span data-dur>\u2248 ${dur}s</span> at current settings \u00b7 grid ${q}n+1</div>
          ${A.audio?`
          <div class="io-row">
            <span class="io-label">Audio</span>
            <div class="io-toggle-grp">
              <button class="io-tog${st.audio_mode==="off"?" active":""}" data-audio-mode="off" title="Silent video">Off</button>
              <button class="io-tog${st.audio_mode==="generate"?" active":""}" data-audio-mode="generate" title="Model generates the soundtrack from the prompt (needs Audio VAE in Model)">Generate</button>
              <button class="io-tog${st.audio_mode==="file"?" active":""}" data-audio-mode="file" title="Audio-driven video: a real audio file is injected into the latent and the video is generated to match it (lip sync, singing, music-timed motion; needs Audio VAE in Model)">File</button>
            </div>
          </div>
          ${st.audio_mode==="file"?audioSlot():""}`:""}
        `);
      };

      // ── Generation section ──
      const samplingSection = () => {
        return sec("sampling","Generation", `
        <div class="io-row">
          <span class="io-label">Seed</span>
          <input class="io-input" type="number" data-f="seed" value="${st.seed}" step="1" min="0"/>
          <button class="io-icon-btn io-go io-sm" data-seed-keep title="Generate (keep seed)">\u25b6</button>
          <button class="io-icon-btn io-dice io-sm" data-seed-rand title="Randomize &amp; Generate">\u{1f3b2}</button>
        </div>
        <div class="io-row">
          <span class="io-label">After gen</span>
          <select class="io-select" data-f="seed_control">${SEED_CONTROLS.map(c=>`<option value="${c}"${c===st.seed_control?" selected":""}>${c}</option>`).join("")}</select>
        </div>
        <div class="io-row">
          <span class="io-label">Sigmas</span>
          <input class="io-input" data-f="sigmas" value="${esc(st.sigmas)}" title="The distilled sigma schedule, comma-separated, ending in 0. Fewer values = faster and rougher. The default is the template's known-good schedule."/>
          <button class="io-icon-btn io-dice io-sm" data-sigmas-reset title="Reset sigmas to arch default">\u21ba</button>
        </div>
        <div class="io-half">${selCol("sampler_name","Sampler",samplers)}${num("cfg","CFG",0.1,0,100,"LTX distilled samples at CFG 1. Raising it roughly doubles time per step and switches the negative prompt to standard guidance; at CFG 1 the negative is applied via NAG.")}</div>
        ${arch().sage?`<div class="io-row" title="SageAttention (KJNodes) speeds up attention with no quality cost on most runs. Turn it off if output looks wrong - noise, garbled audio - or to compare against an unpatched render.">
          <span class="io-label">Attention</span>
          <div class="io-toggle-grp">
            <button class="io-tog${st.sage!==false?" active":""}" data-sage="on" title="SageAttention on (faster)">Sage</button>
            <button class="io-tog${st.sage===false?" active":""}" data-sage="off" title="Stock attention (slower, unpatched)">Off</button>
          </div>
        </div>`:""}
      `);
      };

      // ── Upscale section (RTX VSR pixel pass, then native latent second stage) ──
      const upscaleSection = () => {
        const A = arch();
        const up = A.upscale_native;
        const refActive = !!(st.start_image || st.continue_last ||
                             (st.relay_segments||[]).some(s => (s.guide_image||"").trim()));
        const noFiles = st.enable_upscale && !(allModels.latent_upsamplers||[]).length;
        const vsrMissing = st.enable_vsr && !allModels.rtx_vsr;
        const anyOn = st.enable_vsr || st.enable_upscale;
        return sec("upscale","Upscale", `
        <div class="io-row">${chk("enable_vsr","RTX Video Super Resolution")}</div>
        ${st.enable_vsr?`
        ${vsrMissing?`<div class="io-warn-tip">\u26a0 RTXVideoSuperResolution is not registered. Install Nvidia RTX Nodes from ComfyUI Manager (search RTX) and restart. Needs an Nvidia RTX GPU.</div>`:""}
        <div class="io-row">
          <span class="io-label">Size</span>
          <div class="io-toggle-grp">${VSR_RESIZE.map(r=>`<button class="io-tog${st.vsr_resize_type===r.id?" active":""}" data-vsr-resize="${r.id}">${r.label}</button>`).join("")}</div>
        </div>
        ${st.vsr_resize_type==="target dimensions"
          ?`<div class="io-half">${num("vsr_width","Width",8,64,8192)}${num("vsr_height","Height",8,64,8192)}</div>`
          :num("vsr_scale","\u00d7 Scale",0.01,1,4,"Scale factor. 2.0 doubles each side. The node snaps the result to a multiple of 8.")}
        <div class="io-row">
          <span class="io-label">Quality</span>
          <div class="io-toggle-grp">${VSR_QUALITIES.map(q=>`<button class="io-tog${st.vsr_quality===q?" active":""}" data-vsr-quality="${q}">${q}</button>`).join("")}</div>
        </div>
        <div class="io-mini" style="opacity:.7">Pixel-space, after decode. Spatial Upsample (if on) runs first in latent, then this. Toggling does not resample.</div>`:""}
        ${up?`
        <div class="io-row">${chk("enable_upscale",esc(up.label))}</div>
        ${st.enable_upscale?`
        <div class="io-row"><span class="io-label">Upsampler</span><select class="io-select" data-f="upscale_upsampler">${optBlank(allModels.latent_upsamplers||[],st.upscale_upsampler,"\u2014 select \u2014")}</select></div>
        ${noFiles?`<div class="io-warn-tip">\u26a0 No files found in ComfyUI/models/latent_upscale_models/ \u2014 the LTX spatial upscaler goes in that folder (create it if needed), then restart ComfyUI. It is NOT an ESRGAN pixel upscaler.</div>`:""}
        <div class="io-row">${chk("upscale_polish","Polish pass (re-samples at 2\u00d7; HEAVY)")}</div>
        ${st.upscale_polish?`
        <div class="io-warn-tip">\u26a0 Runs the full diffusion model at the upscaled resolution (4\u00d7 the tokens of the base render). On systems that partially offload the model this can take minutes per step. Off = upsample-only: fast, slightly softer.</div>
        <div class="io-row">
          <span class="io-label">Sigmas</span>
          <input class="io-input" data-f="upscale_sigmas" value="${esc(st.upscale_sigmas)}" title="Re-noise schedule for the polish pass. Fewer/lower values = subtler and faster."/>
          <button class="io-icon-btn io-dice io-sm" data-upscale-sigmas-reset title="Reset polish sigmas to arch default">\u21ba</button>
        </div>
        <div class="io-half">${selCol("upscale_sampler","Sampler",samplers)}${num("upscale_cfg","CFG",0.1,0,100)}</div>`:""}
        <div class="io-mini" style="opacity:.7">Re-runs only the upsample + decode: the sampled video is cached, so toggling this does not regenerate.</div>
        ${refActive?`<div class="io-warn-tip">\u26a0 A reference image is active; upscaling can drift the subject's likeness. Rendering at half your source image's resolution usually looks better.</div>`:""}`:""}
        `:""}
        ${!anyOn?`<div class="io-mini" style="opacity:.7">Off. RTX VSR is a pixel pass after decode; Spatial Upsample is LTX's 2\u00d7 latent second stage.</div>`:""}
      `);
      };

      // ── Encode section ──
      const encodeSection = () => sec("encode","Encode / Save", `
        <div class="io-row">
          <span class="io-label">Format</span>
          <div class="io-toggle-grp">${FORMATS.map(f=>`<button class="io-tog${st.format===f?" active":""}" data-enc-format="${f}">${f}</button>`).join("")}</div>
        </div>
        <div class="io-row">
          <span class="io-label">Codec</span>
          <div class="io-toggle-grp">${CODECS.map(c=>`<button class="io-tog${st.codec===c?" active":""}" data-enc-codec="${c}">${c}</button>`).join("")}</div>
        </div>
        ${LOSSLESS_CODECS.includes(st.codec)?"":`
        <div class="io-row">
          <span class="io-label">Quality</span>
          <div class="io-toggle-grp">${QUALITIES.map(qq=>`<button class="io-tog${st.quality===qq?" active":""}" data-enc-quality="${qq}">${qq}</button>`).join("")}</div>
        </div>
        ${st.quality==="custom"?`<div class="io-row"><span class="io-label">CRF</span><input class="io-input" type="number" data-f="crf" value="${esc(st.crf)}" step="1" min="0" max="63"/></div>`:""}
        `}
        ${gpuEncodeShown(st.codec, nvencCodecs)?`<div class="io-row" title="Encode on the NVIDIA GPU (NVENC). Big speedup on long or upscaled clips; files run slightly larger at the same quality. Falls back to the CPU automatically if the GPU encoder fails. Clip and Create Movie follow this setting.">
          <span class="io-label">GPU Encode</span>
          <div class="io-toggle-grp">
            <button class="io-tog${st.gpu_encode!==false?" active":""}" data-enc-gpu="on">On</button>
            <button class="io-tog${st.gpu_encode===false?" active":""}" data-enc-gpu="off">Off</button>
          </div>
        </div>`:""}
        <div class="io-row"><span class="io-label">Save prefix</span><input class="io-input" data-f="save_prefix" value="${esc(st.save_prefix)}"/></div>
        <div class="io-mini" style="opacity:.7">${esc(encodeHint(st.codec))}</div>
      `);

      // ── Theme + Help (IO verbatim) ──
      const themeRow = (v) => {
        const val = VO_THEME[v.k] || VO_THEME_DEFAULTS[v.k];
        return `<div class="io-row">
          <span class="io-label">${v.label}</span>
          <input class="io-swatch" type="color" data-theme-pick="${v.k}" value="${esc(val)}"/>
          <input class="io-input io-hex" data-theme-hex="${v.k}" value="${esc(val)}" maxlength="7" spellcheck="false"/>
        </div>`;
      };
      const activeNamedThemeId = () => {
        for(const t of VO_NAMED_THEMES){
          const cs = t.colors||{};
          let match = true;
          for(const {k} of VO_THEME_VARS){
            const a = VO_THEME[k] || VO_THEME_DEFAULTS[k];
            const b = cs[k] || VO_THEME_DEFAULTS[k];
            if(a !== b){ match = false; break; }
          }
          if(match) return t.id;
        }
        return null;
      };
      const namedThemesList = () => {
        if(!VO_NAMED_THEMES.length){
          return `<div class="io-mini" style="opacity:.6;padding:4px 2px">No saved themes yet. Tweak the colors above, type a name, and click Save Theme.</div>`;
        }
        const activeId = activeNamedThemeId();
        return VO_NAMED_THEMES.map(t=>{
          const cs = t.colors||{};
          const chips = VO_THEME_VARS.map(v=>{
            const c = cs[v.k] || VO_THEME_DEFAULTS[v.k];
            return `<span class="io-theme-chip" style="background:${esc(c)}" title="${esc(v.label+": "+c)}"></span>`;
          }).join("");
          const isActive = t.id===activeId;
          return `<div class="io-theme-row${isActive?" active":""}" data-theme-load="${t.id}" title="Click to apply">
            <span class="io-theme-chips">${chips}</span>
            <span class="io-theme-nm">${esc(t.name)}</span>
            ${isActive?`<span class="io-theme-meta">active</span>`:""}
            <button class="io-preset-del" data-theme-named-del="${t.id}" title="Delete theme">\u2715</button>
          </div>`;
        }).join("");
      };
      const themeSection = () => sec("theme","Theme", `
        ${VO_THEME_VARS.map(themeRow).join("")}
        <div class="io-row">
          <input class="io-input" data-theme-name placeholder="Save current as\u2026" maxlength="60" value="${esc(themeName)}"/>
          <button class="io-btn" data-theme-save style="margin-top:0">Save Theme</button>
        </div>
        ${namedThemesList()}
        <div class="io-row">
          <button class="io-btn" data-theme-reset style="margin-top:0;flex:1">Reset to default</button>
        </div>
        <div class="io-mini" style="opacity:.7">LTX Oasis keeps its own palette, shared with Video Oasis Viewer. Edits preview live across every LTX Oasis node and do not affect Image Oasis or Audio Oasis. Save Theme stores the current palette as a named entry; click any saved row to switch.</div>
      `);
      const helpSection = () => sec("help","Help", `
        <div class="io-help-body">${IO_HELP_HTML || '<div class="io-mini" style="opacity:.7">Loading help\u2026</div>'}</div>
      `);

      const fmtStamp = ts => { try{ return new Date(ts).toLocaleString(); }catch{ return ""; } };
      const shortName = f => (f||"").split(/[/\\]/).pop().replace(/\.(safetensors|ckpt|pt|gguf)$/i,"") || "\u2014";
      const kv = (k,v) => `<div class="io-kv"><span class="io-kv-k">${k}</span><span class="io-kv-v">${v}</span></div>`;
      const presetsSection = () => {
        const cards = !presets.length
          ? `<div class="io-empty">No saved presets yet.<br/>Configure the node and save one.</div>`
          : presets.map(p=>{
              const exp = expandedPresets.has(p.id), c = p.config || {};
              const grip = `<div class="io-preset-drag" draggable="true" data-preset-drag="${p.id}" title="Drag to reorder">${'<div class="io-preset-drag-dot"></div>'.repeat(9)}</div>`;
              return `<div class="io-preset-card" data-preset-id="${p.id}">
                <div class="io-preset-head" data-preset-toggle="${p.id}">
                  ${grip}
                  <span class="io-preset-nm">${esc(p.name)}</span>
                  <span class="io-preset-meta">${fmtStamp(p.timestamp)}</span>
                  <span class="io-chevron${exp?" open":""}">\u203a</span>
                  <button class="io-preset-del" data-preset-del="${p.id}">\u2715</button>
                </div>
                ${exp?`<div class="io-preset-detail">
                  ${kv("Mode", esc(MODE_LABELS[c.mode]||c.mode||"\u2014"))}
                  ${kv("Source", esc(c.source_type||"\u2014"))}
                  ${kv("Model", `<span title="${esc(c.model_file||"")}">${esc(shortName(c.model_file))}</span>`)}
                  ${kv("Sigmas", `<span title="${esc(c.sigmas||"")}">${esc(String(c.sigmas||"").split(",").filter(x=>x.trim()).length)} values \u00b7 CFG ${esc(c.cfg??"?")}</span>`)}
                  ${kv("Sampler", esc(c.sampler_name||"?"))}
                  ${(c.loras && c.loras.length)?kv("LoRAs", (()=>{
                    const total = c.loras.length;
                    const active = c.loras.filter(l=>l.enabled!==false).length;
                    const names = c.loras.map(l=>shortName(l.name)).filter(Boolean).join(", ") || "(none)";
                    const summary = active===total ? `${active}` : `${active} of ${total}`;
                    const full = c.loras.map(l=>(l.enabled===false?"(off) ":"")+(l.name||"(empty)")+`  [m:${l.strength_model}]`).join("\n");
                    return `<span title="${esc(full)}">${summary} \u2014 ${esc(names)}</span>`;
                  })()):""}
                  ${c.audio?kv("Audio","on"):""}
                  ${c.enable_vsr?kv("RTX VSR","on"):""}
                  ${c.enable_upscale?kv("Upscale","on"):""}
                  <button class="io-btn" data-preset-load="${p.id}">Load preset</button>
                </div>`:""}
              </div>`;
            }).join("");
        return sec("presets","Presets", `
          <div class="io-row">
            <input class="io-input" data-preset-name placeholder="Save current as\u2026" maxlength="60" value="${esc(presetName)}"/>
            <button class="io-btn" data-preset-save style="margin-top:0">Save</button>
          </div>
          ${cards}
        `);
      };

      /* ── Static DOM: left column re-renders IO-style; the player pane is
         built ONCE (innerHTML would destroy the <video> mid-playback). ── */
      const inner = document.createElement("div"); inner.className = "io-inner";
      const body = document.createElement("div"); body.className = "io-body";
      const leftWrap = document.createElement("div"); leftWrap.className = "io-col-left-wrap";
      const leftCol = document.createElement("div"); leftCol.className = "io-col-left";
      const bypassBar = document.createElement("div"); bypassBar.className = "io-bypass-bar";
      const bypassBtn = document.createElement("button");
      bypassBtn.type = "button";
      bypassBtn.className = "io-bypass-btn";
      bypassBar.appendChild(bypassBtn);
      leftWrap.append(leftCol, bypassBar);
      const pane = document.createElement("div"); pane.className = "io-col-right";
      const MODE_ALWAYS = 0;
      const MODE_BYPASS = 4;
      const refreshBypassBtn = () => {
        const bypassed = (selfNode.mode|0) === MODE_BYPASS;
        bypassBtn.textContent = bypassed ? "Activate Node" : "Bypass Node";
        bypassBtn.title = bypassed
          ? "Node is bypassed (skipped at execution). Click to activate."
          : "Click to bypass this node (same as rgthree bypass / mode 4).";
        bypassBtn.classList.toggle("is-bypassed", bypassed);
      };
      bypassBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        selfNode.mode = ((selfNode.mode|0) === MODE_BYPASS) ? MODE_ALWAYS : MODE_BYPASS;
        refreshBypassBtn();
        app.graph?.setDirtyCanvas?.(true, true);
      });
      refreshBypassBtn();

      const mkBtn = (label, title, fn, cls="vo-icon-btn") => {
        const b = document.createElement("button");
        b.className = cls; b.textContent = label; b.title = title;
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        return b;
      };

      // Preview head — IO's header buttons (minus Compare) + Orbitron timer.
      const head = document.createElement("div"); head.className = "io-preview-head";
      const goBtn = mkBtn("\u25b6", "Generate (keep seed)", () => queueKeep(), "io-icon-btn io-go io-hdr");
      const diceBtn = mkBtn("\u{1f3b2}", "Randomize & Generate", () => queueRand(), "io-icon-btn io-dice io-hdr");
      const stopBtn = mkBtn("\u23f9", "Interrupt generation", () => interrupt(), "io-icon-btn io-stop io-hdr");
      stopBtn.style.display = "none";
      const headSpacer = document.createElement("div"); headSpacer.style.flex = "1";
      const timerEl = document.createElement("span"); timerEl.className = "io-timer";
      timerEl.textContent = "00:00:000";
      const saveHdrBtn = mkBtn("\u{1f4be}", "Save current preview to output folder", () => saveCurrent(), "io-icon-btn io-save io-hdr");
      saveHdrBtn.style.display = "none";
      head.append(goBtn, diceBtn, stopBtn, headSpacer, timerEl, saveHdrBtn);

      // Stage
      const stage = document.createElement("div"); stage.className = "vo-stage";
      const empty = document.createElement("div"); empty.className = "vo-empty";
      empty.textContent = "Generated video appears here";
      const video = document.createElement("video");
      video.loop = (playMode === "loop"); video.muted = muted; video.playsInline = true;
      video.style.display = "none";
      // Drag the current frame onto Start or a beat guide slot (help text
      // promised this; drop targets already accept image Files / data URLs).
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
        const fps = history[activeIdx]?.fps || st.fps || 25;
        const frameN = Math.max(0, Math.round((video.currentTime || 0) * fps));
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
        const entry = history[activeIdx];
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
          ? "Drag the current frame onto Start, a beat guide, or any image input"
          : "";
      };
      let lightboxOpen = false;
      video.addEventListener("dragstart", (e) => {
        // Lightbox owns pointer gestures (pan); HTML5 drag must stay off there.
        if (lightboxOpen || !video.draggable) { e.preventDefault(); return; }
        const cap = captureCurrentFrameFile();
        if (!cap) { e.preventDefault(); return; }
        e.dataTransfer.effectAllowed = "copy";
        // File first: Chromium clears File items from the drag store when
        // any string type is added afterwards, so the File may not survive
        // to the drop -- the string payloads below are what drop targets
        // actually see in that case. x-oasis-frame carries the exact
        // on-screen pixels for Start/guide slots; text/uri-list carries a
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
      // Cache-warmer: buffers the next-in-line clip in the background so
      // the DOM src swap at cycle-advance time hits browser cache. Not a
      // true seamless swap (that would need dual video elements layered
      // in the stage), but eliminates the fetch/parse latency for
      // same-codec/same-origin content.
      const preloadVideo = document.createElement("video");
      preloadVideo.style.display = "none";
      preloadVideo.muted = true;
      preloadVideo.preload = "auto";
      const badge = document.createElement("div"); badge.className = "vo-badge"; badge.style.display = "none";
      const toast = document.createElement("div"); toast.className = "vo-toast";
      stage.append(empty, video, preloadVideo, badge, toast);

      // Scrub row
      const scrubrow = document.createElement("div"); scrubrow.className = "vo-scrubrow";
      const scrub = document.createElement("input");
      scrub.type = "range"; scrub.className = "vo-scrub";
      scrub.min = 0; scrub.max = 1000; scrub.value = 0;
      const timeLabel = document.createElement("span"); timeLabel.className = "vo-time";
      timeLabel.textContent = "0:00.00 / 0:00.00";
      scrubrow.append(scrub, timeLabel);

      // Transport bar
      const ctrl = document.createElement("div"); ctrl.className = "vo-ctrlbar";
      const playBtn = mkBtn("\u25b6", "Play/Pause (Space)", () => togglePlay());
      const backBtn = mkBtn("\u23ee", "Frame back (\u2190 \u00b7 Shift+\u2190 = 1s)", () => step(-1));
      const fwdBtn = mkBtn("\u23ed", "Frame forward (\u2192 \u00b7 Shift+\u2192 = 1s)", () => step(1));
      const loopBtn = mkBtn("\u{1f501}", "Loop", () => cyclePlayMode());
      const muteBtn = mkBtn("\u{1f50a}", "Mute", () => toggleMute());
      const speedSel = document.createElement("select"); speedSel.className = "vo-speed";
      for (const s of SPEEDS) {
        const o = document.createElement("option");
        o.value = s; o.textContent = s + "\u00d7";
        speedSel.appendChild(o);
      }
      speedSel.value = "1";
      speedSel.onchange = () => { speed = +speedSel.value; video.playbackRate = speed; };
      speedSel.onclick = (e) => e.stopPropagation();
      const lbBtn = mkBtn("\u26f6", "Fullscreen lightbox (scroll = zoom, drag = pan)", () => openLightbox());
      const ctrlSpacer = document.createElement("div"); ctrlSpacer.style.flex = "1";
      const prevBtn = mkBtn("\u2039", "Previous video (wraps around)", () => navBy(-1), "vo-nav-arrow");
      const counter = document.createElement("span"); counter.className = "vo-nav";
      const nextBtn = mkBtn("\u203a", "Next video (wraps around)", () => navBy(1), "vo-nav-arrow");
      const nav = document.createElement("span"); nav.className = "vo-nav"; nav.style.display = "none";
      nav.append(prevBtn, counter, nextBtn);
      // Clip range: mark in/out on the current viewer clip, then Clip writes
      // a trimmed copy under output/video/ and adds it to the scene bar.
      let clipInS = null, clipOutS = null;
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
      clipRangeLbl.textContent = "";
      const clipBtn = mkBtn("Clip", "Clip current video to marked in/out frames", () => clipCurrent(), "vo-btn-save");
      const movieAudioBtn = mkBtn("\u{1f50a}",
        "Movie audio: on: audio kept where present, silence synthesized for silent clips",
        () => toggleMovieAudio(), "vo-btn-movie-audio");
      const createMovieBtn = mkBtn("\u{1f3ac} Movie", "Create Movie", () => createMovie(), "vo-btn-save");
      ctrl.append(playBtn, backBtn, fwdBtn, loopBtn, muteBtn, speedSel, lbBtn,
        markInBtn, markOutBtn, clipRangeLbl, clipBtn,
        ctrlSpacer, movieAudioBtn, createMovieBtn);

      // Info bar + history strip (scene nav lives here — IO info-bar parity)
      const infobar = document.createElement("div"); infobar.className = "vo-infobar";
      const infoText = document.createElement("span"); infoText.className = "vo-info-text";
      infobar.append(infoText, nav);
      infobar.style.display = "none";
      const historyEl = document.createElement("div"); historyEl.className = "vo-history";
      // Persistent "+" tile for load-from-disk. Sits at the end of the strip
      // via CSS flex order:99; not a member of history[], so reorder/delete
      // logic ignores it. Click opens the picker modal.
      const addTile = document.createElement("div");
      addTile.className = "vo-thumb-add";
      addTile.textContent = "+";
      addTile.title = "Load a video from output/ into the scene bar";
      addTile.addEventListener("pointerdown", e => e.stopPropagation());
      addTile.addEventListener("click", e => { e.stopPropagation(); openPicker(); });
      historyEl.appendChild(addTile);

      pane.append(head, stage, scrubrow, ctrl, infobar, historyEl);
      body.append(leftWrap, pane);
      inner.append(body);
      container.append(inner);

      // Canvas event-stoppers, ONCE (per-render stacking is IO's noted bug).
      container.addEventListener("mousedown", e=>e.stopPropagation());
      container.addEventListener("pointerdown", e=>e.stopPropagation());
      container.addEventListener("wheel", e=>e.stopPropagation());
      container.addEventListener("keydown", (e) => {
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
        if (e.code === "Space") { e.preventDefault(); togglePlay(); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -fpsOf() : -1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? fpsOf() : 1); }
      });

      /* ── Player behaviors ── */
      const safePlay = () => {
        try { const p = video.play(); p?.catch?.(() => {}); } catch { /* autoplay block */ }
      };
      const current = () => history[activeIdx] || null;
      const fpsOf = () => current()?.fps || st.fps || 24;
      const togglePlay = () => {
        if (!current()) return;
        video.paused ? safePlay() : video.pause();
      };
      const step = (nFrames) => {
        if (!current()) return;
        video.pause();
        const dt = nFrames / fpsOf();
        video.currentTime = Math.min(
          Math.max(0, video.currentTime + dt),
          Math.max(0, (video.duration || 0) - 1e-4));
      };
      const PLAY_MODE_ORDER = ["off", "loop", "cycle"];
      const PLAY_MODE_ICON  = { off: "\u{1f501}", loop: "\u{1f502}", cycle: "\u{1f501}" };
      const PLAY_MODE_TIP   = {
        off:   "Playback: no repeat (click to cycle: off \u2192 loop \u2192 cycle)",
        loop:  "Playback: repeat current clip (click for cycle)",
        cycle: "Playback: cycle through the scene bar (click to disable)",
      };
      const refreshPlayModeBtn = () => {
        loopBtn.textContent = PLAY_MODE_ICON[playMode] || PLAY_MODE_ICON.off;
        loopBtn.title = PLAY_MODE_TIP[playMode] || PLAY_MODE_TIP.off;
        loopBtn.classList.toggle("vo-on", playMode !== "off");
      };
      // Refresh the .vo-cycling class on every thumb. Only the active
      // entry gets it, and only while playMode is "cycle".
      const refreshCyclingClass = () => {
        for (const e of history) {
          e.thumbEl?.classList.toggle(
            "vo-cycling", playMode === "cycle" && e === history[activeIdx]);
        }
      };
      // Cache-warm the next entry in the cycle queue. No-op when we're
      // not in cycle mode. Detaches src otherwise so we don't hold a
      // background fetch open.
      const warmPreload = () => {
        if (playMode !== "cycle" || !cycleQueue || !cycleQueue.length) {
          try { preloadVideo.removeAttribute("src"); preloadVideo.load(); } catch {}
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
      // Advance to the next alive entry in the cycle queue. Alive = still
      // in history[]. If every queued entry has been deleted, bail out
      // to "off" and let the user know.
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
        // Nothing left to play.
        setPlayMode("off");
        showToast("Cycle queue exhausted");
      };
      const setPlayMode = (mode) => {
        if (!PLAY_MODE_ORDER.includes(mode)) mode = "off";
        playMode = mode;
        video.loop = (playMode === "loop");
        if (playMode === "cycle") {
          cycleQueue = history.slice();
          // If nothing's playing yet, load the first alive entry so
          // ended → advance chain has something to bounce off of. If
          // something IS playing, leave it and let it finish naturally.
          if (activeIdx < 0 && history.length) loadEntry(0, { autoplay: true });
          warmPreload();
        } else {
          cycleQueue = null;
          warmPreload();   // clears the preload src
        }
        refreshPlayModeBtn();
        refreshCyclingClass();
      };
      // Button click advances Off → Loop → Cycle → Off.
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
        const frame = Math.round(t * fpsOf());
        const total = current()?.frames || Math.round(d * fpsOf());
        timeLabel.textContent = `${fmtTime(t)} / ${fmtTime(d)} \u00b7 f ${frame}/${total}`;
      };
      video.addEventListener("timeupdate", syncTime);
      video.addEventListener("loadedmetadata", syncTime);
      video.addEventListener("play", () => (playBtn.textContent = "\u23f8"));
      video.addEventListener("pause", () => (playBtn.textContent = "\u25b6"));
      // Cycle-mode advance. video.loop is off in cycle mode so `ended`
      // actually fires; in loop mode it doesn't (native repeat).
      video.addEventListener("ended", () => {
        if (playMode === "cycle") advanceCycle();
      });
      video.addEventListener("error", () => {
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
      scrub.addEventListener("click", (e) => e.stopPropagation());
      stage.addEventListener("mouseenter", () => { if (current()) showBadge(); });

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
        const fileFallback = !!st.continue_last && e.hasLatent === false;
        infoText.innerHTML =
          (e.warning ? "\u26a0 " : "") +
          `<span class="vo-info-label">${dims}</span>` +
          ` \u00b7 ${e.fps || "?"} fps \u00b7 ` +
          `${e.frames ?? "?"} frames \u00b7 ${fmtSize(e.size_bytes)}` +
          (e.has_audio ? " \u00b7 audio" : "") +
          (fileFallback ? ` \u00b7 <span class="vo-nolatent">\u26d3 no latent: decoding the file</span>` : "") +
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
      const navBy = (delta) => {
        if (history.length < 2) return;
        const n = history.length;
        loadEntry((activeIdx + delta + n) % n, { autoplay: true });
      };
      // Movie compatibility: fast-path stream-copy needs identical
      // Resolution/fps across every saved entry. Codec may differ (Clip
      // re-encodes); the backend re-encodes when bitstreams don't match.
      // Temp entries are excluded. Returns { ok, saved, reason }.
      const checkMovieCompat = () => {
        const saved = history.filter(e => e.saved);
        if (saved.length < 2) {
          return { ok: false, saved, reason:
            saved.length === 0
              ? "Create Movie: save at least two clips first (temp clips are excluded)"
              : "Create Movie: need at least two saved clips (temp clips are excluded)" };
        }
        const ref = saved[0];
        for (const e of saved.slice(1)) {
          const w = (e.width || 0) !== (ref.width || 0);
          const h = (e.height || 0) !== (ref.height || 0);
          const fps = Math.abs((e.fps || 0) - (ref.fps || 0)) > 0.01;
          if (w || h || fps) {
            const bits = [
              (w || h) ? `${e.width}\u00d7${e.height} vs ${ref.width}\u00d7${ref.height}` : null,
              fps ? `${(e.fps||0).toFixed(2)}fps vs ${(ref.fps||0).toFixed(2)}fps` : null,
            ].filter(Boolean).join(", ");
            return { ok: false, saved, reason:
              `Create Movie disabled: saved clips must match size/fps. Mismatch: ${bits}` };
          }
        }
        return { ok: true, saved };
      };
      const updateSaveBtn = () => {
        const e = current();
        // Create Movie enable state — recomputed here (called on every
        // add/remove/save/load path so the button reflects strip reality).
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
          saveHdrBtn.classList.remove("io-saved-mark");
          saveHdrBtn.title = "Save current preview to output folder";
          return;
        }
        saveHdrBtn.style.display = "";
        saveHdrBtn.disabled = false;
        if (e.saved) {
          saveHdrBtn.textContent = "\u2713";
          saveHdrBtn.classList.add("io-saved-mark");
          saveHdrBtn.title = "Saved to " + e.savedPath + ": click to save another copy";
        } else {
          saveHdrBtn.textContent = "\u{1f4be}";
          saveHdrBtn.classList.remove("io-saved-mark");
          saveHdrBtn.title = "Save current preview to output folder";
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
        // Passive continue-from-viewed: whatever's loaded in the viewer is
        // the tail source. Debounced so scrubbing the strip doesn't spam
        // the server; last stop wins. No-op if the entry already IS the
        // tail source (fresh generation, or previously synced).
        scheduleSetTail(entry);
      };

      // Sequential poster generation (a restored 24-strip must not decode
      // everything at once). Two-phase draw + soft/hard timeout split.
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
        const release = () => { if (!released) { released = true; resolve(); } };
        const cleanup = () => {
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
          } catch { /* canvas unavailable */ }
        };
        const softT = setTimeout(release, 5000);
        const hardT = setTimeout(cleanup, 60000);
        v.muted = true; v.preload = "auto"; v.src = playURL(entry);
        v.addEventListener("error", () => { clearTimeout(softT); cleanup(); });
        v.addEventListener("loadeddata", () => {
          draw();
          try { v.currentTime = Math.min(0.04, (v.duration || 1) / 2); } catch { cleanup(); }
        });
        v.addEventListener("seeked", () => {
          draw();
          clearTimeout(softT);
          cleanup();
        }, { once: true });
      });

      // ── Continue-from-viewed: register the current entry as tail source
      // Generated clips also cache a latent; set_tail reports whether this
      // entry has one. File decode is the fallback when it doesn't.
      const dropLatent = (entry) => {
        if (!entry?.filename) return;
        api.fetchApi("/ltx23_oasis/drop_latent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ video: entry.filename,
                                 subfolder: entry.subfolder || "",
                                 type: entry.type || "temp" }),
        }).catch(() => {});
      };
      const sweepLatents = () => {
        api.fetchApi("/ltx23_oasis/sweep_latents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: history.map(e => ({
            video: e.filename, subfolder: e.subfolder || "",
            type: e.type || "temp" })) }),
        }).catch(() => {});
      };
      const _uploadTail = async (entry) => {
        const r = await api.fetchApi("/ltx23_oasis/set_tail", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            io_id: ensureIoId(),
            video: entry.filename,
            subfolder: entry.subfolder || "",
            type: entry.type || "temp",
          }),
        });
        if (!r.ok) throw new Error(`set_tail HTTP ${r.status}`);
        return r.json();
      };

      // Background sync. Silent — success and failure both go to the
      // console. The user-facing "which entry is seeding the next run"
      // confirmation lives in queueKeep/queueRand instead, so it fires
      // on generate rather than on every playback or cycle advance.
      let _tailInFlight = null;
      const _tailFire = async (entry) => {
        try {
          const r = await _uploadTail(entry);
          entry.hasLatent = !!(r && r.has_latent);
          if (entry === history[activeIdx]) {
            tailSourceEntry = entry;
            renderInfo();
          }
        } catch (e) {
          console.debug("[LTX Oasis] tail sync failed:", e && e.message || e);
        }
      };

      const scheduleSetTail = (entry) => {
        if (!entry) return;
        // If the server already has this entry's tail (fresh generation, or
        // last successful upload), skip.
        if (entry === tailSourceEntry) return;
        if (_tailDebounceT) clearTimeout(_tailDebounceT);
        _tailDebounceT = setTimeout(() => {
          _tailDebounceT = null;
          _tailInFlight = _tailFire(entry).finally(() => { _tailInFlight = null; });
        }, TAIL_DEBOUNCE_MS);
      };

      const cancelPendingTailSync = () => {
        if (_tailDebounceT) { clearTimeout(_tailDebounceT); _tailDebounceT = null; }
      };

      // Fire any pending debounce immediately and await the upload. Called
      // at generate time so the server sees the current viewer's tail
      // before the workflow queues, and the confirmation toast reflects
      // reality (not intent). No-op if nothing pending / nothing in flight.
      const flushPendingTailSync = async () => {
        if (_tailDebounceT) {
          clearTimeout(_tailDebounceT); _tailDebounceT = null;
          const entry = history[activeIdx];
          if (entry && entry !== tailSourceEntry) {
            _tailInFlight = _tailFire(entry).finally(() => { _tailInFlight = null; });
          }
        }
        if (_tailInFlight) {
          try { await _tailInFlight; } catch { /* silent */ }
        }
      };

      // ── Scene-bar delete + long-press reorder ─────────────────────────
      // Delete removes only from the strip; the file on disk is untouched
      // (Jason: "users can clean up their own output folder"). Reorder uses
      // a pointer state machine so a quick tap still means "load this
      // entry" while a hold enters drag mode with an insertion cursor.
      // Constants chosen by feel: 300ms hold matches the OS long-press
      // convention; a 5px move threshold lets the mouse settle before
      // committing to "click vs drag" without a scroll gesture triggering
      // a drag on a jittery pointer.
      const HOLD_MS = 300, MOVE_THRESHOLD = 5;

      const clearEmptyViewer = (msg) => {
        activeIdx = -1;
        clipInS = null; clipOutS = null;
        try { video.pause(); } catch { /* jsdom */ }
        video.removeAttribute("src");
        try { video.load(); } catch { /* */ }
        setFrameDragEnabled(false);
        video.style.display = "none";
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
        dropLatent(entry);
        // If we deleted the entry the server's tail belongs to, clear the
        // marker so the next loadEntry re-syncs from whatever's now active.
        if (entry === tailSourceEntry) tailSourceEntry = null;
        // Purge from the cycle queue so advanceCycle doesn't keep walking
        // over a dead reference. Alive-check inside advanceCycle would
        // eventually skip it, but keeping the queue clean is cheap.
        if (cycleQueue) {
          const qi = cycleQueue.indexOf(entry);
          if (qi >= 0) cycleQueue.splice(qi, 1);
        }
        if (!history.length) {
          clearEmptyViewer("Scene bar is empty \u2014 run the workflow to add a shot");
          return;
        }
        if (wasActive) {
          // Prefer the entry that took our slot (next-in-line); if we were
          // last, fall back to the new last entry. Autoplay only if we're
          // in cycle mode — a manual delete during cycle should keep the
          // playback rolling; a delete during off/loop shouldn't surprise
          // the user with playback.
          const nextIdx = Math.min(idx, history.length - 1);
          loadEntry(nextIdx, { autoplay: playMode === "cycle" });
        } else if (idx < activeIdx) {
          // Splice shifted the active entry left by 1.
          activeIdx -= 1;
          renderInfo();
          updateSaveBtn();
        } else {
          updateSaveBtn();
        }
        // Deletion may have changed which entry is "next in queue" — even
        // if the deleted entry wasn't the active one. Re-warm.
        if (playMode === "cycle") warmPreload();
      };

      const clearDropIndicators = () => {
        historyEl.querySelectorAll(".vo-drop-before,.vo-drop-after")
          .forEach(el => el.classList.remove("vo-drop-before","vo-drop-after"));
      };

      // Given the cursor X, find the target thumb and side (before/after).
      // Uses nearest-midpoint against all thumbs EXCEPT the one being
      // dragged (so we don't compute a drop position on the source itself).
      const computeDropTarget = (clientX) => {
        const others = history.filter(e => e !== dragEntry && e.thumbEl);
        if (!others.length) return null;
        let best = null, bestDist = Infinity;
        for (const e of others) {
          const r = e.thumbEl.getBoundingClientRect();
          const mid = r.left + r.width/2;
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
        container.classList.add("vo-reorder-active");   // hides all ✕ buttons
      };

      const commitDrag = (clientX) => {
        const fromIdx = history.indexOf(dragEntry);
        const t = computeDropTarget(clientX);
        if (fromIdx < 0 || !t) return;
        const targetIdx = history.indexOf(t.entry);
        let insertAt = t.before ? targetIdx : targetIdx + 1;
        // After splice(from,1), indices > from shift down by 1.
        if (fromIdx < insertAt) insertAt -= 1;
        if (fromIdx === insertAt) return;   // no-op
        const activeEntry = history[activeIdx] || null;
        const [moved] = history.splice(fromIdx, 1);
        history.splice(insertAt, 0, moved);
        // Reflect new order in the DOM by re-appending in array order.
        for (const e of history) historyEl.appendChild(e.thumbEl);
        // Re-anchor activeIdx to the same entry.
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

      // Global pointermove/up while a thumb-press is in flight. Attached on
      // pointerdown and detached in cleanupDrag so they never linger.
      function onGlobalMove(ev){
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
      function onGlobalUp(ev){
        if (!pointerStart) return;
        const entry = pointerStart.entry;
        if (dragEntry) {
          commitDrag(ev.clientX);
        } else if (holdTimer) {
          // Hold never fired and we didn't scroll away — treat as a click.
          clearTimeout(holdTimer); holdTimer = null;
          loadEntry(history.indexOf(entry), { autoplay: true });
        }
        cleanupDrag();
      }
      function onGlobalCancel(){ cleanupDrag(); }

      const makeThumb = (entry) => {
        const t = document.createElement("div");
        t.className = "vo-thumb";
        if (entry.saved) t.classList.add("vo-saved");
        t.title = entry.filename;
        // Delete ✕. Stop pointerdown propagation so a click on ✕ never
        // arms the hold timer on the underlying thumb.
        const x = document.createElement("div");
        x.className = "vo-thumb-x";
        x.textContent = "\u2715";
        x.title = "Remove from scene bar (does not delete the file)";
        x.addEventListener("pointerdown", e => e.stopPropagation());
        x.addEventListener("click", e => { e.stopPropagation(); removeEntry(entry); });
        t.appendChild(x);
        // Pointer-based state machine replaces the old onclick: pointerdown
        // arms a 300ms timer, pointerup before the timer decides "click"
        // (loadEntry), timer firing enters drag mode. Global listeners are
        // installed here and removed in cleanupDrag.
        t.addEventListener("pointerdown", (ev) => {
          if (ev.button !== 0) return;   // left button only
          ev.stopPropagation();
          // If another press was somehow still in flight, tear it down first.
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
        const entry = { ...info, rand: newRand(), saved: false };
        history.push(entry);
        while (history.length > HISTORY_CAP) {
          const dropped = history.shift();
          dropped.thumbEl?.remove();
          dropLatent(dropped);
          if (dropped === tailSourceEntry) tailSourceEntry = null;
        }
        makeThumb(entry);
        historyEl.scrollLeft = historyEl.scrollWidth;
        // Fresh generation: the server keeps no pixels of its own any more,
        // so this entry has to be registered like any other. Cancel any
        // stale debounce first; loadEntry's scheduleSetTail then registers
        // this one.
        cancelPendingTailSync();
        tailSourceEntry = null;
        loadEntry(history.length - 1, { autoplay: true });
      };
      const addResults = (results) => { for (const info of results) addEntry(info); };

      // ── Load-from-disk: promotes any existing video under output/ into
      // the scene bar as a saved entry. Two-step against the backend: list
      // is cheap (name/size/mtime), probe runs PyAV on demand for the file
      // the user picks. Entry shape matches fresh-generation output so the
      // rest of the strip (thumbnail poster, info bar, badge, save button,
      // tail sync) treats it identically.
      const loadExternalVideo = async (item) => {
        try {
          const r = await api.fetchApi("/ltx23_oasis/probe_video", {
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
          const entry = {
            filename: item.filename,
            subfolder: item.subfolder || "",
            type: "output",   // served via /view?type=output
            width: meta.width, height: meta.height,
            fps: meta.fps, frames: meta.frames,
            size_bytes: meta.size_bytes,
            codec: meta.codec, format: meta.format,
            crf: null,        // unknown for external files; badge renders codec only
            has_audio: !!meta.has_audio,
            rand: newRand(),
            saved: true,      // lives under output/, so solid green border
            savedPath,
            external: true,   // flag; unused for now, kept for future distinctions
          };
          history.push(entry);
          while (history.length > HISTORY_CAP) {
            const dropped = history.shift();
            dropped.thumbEl?.remove();
            dropLatent(dropped);
            if (dropped === tailSourceEntry) tailSourceEntry = null;
          }
          makeThumb(entry);
          historyEl.scrollLeft = historyEl.scrollWidth;
          // The scheduleSetTail inside loadEntry registers this entry with
          // the backend; external files are no different from fresh ones.
          loadEntry(history.length - 1, { autoplay: true });
          showToast(`Loaded ${item.filename}`);
        } catch (e) {
          showToast(`Load failed: ${e.message || e}`);
        }
      };

      const openPicker = async () => {
        const overlay = document.createElement("div");
        overlay.className = "vog-picker-overlay";
        overlay.innerHTML = `
          <div class="vog-picker">
            <div class="vog-picker-head">
              <div class="vog-picker-title">Load video into scene bar</div>
              <button class="vog-picker-close" title="Cancel (Esc)">\u2715</button>
            </div>
            <div class="vog-picker-search"><input type="text" placeholder="Search filename\u2026" spellcheck="false" autocomplete="off"/></div>
            <div class="vog-picker-list"><div class="vog-picker-empty">Loading\u2026</div></div>
          </div>`;
        document.body.appendChild(overlay);
        const searchEl = overlay.querySelector(".vog-picker-search input");
        const listEl = overlay.querySelector(".vog-picker-list");
        const closeModal = () => {
          overlay.remove();
          document.removeEventListener("keydown", escHandler);
        };
        function escHandler(e){ if (e.key === "Escape") { e.stopPropagation(); closeModal(); } }
        document.addEventListener("keydown", escHandler);
        overlay.querySelector(".vog-picker-close").onclick = closeModal;
        overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
        searchEl.focus();

        let items = [];
        try {
          const r = await api.fetchApi("/ltx23_oasis/list_output_videos");
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          items = await r.json();
          if (!Array.isArray(items)) items = [];
        } catch (e) {
          listEl.innerHTML = `<div class="vog-picker-empty">Could not list output/: ${esc(e.message||e)}</div>`;
          return;
        }
        const renderList = (filter) => {
          const f = (filter || "").toLowerCase();
          const filtered = f
            ? items.filter(it => {
                const path = (it.subfolder ? it.subfolder + "/" : "") + it.filename;
                return path.toLowerCase().includes(f);
              })
            : items;
          if (!filtered.length) {
            listEl.innerHTML = `<div class="vog-picker-empty">${items.length ? "No matches" : "No videos in output/ yet"}</div>`;
            return;
          }
          listEl.innerHTML = filtered.map((it) => {
            const path = (it.subfolder ? it.subfolder + "/" : "") + it.filename;
            const origIdx = items.indexOf(it);
            return `<div class="vog-picker-row" data-idx="${origIdx}">
              <span class="vog-picker-name" title="${esc(path)}">${esc(path)}</span>
              <span class="vog-picker-meta">${fmtSize(it.size_bytes)}</span>
            </div>`;
          }).join("");
          listEl.querySelectorAll(".vog-picker-row").forEach(row => {
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
          if (!flags[i]) {
            e.thumbEl?.remove();
            dropLatent(e);
            return false;
          }
          return true;
        });
        // If the tail source got pruned, forget it so the loadEntry below
        // triggers a fresh sync.
        if (tailSourceEntry && !history.includes(tailSourceEntry)) {
          tailSourceEntry = null;
        }
        if (!history.length) {
          clearEmptyViewer("Previous previews expired (temp is cleared on restart) \u2014 run the workflow");
          return;
        }
        const idx = history.indexOf(activeEntry);
        loadEntry(idx >= 0 ? idx : Math.min(Math.max(activeIdx, 0), history.length - 1),
                  { autoplay: false });
      };

      const saveEntries = async (entries) => {
        createMovieBtn.disabled = true;
        saveHdrBtn.disabled = true;
        try {
          const res = await api.fetchApi("/video_oasis/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              videos: entries.map((e) => ({
                filename: e.filename, subfolder: e.subfolder || "",
              })),
              save_prefix: st.save_prefix || "video/LTX23Oasis",
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
            bytes += (s.size_kb || 0) * 1024;
            // Repoint the entry at the OUTPUT copy so it survives restart.
            // Temp is cleared on ComfyUI restart; the saved file lives on
            // under output/. We derive subfolder/filename from s.path as
            // ground truth (server versions differ on which fields they
            // return separately). rand is regenerated to defeat any stale
            // browser cache of the temp URL.
            // NOTE: On Windows the server can return `s.path` with either
            // separator; normalize to forward-slash before splitting so we
            // don't fall through the -1 branch and leave a `video\…` prefix
            // sitting in filename (which then doubles up with s.subfolder).
            const path = String(s.path || "").replace(/\\/g, "/");
            if (path) {
              const slash = path.lastIndexOf("/");
              e.subfolder = slash >= 0 ? path.slice(0, slash) : (s.subfolder || "");
              e.filename  = slash >= 0 ? path.slice(slash + 1) : path;
              e.type = "output";
              e.rand = newRand();
            }
            e.thumbEl?.classList.add("vo-saved");
          }
          updateSaveBtn();
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
          updateSaveBtn();   // recomputes createMovieBtn state from history
        }
      };
      const saveCurrent = async () => { if (current()) await saveEntries([current()]); };

      const refreshMovieAudioBtn = () => {
        movieAudioBtn.textContent = movieAudio ? "\u{1f50a}" : "\u{1f507}";
        movieAudioBtn.title = movieAudio
          ? "Movie audio: on: audio kept where present, silence synthesized for silent clips"
          : "Movie audio: off: audio stripped from every clip";
        movieAudioBtn.classList.toggle("vo-on", movieAudio);
      };
      const toggleMovieAudio = () => {
        movieAudio = !movieAudio;
        refreshMovieAudioBtn();
      };

      const fmtClipMark = (s) => {
        if (s == null || !Number.isFinite(s)) return "--";
        const fps = fpsOf();
        const f = Math.max(0, Math.round(s * fps));
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
          const fps = fpsOf();
          const r = await api.fetchApi("/ltx23_oasis/clip_video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              filename: entry.filename,
              subfolder: entry.subfolder || "",
              type: entry.type || "temp",
              start_s: clipInS,
              end_s: clipOutS,
              fps,
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
          const r = await api.fetchApi("/ltx23_oasis/create_movie", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              entries: compat.saved.map(e => ({
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

      const openLightbox = () => {
        if (!current() || lightboxOpen) return;
        lightboxOpen = true;
        const dragWasOn = !!video.draggable;
        setFrameDragEnabled(false);
        const overlay = document.createElement("div");
        overlay.className = "vog-lightbox";
        overlay.tabIndex = -1;
        const hint = document.createElement("div");
        hint.className = "vo-lb-hint";
        hint.textContent = "scroll = zoom \u00b7 drag = pan \u00b7 double-click = reset \u00b7 space = play/pause \u00b7 Esc / click background = close";
        const placeholder = document.createComment("vog-video");
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
          // Block native drag / text selection so pan + Space work immediately.
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

      /* ── Execution timer (IO verbatim: Orbitron readout, resume-if-live) ── */
      const fmtTimer = (ms) => {
        if(ms<0) ms=0;
        const m  = String(Math.floor(ms/60000)).padStart(2,"0");
        const s  = String(Math.floor((ms%60000)/1000)).padStart(2,"0");
        const mn = String(Math.floor(ms%1000)).padStart(3,"0");
        return `${m}:${s}:${mn}`;
      };
      const paintTimer = (ms,running) => {
        timerEl.textContent = fmtTimer(ms);
        timerEl.classList.toggle("running", !!running);
      };
      const syncRunState = () => {
        const b = leftCol.querySelector("[data-wand-go]");
        if(b){
          b.disabled = wandBusy || timerRunning;
          b.title = timerRunning ? "Unavailable while a video is generating" : "";
        }
        stopBtn.style.display = timerRunning ? "inline-flex" : "none";
      };
      const startTimer = (resumeStart) => {
        if(timerRunning) return;
        timerRunning = true;
        timerStart = (typeof resumeStart==="number") ? resumeStart : Date.now();
        timerElapsedMs = Date.now()-timerStart;
        paintTimer(timerElapsedMs,true);
        syncRunState();
        timerInterval = setInterval(()=>{
          timerElapsedMs = Date.now()-timerStart;
          paintTimer(timerElapsedMs,true);
        },33);
      };
      const stopTimer = () => {
        if(!timerRunning) return;
        timerRunning = false;
        clearInterval(timerInterval); timerInterval=null;
        timerElapsedMs = Date.now()-timerStart;
        paintTimer(timerElapsedMs,false);
        syncRunState();
      };
      const resumeTimerIfLive = async (start, fallbackElapsed) => {
        try{
          const r = await (await fetch("/prompt")).json();
          if(((r?.exec_info?.queue_remaining)|0) > 0 && !timerRunning){
            startTimer(start);
            return;
          }
        }catch(e){ console.warn("[LTX Oasis] timer resume check failed",e); }
        if(!timerRunning){
          timerElapsedMs = Math.max(0, fallbackElapsed||0);
          paintTimer(timerElapsedMs,false);
        }
      };

      /* ── Queue actions ── */
      // If continue_last is on, block briefly until the current viewer's
      // tail is on the server (fixes the debounce race — click a thumb,
      // hit generate immediately, get that thumb's tail seeded). Then emit
      // one confirmation toast naming the seed source so the user knows
      // which clip is feeding the run. Playback and cycle advances stay
      // silent — no more noise on the render pane.
      const _emitContinueLastToast = () => {
        if (!st.continue_last) return;
        const src = tailSourceEntry || history[activeIdx];
        if (!src) return;
        const short = (src.filename || "").split(/[/\\]/).pop() || "current clip";
        showToast(`\u21bb Generating from ${short}'s last frame`);
      };
      const queueKeep = async () => {
        if (st.continue_last) await flushPendingTailSync();
        _emitContinueLastToast();
        await app.queuePrompt(0,1);
      };
      const queueRand = async () => {
        st.seed = Math.floor(Math.random()*MAX_SEED);
        render();
        if (st.continue_last) await flushPendingTailSync();
        _emitContinueLastToast();
        await app.queuePrompt(0,1);
      };
      const interrupt = async () => {
        try{
          if(typeof api.interrupt === "function") await api.interrupt();
          else await fetch("/interrupt",{method:"POST"});
        }catch(err){ console.warn("[LTX Oasis] interrupt failed",err); }
      };

      /* ── render(): the LEFT COLUMN ONLY re-renders IO-style; the player
         pane is static DOM. Scroll positions preserved (incl. help body). ── */
      const render = () => {
        const scTop = leftCol.scrollTop;
        const helpEl = leftCol.querySelector(".io-help-body");
        const helpTop = helpEl ? helpEl.scrollTop : 0;
        leftCol.innerHTML =
          presetsSection()+modelSection()+loraSection()+refsSection()+
          promptSection()+beatsSection()+videoSection()+samplingSection()+upscaleSection()+
          encodeSection()+themeSection()+helpSection();
        bind();
        refreshBypassBtn();
        leftCol.scrollTop = scTop;
        const help2 = leftCol.querySelector(".io-help-body");
        if (help2 && helpTop) help2.scrollTop = helpTop;
        // NOTE: render() must NOT call save() (IO's re-render-loop rule).
      };

      // Persistence is automatic via getValue reading closure state live;
      // save() stays as a call-site-clarity no-op (IO pattern).
      const save = () => {};

      // Arch switch: reseed the arch-COUPLED fields (sampling shape, frame
      // grid, per-arch defaults) while keeping session work (prompts, seed,
      // loras, refs, canvas size).
      const applyArchChange = (key) => {
        st.architecture = key;
        const A = arch();
        Object.assign(st, archSeed(A));
        st.frames = A.defaults.frames;
      };


      const bind = () => {
        const refreshBeatFrameSum = () => {
          const el = leftCol.querySelector("[data-beat-frame-sum]");
          if (!el) return;
          const info = beatFrameSummary();
          el.textContent = info.text;
          el.classList.remove("ok", "short", "over");
          if (info.tone) el.classList.add(info.tone);
          const btn = leftCol.querySelector("[data-beat-match-frames]");
          if (btn) btn.disabled = !info.anySet || info.sum === (Number(st.frames) || 0);
        };
        leftCol.querySelectorAll("[data-sec]").forEach(el=>el.onclick=(e)=>{e.stopPropagation();open[el.dataset.sec]=!open[el.dataset.sec];save();render();});
        leftCol.querySelectorAll("[data-src]").forEach(el=>el.onclick=(e)=>{e.stopPropagation();st.source_type=el.dataset.src;st.model_file="";save();render();});
        leftCol.querySelectorAll("[data-sage]").forEach(el=>el.onclick=(e)=>{e.stopPropagation();st.sage=el.dataset.sage==="on";save();render();});
        leftCol.querySelectorAll("[data-mode]").forEach(el=>el.onclick=(e)=>{e.stopPropagation();st.mode=el.dataset.mode;save();render();});
        leftCol.querySelectorAll("[data-ratio]").forEach(b=>b.addEventListener("click",e=>{
          e.stopPropagation();
          const r = b.dataset.ratio;
          if(st.aspect_lock === r){ st.aspect_lock = ""; }
          else { st.aspect_lock = r; applyRatioFromWidth(); }
          save(); render();
        }));
        leftCol.querySelector("[data-wh-swap]")?.addEventListener("click",e=>{
          e.stopPropagation();
          const w = st.width; st.width = st.height; st.height = w;
          if(st.aspect_lock) st.aspect_lock = RATIO_MIRROR[st.aspect_lock] || st.aspect_lock;
          save(); render();
        });
        leftCol.querySelectorAll("[data-audio-mode]").forEach(b=>b.onclick=(e)=>{e.stopPropagation();st.audio_mode=b.dataset.audioMode;save();render();});
        leftCol.querySelectorAll("[data-audio-upload]").forEach(b=>b.addEventListener("click",e=>{
          e.stopPropagation();
          const inp = document.createElement("input");
          inp.type="file"; inp.accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a";
          inp.onchange = async () => {
            const file = inp.files?.[0]; if(!file) return;
            try{ st.audio_file = await uploadImageBlob(file, file.name); render(); }
            catch(err){ console.warn("[LTX Oasis] audio upload failed",err); }
          };
          inp.click();
        }));
        leftCol.querySelectorAll("[data-audio-clear]").forEach(b=>b.addEventListener("click",e=>{
          e.stopPropagation(); st.audio_file=""; render();
        }));
        leftCol.querySelectorAll("[data-audio-drop]").forEach(row=>{
          row.addEventListener("dragover",e=>{e.preventDefault();});
          row.addEventListener("drop",async e=>{
            e.preventDefault(); e.stopPropagation();
            // Audio Oasis segment chip, dragged in-app (no File object --
            // just the already-uploaded qualified filename). Same MIME
            // convention as the x-oasis-frame image-drag payload.
            const oasisAudio = (e.dataTransfer?.getData("application/x-oasis-audio") || "").trim();
            if(oasisAudio){ st.audio_file = oasisAudio; render(); return; }
            const f = e.dataTransfer?.files?.[0];
            if(!f || !(f.type.startsWith("audio/") || /\.(mp3|wav|flac|ogg|m4a)$/i.test(f.name))) return;
            try{ st.audio_file = await uploadImageBlob(f, f.name); render(); }
            catch(err){ console.warn("[LTX Oasis] audio drop failed",err); }
          });
        });
        leftCol.querySelectorAll("[data-enc-format]").forEach(b=>b.onclick=(e)=>{e.stopPropagation();st.format=b.dataset.encFormat;save();render();});
        leftCol.querySelectorAll("[data-enc-codec]").forEach(b=>b.onclick=(e)=>{e.stopPropagation();snapEncodeCodec(st, b.dataset.encCodec);save();render();});
        leftCol.querySelectorAll("[data-enc-gpu]").forEach(b=>b.onclick=(e)=>{e.stopPropagation();st.gpu_encode=b.dataset.encGpu==="on";save();render();});
        leftCol.querySelectorAll("[data-enc-quality]").forEach(b=>b.onclick=(e)=>{e.stopPropagation();st.quality=b.dataset.encQuality;save();render();});
        leftCol.querySelectorAll("[data-vsr-resize]").forEach(b=>b.onclick=(e)=>{e.stopPropagation();st.vsr_resize_type=b.dataset.vsrResize;save();render();});
        leftCol.querySelectorAll("[data-vsr-quality]").forEach(b=>b.onclick=(e)=>{e.stopPropagation();st.vsr_quality=b.dataset.vsrQuality;save();render();});
        leftCol.querySelectorAll("[data-chk]").forEach(el=>el.onclick=(e)=>{
          e.stopPropagation();
          const f=el.dataset.chk;
          st[f]=!st[f];
          save();render();
        });
        leftCol.querySelectorAll("[data-f]").forEach(el=>{
          const f=el.dataset.f;
          const handler=()=>{
            let v=el.value;
            if(el.type==="number"){v=parseFloat(v); if(isNaN(v))v=0;}
            if(f==="context_frames"){v=parseInt(v,10); if(isNaN(v))v=0;}
            st[f]=v;
            save();
            if(f==="architecture"){ applyArchChange(v); render(); }
            if(f==="frames" || f==="fps"){
              const d = leftCol.querySelector("[data-dur]");
              if(d && st.frames && st.fps) d.textContent = "\u2248 " + (st.frames/st.fps).toFixed(2) + "s";
              if(f==="frames") refreshBeatFrameSum();
              refreshAudioMeter();
            }
            if(st.aspect_lock && (f==="width" || f==="height")){
              if(f==="width") applyRatioFromWidth(); else applyRatioFromHeight();
              const sib = f==="width" ? "height" : "width";
              const sibEl = leftCol.querySelector(`[data-f="${sib}"]`);
              if(sibEl) sibEl.value = st[sib];
            }
          };
          el.onchange=handler;
          el.addEventListener("click",e=>e.stopPropagation());
          if(el.tagName==="TEXTAREA"||el.type==="number")el.oninput=handler;
          // Frames snap to the arch grid — on CHANGE only (not per keystroke,
          // which would fight the user mid-typing).
          if(f==="frames"){
            el.addEventListener("change",()=>{
              const snapped = snapFrames(el.value);
              if(snapped !== Number(el.value)){ st.frames = snapped; el.value = snapped; }
              else st.frames = snapped;
              save();
              refreshBeatFrameSum();
            });
          }
        });

        // ── Magic-wand bindings (shared IO enhancer) ──
        leftCol.querySelector("[data-llm-model]")?.addEventListener("change",e=>{
          e.stopPropagation();
          llmModel = e.target.value;
          llmRecommended = null;
          save();
          fetchRecommendedLayers();
        });
        leftCol.querySelector("[data-llm-model]")?.addEventListener("click",e=>e.stopPropagation());
        leftCol.querySelector("[data-wand-go]")?.addEventListener("click",e=>{e.stopPropagation();runEnhance();});
        leftCol.querySelector('[data-subsec="enhancer_settings"]')?.addEventListener("click",e=>{
          e.stopPropagation(); llmSettingsOpen = !llmSettingsOpen; save(); render();
          if(llmSettingsOpen && llmModel && !llmRecommended && !llmRecommendedBusy) fetchRecommendedLayers();
        });
        leftCol.querySelector("[data-llm-auto-layers]")?.addEventListener("click",e=>{
          e.stopPropagation();
          llmAutoLayers = !llmAutoLayers;
          if (llmAutoLayers && llmRecommended) llmGpuLayers = llmRecommended.layers;
          save(); render();
        });
        leftCol.querySelector("[data-llm-gpu-layers]")?.addEventListener("input",e=>{
          e.stopPropagation();
          if (llmAutoLayers) return;
          const v = parseInt(e.target.value, 10);
          if (Number.isFinite(v)) { llmGpuLayers = v; save(); }
        });
        leftCol.querySelector("[data-llm-context]")?.addEventListener("input",e=>{
          e.stopPropagation();
          const v = parseInt(e.target.value, 10);
          if (Number.isFinite(v) && v >= 512) { llmContext = v; save(); }
        });
        leftCol.querySelector("[data-llm-max-tokens]")?.addEventListener("input",e=>{
          e.stopPropagation();
          const v = parseInt(e.target.value, 10);
          if (Number.isFinite(v) && v >= 64) { llmMaxTokens = v; save(); }
        });
        leftCol.querySelectorAll("[data-llm-gpu-layers],[data-llm-context],[data-llm-max-tokens]")
          .forEach(el=>el.addEventListener("click",e=>e.stopPropagation()));

        // ── Prompt Beats bindings ──
        leftCol.querySelectorAll("[data-relay-text]").forEach(el=>{
          el.addEventListener("click",e=>e.stopPropagation());
          const h=()=>{ st.relay_segments[+el.dataset.relayText].text = el.value; save(); };
          el.onchange=h; el.oninput=h;
        });
        leftCol.querySelectorAll("[data-relay-frames]").forEach(el=>{
          el.addEventListener("click",e=>e.stopPropagation());
          const h=()=>{
            let v=parseInt(el.value,10); if(!Number.isFinite(v)||v<0)v=0;
            st.relay_segments[+el.dataset.relayFrames].frames = v; save();
            refreshBeatFrameSum();
          };
          el.onchange=h; el.oninput=h;
        });
        leftCol.querySelectorAll("[data-relay-del]").forEach(b=>b.addEventListener("click",e=>{
          e.stopPropagation();
          st.relay_segments = st.relay_segments.filter((_,i)=>i!==+b.dataset.relayDel);
          save(); render();
        }));
        leftCol.querySelector("[data-relay-add]")?.addEventListener("click",e=>{
          e.stopPropagation();
          st.relay_segments = [...(st.relay_segments||[]), {text:"",frames:0,guide_image:"",guide_strength:1.0}];
          if (!open.beats) open.beats = true;
          save(); render();
        });
        leftCol.querySelector("[data-beat-match-frames]")?.addEventListener("click",e=>{
          e.stopPropagation();
          const info = beatFrameSummary();
          if (!info.anySet || !(info.sum > 0)) return;
          st.frames = snapFramesQuantum(info.sum);
          save(); render();
        });
        leftCol.querySelectorAll("[data-relay-guide-thumb]").forEach(thumb=>{
          const i = +thumb.dataset.relayGuideThumb;
          thumb.addEventListener("dragenter",e=>{e.preventDefault();e.stopPropagation();thumb.classList.add("io-drop");});
          thumb.addEventListener("dragover", e=>{e.preventDefault();e.stopPropagation();if(e.dataTransfer)e.dataTransfer.dropEffect="copy";thumb.classList.add("io-drop");});
          thumb.addEventListener("dragleave",e=>{e.stopPropagation();thumb.classList.remove("io-drop");});
          thumb.addEventListener("drop",e=>{
            e.preventDefault(); e.stopPropagation(); thumb.classList.remove("io-drop");
            acceptBeatGuide(i, e.dataTransfer);
          });
          thumb.addEventListener("paste",e=>{
            e.preventDefault(); e.stopPropagation();
            acceptBeatGuide(i, e.clipboardData);
          });
          thumb.addEventListener("click",e=>{
            e.stopPropagation();
            if (!(st.relay_segments[i]?.guide_image||"").trim()) uploadBeatGuide(i);
          });
        });
        leftCol.querySelectorAll("[data-relay-guide-clear]").forEach(b=>b.addEventListener("click",e=>{
          e.stopPropagation();
          const i = +b.dataset.relayGuideClear;
          if (st.relay_segments[i]) {
            st.relay_segments[i].guide_image = "";
            st.relay_segments[i].guide_strength = 1.0;
            save(); render();
          }
        }));
        leftCol.querySelectorAll("[data-relay-guide-str]").forEach(el=>{
          el.addEventListener("click",e=>e.stopPropagation());
          const h=()=>{
            let v=parseFloat(el.value); if(!Number.isFinite(v))v=1;
            st.relay_segments[+el.dataset.relayGuideStr].guide_strength = Math.max(0, Math.min(1, v));
            save();
          };
          el.onchange=h; el.oninput=h;
        });
        leftCol.querySelector("[data-sigmas-reset]")?.addEventListener("click",e=>{
          e.stopPropagation();
          st.sigmas = arch().sampling?.sigmas || "";
          save(); render();
        });
        leftCol.querySelector("[data-upscale-sigmas-reset]")?.addEventListener("click",e=>{
          e.stopPropagation();
          st.upscale_sigmas = arch().upscale_native?.sigmas || "";
          save(); render();
        });

        // ── Reference image upload / clear / drop / paste (IO verbatim,
        //    field-keyed instead of slot-id-keyed) ──
        leftCol.querySelectorAll("[data-ref-upload]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();uploadRef(b.dataset.refUpload);}));
        leftCol.querySelectorAll("[data-ref-clear]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();st[b.dataset.refClear]="";if(b.dataset.refClear==="start_image"&&st.mode!=="t2v"){st.mode="t2v";save();}render();}));
        leftCol.querySelectorAll("[data-ref-thumb]").forEach(thumb=>{
          const field = thumb.dataset.refThumb;
          thumb.addEventListener("dragenter",e=>{e.preventDefault();e.stopPropagation();thumb.classList.add("io-drop");});
          thumb.addEventListener("dragover", e=>{e.preventDefault();e.stopPropagation();if(e.dataTransfer)e.dataTransfer.dropEffect="copy";thumb.classList.add("io-drop");});
          thumb.addEventListener("dragleave",e=>{e.stopPropagation();thumb.classList.remove("io-drop");});
          thumb.addEventListener("drop",     e=>{e.preventDefault();e.stopPropagation();thumb.classList.remove("io-drop");acceptDrop(field, e.dataTransfer);});
          thumb.addEventListener("paste",e=>{
            e.preventDefault(); e.stopPropagation();
            acceptDrop(field, e.clipboardData);
          });
          thumb.addEventListener("click",e=>e.stopPropagation());
        });

        // ── LoRA stack (IO verbatim) ──
        leftCol.querySelector("[data-lora-add]")?.addEventListener("click",e=>{
          e.stopPropagation();
          st.loras=[...(st.loras||[]),{name:"",strength_model:1.0,strength_clip:1.0,enabled:true,trigger_words:""}];
          render();
        });
        leftCol.querySelectorAll("[data-lora-del]").forEach(b=>b.addEventListener("click",e=>{
          e.stopPropagation();
          st.loras=(st.loras||[]).filter((_,idx)=>idx!==+b.dataset.loraDel);
          render();
        }));
        leftCol.querySelectorAll("[data-lora-en]").forEach(b=>b.addEventListener("click",e=>{
          e.stopPropagation();
          const l=st.loras[+b.dataset.loraEn];
          l.enabled = (l.enabled===false);
          render();
        }));
        leftCol.querySelectorAll("[data-lora-drag]").forEach(grip=>{
          const row = grip.closest(".io-lora-row");
          grip.addEventListener("dragstart",e=>{
            e.stopPropagation();
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(grip.dataset.loraDrag));
            if(e.dataTransfer.setDragImage){
              const r = row.getBoundingClientRect();
              e.dataTransfer.setDragImage(row, e.clientX - r.left, e.clientY - r.top);
            }
            setTimeout(()=>row.classList.add("io-lora-dragging"), 0);
          });
          grip.addEventListener("dragend",e=>{
            row.classList.remove("io-lora-dragging");
            leftCol.querySelectorAll(".io-lora-drop-above,.io-lora-drop-below")
              .forEach(el=>el.classList.remove("io-lora-drop-above","io-lora-drop-below"));
          });
        });
        leftCol.querySelectorAll("[data-lora-row-idx]").forEach(row=>{
          row.addEventListener("dragover",e=>{
            e.preventDefault(); e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            const r = row.getBoundingClientRect();
            const above = (e.clientY - r.top) < r.height/2;
            row.classList.toggle("io-lora-drop-above", above);
            row.classList.toggle("io-lora-drop-below", !above);
          });
          row.addEventListener("dragleave",e=>{
            if(e.relatedTarget && row.contains(e.relatedTarget)) return;
            row.classList.remove("io-lora-drop-above","io-lora-drop-below");
          });
          row.addEventListener("drop",e=>{
            e.preventDefault(); e.stopPropagation();
            const r = row.getBoundingClientRect();
            const above = (e.clientY - r.top) < r.height/2;
            row.classList.remove("io-lora-drop-above","io-lora-drop-below");
            const from = parseInt(e.dataTransfer.getData("text/plain"));
            const targetIdx = +row.dataset.loraRowIdx;
            if(isNaN(from) || from === targetIdx) return;
            let insertAt = above ? targetIdx : targetIdx + 1;
            if(from < insertAt) insertAt -= 1;
            const arr = st.loras.slice();
            const [moved] = arr.splice(from, 1);
            arr.splice(insertAt, 0, moved);
            st.loras = arr;
            render();
          });
        });
        leftCol.querySelectorAll("[data-lora-name]").forEach(el=>{
          el.addEventListener("click",e=>e.stopPropagation());
          el.addEventListener("change",e=>{
            e.stopPropagation();
            st.loras[+el.dataset.loraName].name=el.value;
            const btn = leftCol.querySelector(`[data-lora-civit="${el.dataset.loraName}"]`);
            if (btn) btn.disabled = !el.value;
          });
        });
        leftCol.querySelectorAll("[data-lora-sm]").forEach(el=>{
          el.addEventListener("click",e=>e.stopPropagation());
          const h=()=>{
            let v=parseFloat(el.value); if(isNaN(v))v=0;
            const lora = st.loras[+el.dataset.loraSm];
            lora.strength_model = v;
            lora.strength_clip  = v;
          };
          el.onchange=h; el.oninput=h;
        });
        leftCol.querySelectorAll("[data-lora-trigger]").forEach(el=>{
          el.addEventListener("click",e=>e.stopPropagation());
          const h=()=>{ st.loras[+el.dataset.loraTrigger].trigger_words = el.value; };
          el.onchange=h; el.oninput=h;
        });
        leftCol.querySelectorAll("[data-lora-civit]").forEach(b=>b.addEventListener("click",async e=>{
          e.stopPropagation();
          const name = (st.loras[+b.dataset.loraCivit]?.name || "").trim();
          if (!name || b.dataset.busy === "1") return;
          const prev = b.textContent;
          b.dataset.busy = "1";
          b.disabled = true;
          b.textContent = "\u2026";
          try{
            const r = await fetch("/ltx23_oasis/civitai_lora?name=" + encodeURIComponent(name));
            const data = await r.json().catch(()=>({}));
            if (!r.ok || !data.url) throw new Error(data.error || "Not found on CivitAI");
            window.open(data.url, "_blank", "noopener,noreferrer");
          }catch(err){
            showToast("CivitAI: " + (err.message || err));
          }finally{
            b.dataset.busy = "0";
            b.textContent = prev;
            b.disabled = !(st.loras[+b.dataset.loraCivit]?.name || "").trim();
          }
        }));

        // ── Seed row buttons (section-level twins of the header pair) ──
        leftCol.querySelectorAll("[data-seed-rand]").forEach(btn=>btn.addEventListener("click",async e=>{
          e.stopPropagation();
          await queueRand();
        }));
        leftCol.querySelectorAll("[data-seed-keep]").forEach(btn=>btn.addEventListener("click",async e=>{
          e.stopPropagation();
          await queueKeep();
        }));

        // ── Prompt textarea drag-handles ──
        leftCol.querySelectorAll("[data-ta-handle]").forEach(h=>{
          h.addEventListener("pointerdown",e=>{
            e.preventDefault(); e.stopPropagation();
            const field=h.dataset.taHandle;
            const ta=h.parentElement.querySelector("textarea");
            const startY=e.clientY, startH=ta.offsetHeight;
            h.setPointerCapture(e.pointerId);
            const move=ev=>{
              const nh=Math.max(40,startH+(ev.clientY-startY));
              ta.style.height=nh+"px";
              taHeights[field]=nh;
            };
            const up=ev=>{ h.releasePointerCapture(e.pointerId); h.removeEventListener("pointermove",move); h.removeEventListener("pointerup",up); };
            h.addEventListener("pointermove",move);
            h.addEventListener("pointerup",up);
          });
        });

        // ── Presets ──
        const nameInp = leftCol.querySelector("[data-preset-name]");
        if(nameInp){ nameInp.addEventListener("input",()=>{presetName=nameInp.value;}); nameInp.addEventListener("click",e=>e.stopPropagation()); }
        leftCol.querySelector("[data-preset-save]")?.addEventListener("click",e=>{e.stopPropagation();savePreset();});
        leftCol.querySelectorAll("[data-preset-toggle]").forEach(h=>h.addEventListener("click",e=>{
          if(e.target.closest("[data-preset-del]"))return;
          if(e.target.closest("[data-preset-drag]"))return;
          e.stopPropagation();const id=h.dataset.presetToggle;
          expandedPresets.has(id)?expandedPresets.delete(id):expandedPresets.add(id);
          const p = presets.find(x=>x.id===id);
          if(p) presetName = p.name;
          render();
        }));
        leftCol.querySelectorAll("[data-preset-load]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();loadPreset(b.dataset.presetLoad);}));
        leftCol.querySelectorAll("[data-preset-del]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();deletePreset(b.dataset.presetDel);}));
        leftCol.querySelectorAll("[data-preset-drag]").forEach(grip=>{
          const card = grip.closest(".io-preset-card");
          grip.addEventListener("dragstart",e=>{
            e.stopPropagation();
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", String(grip.dataset.presetDrag));
            if(e.dataTransfer.setDragImage){
              const r = card.getBoundingClientRect();
              e.dataTransfer.setDragImage(card, e.clientX - r.left, e.clientY - r.top);
            }
            setTimeout(()=>card.classList.add("io-preset-dragging"), 0);
          });
          grip.addEventListener("dragend",()=>{
            card.classList.remove("io-preset-dragging");
            leftCol.querySelectorAll(".io-preset-drop-above,.io-preset-drop-below")
              .forEach(el=>el.classList.remove("io-preset-drop-above","io-preset-drop-below"));
          });
        });
        leftCol.querySelectorAll("[data-preset-id]").forEach(card=>{
          card.addEventListener("dragover",e=>{
            if(!e.dataTransfer || !Array.from(e.dataTransfer.types||[]).includes("text/plain")) return;
            e.preventDefault(); e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            const r = card.getBoundingClientRect();
            const above = (e.clientY - r.top) < r.height/2;
            card.classList.toggle("io-preset-drop-above", above);
            card.classList.toggle("io-preset-drop-below", !above);
          });
          card.addEventListener("dragleave",e=>{
            if(e.relatedTarget && card.contains(e.relatedTarget)) return;
            card.classList.remove("io-preset-drop-above","io-preset-drop-below");
          });
          card.addEventListener("drop",async e=>{
            e.preventDefault(); e.stopPropagation();
            const r = card.getBoundingClientRect();
            const above = (e.clientY - r.top) < r.height/2;
            card.classList.remove("io-preset-drop-above","io-preset-drop-below");
            const fromId = e.dataTransfer.getData("text/plain");
            const targetId = card.dataset.presetId;
            if(!fromId || fromId === targetId) return;
            const from = presets.findIndex(p=>p.id===fromId);
            const targetIdx = presets.findIndex(p=>p.id===targetId);
            if(from < 0 || targetIdx < 0) return;
            let insertAt = above ? targetIdx : targetIdx + 1;
            if(from < insertAt) insertAt -= 1;
            const arr = presets.slice();
            const [moved] = arr.splice(from, 1);
            arr.splice(insertAt, 0, moved);
            presets = arr;
            render();
            try{
              await fetch("/ltx23_oasis/reorder_presets",{
                method:"POST",
                headers:{"Content-Type":"application/json"},
                body: JSON.stringify({ ids: presets.map(p=>p.id) }),
              });
            }catch(err){ console.warn("[LTX Oasis] reorder persist failed:", err); }
          });
        });

        // ── Theme editor bindings (VO-scoped palette) ──
        const hexOk = s => /^#[0-9a-fA-F]{6}$/.test(s);
        leftCol.querySelectorAll("[data-theme-pick]").forEach(el=>{
          el.addEventListener("click",e=>e.stopPropagation());
          el.addEventListener("input",e=>{ e.stopPropagation(); VO_THEME[el.dataset.themePick]=el.value; applyTheme(); });
          el.addEventListener("change",e=>{ e.stopPropagation(); VO_THEME[el.dataset.themePick]=el.value; refreshTheme(); });
        });
        leftCol.querySelectorAll("[data-theme-hex]").forEach(el=>{
          el.addEventListener("click",e=>e.stopPropagation());
          el.addEventListener("change",e=>{
            e.stopPropagation();
            let v=el.value.trim(); if(v && v[0]!=="#") v="#"+v;
            if(hexOk(v)){ VO_THEME[el.dataset.themeHex]=v; refreshTheme(); }
            else { el.value = VO_THEME[el.dataset.themeHex]||VO_THEME_DEFAULTS[el.dataset.themeHex]; }
          });
        });
        const themeNameInp = leftCol.querySelector("[data-theme-name]");
        if(themeNameInp){
          themeNameInp.addEventListener("input",()=>{ themeName=themeNameInp.value; });
          themeNameInp.addEventListener("click",e=>e.stopPropagation());
        }
        leftCol.querySelector("[data-theme-save]")?.addEventListener("click",async e=>{
          e.stopPropagation();
          const nm = (themeName||"").trim();
          if(!nm){ themeNameInp?.focus(); return; }
          const ok = await saveNamedTheme(nm);
          if(ok){ themeName=""; render(); }
        });
        leftCol.querySelectorAll("[data-theme-load]").forEach(row=>row.addEventListener("click",async e=>{
          if(e.target.closest("[data-theme-named-del]")) return;
          e.stopPropagation();
          const id = row.dataset.themeLoad;
          const t = VO_NAMED_THEMES.find(x=>x.id===id);
          if(t) themeName = t.name;
          await applyNamedTheme(id);
          render();
        }));
        leftCol.querySelectorAll("[data-theme-named-del]").forEach(b=>b.addEventListener("click",async e=>{
          e.stopPropagation();
          await deleteNamedTheme(b.dataset.themeNamedDel);
        }));
        leftCol.querySelector("[data-theme-reset]")?.addEventListener("click",e=>{
          e.stopPropagation(); VO_THEME={...VO_THEME_DEFAULTS}; saveTheme();
        });
      };

      // Upload a File/Blob into ComfyUI's input folder; returns the stored
      // (subfolder-qualified) name. Shared by the picker AND drag-drop.
      const uploadImageBlob = async (fileOrBlob, filename) => {
        const fname = filename || fileOrBlob.name || `dropped_${Date.now()}.png`;
        const body = new FormData();
        body.append("image", fileOrBlob, fname);
        body.append("overwrite","true");
        const r = await (await fetch("/upload/image",{method:"POST",body})).json();
        if(!r || !r.name) throw new Error("upload returned no name");
        return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
      };
      const uploadRef = (field) => {
        const inp = document.createElement("input");
        inp.type="file"; inp.accept="image/*";
        inp.onchange = async () => {
          const file = inp.files?.[0]; if(!file) return;
          try{ st[field] = await uploadImageBlob(file, file.name); if(field==="start_image"&&st.mode!=="i2v"){st.mode="i2v";save();} render(); }
          catch(e){ console.warn("[LTX Oasis] upload failed",e); }
        };
        inp.click();
      };
      const uploadBeatGuide = (i) => {
        const inp = document.createElement("input");
        inp.type="file"; inp.accept="image/*";
        inp.onchange = async () => {
          const file = inp.files?.[0]; if(!file) return;
          try{
            const name = await uploadImageBlob(file, file.name);
            if (!st.relay_segments[i]) return;
            st.relay_segments[i].guide_image = name;
            if (st.relay_segments[i].guide_strength == null)
              st.relay_segments[i].guide_strength = 1.0;
            save(); render();
          }catch(e){ console.warn("[LTX Oasis] beat guide upload failed",e); }
        };
        inp.click();
      };
      // File → Oasis frame payload → uri-list → plain → html src scrape.
      // Works for ComfyUI /view URLs and this node's own preview-frame drag.
      const resolveDropImage = async (dt) => {
        if(!dt) return null;
        const f = dt.files && dt.files[0];
        if(f && f.type.startsWith("image/")){
          return await uploadImageBlob(f, f.name);
        }
        let url = "";
        try { url = (dt.getData("application/x-oasis-frame") || "").trim(); } catch { /* */ }
        if(!url) url = (dt.getData("text/uri-list")||"").split(/\r?\n/).find(s=>s && !s.startsWith("#")) || "";
        if(!url) url = (dt.getData("text/plain")||"").trim();
        if(!url){
          const html = dt.getData("text/html")||"";
          const m = html.match(/(?:src|href)\s*=\s*["']([^"']+)["']/i);
          if(m) url = m[1];
        }
        if(!url) return null;
        // Filename-only leftovers from a broken drag payload — not a real source.
        if(!/^(data:|blob:|https?:|\/)/i.test(url)) return null;
        const abs = url.startsWith("data:") || url.startsWith("blob:")
          ? url
          : new URL(url, window.location.href).href;
        const resp = await fetch(abs);
        if(!resp.ok) throw new Error("HTTP "+resp.status);
        const blob = await resp.blob();
        if(!blob.type.startsWith("image/") && !url.startsWith("data:image/"))
          throw new Error("not an image: "+blob.type);
        let nm = "";
        try{ nm = new URL(abs).searchParams.get("filename")||""; }catch{}
        if(!nm && !abs.startsWith("data:") && !abs.startsWith("blob:"))
          nm = abs.split(/[?#]/)[0].split("/").pop()||"";
        return await uploadImageBlob(blob, nm || `frame_${Date.now()}.png`);
      };
      const acceptDrop = async (field, dt) => {
        try{
          const name = await resolveDropImage(dt);
          if(!name) return;
          st[field] = name;
          if(field==="start_image"&&st.mode!=="i2v"){st.mode="i2v";save();}
          render();
        }catch(e){ console.warn("[LTX Oasis] drop failed",e); }
      };
      const acceptBeatGuide = async (i, dt) => {
        try{
          const name = await resolveDropImage(dt);
          if(!name || !st.relay_segments[i]) return;
          st.relay_segments[i].guide_image = name;
          if (st.relay_segments[i].guide_strength == null)
            st.relay_segments[i].guide_strength = 1.0;
          save(); render();
        }catch(e){ console.warn("[LTX Oasis] beat guide drop failed",e); }
      };

      // ── Presets: session work is never captured or clobbered (IO rules) ──
      const PRESET_EXCLUDE = ["user_prompt", "positive", "negative", "seed",
                              "start_image", "audio_file", "continue_last",
                              "width", "height", "aspect_lock"];
      const presetConfig = (state) => {
        const out = {...state};
        for (const k of PRESET_EXCLUDE) delete out[k];
        // Guide images are session media (like start_image); keep beat text/lengths.
        if (Array.isArray(out.relay_segments)) {
          out.relay_segments = out.relay_segments.map(s => ({
            text: s.text || "",
            frames: s.frames || 0,
            guide_strength: s.guide_strength ?? 1.0,
          }));
        }
        return out;
      };
      const loadPresets = async () => {
        try{ presets = await (await fetch("/ltx23_oasis/presets")).json(); }catch(e){ console.warn("[LTX Oasis]",e); presets=[]; }
      };
      const savePreset = async () => {
        const name = (presetName||"").trim();
        if(!name) return;
        try{
          const r = await (await fetch("/ltx23_oasis/save_preset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name, config:presetConfig(st)})})).json();
          if(r.ok){ presetName=""; await loadPresets(); render(); }
        }catch(e){ console.warn("[LTX Oasis]",e); }
      };
      const loadPreset = (id) => {
        const p = presets.find(x=>x.id===id);
        if(!p||!p.config) return;
        st = {...st, ...presetConfig(p.config)};
        presetName = p.name;
        render();
      };
      const deletePreset = async (id) => {
        try{ await fetch(`/ltx23_oasis/presets/${id}`,{method:"DELETE"}); }catch(e){ console.warn("[LTX Oasis]",e); }
        expandedPresets.delete(id); await loadPresets(); render();
      };

      // ── Prompt enhancer — SHARED with Image Oasis (same endpoints, same
      //    models, one implementation suite-wide). ──
      const loadLlmModels = async () => {
        try{
          const r = await (await fetch("/image_oasis/llm_models")).json();
          llmModels = Array.isArray(r.models) ? r.models : [];
          if(!llmModel && llmModels.length) llmModel = llmModels[0];
        }catch(e){ llmModels=[]; }
      };
      const fetchRecommendedLayers = async () => {
        if (!llmModel) { llmRecommended = null; render(); return; }
        if (llmModel.toLowerCase().endsWith(".safetensors")) {
          llmRecommended = null; render(); return;
        }
        llmRecommendedBusy = true; render();
        try{
          const r = await fetch("/image_oasis/llm_recommended_layers?model=" + encodeURIComponent(llmModel));
          const data = await r.json();
          if (!r.ok || data.error) llmRecommended = null;
          else {
            llmRecommended = data;
            if (llmAutoLayers) llmGpuLayers = data.layers;
          }
        } catch(e) {
          llmRecommended = null;
        } finally {
          llmRecommendedBusy = false; render();
        }
      };
      const runEnhance = async () => {
        if(wandBusy) return;
        if(timerRunning){ alert("Enhance is unavailable while a video is generating."); return; }
        const cur = (st.user_prompt||"").trim();
        if(!cur){ console.warn("[LTX Oasis] nothing to enhance \u2014 User Prompt is empty"); return; }
        if(!llmModel){ alert("Select an enhancer model (place .gguf files in models/LLM)."); return; }
        const layersToSend = llmAutoLayers
          ? (llmRecommended ? llmRecommended.layers : -1)
          : llmGpuLayers;
        wandBusy = true; render();
        try{
          const r = await fetch("/ltx23_oasis/enhance",{
            method:"POST", headers:{"Content-Type":"application/json"},
            body:JSON.stringify({
              prompt: cur,
              style: st.mode === "i2v" ? "i2v" : "t2v",
              model: llmModel,
              auto_layers: llmAutoLayers,
              n_gpu_layers: layersToSend,
              n_ctx: llmContext,
              max_tokens: llmMaxTokens,
            }),
          });
          const data = await r.json();
          if(!r.ok || data.error){
            alert("Enhance failed: " + (data.error || ("HTTP "+r.status)));
          } else if(data.enhanced){
            st.positive = data.enhanced;
            if(typeof data.gpu_layers === "number"){
              const total = llmRecommended?.total || 0;
              llmRecommended = { total, layers: data.gpu_layers, all: data.gpu_layers === -1 };
              if(llmAutoLayers) llmGpuLayers = data.gpu_layers;
            }
          }
        }catch(e){
          alert("Enhance failed: " + e.message);
        }finally{
          wandBusy = false; render();
        }
      };

      // ── Model lists + registry-served arch structures ──
      const applyArchs = (m) => {
        const list = m && Array.isArray(m.archs) ? m.archs : null;
        if(list && list.length) VOG_ARCHS = list;
      };
      const loadModels = async () => {
        try{
          allModels = await (await fetch("/ltx23_oasis/models")).json();
          applyArchs(allModels);
          if(!Array.isArray(allModels.latent_upsamplers)) allModels.latent_upsamplers = [];
          if(typeof allModels.rtx_vsr !== "boolean") allModels.rtx_vsr = false;
        }catch(e){ console.warn("[LTX Oasis]",e); }
        try{
          const oi = await (await fetch("/object_info/KSampler")).json();
          const inp = oi?.KSampler?.input?.required;
          if(inp?.sampler_name?.[0]) samplers = inp.sampler_name[0];
        }catch{}
        render();
      };

      // ── io_id lifecycle (IO's registration/drain pattern, VO's maps) ──
      let registeredIoId = null;
      const ensureIoId = () => {
        if (!ioId) ioId = (crypto?.randomUUID?.() ?? ("vog-" + Date.now() + "-" + newRand()));
        return ioId;
      };
      const registerIoHandler = () => {
        ensureIoId();
        const existing = VOG_HANDLERS.get(ioId);
        if (existing && existing !== addResults) {
          ioId = "";
          ensureIoId();
        }
        if (registeredIoId && registeredIoId !== ioId) VOG_HANDLERS.delete(registeredIoId);
        VOG_HANDLERS.set(ioId, addResults);
        registeredIoId = ioId;
        if (VOG_PENDING.has(ioId)) {
          const pending = VOG_PENDING.get(ioId);
          VOG_PENDING.delete(ioId);
          addResults(pending);
        }
      };

      /* ── Widget mount + persistence ──
         The Python side declares "ltx23_oasis_ui" as an optional STRING
         input; the frontend auto-creates a text widget for it. Remove that
         and mount the DOM widget UNDER THE SAME NAME so its getValue is what
         serializes into the prompt (the backend reads execState + io_id from
         it) and into workflow JSON. NO computeSize / onResize overrides —
         the DOM widget fills whatever size the node is (IO's rule; the
         override was the runaway-Y bug). ── */
      const auto = this.widgets?.findIndex((w) => w.name === "ltx23_oasis_ui");
      if (auto >= 0) this.widgets.splice(auto, 1);

      this.addDOMWidget("ltx23_oasis_ui", "div", container, {
        hideOnZoom: false,
        getValue: () => {
          // Persist the full scene bar (temps included) so a ComfyUI tab
          // switch — which tears down and rebuilds this widget — does not
          // blank the video you just generated. After a server restart the
          // temp dir is wiped and pruneDead removes the dead refs on restore
          // (same policy as Video Oasis Viewer).
          return JSON.stringify({
            version: 2,
            io_id: ensureIoId(),
            execState: st,
            uiState: { open, taHeights, playMode, muted, speed, movieAudio },
            preview: {
              history: history.map(({ thumbEl, rand, warned, proxy, _proxyP, proxyFailed, proxyTried, proxyError, ...keep }) => keep),
              activeIdx,
            },
            wand: {
              model: llmModel, style: st.mode === "i2v" ? "i2v" : "t2v",
              settings_open: llmSettingsOpen,
              auto_layers: llmAutoLayers,
              gpu_layers: llmGpuLayers,
              n_ctx: llmContext,
              max_tokens: llmMaxTokens,
            },
            timer: { elapsed: timerElapsedMs, running: timerRunning, start: timerStart },
          });
        },
        setValue: (v) => { try {
          const o = JSON.parse(v);
          if (!o || typeof o !== "object") return;
          if (typeof o.io_id === "string" && o.io_id) ioId = o.io_id;
          const ex = o.execState || o.exec;
          if (ex && typeof ex === "object") {
            st = { ...st, ...ex };
            delete st.relay_enabled;
          }
          const ui = o.uiState || {};
          if (ui.open) open = { ...open, ...ui.open };
          if (ui.taHeights) taHeights = { ...taHeights, ...ui.taHeights };
          let _restorePlayMode = null;
          if (typeof ui.playMode === "string" && PLAY_MODE_ORDER.includes(ui.playMode)) {
            _restorePlayMode = ui.playMode;
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
            loadEntry(idx, { autoplay: false });   // passive restore, no surprise audio
            sweepLatents();
          }
          // Apply the restored playMode AFTER history is loaded, so cycle
          // mode snapshots the restored entries into cycleQueue. If saved
          // history is empty and playMode was cycle, the queue stays empty
          // until the next generation lands; that's fine.
          if (_restorePlayMode) setPlayMode(_restorePlayMode);
          if (o.wand) {
            if (o.wand.model) llmModel = o.wand.model;
            if ("settings_open" in o.wand) llmSettingsOpen = !!o.wand.settings_open;
            if ("auto_layers" in o.wand) llmAutoLayers = !!o.wand.auto_layers;
            if (typeof o.wand.gpu_layers === "number") llmGpuLayers = o.wand.gpu_layers;
            if (typeof o.wand.n_ctx === "number" && o.wand.n_ctx >= 512) llmContext = o.wand.n_ctx;
            if (typeof o.wand.max_tokens === "number" && o.wand.max_tokens >= 64) llmMaxTokens = o.wand.max_tokens;
          }
          if (o.timer && !timerRunning) {
            if (o.timer.running && typeof o.timer.start === "number") {
              resumeTimerIfLive(o.timer.start, o.timer.elapsed);
            } else if (typeof o.timer.elapsed === "number") {
              timerElapsedMs = Math.max(0, o.timer.elapsed);
              paintTimer(timerElapsedMs, false);
            }
          }
          render();
          // Re-key + drain AFTER the history restore so drained results
          // append after the restored strip (IO's ordering rule).
          registerIoHandler();
          if (history.length) pruneDead();
        } catch (err) { console.warn("[LTX Oasis] state restore failed:", err); } },
      });

      // Control-after-generate: apply the seed action after each queued
      // prompt so the NEXT run uses the updated seed (ComfyUI semantics).
      const _seedHook = () => {
        const a = st.seed_control;
        if(a==="fixed") return;
        let s = Number(st.seed)||0;
        if(a==="randomize") s = Math.floor(Math.random()*MAX_SEED);
        else if(a==="increment") s = s>=MAX_SEED ? 0 : s+1;
        else if(a==="decrement") s = s<=0 ? MAX_SEED : s-1;
        st.seed = s;
        render();
      };
      api.addEventListener("promptQueued", _seedHook);

      // ── Execution-timer listeners (global queue events, IO verbatim) ──
      const _timerStartEvt = () => startTimer();
      const _timerExecutingEvt = (e) => { if(e?.detail===null) stopTimer(); };
      const _timerEndEvt = () => stopTimer();
      api.addEventListener("execution_start", _timerStartEvt);
      api.addEventListener("executing", _timerExecutingEvt);
      api.addEventListener("execution_error", _timerEndEvt);
      api.addEventListener("execution_interrupted", _timerEndEvt);

      // ── Suppress in-node live preview rendering (IO item 11) ──
      const _suppressLivePreview = () => {
        if (app.nodePreviewImages) delete app.nodePreviewImages[selfNode.id];
        if (selfNode.imgs && selfNode.imgs.length) selfNode.imgs = [];
        app.graph?.setDirtyCanvas(true, false);
      };
      api.addEventListener("b_preview", _suppressLivePreview);
      api.addEventListener("progress", _suppressLivePreview);

      // Repaint theme swatches when any LTX Oasis node edits the palette.
      const _themeRedraw = () => { if(open.theme) render(); };
      VO_THEME_LISTENERS.add(_themeRedraw);
      const _helpReady = () => { if(open.help) render(); };
      IO_HELP_LISTENERS.add(_helpReady);
      loadHelpOnce();

      selfNode.onDrawBackground = function(){};

      // Registry scanner false-positive hygiene (Image Oasis v1.4.1).
      const _origAdded = selfNode.onAdded;
      selfNode.onAdded = function(){
        if(_origAdded) _origAdded.apply(this, arguments);
        registerIoHandler();
        Promise.all([loadModels(), loadPresets(), loadLlmModels(), loadTheme(), loadNamedThemes()]).then(()=>render());
        loadNvencCodecs().then(c=>{ nvencCodecs = c; render(); });
      };
      const _origRemoved = selfNode.onRemoved;
      selfNode.onRemoved = function(){
        if (registeredIoId) { VOG_HANDLERS.delete(registeredIoId); registeredIoId = null; }
        api.removeEventListener("promptQueued", _seedHook);
        api.removeEventListener("execution_start", _timerStartEvt);
        api.removeEventListener("executing", _timerExecutingEvt);
        api.removeEventListener("execution_error", _timerEndEvt);
        api.removeEventListener("execution_interrupted", _timerEndEvt);
        api.removeEventListener("b_preview", _suppressLivePreview);
        api.removeEventListener("progress", _suppressLivePreview);
        VO_THEME_LISTENERS.delete(_themeRedraw);
        IO_HELP_LISTENERS.delete(_helpReady);
        if(timerInterval){ clearInterval(timerInterval); timerInterval=null; }
        clearTimeout(_badgeT);
        clearTimeout(_toastT);
        // If a reorder was in flight when the node was removed, cleanupDrag
        // tears down the document-level pointermove/up listeners.
        cleanupDrag();
        cancelPendingTailSync();
        if(_origRemoved) _origRemoved.apply(this, arguments);
      };

      /* ── first paint ── */
      render();
      syncPlayerPrefs();
      renderInfo();
      updateSaveBtn();
    };
  },
});
