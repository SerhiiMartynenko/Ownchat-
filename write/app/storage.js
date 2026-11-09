// Storage protection status and the library notices (protect storage / export a backup). Pure, no DOM.
var DAY = 864e5;

export const NOTICE_DEFAULTS = { backupAfterMs: 7 * DAY, storageSnoozeMs: 30 * DAY, backupSnoozeMs: 7 * DAY, minWords: 500 };

function num(v){ return typeof v === "number" && isFinite(v) ? v : 0; }

export function formatBytes(n){
  if(typeof n !== "number" || !isFinite(n) || n <= 0) return "0 B";
  if(n < 1000) return Math.round(n) + " B";
  var units = ["kB", "MB", "GB", "TB"], v = n, i = -1;
  do{ v /= 1000; i++; }while(v >= 1000 && i < units.length - 1);
  return (Math.round(v * 10) / 10).toFixed(1) + " " + units[i];
}

export async function readStorageStatus(nav){
  var st = { supported: false, persisted: null, usage: null, quota: null };
  var s = nav && nav.storage;
  if(!s) return st;
  try{
    if(typeof s.persisted === "function"){
      st.supported = true;
      try{ var p = await s.persisted(); st.persisted = p === true ? true : p === false ? false : null; }catch(e){}
    }
    if(typeof s.estimate === "function"){
      st.supported = true;
      try{
        var est = await s.estimate();
        if(est){
          if(typeof est.usage === "number" && isFinite(est.usage)) st.usage = est.usage;
          if(typeof est.quota === "number" && isFinite(est.quota)) st.quota = est.quota;
        }
      }catch(e){}
    }
  }catch(e){}
  return st;
}

export function storageStatusText(st){
  if(!st || !st.supported) return "Storage status unavailable";
  var head = st.persisted === true ? "Protected" : "Not protected";
  if(st.usage == null || st.quota == null) return head;
  return head + " · " + formatBytes(st.usage) + " used of " + formatBytes(st.quota);
}

export function isIOS(ua, platform, maxTouchPoints){
  if(/iPhone|iPad|iPod/.test(String(ua || ""))) return true;
  return platform === "MacIntel" && num(maxTouchPoints) > 1;
}

export function isStandalone(nav, matchMediaFn){
  try{ if(nav && nav.standalone === true) return true; }catch(e){}
  try{ if(typeof matchMediaFn === "function"){ var m = matchMediaFn("(display-mode: standalone)"); return !!(m && m.matches); } }catch(e){}
  return false;
}

export function pickNotice(input, opts){
  try{
    var o = Object.assign({}, NOTICE_DEFAULTS, opts || {});
    input = input || {};
    var now = num(input.now);
    var projects = Array.isArray(input.projects) ? input.projects : [];
    var exps = input.exports || {};
    var dis = input.dismissed || {};
    if(!projects.length) return null;

    var storageSnoozed = !!dis.storageAt && now - dis.storageAt < o.storageSnoozeMs;
    if(input.persisted === false && !input.standalone && !storageSnoozed){
      return {
        kind: "storage",
        text: "Your writing is stored only in this browser. Protect it so the browser does not clear it when space runs low.",
        action: "Protect storage"
      };
    }

    if(!!dis.backupAt && now - dis.backupAt < o.backupSnoozeMs) return null;
    var best = null, bestSpan = -1;
    projects.forEach(function(p){
      if(!p || !p.id) return;
      var words = num(p.stats && p.stats.words);
      if(words < o.minWords) return;
      var exp = num(exps[p.id]);
      var span;
      if(!exp){
        span = now - num(p.createdAt);
      }else{
        if(!(num(p.updatedAt) > exp)) return;
        span = now - exp;
      }
      if(span < o.backupAfterMs) return;
      if(span > bestSpan){ best = p; bestSpan = span; }
    });
    if(!best) return null;
    var title = best.title ? String(best.title) : "Untitled project";
    var days = Math.floor(bestSpan / DAY);
    var never = !num(exps[best.id]);
    return {
      kind: "backup",
      projectId: best.id,
      days: days,
      text: never
        ? "“" + title + "” has never been exported. Export a backup to keep a copy outside this browser."
        : "“" + title + "” has changes that were not exported for " + days + " days. Export a backup.",
      action: "Export backup"
    };
  }catch(e){
    return null;
  }
}
