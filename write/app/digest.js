// Background scene summariser: a serial queue that keeps scene digests fresh and proposes facts. No DOM.
import { hashText } from "./util.js";
import { blocksToText, countWords } from "./scene.js";
import { SCENE_SUMMARY_DEFAULTS, runSceneSummary } from "./summaries.js";
import { proposeFacts, cardNames } from "./bible.js";

export function createDigest(deps){
  var o=Object.assign({}, SCENE_SUMMARY_DEFAULTS, deps.opts||{});
  var waiting=[];   // queued scene ids
  var urgent=[];    // summarizeNow jobs: { id, force, resolve }
  var current=null; // scene id in flight
  var busy=false;

  function state(){ if(deps.onStateChange) deps.onStateChange(); }
  function updated(rec){ if(deps.onSceneUpdated) deps.onSceneUpdated(rec); }
  function fail(id, err, force){ if(deps.onError) deps.onError(id, err, { force:force }); }
  function now(){ return deps.now ? deps.now() : Date.now(); }

  async function runJob(id, force){
    var loaded=await deps.loadScene(id);
    if(!loaded || !loaded.scene) return null;
    var scene=loaded.scene;
    var settings=deps.getSettings() || {};
    if(!settings.apiKey){
      if(force) fail(id, new Error("Add your OpenRouter API key first"), true);
      return null;
    }
    var text=blocksToText(scene.blocks), words=countWords(text), hash=hashText(text);
    var stored=typeof scene.summary==="string" ? scene.summary : "";
    if(words===0){
      if(stored.trim()){
        var cleared=await deps.patchScene(id, { summary:"", summaryHash:hash, summaryUpdatedAt:now(), summaryModel:"" });
        if(cleared) updated(cleared);
      }
      return null;
    }
    if(!force && hash===scene.summaryHash && stored.trim()) return null;
    if(!force && words<o.minWords) return null;
    var pid=scene.projectId;
    var res=await runSceneSummary({
      title: scene.title, chapterTitle: loaded.chapterTitle, text: text, previousSummary: stored,
      cardNames: cardNames(deps.getBible(pid)), callApi: deps.callApi, model: settings.utilityModel,
      signal: new AbortController().signal, opts: o
    });
    if(!res) return null;
    var rec=await deps.patchScene(id, { summary:res.summary, summaryHash:res.hash, summaryUpdatedAt:now(), summaryModel:res.model });
    if(!rec) return null;
    updated(rec);
    var added=[], b=deps.getBible(pid);
    if(b){
      var r=proposeFacts(b, res.facts, { kind:"scene", sceneId:id, sceneTitle:scene.title, at:now() }, deps.uid);
      added=r.added;
      if(added.length) await deps.setBible(pid, r.bible);
    }
    return { summary:res.summary, facts:res.facts, added:added };
  }

  async function loop(){
    busy=true;
    while(urgent.length || waiting.length){
      var job=urgent.length ? urgent.shift() : { id:waiting.shift(), force:false, resolve:null };
      var result=null;
      current=job.id;
      state();
      try { result=await runJob(job.id, job.force); }
      catch(err){ result=null; try { fail(job.id, err, job.force); } catch(e){} }
      current=null;
      state();
      if(job.resolve) job.resolve(result);
    }
    busy=false;
  }

  function kick(){ if(!busy) loop(); }

  return {
    queue: function(id){
      if(!id || waiting.indexOf(id)>=0) return;
      waiting.push(id);
      kick();
    },
    summarizeNow: function(id, opts){
      var force=!!(opts && opts.force);
      return new Promise(function(resolve){
        urgent.push({ id:id, force:force, resolve:resolve });
        kick();
      });
    },
    isRunning: function(id){ return current!==null && current===id; },
    pending: function(){ return urgent.map(function(j){ return j.id; }).concat(waiting); },
    forget: function(ids){
      var drop=Array.isArray(ids) ? ids : [ids];
      waiting=waiting.filter(function(id){ return drop.indexOf(id)<0; });
    }
  };
}
