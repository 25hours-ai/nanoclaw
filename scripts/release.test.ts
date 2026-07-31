import { describe, expect, it } from 'vitest';

import { assembleReleaseBody, changelogSection, verifyRelease } from './release.mjs';

const changelog = `# Changelog

## [Unreleased]

## [2.1.54] - 2026-07-31

Rollup release.

- First curated change.
- Second curated change.

## [2.1.17] - 2026-06-17

- Previous change.
`;

describe('release metadata', () => {
  it('extracts exactly one dated version section', () => {
    expect(changelogSection(changelog, '2.1.54')).toBe(
      'Rollup release.\n\n- First curated change.\n- Second curated change.',
    );
  });

  it('requires the package version to match', () => {
    expect(() => verifyRelease({ changelog, packageVersion: '2.1.53', version: '2.1.54' })).toThrow('does not match');
  });

  it('rejects missing, duplicate, empty, and prefixed versions', () => {
    expect(() => changelogSection(changelog, 'v2.1.54')).toThrow('without a v prefix');
    expect(() => changelogSection(changelog, '2.1.55')).toThrow('found 0');
    expect(() => changelogSection(`${changelog}\n## [2.1.54] - 2026-08-01\n\n- Duplicate.`, '2.1.54')).toThrow(
      'found 2',
    );
    expect(() =>
      changelogSection(changelog.replace('- First curated change.\n- Second curated change.', 'No bullets.'), '2.1.54'),
    ).toThrow('at least one release-note bullet');
  });
});

describe('release body assembly', () => {
  it('keeps curated notes and appends first-time and complete contributor sections', () => {
    const generatedNotes = `## What's Changed
* Fix one by @alice in https://github.com/nanocoai/nanoclaw/pull/1
* Fix two by @bob in https://github.com/nanocoai/nanoclaw/pull/2

## New Contributors
* @alice made their first contribution in https://github.com/nanocoai/nanoclaw/pull/1

**Full Changelog**: https://github.com/nanocoai/nanoclaw/compare/v2.1.17...v2.1.54`;

    const body = assembleReleaseBody({ changelog, generatedNotes, version: '2.1.54' });

    expect(body).toContain('Rollup release.');
    expect(body).toContain('## New Contributors\n\n* @alice');
    expect(body).toContain('## Contributors\n\nThanks to everyone');
    expect(body).toContain('Fix one by @alice');
    expect(body).toContain('Fix two by @bob');
    expect(body).toContain('compare/v2.1.17...v2.1.54');
    expect(body.indexOf('Rollup release.')).toBeLessThan(body.indexOf('## Contributors'));
  });

  it('works when GitHub reports no first-time contributors', () => {
    const generatedNotes = `## What's Changed
* Fix one by @alice in https://github.com/nanocoai/nanoclaw/pull/1

**Full Changelog**: https://github.com/nanocoai/nanoclaw/compare/v2.1.17...v2.1.54`;

    const body = assembleReleaseBody({ changelog, generatedNotes, version: '2.1.54' });

    expect(body).not.toContain('## New Contributors');
    expect(body).toContain('## Contributors');
  });
});
