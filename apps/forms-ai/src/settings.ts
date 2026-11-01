import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultOutputDir, type Host, settingsFile } from './host.js';

/**
 * The tool's one setting: where packages are saved. Kept in a small JSON file
 * beside the installed program, chosen in the installer ("Change output
 * folder"), and overridden for one run by `INTEGR8_FORMS_OUTPUT`.
 */
export interface Settings {
  outputFolder: string | null;
}

export function readSettings(host: Host): Settings {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(host), 'utf8')) as Partial<Settings>;
    return {
      outputFolder:
        typeof parsed.outputFolder === 'string' && parsed.outputFolder !== ''
          ? parsed.outputFolder
          : null,
    };
  } catch {
    return { outputFolder: null };
  }
}

export function writeSettings(host: Host, settings: Settings): void {
  const file = settingsFile(host);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temporary, file);
}

/** The folder packages go to: the environment's, the user's choice, or Documents/Integr8 forms. */
export function outputFolder(host: Host): string {
  const override = host.env.INTEGR8_FORMS_OUTPUT;
  if (override !== undefined && override !== '') {
    return override;
  }
  return readSettings(host).outputFolder ?? defaultOutputDir(host);
}
