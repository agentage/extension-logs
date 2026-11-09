import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { imageParts, validateManifest } from '@agentage/extension/tool';
import { describe, expect, it } from 'vitest';

const SRC = new URL('.', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', SRC), 'utf8')) as {
  exports: Record<string, unknown>;
  agentage: { id: string };
};
const IMAGES = ['pages', 'ui', 'api', 'mcp', 'worker'];
const has = (path: string) => existsSync(new URL(path, SRC));
const folders = IMAGES.filter((part) => has(part));
// A variable specifier: the ui folder may have been dropped by create.
const UI = './ui/index.js';

const sources = (): [string, string][] =>
  readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !/\.(test|spec)\.ts$/.test(file))
    .map((file) => [file, readFileSync(new URL(file, SRC), 'utf8')]);

const relativeImports = (text: string): string[] =>
  [...text.matchAll(/from '(\.[^']+)'/g)].map((match) => match[1] ?? '');

describe('the manifest', () => {
  it('is valid and declares exactly the parts whose folders exist', () => {
    const manifest = validateManifest(pkg);
    expect(imageParts(manifest)).toEqual(folders);
    const store = has('../migrations') ? { store: 'postgres' } : {};
    const cli = has('cli') ? { cli: true } : {};
    const parts = Object.fromEntries(folders.map((part) => [part, true]));
    expect(manifest.agentage.parts).toEqual({ ...parts, ...cli, ...store });
    expect(manifest.agentage.commands?.map(({ name }) => name)).toEqual(
      has('cli') ? ['ping'] : undefined
    );
  });

  it.runIf(has('ui'))('ui exports its widgets map', async () => {
    expect(Object.keys((await import(UI)) as object)).toEqual(['widgets']);
  });

  it('commits a contract only beside its part', () => {
    expect([has('../openapi.json'), has(`../${pkg.agentage.id}.mcpc.json`)]).toEqual([
      has('api'),
      has('mcp'),
    ]);
  });

  it('the package exports no part code', () => {
    expect(Object.keys(pkg.exports)).toEqual(['./agentage-extension.json', './package.json']);
  });

  it('a part imports only its own folder and src/lib: each image carries just those', () => {
    const crossing = sources().flatMap(([file, text]) => {
      const part = file.split(/[\\/]/)[0] ?? '';
      return relativeImports(text)
        .map((spec) => normalize(join(dirname(file), spec)).split(/[\\/]/)[0] ?? '')
        .filter((target) => target !== part && target !== 'lib')
        .map((target) => `${file} -> ${target}`);
    });
    expect(crossing).toEqual([]);
  });
});
