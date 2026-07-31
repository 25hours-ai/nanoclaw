#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function changelogSection(markdown, version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`version must be an exact x.y.z value without a v prefix: ${version}`);
  }

  const escaped = version.replaceAll('.', '\\.');
  const header = new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'gm');
  const matches = [...markdown.matchAll(header)];

  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one dated [${version}] heading; found ${matches.length}`);
  }

  const start = matches[0].index + matches[0][0].length;
  const remainder = markdown.slice(start);
  const nextHeading = remainder.search(/^## \[/m);
  const section = (nextHeading === -1 ? remainder : remainder.slice(0, nextHeading)).trim();

  if (!section || !/^[-*] /m.test(section)) {
    throw new Error(`CHANGELOG.md [${version}] must contain at least one release-note bullet`);
  }

  return section;
}

export function verifyRelease({ changelog, packageVersion, version }) {
  if (packageVersion !== version) {
    throw new Error(`package.json version ${packageVersion} does not match requested release ${version}`);
  }

  const unreleasedIndex = changelog.indexOf('## [Unreleased]');
  const releaseIndex = changelog.indexOf(`## [${version}]`);
  if (unreleasedIndex === -1 || unreleasedIndex > releaseIndex) {
    throw new Error('CHANGELOG.md must keep [Unreleased] immediately ahead of released versions');
  }

  return changelogSection(changelog, version);
}

export function assembleReleaseBody({ changelog, generatedNotes, version }) {
  const curated = changelogSection(changelog, version);
  const changesMatch = generatedNotes.match(
    /## What's Changed\s*\n([\s\S]*?)(?=\n## New Contributors|\n\*\*Full Changelog\*\*:)/,
  );
  const fullChangelogMatch = generatedNotes.match(/^\*\*Full Changelog\*\*:.*$/m);

  if (!changesMatch?.[1].trim()) {
    throw new Error("GitHub generated notes did not contain a non-empty What's Changed section");
  }
  if (!fullChangelogMatch) {
    throw new Error('GitHub generated notes did not contain a Full Changelog link');
  }

  const newContributorsMatch = generatedNotes.match(/## New Contributors\s*\n([\s\S]*?)(?=\n\*\*Full Changelog\*\*:)/);
  const sections = [curated];

  if (newContributorsMatch?.[1].trim()) {
    sections.push(`## New Contributors\n\n${newContributorsMatch[1].trim()}`);
  }

  sections.push(`## Contributors\n\nThanks to everyone who landed work in this release:\n\n${changesMatch[1].trim()}`);
  sections.push(fullChangelogMatch[0]);

  return `${sections.join('\n\n')}\n`;
}

function repositoryInputs() {
  return {
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
    packageVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
  };
}

export function main(argv) {
  const [command, version, generatedNotesPath] = argv;
  if (!command || !version) {
    throw new Error('usage: node scripts/release.mjs <verify|extract|assemble> <x.y.z> [generated-notes.md]');
  }

  const inputs = repositoryInputs();
  const section = verifyRelease({ ...inputs, version });

  if (command === 'verify') {
    process.stdout.write(`release metadata verified for v${version}\n`);
    return;
  }
  if (command === 'extract') {
    process.stdout.write(`${section}\n`);
    return;
  }
  if (command === 'assemble') {
    if (!generatedNotesPath) {
      throw new Error('assemble requires the path to GitHub-generated notes');
    }
    process.stdout.write(
      assembleReleaseBody({
        changelog: inputs.changelog,
        generatedNotes: readFileSync(generatedNotesPath, 'utf8'),
        version,
      }),
    );
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
