// Outline view: chapters and scenes of one project, with menus to rename, move and delete.
import { el, rowMenu, words } from "./common.js";
import { blocksToText } from "../scene.js";
import { hashText } from "../util.js";

export function initOutline(deps){
  var $ = deps.$, store = deps.store, toast = deps.toast, openMenu = deps.openMenu;
  var listEl = $("outlineList"), emptyEl = $("outlineEmpty"), addChapterBtn = $("outlineAddChapter");
  var headTitleEl = $("outlineHeadTitle"), headMetaEl = $("outlineHeadMeta");
  var pid = null;
  var renderSeq = 0;
  var currentId = null;      // the scene highlighted in the sidebar; survives re-renders

  function guard(p){
    return p.catch(function(e){ toast("Could not update the outline" + (e && e.message ? ": " + e.message : "")); });
  }

  async function renderOutline(projectId){
    if(projectId) pid = projectId;
    var seq = ++renderSeq;
    var outline = await store.getOutline(pid);
    if(seq !== renderSeq) return outline;
    listEl.innerHTML = "";
    if(!outline){
      if(headTitleEl) headTitleEl.textContent = "";
      if(headMetaEl) headMetaEl.textContent = "";
      return null;
    }
    var chapters = outline.chapters;
    emptyEl.hidden = chapters.length > 0;
    addChapterBtn.hidden = chapters.length === 0;
    var total = 0;
    chapters.forEach(function(ch){
      var chWords = ch.scenes.reduce(function(a, s){ return a + (Number(s.wordCount) || 0); }, 0);
      total += chWords;
      var box = el("div", "chapter");
      box.setAttribute("data-id", ch.id);
      var head = el("div", "chapter-head");
      head.appendChild(el("span", "chapter-title", ch.title || "Untitled chapter"));
      head.appendChild(el("span", "chapter-meta", words(chWords)));
      head.appendChild(rowMenu("Chapter actions", function(){ chapterMenu(ch); }));
      box.appendChild(head);
      ch.scenes.forEach(function(sc){
        var row = el("button", "scene-row");
        row.type = "button";
        row.setAttribute("data-id", sc.id);
        if(currentId && sc.id === currentId) row.classList.add("current");
        var main = el("span", "row-main");
        main.appendChild(el("span", "row-title", sc.title || "Untitled scene"));
        var sum = (sc.summary || "").trim();
        var stale = !!sum && hashText(blocksToText(sc.blocks)) !== sc.summaryHash;
        var sumEl = el("span", "scene-summary" + (stale ? " stale" : ""), sum ? sum + (stale ? " \u00b7 out of date" : "") : "No summary yet");
        main.appendChild(sumEl);
        row.appendChild(main);
        row.appendChild(el("span", "row-meta", words(Number(sc.wordCount) || 0)));
        row.appendChild(rowMenu("Scene actions", function(){ sceneMenu(sc); }));
        row.addEventListener("click", function(){ deps.go({ name: "scene", sceneId: sc.id }); });
        box.appendChild(row);
      });
      var add = el("button", "ghost-btn add-scene", "+ Add scene");
      add.type = "button";
      add.addEventListener("click", function(){ addScene(ch); });
      box.appendChild(add);
      listEl.appendChild(box);
    });
    outline.words = total;
    if(headTitleEl) headTitleEl.textContent = (outline.project && outline.project.title) || "Untitled project";
    if(headMetaEl) headMetaEl.textContent = words(total);
    if(deps.onRendered) deps.onRendered(outline);
    return outline;
  }

  // Highlights the row of scene id (null clears it); remembered for later renders.
  function setCurrent(id){
    currentId = id || null;
    listEl.querySelectorAll("button.scene-row[data-id]").forEach(function(row){
      row.classList.toggle("current", !!currentId && row.getAttribute("data-id") === currentId);
    });
  }

  async function addChapter(){
    if(!pid) return;
    var n = listEl.querySelectorAll(".chapter").length + 1;
    var t = window.prompt("Chapter title", "Chapter " + n);
    if(t == null) return;
    await guard(store.addChapter(pid, t));
    renderOutline();
  }

  async function addScene(ch){
    var n = (ch.scenes || []).length + 1;
    var t = window.prompt("Scene title", "Scene " + n);
    if(t == null) return;
    await guard(store.addScene(ch.id, t));
    renderOutline();
  }

  async function chapterMenu(ch){
    var act = await openMenu(ch.title || "Chapter", [
      { act: "rename", label: "Rename" },
      { act: "up", label: "Move up" },
      { act: "down", label: "Move down" },
      { act: "add", label: "Add scene" },
      { act: "delete", label: "Delete chapter", danger: true }
    ]);
    if(act === "rename"){
      var t = window.prompt("Chapter title", ch.title || "");
      if(t == null || !t.trim()) return;
      await guard(store.renameChapter(ch.id, t));
    } else if(act === "up" || act === "down"){
      await guard(store.moveChapter(ch.id, act === "up" ? -1 : 1));
    } else if(act === "add"){
      return addScene(ch);
    } else if(act === "delete"){
      var n = (ch.scenes || []).length;
      var msg = "Delete “" + (ch.title || "Untitled chapter") + "”" +
        (n ? " and its " + (n === 1 ? "scene" : n + " scenes") : "") + "? This cannot be undone.";
      if(!window.confirm(msg)) return;
      await guard(store.deleteChapter(ch.id));
      if(deps.onScenesDeleted) deps.onScenesDeleted((ch.scenes || []).map(function(s){ return s.id; }));
    } else {
      return;
    }
    renderOutline();
  }

  async function sceneMenu(sc){
    var act = await openMenu(sc.title || "Scene", [
      { act: "rename", label: "Rename" },
      { act: "up", label: "Move up" },
      { act: "down", label: "Move down" },
      { act: "summary", label: "Summary\u2026" },
      { act: "delete", label: "Delete scene", danger: true }
    ]);
    if(act === "summary"){
      if(deps.openSummary) deps.openSummary(sc);
      return;
    }
    if(act === "rename"){
      var t = window.prompt("Scene title", sc.title || "");
      if(t == null || !t.trim()) return;
      await guard(store.renameScene(sc.id, t));
      if(deps.onSceneRenamed) deps.onSceneRenamed(sc.id);
    } else if(act === "up" || act === "down"){
      await guard(store.moveScene(sc.id, act === "up" ? -1 : 1));
    } else if(act === "delete"){
      if(!window.confirm("Delete “" + (sc.title || "Untitled scene") + "”? This cannot be undone.")) return;
      await guard(store.deleteScene(sc.id));
      if(deps.onScenesDeleted) deps.onScenesDeleted([sc.id]);
    } else {
      return;
    }
    renderOutline();
  }

  async function projectMenu(){
    if(!pid) return;
    var project = await store.getProject(pid);
    if(!project) return;
    var act = await openMenu(project.title || "Project", [
      { act: "rename", label: "Rename project" },
      { act: "bundle", label: "Export bundle" },
      { act: "manuscript", label: "Export manuscript" },
      { act: "settings", label: "Settings" },
      { act: "delete", label: "Delete project", danger: true }
    ]);
    if(act === "rename"){
      var t = window.prompt("Project title", project.title || "");
      if(t == null || !t.trim()) return;
      await guard(store.renameProject(pid, t));
      if(deps.onProjectRenamed) deps.onProjectRenamed(pid);
    } else if(act === "bundle" || act === "manuscript"){
      deps.exportProject(pid, act);
    } else if(act === "settings"){
      deps.openSettings();
    } else if(act === "delete"){
      if(!window.confirm("Delete “" + (project.title || "Untitled project") + "” with all its chapters, scenes, story bible and chat? This cannot be undone.")) return;
      await deps.deleteProject(pid);
      toast("Project deleted");
      deps.go({ name: "library" }, { replace: true });
    }
  }

  addChapterBtn.addEventListener("click", addChapter);
  $("outlineEmptyAdd").addEventListener("click", addChapter);
  // #hdrMenu is bound once in main.js, which calls projectMenu() while the outline is shown.
  return { renderOutline: renderOutline, projectMenu: projectMenu, setCurrent: setCurrent };
}
