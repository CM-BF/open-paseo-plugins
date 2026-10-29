import { invoke, initValue, BridgeError } from './bridge';
import { currentBotId, onRoutinesChanged } from './adapters/settings-target';
import { presetApi } from './adapters/presets';
import { createLinkedProjectsAdapter } from './adapters/linked-projects';
import { getDataOwnerGeneration } from '../vendor/renderer/contexts/dataOwnerGeneration';
const linkedProjects = createLinkedProjectsAdapter(invoke, () => {
  const init = initValue();
  return init ? { hostId: init.host.id, botId: init.botId, generation: getDataOwnerGeneration().generation } : null;
});
function chooseAvatarSource(): Promise<{canceled:boolean;previewDataUrl?:string}> {
  return new Promise((resolve,reject)=>{
    const input=document.createElement('input'); input.type='file'; input.accept='image/png,image/jpeg,image/webp,image/avif,image/gif'; input.style.display='none'; document.body.append(input);
    let done=false;
    const finish=(result:{canceled:boolean;previewDataUrl?:string})=>{if(done)return;done=true;input.remove();resolve(result);};
    input.addEventListener('cancel',()=>finish({canceled:true}),{once:true});
    input.addEventListener('change',()=>{
      const file=input.files?.[0]; if(!file){finish({canceled:true});return;}
      if(file.size>20*1024*1024){input.remove();reject(new BridgeError('INVALID_ARGUMENT','Choose an image smaller than 20 MiB.'));return;}
      const reader=new FileReader(); reader.onload=()=>finish({canceled:false,previewDataUrl:String(reader.result)}); reader.onerror=()=>{input.remove();reject(new Error('Could not read the selected image.'));}; reader.readAsDataURL(file);
    },{once:true}); input.click();
  });
}
const nightly = Object.fromEntries(['get','setEnabled','setFrequency','runNow','revert','candidate'].map(name=>[name,(...args:unknown[])=>invoke(`paseo.nightlyLearning.${name}`,{botId:args[0],values:args.slice(1)})]));
Object.defineProperty(window,'electronAPI',{value:{
  platform:'darwin', windowBackdropMaterial:'none',
  openPath:(path:string)=>invoke('paseo.openPath',{botId:currentBotId(),path}).catch(error=>({success:false,error:error instanceof Error?error.message:String(error)})),
  onAuthStateChange:()=>()=>{},
  voiceInput:{onPowerStateChange:(listener:()=>void)=>{ window.addEventListener('pagehide',listener);return()=>window.removeEventListener('pagehide',listener); }},
  openExternal:(url:string)=>invoke('paseo.openExternal',{url}),
  localDb:{bots:{projects:linkedProjects,chooseAvatarSource,generateAvatar:()=>Promise.reject(new BridgeError('UNSUPPORTED','Portrait generation is not connected.')),todos:{dailyCheck:(botId:string,enabled:boolean)=>invoke('paseo.todos.dailyCheck',{botId,enabled})}}},
  maker:{onBotWorkbenchChanged:linkedProjects.onChanged},
  routines:{nightlyLearning:nightly,onChanged:onRoutinesChanged},
  botMarket:presetApi,
}, configurable:false});
