import checker from 'license-checker';

const allowed = new Set([
  '0BSD',
  'Apache-2.0',
  'Apache 2.0',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Python-2.0',
]);

const packageOverrides = new Map([
  ['@lancedb/lancedb', 'Apache 2.0'],
  ['@lancedb/lancedb-linux-x64-gnu', 'Apache 2.0'],
  ['expand-template', 'MIT'],
  ['rc', 'Apache-2.0'],
]);

checker.init(
  {
    start: process.cwd(),
    production: true,
    excludePrivatePackages: true,
    customPath: undefined,
  },
  (error, packages) => {
    if (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    const violations = Object.entries(packages).flatMap(([name, info]) => {
      const packageName = name.replace(/@[^@]+$/, '');
      
      // Skip the root package itself
      if (packageName === '@yohi/nexus') {
        return [];
      }

      const license = packageOverrides.get(packageName) ?? info.licenses;

      if (typeof license !== 'string' || !allowed.has(license)) {
        return [`${name}: ${String(license)}`];
      }

      return [];
    });

    if (violations.length > 0) {
      console.error('Disallowed licenses found:');
      for (const violation of violations) {
        console.error(`- ${violation}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`License check passed for ${Object.keys(packages).length} production packages.`);
  },
);
