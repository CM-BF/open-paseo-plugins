import { useSnapshot } from '../state';
import { useTranslation } from 'react-i18next';
export function HostServiceNotice({op,service}:{op:string;service:'voice'}) {
 const state=useSnapshot(); const {t}=useTranslation();
 return state?.caps.ops.includes(op)?null:<p role="status" className="text-13 leading-relaxed text-[var(--text-secondary)]">{t(`paseoIntegration.${service}Unavailable`)}</p>;
}

import { toast } from '../../vendor/renderer/lib/toast';
import { i18n } from './i18n';
export function showHostSettingsNotice() { toast.warning(i18n.language === 'zh-CN' ? '请在 Paseo 主机设置中管理全局提供商和工具；此抽屉尚未连接该入口。' : 'Manage global providers and tools in Paseo host settings. This drawer has not connected that settings entry yet.'); }
