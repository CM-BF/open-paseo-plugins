import { useSnapshot } from '../state';
export type CatalogModel = { id: string; name?: string; label?: string; isDefault?: boolean; isSelectable?: boolean; thinkingOptions?: {id:string;label:string;isDefault?:boolean}[]; defaultThinkingOptionId?:string; [key: string]: unknown };
export type ProviderRow = { id: string; name: string; vendor: 'cc'|'codex'|'pi'; status: string; models: CatalogModel[]; [key:string]: unknown };
export function providerRows(raw: unknown): ProviderRow[] {
  const entries = raw && typeof raw==='object' && Array.isArray((raw as any).entries) ? (raw as any).entries : [];
  return entries.flatMap((entry: any) => {
    const id=String(entry.provider ?? '');
    const vendor=id==='claude' || id==='claude-code' ? 'cc' : id==='codex' ? 'codex' : id==='pi' ? 'pi' : null;
    return vendor ? [{ ...entry, id, name: entry.name ?? id, vendor, status: entry.status ?? 'unavailable', models: Array.isArray(entry.models) ? entry.models.map((model:any)=>({...model,name:model.label??model.name??model.id})) : [] }] : [];
  });
}
export function useDeviceProviders() { return { providers: providerRows(useSnapshot()?.models), loading: false, loaded: true }; }
export const useProviders = useDeviceProviders;
export function providerDisplayName(provider: { name?:string; id?:string }) { return provider.name ?? provider.id ?? ''; }
export function providerAccountLabel(name: string, identity?: string) { return identity ? `${name} · ${identity}` : name; }
