export type NativeFeature = {type:'toggle';id:string;label:string;value:boolean} | {type:'select';id:string;label:string;value:string;options:{id:string;label:string;isDefault?:boolean}[]};
export type ModelFeatures = {provider:string;features?:NativeFeature[];error?:unknown};
export type SpeedChoice = {id:string;label:string;value:boolean|'ultrafast'};
// Only expose speeds that the selected provider/model actually advertised.
export function speedChoices(features: NativeFeature[] = []): SpeedChoice[] {
  const tiers=features.find(feature=>feature.type==='select'&&feature.id==='service_tier');
  if(tiers?.type==='select') return tiers.options.flatMap(option=>{
    const label=option.label.toLowerCase();
    const value=option.id==='default'||label==='standard'?false:label==='fast'?true:option.id==='ultrafast'||label==='ultrafast'?'ultrafast':null;
    return value===null?[]:[{id:option.id,label:option.label,value}];
  });
  return features.some(feature=>feature.type==='toggle'&&feature.id==='fast_mode') ? [{id:'standard',label:'Standard',value:false},{id:'fast',label:'Fast',value:true}] : [];
}
