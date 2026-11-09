// Generic action sheet: openMenu(title, items) resolves with the chosen item's act, or null when the
// sheet is dismissed (backdrop, Cancel). items: [{act, label, danger}]. A Cancel row is added unless
// the caller provides an item with act "cancel".
var els = null;
var pending = null;

function settle(value){
  if(!els) return;
  els.overlay.classList.remove("open");
  var p = pending; pending = null;
  if(p) p(value);
}

export function initMenu(deps){
  var $ = deps.$;
  els = { overlay: $("menuOverlay"), title: $("menuTitle"), items: $("menuItems") };
  els.overlay.addEventListener("click", function(e){ if(e.target === els.overlay) settle(null); });
  document.addEventListener("keydown", function(e){
    if(e.key === "Escape" && pending) settle(null);
  });
}

export function openMenu(title, items){
  if(!els) return Promise.resolve(null);
  if(pending) settle(null);
  var list = (items || []).slice();
  if(!list.some(function(it){ return it.act === "cancel"; })) list.push({ act: "cancel", label: "Cancel" });
  els.title.textContent = title || "";
  els.items.innerHTML = "";
  return new Promise(function(resolve){
    pending = resolve;
    list.forEach(function(it){
      var b = document.createElement("button");
      b.type = "button";
      b.className = "menu-item" + (it.danger ? " danger" : "");
      b.setAttribute("data-act", it.act);
      b.textContent = it.label;
      b.addEventListener("click", function(){ settle(it.act === "cancel" ? null : it.act); });
      els.items.appendChild(b);
    });
    els.overlay.classList.add("open");
  });
}

export function closeMenu(){ settle(null); }
