// Storage protection UI: Settings status line and the library notice (protect storage / export a backup).
import { NOTICE_DEFAULTS, readStorageStatus, storageStatusText, pickNotice } from "../storage.js";

// deps: {$, store, toast, requestPersistence() -> Promise<boolean>, readStatus?() -> Promise<status>,
//        exportProject(pid, "bundle") -> Promise, now?() -> ms, env: {ios, standalone}, opts?}
export function initStorageUI(deps){
  var $ = deps.$, store = deps.store;
  var env = deps.env || {};
  var opts = Object.assign({}, NOTICE_DEFAULTS, deps.opts || {});
  var now = deps.now || function(){ return Date.now(); };
  var readStatus = deps.readStatus || function(){ return readStorageStatus(navigator); };
  var statusEl = $("storageStatus"), protectBtn = $("storageProtect"), hintEl = $("storageInstallHint");
  var noticeEl = $("libraryNotice"), textEl = $("libraryNoticeText");
  var actBtn = $("libraryNoticeAct"), laterBtn = $("libraryNoticeLater");
  var projects = null;       // last list given to refreshNotice
  var current = null;        // the notice on show
  var cache = null, cacheAt = 0;

  function toast(m){ if(deps.toast) deps.toast(m); }
  function iosHint(){ return !!(env.ios && !env.standalone); }
  function visible(){ return !!noticeEl && !noticeEl.hidden; }

  async function status(fresh){
    var t = now();
    if(!fresh && cache && t - cacheAt < 30000) return cache;
    var st;
    try{ st = await readStatus(); }catch(e){ st = null; }
    cache = st || { supported: false, persisted: null, usage: null, quota: null };
    cacheAt = t;
    return cache;
  }

  async function refreshSettings(){
    var st = await status(true);
    if(statusEl) statusEl.textContent = storageStatusText(st);
    if(protectBtn) protectBtn.hidden = st.persisted !== false;
    if(hintEl) hintEl.hidden = !iosHint();
    return st;
  }

  async function refreshNotice(list){
    if(Array.isArray(list)) projects = list;
    if(!projects) return null;
    var st = await status(false);
    var meta = {};
    try{ meta = (await store.getMeta()) || {}; }catch(e){}
    var n = pickNotice({
      persisted: st.persisted,
      projects: projects,
      exports: meta.exports || {},
      dismissed: meta.notices || {},
      now: now(),
      standalone: !!env.standalone
    }, opts);
    current = n;
    if(noticeEl){
      if(n){
        if(textEl) textEl.textContent = n.text;
        if(actBtn) actBtn.textContent = n.action;
        noticeEl.hidden = false;
      }else{
        noticeEl.hidden = true;
      }
    }
    return n;
  }

  async function protect(){
    var ok = false;
    try{ ok = !!(await deps.requestPersistence()); }catch(e){ ok = false; }
    if(ok) toast("Storage protected");
    else{
      toast("The browser did not grant protection");
      if(iosHint() && hintEl) hintEl.hidden = false;
    }
    cache = null;
    await refreshSettings();
    if(!ok && iosHint() && hintEl) hintEl.hidden = false;
    if(projects) await refreshNotice();
    return ok;
  }

  async function noteExported(pid){
    if(!pid) return;
    var meta = {};
    try{ meta = (await store.getMeta()) || {}; }catch(e){}
    var patch = {};
    patch[pid] = now();
    await store.setMeta({ exports: Object.assign({}, meta.exports, patch) });
    if(visible() || projects) await refreshNotice();
  }

  if(actBtn) actBtn.addEventListener("click", async function(){
    var n = current;
    if(!n) return;
    try{
      if(n.kind === "storage") await protect();
      else if(n.kind === "backup") await deps.exportProject(n.projectId, "bundle");
    }catch(e){}
    await refreshNotice();
  });

  if(laterBtn) laterBtn.addEventListener("click", async function(){
    var n = current;
    if(!n) return;
    var meta = {};
    try{ meta = (await store.getMeta()) || {}; }catch(e){}
    var patch = {};
    patch[n.kind === "storage" ? "storageAt" : "backupAt"] = now();
    await store.setMeta({ notices: Object.assign({}, meta.notices, patch) });
    if(noticeEl) noticeEl.hidden = true;
    await refreshNotice();
  });

  return { refreshSettings: refreshSettings, refreshNotice: refreshNotice, noteExported: noteExported, protect: protect };
}
