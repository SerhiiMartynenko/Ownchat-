// Test stand-in for fflate: a FAKE zip (JSON of base64 entries), not a real zip file.
// Works in Node and in the browser.
const PREFIX = "OWNCHAT-FAKEZIP\n";

export function strToU8(str){ return new TextEncoder().encode(String(str)); }
export function strFromU8(u8){ return new TextDecoder().decode(u8); }

function toB64(u8){
  if(typeof btoa === "function"){
    let bin = "";
    for(let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  return Buffer.from(u8).toString("base64");
}
function fromB64(s){
  if(typeof atob === "function"){
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

export function zipSync(files, opts){ // eslint-disable-line no-unused-vars
  const out = {};
  for(const path of Object.keys(files || {})){
    let v = files[path];
    if(Array.isArray(v)) v = v[0];
    out[path] = toB64(v instanceof Uint8Array ? v : strToU8(v));
  }
  return strToU8(PREFIX + JSON.stringify(out));
}

export function unzipSync(bytes){
  const text = strFromU8(bytes);
  if(!text.startsWith(PREFIX)) throw new Error("invalid zip data");
  const obj = JSON.parse(text.slice(PREFIX.length));
  const out = {};
  for(const path of Object.keys(obj)) out[path] = fromB64(obj[path]);
  return out;
}
