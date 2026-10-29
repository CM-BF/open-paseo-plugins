// A sandboxed opaque-origin frame has no browser storage. Preferences live only for this frame.
const values = new Map<string,string>();
export const frameStorage = { getItem: (key:string)=>values.get(key)??null, setItem: (key:string,value:string)=>{values.set(key,String(value));}, removeItem:(key:string)=>{values.delete(key);}, clear:()=>values.clear() };
