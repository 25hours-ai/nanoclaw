import { describe, expect, it } from 'vitest';

import { resolveProviderName, securityArgs } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('securityArgs', () => {
  it('emits safe defaults when no override given', () => {
    const args = securityArgs(undefined);
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
    expect(args.join(' ')).toContain('--pids-limit 2048');
    expect(args.join(' ')).not.toContain('--cap-add');
    expect(args.join(' ')).not.toContain('--memory');
  });

  it('honors capAdd override', () => {
    const args = securityArgs({ capAdd: ['SYS_ADMIN'] });
    expect(args.join(' ')).toContain('--cap-add SYS_ADMIN');
  });

  it('omits pids-limit when explicitly null', () => {
    const args = securityArgs({ pidsLimit: null });
    expect(args.join(' ')).not.toContain('--pids-limit');
  });

  it('adds a memory cap when set', () => {
    const args = securityArgs({ memory: '4g' });
    expect(args.join(' ')).toContain('--memory 4g');
  });

  it('drops no-new-privileges when disabled', () => {
    const args = securityArgs({ noNewPrivileges: false });
    expect(args.join(' ')).not.toContain('no-new-privileges');
  });
});
