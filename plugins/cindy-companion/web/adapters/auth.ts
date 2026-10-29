import { initValue } from '../bridge';

/** The iframe is scoped to one Paseo host; it has no Cindy account or credentials. */
export function useAuth() { return { dataOwnerId: initValue()?.host.id ?? null }; }
