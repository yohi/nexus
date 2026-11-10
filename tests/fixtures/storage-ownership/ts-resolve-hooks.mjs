// Test-only module hooks so a plain `node` child process can import repository TypeScript sources directly
// (Node's built-in type stripping) while sources keep their NodeNext `.js` import specifiers.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') && context.parentURL) {
      const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
