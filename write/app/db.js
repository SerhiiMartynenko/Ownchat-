// IndexedDB storage for the writing app.
// Falls back to an in-memory map when IndexedDB is missing or fails to open.
// The handle API is the same for both: get, put, del, getAll, getAllBy, batch.

var DB_NAME = "ownchat-write";
var DB_VERSION = 2;

// Declared once: store name → index names (each index keyPath equals its name).
var SCHEMA = {
  bible: [],
  threads: ["projectId"],
  projects: [],
  chapters: ["projectId"],
  scenes: ["projectId", "chapterId"],
  versions: ["sceneId"],
  meta: []
};
var STORES = Object.keys(SCHEMA);

function clone(v){
  if(v === undefined) return undefined;
  try{ return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
  catch(e){ return JSON.parse(JSON.stringify(v)); }
}

export function memoryHandle(){
  var maps = {};
  STORES.forEach(function(s){ maps[s] = new Map(); });
  function map(store){ if(!maps[store]) maps[store] = new Map(); return maps[store]; }
  function apply(op){
    if(op.type === "put") map(op.store).set(op.value.id, clone(op.value));
    else if(op.type === "del") map(op.store).delete(op.id);
    else throw new Error("Unknown batch op: " + op.type);
  }
  return {
    memory: true,
    get: function(store, id){ return Promise.resolve(clone(map(store).get(id))); },
    put: function(store, value){ map(store).set(value.id, clone(value)); return Promise.resolve(value.id); },
    del: function(store, id){ map(store).delete(id); return Promise.resolve(); },
    getAll: function(store){ return Promise.resolve(Array.from(map(store).values()).map(clone)); },
    getAllBy: function(store, index, value){
      return Promise.resolve(Array.from(map(store).values())
        .filter(function(rec){ return rec && rec[index] === value; }).map(clone));
    },
    batch: function(ops){
      try{ (ops || []).forEach(apply); }catch(e){ return Promise.reject(e); }
      return Promise.resolve();
    }
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
    del: function(store, id){ return run(store, "readwrite", function(s){ return s.delete(id); }); },
    getAll: function(store){ return run(store, "readonly", function(s){ return s.getAll(); }); },
    getAllBy: function(store, index, value){
      return run(store, "readonly", function(s){ return s.index(index).getAll(value); });
    },
    batch: function(ops){
      ops = ops || [];
      if(!ops.length) return Promise.resolve();
      return new Promise(function(resolve, reject){
        var names = [], tx;
        ops.forEach(function(op){ if(names.indexOf(op.store) < 0) names.push(op.store); });
        try{
          tx = db.transaction(names, "readwrite");
          ops.forEach(function(op){
            var s = tx.objectStore(op.store);
            if(op.type === "put") s.put(op.value);
            else if(op.type === "del") s.delete(op.id);
            else throw new Error("Unknown batch op: " + op.type);
          });
        }catch(e){
          try{ if(tx) tx.abort(); }catch(e2){}
          reject(e); return;
        }
        tx.oncomplete = function(){ resolve(); };
        tx.onerror = function(){ reject(tx.error); };
        tx.onabort = function(){ reject(tx.error || new Error("Transaction aborted")); };
      });
    }
  };
}

function upgrade(r){
  var db = r.result, tx = r.transaction;
  STORES.forEach(function(name){
    var os = db.objectStoreNames.contains(name) ? tx.objectStore(name)
      : db.createObjectStore(name, { keyPath: "id" });
    SCHEMA[name].forEach(function(ix){
      if(!os.indexNames.contains(ix)) os.createIndex(ix, ix, { unique: false });
    });
  });
}

// opts.onBlocked(): another tab holds an older version open; we keep waiting.
// opts.onVersionChange(): a newer version was requested elsewhere; the connection is closed first.
export function openDb(opts){
  opts = opts || {};
  return new Promise(function(resolve){
    var idb;
    try{ idb = globalThis.indexedDB; }catch(e){ idb = null; }
    if(!idb){ resolve(memoryHandle()); return; }
    var done = false;
    function finish(h){ if(!done){ done = true; resolve(h); } }
    try{
      var r = idb.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = function(){ upgrade(r); };
      r.onblocked = function(){ try{ if(opts.onBlocked) opts.onBlocked(); }catch(e){} };
      r.onsuccess = function(){
        var db = r.result;
        db.onversionchange = function(){
          db.close();
          if(opts.onVersionChange) opts.onVersionChange();
        };
        finish(idbHandle(db));
      };
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
