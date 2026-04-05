import type { GrepMatch, GrepParams, IGrepEngine } from '../../../src/types/index.js';

export class TestGrepEngine implements IGrepEngine {
  private readonly files = new Map<string, string>();

  addFile(filePath: string, content: string): void {
    this.files.set(filePath, content);
  }

  async search(params: GrepParams): Promise<GrepMatch[]> {
    const results: GrepMatch[] = [];
    const needle = params.caseSensitive ? params.query : params.query.toLowerCase();

    for (const [filePath, content] of this.files) {
      const lines = content.split('\n');

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const haystack = params.caseSensitive ? line : line.toLowerCase();

        const submatches: { start: number; end: number; match: string }[] = [];
        let pos = haystack.indexOf(needle);
        while (pos !== -1) {
          submatches.push({
            start: pos,
            end: pos + needle.length,
            match: line.slice(pos, pos + needle.length),
          });
          pos = haystack.indexOf(needle, pos + needle.length);
        }

        if (submatches.length === 0) {
          continue;
        }

        results.push({
          filePath,
          lineNumber: index + 1,
          lineText: line,
          submatches,
        });

        if (results.length >= (params.maxResults ?? 100)) {
          return results;
        }
      }
    }

    return results;
  }
}
