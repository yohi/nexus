const fixtureProfiles = Object.freeze({
  smoke: Object.freeze({ files: 20, declarationsPerFile: 5 }),
  small: Object.freeze({ files: 100, declarationsPerFile: 10 }),
  medium: Object.freeze({ files: 1_000, declarationsPerFile: 10 }),
  large: Object.freeze({ files: 10_000, declarationsPerFile: 10 }),
});

const padded = (index) => String(index).padStart(5, '0');

export function fixturePath(index) {
  return `packages/package-${padded(Math.floor(index / 20))}/src/file-${padded(index)}.ts`;
}

export function createFixtureRecipe(input) {
  const { index, fileCount, declarationsPerFile, variant = 'initial' } = input;
  const moduleSpecifier = `./file-${padded(Math.floor(index / 20) * 20)}.js`;
  const importText = `import '${moduleSpecifier}';`;
  let text = `${importText}\n`;
  const drafts = [];
  let previousEnd = importText.length;
  for (let marker = index; marker < 125; marker += fileCount) text += `// perf_hybrid_125 marker-${marker}\n`;
  text += '// perf_early\n';
  for (let declaration = 0; declaration < declarationsPerFile; declaration += 1) {
    text += '\n// perf_broad\n// perf_broad\n';
    const helper = declaration === declarationsPerFile - 1;
    const name = helper ? 'sharedHelper' : `case${padded(index)}_${declaration}`;
    const value = helper ? 'shared 日本語' : `${name}-${variant}`;
    const content = `export function ${name}(): string {\n  return '${value}';\n}`;
    const start = text.length;
    text += `${content}\n`;
    drafts.push(Object.freeze({ name, start, end: start + content.length, fullStart: previousEnd, content }));
    previousEnd = start + content.length;
  }
  text += '// perf_late\n';
  return Object.freeze({ text, importText, moduleSpecifier, drafts: Object.freeze(drafts) });
}

export { fixtureProfiles };
