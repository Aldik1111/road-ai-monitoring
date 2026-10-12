import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Environment supplied by the host takes precedence over local settings.
const file = fileURLToPath(new URL('../.env', import.meta.url));
if (process.env.ROAD_AI_SKIP_ENV !== '1' && existsSync(file)) process.loadEnvFile(file);
