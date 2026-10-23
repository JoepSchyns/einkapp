import fs from 'fs/promises';
import type { GeneratorParam, ImageGenerator } from './ImageGenerator.js';
import { getSourceSettings } from '../settings/settings.js';

export type GeneratorClass = {
  new (sessionId: string): ImageGenerator;
  readonly name: string;
  label: string;
  requiredEnv: string[];
  params: GeneratorParam[];
};

let generatorClasses: Promise<GeneratorClass[]> | undefined;

async function discoverGenerators(): Promise<GeneratorClass[]> {
  const files = await fs.readdir(new URL('./generators', import.meta.url));
  const classes: GeneratorClass[] = [];
  for (const file of files) {
    if ((file.endsWith('.js') || file.endsWith('.ts')) && !file.endsWith('.d.ts')) {
      const module = await import(`./generators/${file}`);
      if (module.default) {
        classes.push(module.default);
      }
    }
  }
  if (classes.length === 0) {
    throw new Error('No image generators found.');
  }
  return classes.sort((a, b) => a.name.localeCompare(b.name));
}

/** All generator classes found on disk, regardless of settings. Loaded once per process. */
export function getGeneratorClasses(): Promise<GeneratorClass[]> {
  generatorClasses ??= discoverGenerators();
  return generatorClasses;
}

export function getMissingEnv(generator: GeneratorClass): string[] {
  return generator.requiredEnv.filter((name) => !process.env[name]);
}

export function isAvailable(generator: GeneratorClass): boolean {
  return getMissingEnv(generator).length === 0;
}

/** Generators that are configured (env) and enabled globally */
export async function getUsableGeneratorNames(): Promise<string[]> {
  const classes = await getGeneratorClasses();
  return classes
    .filter((g) => isAvailable(g) && getSourceSettings(g.name).enabled)
    .map((g) => g.name);
}

export async function describeSources() {
  const classes = await getGeneratorClasses();
  return classes.map((g) => {
    const settings = getSourceSettings(g.name);
    const missingEnv = getMissingEnv(g);
    return {
      name: g.name,
      label: g.label || g.name,
      available: missingEnv.length === 0,
      missingEnv,
      enabled: settings.enabled && missingEnv.length === 0,
      weight: settings.weight,
      params: g.params.map((p) => ({ ...p, value: settings.params[p.key] ?? '' })),
    };
  });
}
