import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A6 desktop shell (D-081 stage 2): the Tauri wrapper stays in step with the web
// host and opens nothing beyond it until the listen-only HAL lands with its tests.

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const pkg = JSON.parse(read('package.json'));
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1];

describe('desktop shell', () => {
  it('has one version in package.json, tauri.conf.json and Cargo.toml', () => {
    expect(conf.version).toBe(pkg.version);
    expect(cargoVersion).toBe(pkg.version);
  });

  it('serves the same frontend build as the web host', () => {
    expect(conf.build.frontendDist).toBe('../dist');
    expect(conf.build.beforeBuildCommand).toBe('npm run build');
  });

  it('sets a CSP with no inline or eval scripts and no third-party host', () => {
    const csp: Record<string, string> = conf.app.security.csp;
    expect(csp).toBeTypeOf('object');
    expect(csp['default-src']).toBe("'self'");
    expect(csp['script-src']).toBe("'self'");
    expect(csp['object-src']).toBe("'none'");
    for (const [directive, sources] of Object.entries(csp)) {
      for (const source of sources.split(/\s+/)) {
        // Keywords ('self', ...), bare schemes (blob:, ws:) or the Tauri IPC origin only;
        // the server URL is user-entered at run time, never baked in.
        const allowed = /^'[a-z-]+'$/.test(source) || /^[a-z]+:$/.test(source) || source === 'http://ipc.localhost';
        expect(allowed, `${directive}: ${source}`).toBe(true);
      }
    }
  });

  it('grants the window the core defaults only', () => {
    const cap = JSON.parse(read('src-tauri/capabilities/default.json'));
    expect(cap.windows).toEqual(['main']);
    expect(cap.permissions).toEqual(['core:default']);
  });

  it('registers no native commands before the listen-only HAL (D-081 item 2)', () => {
    expect(read('src-tauri/src/main.rs')).not.toMatch(/invoke_handler|plugin\(/);
  });
});
