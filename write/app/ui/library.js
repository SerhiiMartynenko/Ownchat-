// Library view: the list of projects, new project, import, per-project menu.
import { el, rowMenu, plural, words, relTime } from "./common.js";

export function initLibrary(deps){
  var $ = deps.$, store = deps.store, toast = deps.toast, openMenu = deps.openMenu;
  var listEl = $("projectList"), emptyEl = $("libraryEmpty"), fileInput = $("bundleInput");
  var renderSeq = 0;

  async function renderLibrary(){
    var seq = ++renderSeq;
    var projects;
    try{ projects = await store.listProjects(); }
    catch(e){ toast("Could not load projects"); return []; }
    if(seq !== renderSeq) return projects;
    listEl.innerHTML = "";
    emptyEl.hidden = projects.length > 0;
    var now = Date.now();
    projects.forEach(function(p){
      var row = el("button", "project-row");
      row.type = "button";
      row.setAttribute("data-id", p.id);
      var main = el("span", "row-main");
      main.appendChild(el("span", "row-title", p.title || "Untitled project"));
      var st = p.stats || { scenes: 0, words: 0 };
      main.appendChild(el("span", "row-meta", plural(st.scenes, "scene") + " · " + words(st.words) + " · " + relTime(p.updatedAt, now)));
      row.appendChild(main);
      row.appendChild(rowMenu("Project actions", function(){ projectMenu(p); }));
      row.addEventListener("click", function(){ deps.go({ name: "outline", projectId: p.id }); });
      listEl.appendChild(row);
    });
    return projects;
  }

  async function projectMenu(p){
    var act = await openMenu(p.title || "Project", [
      { act: "rename", label: "Rename" },
      { act: "bundle", label: "Export bundle" },
      { act: "manuscript", label: "Export manuscript" },
      { act: "delete", label: "Delete", danger: true }
    ]);
    if(act === "rename"){
      var t = window.prompt("Project title", p.title || "");
      if(t == null || !t.trim()) return;
      await store.renameProject(p.id, t);
      if(deps.onRenamed) deps.onRenamed(p.id);
      renderLibrary();
    } else if(act === "bundle" || act === "manuscript"){
      deps.exportProject(p.id, act);
    } else if(act === "delete"){
      if(!window.confirm("Delete “" + (p.title || "Untitled project") + "” with all its chapters, scenes, story bible and chat? This cannot be undone.")) return;
      await deps.deleteProject(p.id);
      renderLibrary();
      toast("Project deleted");
    }
  }

  async function newProject(){
    var t = window.prompt("Project title", "");
    if(t == null) return;
    var p = await store.createProject(t.trim() || "Untitled project");
    deps.go({ name: "outline", projectId: p.id });
  }

  function pickBundle(){ fileInput.click(); }

  $("hdrNewProject").addEventListener("click", newProject);
  $("libraryNew").addEventListener("click", newProject);
  $("hdrImport").addEventListener("click", pickBundle);
  $("libraryImport").addEventListener("click", pickBundle);
  fileInput.addEventListener("change", function(){
    var f = fileInput.files && fileInput.files[0];
    fileInput.value = "";   // allow picking the same file again
    if(f) deps.importFile(f);
  });

  return { renderLibrary: renderLibrary, pickBundle: pickBundle };
}
