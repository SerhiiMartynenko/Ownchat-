// Small DOM helpers shared by the library and outline views.
export var DOTS = '<svg class="ic" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';

export function el(tag, cls, text){
  var e = document.createElement(tag);
  if(cls) e.className = cls;
  if(text != null) e.textContent = text;
  return e;
}

// A "⋯" control inside a tappable row; it must not trigger the row itself.
export function rowMenu(label, onOpen){
  var m = el("span", "row-menu");
  m.setAttribute("role", "button");
  m.setAttribute("tabindex", "0");
  m.setAttribute("aria-label", label);
  m.innerHTML = DOTS;
  function fire(e){ e.stopPropagation(); e.preventDefault(); onOpen(); }
  m.addEventListener("click", fire);
  m.addEventListener("keydown", function(e){ if(e.key === "Enter" || e.key === " ") fire(e); });
  return m;
}

export function plural(n, word){ return n + " " + word + (n === 1 ? "" : "s"); }
export function words(n){ return (Number(n) || 0).toLocaleString() + (n === 1 ? " word" : " words"); }

export function relTime(t, now){
  if(!t) return "";
  var d = Math.max(0, (now || Date.now()) - t) / 1000;
  if(d < 60) return "just now";
  if(d < 3600) return Math.floor(d / 60) + " min ago";
  if(d < 86400) return Math.floor(d / 3600) + " h ago";
  if(d < 86400 * 7) return Math.floor(d / 86400) + " d ago";
  return new Date(t).toLocaleDateString();
}
