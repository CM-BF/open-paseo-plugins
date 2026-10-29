import { initValue } from '../bridge';
export const useTheme = () => ({ theme: initValue()?.theme ?? 'dark', resolvedTheme: initValue()?.theme ?? 'dark', isDark: initValue()?.theme !== 'light' });
