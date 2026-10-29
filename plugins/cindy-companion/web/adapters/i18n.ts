import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../../vendor/renderer/i18n/locales/en/common.json';
import zhCN from '../../vendor/renderer/i18n/locales/zh-CN/common.json';
void i18n.use(initReactI18next).init({ resources: { en: { common: { ...en, paseoIntegration: { voiceUnavailable: 'Voice service is not connected on this Paseo host.', channelsUnavailable: 'Messaging platforms are not connected on this Paseo host.' } } }, 'zh-CN': { common: { ...zhCN, paseoIntegration: { voiceUnavailable: '此 Paseo 主机尚未连接语音服务。', channelsUnavailable: '此 Paseo 主机尚未连接消息平台。' } } } }, lng: 'en', fallbackLng: 'en', defaultNS: 'common', initAsync: false, interpolation: { escapeValue: false, defaultVariables: { brand: 'Cindy', pronoun: '这位伙伴' } }, react: { useSuspense: false } });
export { i18n };
