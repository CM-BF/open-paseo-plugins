import { homedir } from 'node:os';
import { join } from 'node:path';
/** Same public host selection for schedule and owned-agent compatibility commands. */
export function publicPaseoCli() {
  return { file: process.env.PASEO_CLI ?? (process.platform === 'darwin' ? '/Applications/Paseo.app/Contents/Resources/bin/paseo' : 'paseo'),
    home: process.env.PASEO_HOME ?? join(homedir(), '.paseo') };
}
