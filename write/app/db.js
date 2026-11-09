// IndexedDB storage for the writing app (browser only).
// Falls back to an in-memory map when IndexedDB is missing or fails to open.

var DB_NAME = "ownchat-write";
var DB_VERSION = 1;
var STORES = ["bible", "threads"];

function clone(v){
  if(v === undefined) return undefined;
  try{ return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
  catch(e){ return JSON.parse(JSON.stringify(v)); }
}

function memoryHandle(){
  var maps = {};
  STORES.forEach(function(s){ maps[s] = new Map(); });
  function map(store){ if(!maps[store]) maps[store] = new Map(); return maps[store]; }
  return {
    memory: true,
    get: function(store, id){ return Promise.resolve(clone(map(store).get(id))); },
    put: function(store, value){ map(store).set(value.id, clone(value)); return Promise.resolve(value.id); },
    del: function(store, id){ map(store).delete(id); return Promise.resolve(); }
  };
}

function req(r){
  return new Promise(function(resolve, reject){
    r.onsuccess = function(){ resolve(r.result); };
    r.onerror = function(){ reject(r.error); };
  });
}

function idbHandle(db){
  function run(store, mode, fn){
    return new Promise(function(resolve, reject){
      var tx, out;
      try{ tx = db.transaction(store, mode); }catch(e){ reject(e); return; }
      req(fn(tx.objectStore(store))).then(function(v){ out = v; }, reject);
      tx.oncomplete = function(){ resolve(out); };
      tx.onerror = function(){ reject(tx.error); };
      tx.onabort = function(){ reject(tx.error || new Error("Transaction aborted")); };
    });
  }
  return {
    memory: false,
    get: function(store, id){ return run(store, "readonly", function(s){ return s.get(id); }); },
    put: function(store, value){ return run(store, "readwrite", function(s){ return s.put(value); }); },
    del: function(store, id){ return run(store, "readwrite", function(s){ return s.delete(id); }); }
  };
}

export function openDb(){
  return new Promise(function(resolve){
    var idb;
    try{ idb = globalThis.indexedDB; }catch(e){ idb = null; }
    if(!idb){ resolve(memoryHandle()); return; }
    var done = false;
    function finish(h){ if(!done){ done = true; resolve(h); } }
    try{
      var r = idb.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = function(){
        var db = r.result;
        STORES.forEach(function(s){
          if(!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
        });
      };
      r.onsuccess = function(){ finish(idbHandle(r.result)); };
      r.onerror = function(){ finish(memoryHandle()); };
    }catch(e){ finish(memoryHandle()); }
  });
}

export function requestPersistence(){
  try{
    if(navigator.storage && typeof navigator.storage.persist === "function"){
      return navigator.storage.persist().then(function(v){ return !!v; }, function(){ return false; });
    }
  }catch(e){}
  return Promise.resolve(false);
}
