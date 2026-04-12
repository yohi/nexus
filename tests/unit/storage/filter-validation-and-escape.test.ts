import { describe, it, expect, beforeEach } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';

class TestableLanceVectorStore extends LanceVectorStore {
  testValidateFilterValue(value: string, paramName: string): void {
    return this.validateFilterValue(value, paramName);
  }

  testEscapeFilterValue(value: string): string {
    return this.escapeFilterValue(value);
  }

  testEscapeLikeValue(value: string): string {
    return this.escapeLikeValue(value);
  }

  testFilePathFilter(filePath: string): string {
    return this.filePathFilter(filePath);
  }

  testFilePathPrefixFilter(prefix: string): string {
    return this.filePathPrefixFilter(prefix);
  }
}

describe('Filter Validation and Escape', () => {
  let store: TestableLanceVectorStore;

  beforeEach(() => {
    store = new TestableLanceVectorStore({ dimensions: 64 });
  });

  describe('validateFilterValue()', () => {
    it('正常パス（ASCII）— 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('src/utils/parser.ts', 'filePath')).not.toThrow();
    });

    it('正常パス（ドット付き）— 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('./src/index.ts', 'filePath')).not.toThrow();
    });

    it('正常パス（コロン付き ID）— 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('src/main.ts:1-10', 'filePath')).not.toThrow();
    });

    it('空文字列 — 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('', 'filePath')).not.toThrow();
    });

    it('Null バイト — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\0path', 'filePath'))
        .toThrow('contains control characters');
    });

    it('改行文字 — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\npath', 'filePath'))
        .toThrow('contains control characters');
    });

    it('CR/LF 混在 — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\r\npath', 'filePath'))
        .toThrow('contains control characters');
    });

    it('タブ文字 — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\tpath', 'filePath'))
        .toThrow('contains control characters');
    });

    it('DEL 文字 — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\x7fpath', 'filePath'))
        .toThrow('contains control characters');
    });

    it('非 ASCII（日本語）— 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('ソース/main.ts', 'filePath')).not.toThrow();
    });

    it('非 ASCII（絵文字）— 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('src/🚀.ts', 'filePath')).not.toThrow();
    });

    it('非 ASCII（結合文字 NFD）— 例外をスローしない', () => {
      // "café" (e + \u0301)
      expect(() => store.testValidateFilterValue('src/cafe\u0301.ts', 'filePath')).not.toThrow();
    });

    it('LINE SEPARATOR (U+2028) — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\u2028path', 'filePath'))
        .toThrow('contains control characters');
    });

    it('PARAGRAPH SEPARATOR (U+2029) — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\u2029path', 'filePath'))
        .toThrow('contains control characters');
    });

    it('制御文字混入 Unicode — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('ソース/ma\x00in.ts', 'filePath'))
        .toThrow('contains control characters');
    });

    it('Private Use Area — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('\uE000path', 'filePath'))
        .toThrow('contains characters outside the allowed set');
    });

    it('BOM（Byte Order Mark）— Error をスロー', () => {
      expect(() => store.testValidateFilterValue('\uFEFFsrc/main.ts', 'filePath'))
        .toThrow('contains characters outside the allowed set');
    });

    it('ゼロ幅スペース — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('src/ma\u200Bin.ts', 'filePath'))
        .toThrow('contains characters outside the allowed set');
    });

    it('symbolKind のバリデーション — 制御文字で Error をスロー', () => {
      expect(() => store.testValidateFilterValue('function\0', 'symbolKind'))
        .toThrow('contains control characters');
    });
  });

  describe('escapeFilterValue()', () => {
    it('基本エスケープ — シングルクォート', () => {
      expect(store.testEscapeFilterValue("O'Brien")).toBe("O''Brien");
    });

    it('バックスラッシュ', () => {
      expect(store.testEscapeFilterValue('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('複合攻撃 — SQL インジェクション', () => {
      const result = store.testEscapeFilterValue("'; DROP TABLE chunks --");
      expect(result).toBe("''; DROP TABLE chunks --");
    });

    it('SQL コメント — リテラルとして保持', () => {
      const result = store.testEscapeFilterValue('file /* comment */ path');
      expect(result).toBe('file /* comment */ path');
    });

    it('セミコロン — リテラルとして保持', () => {
      const result = store.testEscapeFilterValue('file; SELECT * FROM t');
      expect(result).toBe('file; SELECT * FROM t');
    });

    it('空文字列 — 安全に処理', () => {
      expect(store.testEscapeFilterValue('')).toBe('');
    });

    it('超長文字列 — 例外やバッファ溢れなし', () => {
      const longStr = 'a'.repeat(10_000);
      expect(() => store.testEscapeFilterValue(longStr)).not.toThrow();
      expect(store.testEscapeFilterValue(longStr)).toBe(longStr);
    });
  });

  describe('escapeLikeValue()', () => {
    it('アンダースコア含有パス', () => {
      expect(store.testEscapeLikeValue('src/my_file.ts')).toBe('src/my\\_file.ts');
    });

    it('パーセント含有パス', () => {
      expect(store.testEscapeLikeValue('src/100%.ts')).toBe('src/100\\%.ts');
    });

    it('複合ワイルドカード', () => {
      const result = store.testEscapeLikeValue('src/my_module/100%_done');
      expect(result).toContain('\\_');
      expect(result).toContain('\\%');
    });

    it('ワイルドカード無しのパス — 変換なし', () => {
      expect(store.testEscapeLikeValue('src/utils/parser.ts')).toBe('src/utils/parser.ts');
    });

    it('クォートとワイルドカード混在', () => {
      const result = store.testEscapeLikeValue("src/O'Brien_file.ts");
      expect(result).toContain("''");
      expect(result).toContain('\\_');
    });
  });

  describe('統合フロー（filePathFilter / filePathPrefixFilter）', () => {
    it('制御文字を含むパス — validateFilterValue で例外スロー', () => {
      expect(() => store.testFilePathFilter('file\0path')).toThrow('contains control characters');
    });

    it('正常入力の貫通 — 正しいフィルタ文字列が構築される', () => {
      const result = store.testFilePathFilter('src/utils/parser.ts');
      expect(result).toBe("filepath = 'src/utils/parser.ts'");
    });

    it('LIKE ワイルドカードの安全なプレフィックス検索', () => {
      const result = store.testFilePathPrefixFilter('src/my_module');
      expect(result).toBe("filepath LIKE 'src/my\\_module%' ESCAPE '\\\\'");
    });

    it('ESCAPE 句の付与', () => {
      const result = store.testFilePathPrefixFilter('src/utils');
      expect(result).toBe("filepath LIKE 'src/utils%' ESCAPE '\\\\'");
    });

    it('完全一致フィルタに ESCAPE なし', () => {
      const result = store.testFilePathFilter('src/utils/parser.ts');
      expect(result).toBe("filepath = 'src/utils/parser.ts'");
    });
  });
});