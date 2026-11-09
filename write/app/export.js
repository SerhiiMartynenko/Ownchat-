// Export and import: zip bundle, manuscript, share sheet / download. The zip library is
// loaded on demand; pass `lib` to inject one (tests and e2e use a shim).
import { buildBundle, parseBundle, buildManuscript, slugify } from "./bundle.js";

export { slugify };

export const FFLATE_URL = "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

const zipCache = new Map();

export function loadZip(url){
  var u = url || FFLATE_URL;
  if(zipCache.has(u)) return zipCache.get(u);
  var p = import(u).then(function(mod){
    var lib = mod && (mod.zipSync ? mod : mod.default);
    if(!lib || typeof lib.zipSync !== "function" || typeof lib.unzipSync !== "function") throw new Error("bad module");
    return lib;
  }).catch(function(){
    zipCache.delete(u);
    throw new Error("Could not load the zip library. Check your connection.");
  });
  zipCache.set(u, p);
  return p;
}

export function zipBundle(data, lib, now){
  var built = buildBundle(data, { now: now });
  var entries = {};
  Object.keys(built.files).forEach(function(path){ entries[path] = lib.strToU8(built.files[path]); });
  return lib.zipSync(entries, { level: 6 });
}

function tooBig(){ return new Error("This file is too large to import (over 50 MB)."); }

export function unzipBundle(bytes, lib, opts){
  if(!bytes || bytes.length > MAX_BUNDLE_BYTES) throw tooBig();
  var entries;
  try { entries = lib.unzipSync(bytes); }
  catch(e){ throw new Error("Not an Ownchat project bundle"); }
  var files = {};
  Object.keys(entries).forEach(function(path){
    if(path.endsWith("/")) return;
    files[path] = lib.strFromU8(entries[path]);
  });
  return parseBundle(files, opts);
}

export function dateStamp(d){
  var x = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
  return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
}

export function projectSlug(project){ return slugify(project && project.title, "project"); }
export function bundleFilename(project){ return projectSlug(project) + ".ownchat.zip"; }
export function manuscriptFilename(project, date){ return projectSlug(project) + "-" + dateStamp(date) + ".md"; }

function anchorDownload(blob, filename, deps){
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1500);
  if(deps && typeof deps.toast === "function") deps.toast("Exported " + filename);
}

// iOS share sheet (Save to Files) first, anchor download as fallback.
// Resolves "shared" | "cancelled" | "downloaded".
export function shareOrDownload(blob, filename, deps){
  return new Promise(function(resolve){
    try{
      var file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
      if(navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share){
        // Share ONLY the file. Passing title/text makes some targets save a second .txt of that text.
        navigator.share({ files: [file] }).then(function(){ resolve("shared"); }, function(err){
          if(err && err.name === "AbortError"){ resolve("cancelled"); return; }
          anchorDownload(blob, filename, deps); resolve("downloaded");
        });
        return;
      }
    }catch(e){ /* File ctor or share unsupported -> fallback */ }
    anchorDownload(blob, filename, deps);
    resolve("downloaded");
  });
}

function getLib(deps){
  if(deps && deps.lib) return Promise.resolve(deps.lib);
  return ((deps && deps.loadZip) || loadZip)();
}

// data: {project, chapters, scenes, bible, thread}; deps: {lib?, loadZip?, toast, now?}
export async function exportBundle(data, deps){
  var lib = await getLib(deps);
  var bytes = zipBundle(data, lib, deps && deps.now);
  var blob = new Blob([bytes], { type: "application/zip" });
  return shareOrDownload(blob, bundleFilename(data && data.project), deps);
}

export async function exportManuscript(data, deps){
  var d = data || {};
  var text = buildManuscript(d.project, d.chapters, d.scenes);
  var now = deps && deps.now;
  var when = typeof now === "function" ? now() : (now == null ? Date.now() : now);
  var blob = new Blob([text], { type: "text/markdown" });
  return shareOrDownload(blob, manuscriptFilename(d.project, when), deps);
}

// file: File or Blob from <input type=file>; deps: {lib?, loadZip?, uid?, now?}
export async function readBundleFile(file, deps){
  if(!file) throw new Error("No file selected");
  if(file.size > MAX_BUNDLE_BYTES) throw tooBig();
  var lib = await getLib(deps);
  var bytes = new Uint8Array(await file.arrayBuffer());
  return unzipBundle(bytes, lib, deps ? { uid: deps.uid, now: deps.now } : undefined);
}
