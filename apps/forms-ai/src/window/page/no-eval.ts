import { config } from 'zod';

/**
 * Imported first by the page. The form engine checks definitions with zod,
 * which probes once whether it may build code with `new Function` to run
 * faster. The window's Content-Security-Policy forbids that, and the browser
 * reports the probe as a policy violation even though zod catches it;
 * `jitless` tells zod not to try.
 */
config({ jitless: true });
