// Reproduce the vendored settings slice without bringing in the desktop app.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.dirname(here);
if (!process.argv[2]) throw new Error('Usage: node import-upstream.mjs /path/to/pinned/cindy');
const upstream = path.resolve(process.argv[2]);
const revision = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (revision !== '118767c987f518286ae10a506a54287c3dc2a560') throw new Error('The Cindy checkout does not match the pinned source revision');
const desktop = path.join(upstream, 'apps/desktop');
const renderer = path.join(desktop, 'src/renderer');
const shared = path.join(desktop, 'src/shared');
const adapters = {
  'features/bots/botStore': 'bot-store.ts',
  'features/bots/paseoHostStatus': 'host-status.tsx',
  'features/bots/useBotSettingsTarget': 'settings-target.ts',
  'features/bots/companionCloudStore': 'cloud.ts',
  'features/bots/cloudCompanionPresentation': 'cloud.ts',
  'features/bots/useRemoteBots': 'cloud.ts',
  'features/bots/RemoteTeammateSettings': 'unsupported.tsx',
  'features/bots/BotHomeComputerSetting': 'home.tsx',
  'features/bots/CindyMergeSetting': 'unsupported.tsx',
  'features/bots/BotProjectsSettings': 'unsupported.tsx',
  'features/bots/companionAvatarCache': 'avatar-cache.ts',
  'components/chat/MarkdownRenderer': 'memory-markdown.tsx',
  'components/new-chat/ModelRouteSelector': 'model-picker.tsx',
  'hooks/useDeviceProviders': 'catalog.ts',
  'lib/makerChatStore': 'voice-session.ts',
  'components/settings/HookConnectionsSection': 'unsupported.tsx',
  'components/settings/WechatBotSection': 'unsupported.tsx',
  'features/bots/RemoteOfficialXCard': 'unsupported.tsx',
  'lib/providerDisplayName': 'catalog.ts',
  'lib/orcaSessionIdentity': 'navigation.ts',
  'i18n': 'i18n.ts',
  'i18n/index': 'i18n.ts',
  'hooks/useTheme': 'theme.tsx',
};
fs.writeFileSync(path.join(here, 'aliases.json'), JSON.stringify(adapters, null, 2) + '\n');
const seen = new Set();
const records = [];
const external = new Set();
const missing = new Set();
function resolve(base) {
  for (const p of [base, ...(base.endsWith('.js')?[base.slice(0,-3)+'.ts',base.slice(0,-3)+'.tsx']:[]), ...['.ts','.tsx','.js','.mjs','.json','.css'].map(x=>base+x), ...['index.ts','index.tsx'].map(x=>path.join(base,x))])
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  return null;
}
function adapterFor(file) {
  const rel = path.relative(renderer, file).replace(/\\/g,'/').replace(/\.(tsx?|js)$/,'');
  return adapters[rel];
}
function destination(file) {
  if (file.startsWith(renderer + path.sep)) return path.join(plugin,'vendor/renderer',path.relative(renderer,file));
  if (file.startsWith(shared + path.sep)) return path.join(plugin,'vendor/shared',path.relative(shared,file));
  if (file.startsWith(path.join(desktop,'resources') + path.sep)) return path.join(here,'assets',path.relative(path.join(desktop,'resources'),file));
  throw new Error('Out-of-slice dependency: '+file);
}
function deps(file, code) {
  if (file.endsWith('.css')) return [...code.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map(x=>x[1]);
  if (!/\.(tsx?|js|mjs)$/.test(file)) return [];
  const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const result = [];
  ast.forEachChild(node=>{
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const clause=node.importClause;
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name && clause.namedBindings.elements.every(x=>x.isTypeOnly)) return;
      result.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) result.push(node.moduleSpecifier.text);
  });
  return result;
}
function add(file, transform) {
  if (seen.has(file) || adapterFor(file)) return;
  seen.add(file);
  const bytes = fs.readFileSync(file);
  let code = bytes.toString('utf8');
  const isText = /\.(tsx?|js|mjs|json|css)$/.test(file);
  if (transform) code=transform(code);
  if (isText) {
    if(file.endsWith('/styles/globals.css')) code=code
      .replace(/@font-face\s*\{\s*font-family: 'Cindy CJK Punctuation Bundled';[^}]*\}\s*/g,'')
      .replaceAll("'Cindy CJK Punctuation Bundled'", "'HarmonyOS Sans SC'")
      .replace('while the\n   bundled faces cover the punctuation glyphs HarmonyOS actually ships.', 'while the\n   complete original HarmonyOS face is loaded by the Paseo font bridge.')
      .replace('Keep the asset names aligned with the\n   exact-pinned font package.', 'The bridge verifies the full original font bytes before loading.');
    code=code.replaceAll("'../../../../resources/", "'@cindy-assets/");
    if(file.endsWith('/BotAvatar.tsx')) code=code.replace("value?.startsWith('https://')", "(value?.startsWith('https://') || /^data:image\\/(?:png|jpeg|webp);base64,/i.test(value ?? ''))");
    if(file.endsWith('/CompanionVoiceSettings.tsx')) code="import { HostServiceNotice } from '@/features/bots/paseoHostStatus';\n"+code.replaceAll('<div className="space-y-4 pt-3">','<div className="space-y-4 pt-3"><HostServiceNotice op="voice.models" service="voice" />');
    if(file.endsWith('/BotChannelsPage.tsx')) code=code.replace("{t('bots.channels.empty', { name: bot.name })}","{t(im ? 'bots.channels.empty' : 'paseoIntegration.channelsUnavailable', { name: bot.name })}").replace('size="md" onClick={() => setAdding(true)}','size="md" disabled={!im} onClick={() => setAdding(true)}');
    if(file.endsWith('/speechVoiceLabelCache.ts')) code="import { frameStorage } from '@paseo/frame-storage';\n"+code.replaceAll('window.localStorage','frameStorage');
    if(file.endsWith('/confirm-dialog-provider.tsx')) code="import { frameStorage as localStorage } from '@paseo/frame-storage';\n"+code;
    for (const spec of deps(file,code)) {
      let target;
      if (spec.startsWith('@/') && adapters[spec.slice(2)]) continue;
      if (spec.startsWith('@/')) target=resolve(path.join(renderer,spec.slice(2)));
      else if (spec.startsWith('@cindy-assets/')) target=resolve(path.join(desktop,'resources',spec.slice(14)));
      else if (spec.startsWith('.')) { const base=path.resolve(path.dirname(file),spec); if(adapterFor(base))continue; target=resolve(base); }
      else { external.add(spec); continue; }
      if (target) add(target); else missing.add(path.relative(upstream,file)+' -> '+spec);
    }
  }
  const dest=destination(file);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.writeFileSync(dest,isText?code:bytes);
  records.push({source:path.relative(upstream,file),destination:path.relative(plugin,dest),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),modified:isText&&code!==bytes.toString('utf8')});
}
const settingsFile=path.join(renderer,'features/bots/BotsHomeView.tsx');
add(settingsFile,source=>{
  const start=source.indexOf('export function BotSettings(');
  const end=source.indexOf('\nexport function BotsHomeView()');
  let body=source.slice(start,end);
  // This is the same settings component; only the unrelated project page is outside the chosen surface.
  body=body.replace("        {page === 'projects' && <BotProjectsSettings key={bot.id} botId={bot.id} />}\n",'');
  body=body.replace("navigate(kind === 'skill' ? '/skillhub/local' : `/settings?tab=${toolSettings[id ?? ''] ?? 'builtin-tools'}`);",'showHostSettingsNotice();').replace("if (allowed) navigate('/settings?tab=providers');",'if (allowed) showHostSettingsNotice();');
  return `// Extracted from Cindy BotsHomeView: original BotSettings JSX, autosave and navigation guards.\n`+
`import { showHostSettingsNotice } from '@/features/bots/paseoHostStatus';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/input';
import { shouldShowOpenPathError } from '../../../shared/openPathResult';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, Check, ChevronRight, FolderOpen } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBotTranslation } from './botPronounContext';
import { Spinner } from '@/components/ui/spinner';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { canonicalBotSessionId, type BotCapabilities, type BotProfile } from './botStore';
import { useBotSettingsTarget } from './useBotSettingsTarget';
import { BotPortraitPicker } from './BotPortraitPicker';
import { botSettingsIcons } from './botSettingsIcons';
import { BotAvatar } from './BotAvatar';
import { BotBasicProfileFields } from './BotBasicProfileFields';
import { normalizeBotName } from '../../../shared/botCreation';
import { useCompanionCloud } from './companionCloudStore';
import { cloudCompanionAt } from './cloudCompanionPresentation';
import { BotHomeComputerSetting } from './BotHomeComputerSetting';
import { CindyMergeSetting } from './CindyMergeSetting';
import { BotLifecycleSettings } from './BotLifecycleSettings';
import { BotInvitationWelcome } from './BotInvitationWelcome';
import { BotModelChainEditor } from './BotModelChainEditor';
import { BotTaskModelEditor } from './BotTaskModelEditor';
import { BotCapabilitySettings } from './BotCapabilitySettings';
import { BotRoutines } from './BotRoutines';
import { BotAutonomySettings } from './BotAutonomySettings';
import { BotMemorySettings } from './BotMemorySettings';
import { CompanionVoiceSettings } from './voice/CompanionVoiceSettings';
import { BotChannelsPage } from './BotChannelsPage';
import { botSettingsChanges, normalizeBotSettingsPayload, reconcileBotSettingsDraft, type BotSettingsPayload } from './botSettingsAutosave';
import { useBotSettingsAutosave } from './useBotSettingsAutosave';\n`+body;
});
add(path.join(renderer,'features/bots/BotSettingsDrawer.tsx'),source=>source.replace(
  '  if (!bot && !remoteBot) return null;',
  `  useEffect(() => {
    const requestClose = () => close();
    window.addEventListener('cindy-request-close', requestClose);
    return () => window.removeEventListener('cindy-request-close', requestClose);
  });
  if (!bot && !remoteBot) return null;`
));
for(const rel of ['components/ui/effort-slider.tsx','components/new-chat/FastModeToggle.tsx','themes/colors.ts','themes/theme-service.ts','themes/builtin/default-light.ts','themes/builtin/default-dark.ts','styles/globals.css','components/ui/confirm-dialog-provider.tsx','components/ui/tooltip.tsx','components/ui/toast/index.ts','features/bots/botSettingsTarget.ts']) {
 const file=resolve(path.join(renderer,rel)); if(file)add(file);else missing.add(rel);
}
for(const locale of ['en','zh-CN']) add(path.join(renderer,`i18n/locales/${locale}/common.json`));
for(const [source, filename, extract] of [
 ['packages/maker-shared/src/modelRoute.ts','modelRoute.ts',null],
 ['packages/maker-scheduler/src/engine/cron.ts','cron.ts',null],
 ['packages/maker-shared/src/scheduleForm.ts','scheduleInterval.ts',code=>code.match(/export const SUPPORTED_INTERVAL_MINUTES = \[[^\]]+\] as const;/)[0]+'\n'],
]) {
 const bytes=fs.readFileSync(path.join(upstream,source));const dest=path.join(plugin,'vendor/shared/upstream',filename);
 fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,extract?extract(bytes.toString('utf8')):bytes);
 records.push({source,destination:path.relative(plugin,dest),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),modified:!!extract});
}
// Original Tailwind numeric token configuration, with only its content roots relocated.
const tailwind=path.join(desktop,'tailwind.config.ts');
const config=fs.readFileSync(tailwind,'utf8').replace("content: ['./src/renderer/**/*.{ts,tsx,html}']", "content: ['./vendor/renderer/**/*.{ts,tsx,html}', './web/**/*.{ts,tsx,html}']");
fs.writeFileSync(path.join(here,'tailwind.config.ts'),config);
records.push({source:path.relative(upstream,tailwind),destination:'web/tailwind.config.ts',sha256:crypto.createHash('sha256').update(fs.readFileSync(tailwind)).digest('hex'),modified:true});
fs.copyFileSync(path.join(upstream,'LICENSE'),path.join(here,'LICENSE-CINDY'));
fs.copyFileSync(path.join(upstream,'NOTICE'),path.join(here,'NOTICE-CINDY'));
fs.writeFileSync(path.join(here,'upstream-files.json'),JSON.stringify(records.sort((a,b)=>a.destination.localeCompare(b.destination)),null,2)+'\n');
console.log(JSON.stringify({files:records.length,external:[...external].sort(),missing:[...missing].sort()},null,2));
