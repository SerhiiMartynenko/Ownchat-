// Hash routes for the writing app. Pure, no DOM.
//   #/library           library
//   #/p/<id>            project outline
//   #/s/<id>            scene editor
//   #/p/<id>/chat       project chat
//   #/s/<id>/chat       scene chat
// Anything else parses as the library.

function dec(s){
  try{ return decodeURIComponent(s); }catch(e){ return null; }
}

export function parseRoute(hash){
  var h = String(hash == null ? "" : hash).replace(/^#/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  var parts = h ? h.split("/") : [];
  if(parts.length === 2 && parts[0] === "p"){
    var pid = dec(parts[1]);
    if(pid) return { name: "outline", projectId: pid };
  } else if(parts.length === 3 && parts[0] === "p" && parts[2] === "chat"){
    var cid = dec(parts[1]);
    if(cid) return { name: "chat", projectId: cid };
  } else if(parts.length === 2 && parts[0] === "s"){
    var sid = dec(parts[1]);
    if(sid) return { name: "scene", sceneId: sid };
  } else if(parts.length === 3 && parts[0] === "s" && parts[2] === "chat"){
    var scid = dec(parts[1]);
    if(scid) return { name: "sceneChat", sceneId: scid };
  }
  return { name: "library" };
}

export function formatRoute(route){
  var r = route || {};
  var e = encodeURIComponent;
  if(r.name === "outline" && r.projectId) return "#/p/" + e(r.projectId);
  if(r.name === "chat" && r.projectId) return "#/p/" + e(r.projectId) + "/chat";
  if(r.name === "scene" && r.sceneId) return "#/s/" + e(r.sceneId);
  if(r.name === "sceneChat" && r.sceneId) return "#/s/" + e(r.sceneId) + "/chat";
  return "#/library";
}

export function sameRoute(a, b){ return formatRoute(a) === formatRoute(b); }
