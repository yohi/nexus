# LanceDB 実統合 & Compaction Pipeline 統合 — 設計仕様書

## Overview

Nexus の `LanceVectorStore` は現在 `Map` ベースのインメモリ実装であり、永続化・ベクトル検索が
機能していない。本設計では以下の2つを同一スコープで対応する:

1. **LanceDB 実統合** — `@lancedb/lancedb` を使った永続化・ベクトル検索への書き換え
2. **Compaction Pipeline 統合** — 既に実装済みの compaction メソッドを `IndexPipeline` から呼び出す

両者は「ストレージ層の本番化」という1つのテーマで密結合しており、LanceDB 実統合なしに
コンパクションは意味を持たない。

### スコープ外

- `openai-compat` Embedding Provider の実装（別スペック）
- `rename-detection.test.ts` の新設（既存テストで十分カバー）
- SQLite バッチサイズ最適値の検証実行

## LanceVectorStore の LanceDB 実装

### 方針

現在の `src/storage/vector-store.ts` の `LanceVectorStore` クラスは **`Map` ベースの
インメモリ実装（モック）** である。クラス名は `LanceVectorStore` だが、実態は `@lancedb/lancedb`
への依存を持たず、全ての CRUD 操作を `Map<string, StoredVectorRow>` 上で行うスタブ実装
となっている（ファイル冒頭の `TODO: Replace Map with actual LanceDB integration` コメント参照）。

このモック実装を `@lancedb/lancedb` による本番実装に直接書き換える。ただし、書き換え前に
以下の移行ステップを実行し、既存のインメモリロジックの退避と整合性を確認する。

#### 移行ステップ（LanceDB 書き換え前の事前作業）

> [!IMPORTANT]
> 以下のステップは LanceDB 実装の着手 **前に** 完了させること。`src/storage/vector-store.ts`
> を直接 LanceDB 版に書き換えると、ユニットテストの実行環境（CI を含む）で LanceDB の
> ネイティブバイナリ依存が必要になり、テスト実行のハードルが上がる。インメモリ実装を
> テスト用として確実に分離・維持してから本番実装に着手する。

**Step 1: `tests/unit/storage/in-memory-vector-store.ts` の網羅性検証**

既にテスト用の `InMemoryVectorStore` が `tests/unit/storage/in-memory-vector-store.ts`
に存在する。このファイルが `src/storage/vector-store.ts` の現在のインメモリロジックと
**機能的に等価** であることを以下の方法で検証する:

1. `src/storage/vector-store.ts`（現モック）と `tests/unit/storage/in-memory-vector-store.ts`
   の API シグネチャの一致を確認（`IVectorStore` インターフェースの全メソッド）
2. Contract Tests（`tests/shared/vector-store-contract.ts`、本設計で新規作成）を
   **先に作成** し、両方の実装に対して実行。全テストがパスすることを確認
3. 差異が見つかった場合、`InMemoryVectorStore` 側を修正して一致させる

**Step 2: 既存ユニットテストの `InMemoryVectorStore` 移行確認**

現在の全ユニットテスト（`tests/unit/indexer/pipeline.test.ts` 等）が
`tests/unit/storage/in-memory-vector-store.ts` の `InMemoryVectorStore` を使用して
いることを確認する。`src/storage/vector-store.ts` を直接 import しているテストが
存在する場合は、`InMemoryVectorStore` への import 切り替えを行う。

**Step 3: `src/storage/vector-store.ts` の LanceDB 書き換え**

Step 1-2 の検証完了後、`src/storage/vector-store.ts` を `@lancedb/lancedb` による
本番実装に全面書き換えする。この時点でインメモリロジックは
`tests/unit/storage/in-memory-vector-store.ts` に完全に退避済みであり、ユニットテストへの
影響はない。

**Step 4: テスト構成の最終確認**

書き換え完了後、以下のテスト構成が成立していることを確認:

| テストレベル | 対象実装 | テストファイル |
|-------------|---------|---------------|
| ユニットテスト | `InMemoryVectorStore` | `tests/unit/storage/in-memory-vector-store.test.ts` |
| インテグレーションテスト | `LanceVectorStore`（LanceDB） | `tests/integration/vector-store.test.ts` |
| 両方 | Contract Tests 共通スイート | `tests/shared/vector-store-contract.ts` |

`IVectorStore` インターフェースには `close()` メソッドを追加する（後述）。
それ以外の DI 境界はそのまま維持する。

### コンストラクタ・初期化

```typescript
interface LanceVectorStoreOptions {
  dbPath: string;       // e.g. "<projectRoot>/.nexus/lancedb"
  dimensions: number;   // embedding 次元数
}
```

- `constructor(options)` — オプションを保持するのみ。I/O はしない
- `async initialize()` — `lancedb.connect(dbPath)` でデータベース接続。
  `chunks` テーブルが存在しなければ作成。`dbPath` のディレクトリが存在しなければ
  `mkdir -p` 相当で作成
- `async close()` — DB 接続およびテーブルハンドルを解放する（後述「リソースクローズ」参照）

### ストレージパス

```
<projectRoot>/.nexus/lancedb/    ← LanceDB データベースディレクトリ
```

テーブルは `chunks` の1テーブル構成。

### テーブルスキーマ

元設計仕様書（`2026-04-03-codebase-index-mcp-server-design.md`）に準拠:

| Column | Type | Description |
|--------|------|-------------|
| id | string | チャンク一意識別子（`filePath:startLine-endLine`） |
| filePath | string | ソースファイル相対パス |
| content | string | チャンクテキスト |
| language | string | プログラミング言語識別子 |
| symbolName | string | シンボル名（nullable） |
| symbolKind | string | シンボル種別（nullable） |
| startLine | uint32 | 開始行 |
| endLine | uint32 | 終了行 |
| vector | FixedSizeList\<float32\> | embedding ベクトル |

### フィルタ値エスケープ（インジェクション対策）

LanceDB の `table.delete()`, `table.update()`, `table.query().where()` は全て
SQL フィルタ文字列を受け取る API 設計であり、**パラメータ化クエリ（prepared statement）は
提供されていない**。

したがって、フィルタに埋め込む値のエスケープはアプリケーション層で行う必要がある。
`LanceVectorStore` 内にプライベートユーティリティを設ける:

#### 事前フォーマット検証（ホワイトリスト方式）

エスケープ処理（`escapeFilterValue`）のみに依存する防御は、DataFusion パーサーの
未知のバイパス手法に対する脆弱性リスクが高い。**エスケープの前段階**で入力値の
フォーマットを厳密に検証し、許可された文字セットのみで構成されていることを保証する。

この検証は `PathSanitizer.sanitize()` による**パストラバーサル防御とは異なるレイヤー**
の防御である。`PathSanitizer` はファイルシステム上のパス正規化とシンボリックリンク解決を
行うが、フィルタ値に混入する制御文字や SQL 構文要素の検出は行わない。

```typescript
/**
 * フィルタ値の事前フォーマット検証（ホワイトリスト方式）。
 * escapeFilterValue() の前に呼び出し、許可された文字セット以外を含む入力を拒否する。
 *
 * 許可文字: Unicode の印刷可能文字（文字・数字・句読点・空白・記号カテゴリ）
 * 禁止: 制御文字(\p{Cc}: \x00-\x1f, \x7f-\x9f 等)、未割当コードポイント、
 *       Private Use Area、サロゲートペア断片
 *
 * ES2018 Unicode Property Escapes を使用（Node.js >= 10, TypeScript target ES2018+ で利用可能）。
 * Nexus の要件: Node.js >= 22.0.0, TypeScript target ES2023 — 完全にサポート。
 */
private static readonly ALLOWED_FILTER_VALUE_PATTERN = /^[\p{L}\p{N}\p{P}\p{Z}\p{S}]*$/u;
private static readonly FORBIDDEN_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

private validateFilterValue(value: string, paramName: string): void {
  // 1. 制御文字の混入チェック（\0, \n, \r, \t 等）
  if (LanceVectorStore.FORBIDDEN_CONTROL_CHARS.test(value)) {
    throw new Error(
      `Invalid ${paramName}: contains control characters that could compromise filter integrity`
    );
  }

  // 2. 許可された印刷可能 Unicode 文字のみで構成されているか
  if (!LanceVectorStore.ALLOWED_FILTER_VALUE_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${paramName}: contains characters outside the allowed set (printable Unicode only)`
    );
  }
}
```

**設計判断:**

- **印刷可能 Unicode 許容（`\p{L}\p{N}\p{P}\p{Z}\p{S}`）:** Nexus は任意のプロジェクトの
  コードベースをインデックスする MCP サーバーであり、非英語圏のファイル名（例: `仕様書.md`、
  `données/config.yaml`）やマルチバイトシンボル名は正当なユースケースとして存在する。
  ASCII 限定ではこれらのプロジェクトでインデックスパイプラインがクラッシュする致命的な
  制限となるため、Unicode Property Escapes により正当な印刷可能文字を広く許容する。
  各 Unicode General Category の役割:
  - `\p{L}` — Letter（全言語の文字: CJK、キリル、アラビア文字等）
  - `\p{N}` — Number（数字）
  - `\p{P}` — Punctuation（句読点: `.`, `-`, `_`, `/` 等パス区切りを含む）
  - `\p{Z}` — Separator（空白文字。ただし制御文字カテゴリの改行等は含まない）
  - `\p{S}` — Symbol（記号: 絵文字、数学記号等）
- **制御文字は引き続き拒否:** `FORBIDDEN_CONTROL_CHARS`（`\x00-\x1f`, `\x7f`）による
  先行チェックに加え、`ALLOWED_FILTER_VALUE_PATTERN` 自体が `\p{Cc}`（制御文字カテゴリ）を
  含まないため、制御文字は二重に排除される
- **DataFusion とのリスク評価:** SQL インジェクションに使用される構文要素（`'`, `\`, `;`,
  `--`, `/*`）は全て ASCII 文字であり、L3（`escapeFilterValue()`）でエスケープ処理される。
  Unicode 文字自体が DataFusion の SQL パーサーの構文を破壊するリスクは、DataFusion が
  Apache Arrow の UTF-8 ネイティブ設計に基づいている点から極めて低い
- **即座に例外スロー:** 検証に失敗した入力はエスケープ処理に到達させず、
  `Error` を即座にスローする。これにより不正入力がフィルタ文字列に混入する
  経路を完全に遮断する
- **`paramName` パラメータ:** エラーメッセージにどのパラメータが不正だったかを
  含めることで、デバッグ効率を向上させる

#### エスケープユーティリティ

```typescript
/**
 * LanceDB フィルタ文字列に埋め込む値のエスケープ。
 * シングルクォートを二重化し、バックスラッシュをエスケープする。
 * 必ず validateFilterValue() による事前検証を通過した値に対して呼び出すこと。
 */
private escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/**
 * LIKE 句に埋め込む値の追加エスケープ。
 * escapeFilterValue() によるクォート・バックスラッシュのエスケープに加え、
 * LIKE 句のワイルドカード文字（`_` と `%`）をリテラルとして扱うためにエスケープする。
 *
 * 例: `src/my_file.ts` → `src/my\_file.ts`（`ESCAPE '\'` と併用）
 *
 * ファイルパスには `_` が極めて一般的に含まれるため（例: `my_module`, `test_utils`）、
 * このエスケープなしでは `deleteByPathPrefix('src/my_file')` が `src/myXfile`
 * のような意図しないファイルにもマッチし、データ損失のリスクがある。
 *
 * DataFusion（LanceDB の内部 SQL エンジン）は SQL 標準の `ESCAPE` 句を
 * サポートしている。`\` をエスケープ文字として指定することで、
 * `\_` と `\%` がリテラルとして解釈される。
 */
private escapeLikeValue(value: string): string {
  // 1. 先に通常のフィルタ値エスケープ（クォート、バックスラッシュ）
  const escaped = this.escapeFilterValue(value);
  // 2. LIKE ワイルドカードをエスケープ（バックスラッシュは既にエスケープ済み）
  //    注: escapeFilterValue で \ → \\ に変換済みのため、
  //    ここでは \_ と \% を追加するだけでよい
  return escaped.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** filePath 完全一致フィルタを構築する */
private filePathFilter(filePath: string): string {
  this.validateFilterValue(filePath, 'filePath');
  return `filePath = '${this.escapeFilterValue(filePath)}'`;
}

/** filePath プレフィックス一致フィルタを構築する */
private filePathPrefixFilter(prefix: string): string {
  this.validateFilterValue(prefix, 'prefix');
  // escapeLikeValue で _ と % をエスケープした後、末尾に LIKE ワイルドカード % を付与
  // ESCAPE '\' により \_ と \% がリテラルとして解釈される
  return `filePath LIKE '${this.escapeLikeValue(prefix)}%' ESCAPE '\\'`;
}
```

**エッジケースのリスク:** 上記のエスケープは `\` と `'` の2文字を対象としているが、
これだけでは全ての攻撃ベクトルをカバーできない可能性がある。LanceDB のフィルタパーサーは
内部的に DataFusion（Apache Arrow SQL エンジン）を使用しており、以下の入力に対する
振る舞いが未定義・未検証である:

- **制御文字** — `\0`（null byte）、`\n`、`\r`、`\t` 等がフィルタ構文を破壊する可能性
- **不正なエンコーディング** — 非 UTF-8 バイトシーケンスによるパーサー誤動作
- **SQL 構文要素** — `;`、`--`、`/*` 等のコメント構文や文終端がフィルタ文字列内で解釈される可能性
- **Unicode 正規化** — 同一に見える異なるコードポイント（NFC/NFD）によるフィルタ一致の不整合
- **LIKE ワイルドカード** — `_`（任意の1文字）と `%`（任意の0文字以上）がリテラルではなくパターンとして解釈される

上記のうち**制御文字**と**不正エンコーディング**は事前フォーマット検証（L2: `validateFilterValue()`）
により遮断される。`FORBIDDEN_CONTROL_CHARS` が `\x00-\x1f`, `\x7f` を明示的にブロックし、
`ALLOWED_FILTER_VALUE_PATTERN` が印刷可能 Unicode カテゴリ以外の文字（未割当コードポイント、
Private Use Area 等）を拒否する。
**SQL 構文要素**（`;`, `--`, `/*`）は印刷可能 ASCII 範囲内だがエスケープ処理（L3）で無害化
される。**LIKE ワイルドカード**（`_`, `%`）は L3.5（`escapeLikeValue()`）で `\_`, `\%` に
エスケープされ、`ESCAPE '\'` 句により DataFusion がリテラルとして解釈する。
**Unicode 正規化**については、NFC/NFD の差異はフィルタの一致判定に影響しうるが、
これはデータ破壊やインジェクションには繋がらない（「検索ヒットしない」問題に限定される）。
正規化の一貫性は、ファイルシステムとインデックスパイプラインの間で NFC 正規化
（将来的に `String.prototype.normalize('NFC')` の適用を検討）により保証する。

これらのリスクに対しては、検証関数とエスケープ関数に対する**セキュリティ単体テスト**
（後述「テスト戦略」セクション参照）を TDD の Red フェーズで先行実装し、振る舞いを
明示的に定義・検証する。

**防御の多層性（4層構造）:**

| レイヤー | コンポーネント | 防御対象 |
|----------|--------------|----------|
| L1: ツールハンドラ | `PathSanitizer.sanitize()` | パストラバーサル、シンボリックリンク攻撃 |
| L2: ストレージ層（検証） | `validateFilterValue()` | 制御文字混入、不正エンコーディング、未割当コードポイント、Private Use Area |
| L3: ストレージ層（エスケープ） | `escapeFilterValue()` | SQL インジェクション（クォート、バックスラッシュ） |
| L3.5: ストレージ層（LIKE エスケープ） | `escapeLikeValue()` | LIKE ワイルドカード（`_`, `%`）のリテラル化 |

各レイヤーは独立して機能し、いずれか1つが突破されても後段で捕捉する。
`escapeLikeValue()` は `filePathPrefixFilter()` でのみ使用され、完全一致フィルタ
（`filePathFilter()`）では不要である。

以下の CRUD 操作は全て事前検証 → エスケープの2段階を経由してフィルタ文字列を構築する。

### CRUD 操作

#### upsertChunks(filePath, chunks, vectors)

LanceDB の `mergeInsert()` API を使い、**単一操作での upsert** を行う:

```typescript
await table
  .mergeInsert('id')
  .whenMatchedUpdateAll()
  .whenNotMatchedInsertAll()
  .execute(rows);
```

`id` カラム（`filePath:startLine-endLine`）をマッチキーとする。既存の同一 `id` の
レコードは全カラム更新され、新規 `id` のレコードは挿入される。

同一 `filePath` の古いチャンク（行範囲変更によりもはや新データに含まれないもの）の
扱いは、`mergeInsert` の振る舞いによって最終的な実装パスが分岐する。

#### TDD Spike による `mergeInsert` 振る舞い検証

`mergeInsert` が「マッチキーに存在しない旧行を自動削除するか」は LanceDB のドキュメントから
一義的に確定できない。**本番実装に入る前に、TDD の枠組み内で Spike（技術検証）テストを
実施し、この振る舞いを確定させる。**

> [!IMPORTANT]
> **LanceDB ターゲットバージョンの固定:** `mergeInsert` の振る舞い（旧行の自動削除の有無、
> `whenMatchedUpdateAll` / `whenNotMatchedInsertAll` の詳細セマンティクス）は
> `@lancedb/lancedb` のバージョンに依存する可能性がある。Spike テストの結果を確定させる際、
> テスト実行時の **`@lancedb/lancedb` のバージョンを `package.json` で固定（exact version）** し、
> テストファイル内にも前提バージョンをコメントとして明記すること。
>
> これにより、将来の `@lancedb/lancedb` バージョンアップ時に Spike テスト（→移動後の
> インテグレーションテスト）が **リグレッション検出テスト** として機能し、振る舞いの変更を
> CI パイプラインで即座に捕捉できる。バージョンアップで振る舞いが変わった場合は、
> テストの期待値と実装パス（A/B）の再評価を行うこと。

Spike テストは `tests/spike/mergeinsert-behavior.test.ts` に配置する:

```typescript
// tests/spike/mergeinsert-behavior.test.ts
// 前提: @lancedb/lancedb@<実行時のバージョンをここに記載>
// このテストの結果は上記バージョンでの振る舞いに基づく。
// バージョンアップ時のリグレッション検出テストとして維持する。
describe('Spike: mergeInsert behavior verification', () => {
  it('should clarify whether mergeInsert removes unmatched old rows', async () => {
    // 1. テーブルに id="file:1-10", id="file:11-20" の2行を挿入
    // 2. mergeInsert('id') で id="file:1-10", id="file:21-30" を実行
    //    （id="file:11-20" は新データに含まれない）
    // 3. テーブルの全行を取得し、id="file:11-20" が残っているか確認
    //    → 残っている場合: パス (B) を採用
    //    → 削除されている場合: パス (A) を採用
  });
});
```

> [!CAUTION]
> **Spike 検証フェーズと本実装フェーズの分離（ブロック要件）**
>
> Spike テスト（`tests/spike/mergeinsert-behavior.test.ts`）のコードを作成した後、
> **必ずテストランナー（`vitest`）で実際に実行し、LanceDB の `mergeInsert` の振る舞いが
> パス (A)（旧行自動削除）かパス (B)（旧行残存）かを実証的に確定させること。**
>
> **以下の作業は、Spike テストの実行が完了し、結果が確定するまで絶対に着手してはならない:**
>
> 1. Contract Tests（`tests/shared/vector-store-contract.ts`）における
>    「同一 filePath の再 upsert」テストケースの期待値定義
> 2. `LanceVectorStore`（`src/storage/vector-store.ts`）の `upsertChunks()` 本実装
> 3. 上記に依存する全てのテストの Red-Green サイクル
>
> **この制約の理由:**
>
> - `mergeInsert` の振る舞い（旧行を自動削除するか否か）は LanceDB のドキュメントから
>   一義的に確定できず、**実行結果のみが正解** である
> - 結果を「予測」して先行実装すると、予測が外れた場合に Contract Tests の期待値、
>   `upsertChunks()` の実装パス、障害時リカバリの前提が全て崩壊し、
>   大規模な手戻りが発生する
> - TDD の原則上、テストの期待値は「正確に検証された事実」に基づくべきであり、
>   未検証の仮説に基づいてはならない
>
> **AI エージェントへの指示:** Spike テストの実行結果をテストランナーの出力ログとして
> 確認し、「パス (A) が確定した」または「パス (B) が確定した」をコメントとして
> テストファイルに記録してから、次のフェーズに進むこと。テストを書いただけで
> 実行していない状態での本実装着手は **TDD 原則違反** として扱う。

**Spike の結果に基づく実装パス:**

- **(A)** `mergeInsert` が旧行を自動削除する場合 — `mergeInsert` 単一操作で完結。
  最もアトミックであり、障害時リカバリセクションの中間障害リスクが排除される
- **(B)** `mergeInsert` が旧行を自動削除しない場合 — delete-then-add の2段階操作:

```typescript
await table.delete(this.filePathFilter(filePath));  // 旧チャンク全削除
await table.add(rows);                               // 新チャンク全挿入
```

**Spike の結果は Contract Tests の仕様を確定させる。** 具体的には、
`vectorStoreContractTests` 内の「同一 filePath の再 upsert — 旧チャンクが新チャンクに
置換される」テストケースの期待値が、Spike の結果に基づいて定義される。Spike 完了まで
このテストケースの Red フェーズには入らない。

**Spike 完了後のクリーンアップ方針:** Spike テスト（`tests/spike/mergeinsert-behavior.test.ts`）
は結論確定後に `tests/integration/mergeinsert-behavior.test.ts` へ移動し、恒久的な
インテグレーションテストとして維持する。**このテストは LanceDB のバージョンアップ時に
`mergeInsert` の振る舞い退行を CI で即座に検出するリグレッションガードとして不可欠であり、
削除や skip を禁止する。** テストファイル冒頭の前提バージョンコメントと `package.json` の
実際のバージョンが乖離した場合、テスト結果の再検証をトリガーする運用とする。
`tests/spike/` ディレクトリにファイルが残存する状態を許容しない。

#### upsertChunks の障害時リカバリ

LanceDB（Lance v2 フォーマット）は append-only であり、`delete` は tombstone マーキング、
`add` は新フラグメント追加として実行される。**跨操作トランザクションは提供されない**ため、
2段階操作（delete → add）の中間でクラッシュした場合、以下の状態が発生しうる:

| 障害タイミング | 結果状態 | リカバリ |
|----------------|----------|----------|
| delete 完了前 | 変更なし（旧データ維持） | 不要 |
| delete 完了後、add 前 | 旧チャンクが tombstone 化、新チャンク未追加 | 起動時 Reconciliation が検出・修復 |
| add 完了後 | 正常状態 | 不要 |

**Reconciliation によるリカバリ:** Nexus は起動時に `reconcileOnStartup()` を実行し、
SQLite Merkle Tree のハッシュとファイルシステムの実態を突き合わせる。ベクトルストアに
チャンクが存在しないファイルは「hash mismatch」として再インデックスキューに追加される。
したがって、中間障害によるデータ欠損は **次回起動時に自動的に修復される**（結果整合性）。

> **非機能要件上の設計判断（一時的な検索欠落の許容）:**
> delete 完了後〜add 完了前にクラッシュした場合、該当ファイルのチャンクは次回起動時の
> `reconcileOnStartup()` まで検索不能（欠落状態）となる。この一時的なダウンタイムは、
> 以下の理由から **許容される設計判断** として採用する:
>
> 1. **MCP サーバーの性質:** Nexus は常時稼働のサービスではなく、クライアント要求に応じて
>    起動されるプロセスである。クラッシュ後の再起動は通常のリカバリフローに含まれる
> 2. **自動修復の保証:** `reconcileOnStartup()` が全ファイルのハッシュ整合性を検証し、
>    欠落を自動検出・再インデックスするため、手動介入は不要
> 3. **YAGNI:** WAL（Write-Ahead Log）やジャーナリング機構を自作する複雑性は、
>    このユースケースにおけるリスク（中間クラッシュの発生頻度 × 影響範囲）に対して
>    過剰であり、保守コストが見合わない
>
> この挙動はバグではなく意図された結果整合性モデルである。将来の開発者がこの一時的な
> 検索欠落を観測した場合、本セクションを参照し、修正不要であることを確認されたい。

#### deleteByFilePath(filePath)

```typescript
await table.delete(this.filePathFilter(filePath));
```

#### deleteByPathPrefix(prefix)

```typescript
await table.delete(this.filePathPrefixFilter(prefix));
```

#### renameFilePath(oldPath, newPath)

```typescript
const result = await table.update({
  where: this.filePathFilter(oldPath),
  values: { filePath: newPath },
});
return result.count;  // table.update() が直接返す更新行数を使用
```

LanceDB の `table.update()` は更新行数を含むオブジェクトを返す（API ドキュメント:
"resolving to the number of rows affected and the new version number"）。
事前の `countRows()` は不要であり、**TOCTOU 競合を回避**する。

#### search(queryVector, topK, filter?)

```typescript
table.vectorSearch(queryVector).limit(topK)
```

filter がある場合は `.where()` で絞り込み。結果はスコア降順。
filter 値にもエスケープユーティリティを適用する。

### ベクトルインデックス戦略（Exact KNN vs ANN）

本設計では **`table.createIndex()` によるベクトルインデックス（IVF-PQ 等）の構築は行わず、
Exact KNN（全件走査）による検索を採用する。**

LanceDB は `vectorSearch()` 呼び出し時にベクトルインデックスが存在しない場合、自動的に
Exact KNN（全件ブルートフォース走査）にフォールバックする。この動作は明示的に利用可能であり、
インデックスなしでも `vectorSearch()` API は正常に動作する。

**設計判断の根拠:**

1. **データ規模:** Nexus は単一プロジェクトのコードベースをインデックスする MCP サーバーであり、
   チャンク数は通常 数百〜数万行の規模に留まる。LanceDB の IVF-PQ インデックスは
   数千行以上（推奨は数万行以上）のデータで初めて効果を発揮するため、現段階では
   Exact KNN で十分な検索性能が得られる
2. **YAGNI:** インデックス構築・管理ロジック（パーティション数やサブベクトル数の
   チューニング、インデックス再構築タイミングの制御等）は実装・保守の複雑性を
   増大させる。現時点で性能問題が顕在化していない段階での導入は過剰設計である
3. **Compaction との相互作用:** LanceDB の `table.optimize()` 実行後はインデックスの
   再構築が必要になる場合がある。Exact KNN であれば Compaction 後のインデックス
   再構築を考慮する必要がなく、設計がシンプルになる

> [!NOTE]
> **将来の ANN インデックス移行パス:** データ規模の増大により Exact KNN の検索レイテンシが
> 許容範囲を超えた場合、以下の手順で ANN インデックスに移行する:
>
> 1. ベンチマークで Exact KNN の性能ボトルネックを定量的に確認
> 2. `table.createIndex()` による IVF-PQ インデックス構築を `compactIfNeeded()` の
>    後続処理として実装（Compaction 後のインデックス再構築を統合）
> 3. `LanceVectorStoreOptions` にインデックス設定パラメータを追加
>
> この移行は API 変更を伴わず（`vectorSearch()` は自動的にインデックスを使用する）、
> 既存の `IVectorStore` インターフェースへの影響はない。

#### getStats()

`table.countRows()` でレコード数を取得し、フラグメンテーション率とともに返す。

### リソースクローズ（`close()` メソッド）

`IVectorStore` インターフェースに `close()` メソッドを追加し、DB 接続およびテーブル
ハンドルの確実な解放を保証する。

```typescript
// IVectorStore インターフェースへの追加
export interface IVectorStore {
  // ... 既存メソッド ...
  close(): Promise<void>;
}
```

#### In-flight I/O トラッキングと安全なクローズ

LanceDB の CRUD 操作（`mergeInsert`, `vectorSearch`, `delete`, `update` 等）は
非同期であり、`close()` 呼び出し時に実行中の操作が存在する場合がある。LanceDB の
Node.js クライアントは個々の操作に対する完全な `AbortSignal` サポートを保証しておらず、
`this.table = undefined` で参照を即座にクリアすると以下のリスクが発生する:

- **未ハンドルの Promise 拒否:** 実行中の操作が `this.table` を参照した時点で
  `TypeError: Cannot read properties of undefined` がスローされる
- **データ不整合:** `mergeInsert` や `delete` 等の書き込み操作が中断される可能性

これを防止するため、**インフライト I/O カウンタ** を導入し、`close()` が全ての
実行中操作の完了を待機してからリソースを解放する設計とする。

```typescript
private inflightOps = 0;
private closingResolve: (() => void) | undefined = undefined;
private closing = false;

/**
 * インフライト I/O 操作をトラッキングするラッパー。
 * 全ての DB 操作（mergeInsert, vectorSearch, delete, update, countRows）を
 * このメソッド経由で実行する。
 */
private async trackOp<T>(op: () => Promise<T>): Promise<T> {
  if (this.closing) {
    throw new Error('VectorStore is closing, no new operations accepted');
  }
  this.inflightOps++;
  try {
    return await op();
  } finally {
    this.inflightOps--;
    if (this.closing && this.inflightOps === 0 && this.closingResolve) {
      this.closingResolve();
    }
  }
}
```

`LanceVectorStore` の `close()` 実装:

```typescript
// インフライト I/O 待機のタイムアウト（ms）。
// ネイティブバインディングのデッドロック等で操作がハングした場合に
// シャットダウンが永久にブロックされることを防ぐ安全装置。
private static readonly CLOSE_TIMEOUT_MS = 5_000;

async close(): Promise<void> {
  if (this.closing) {
    // 既にクローズ処理中 — 冪等性を保証
    return;
  }
  this.closing = true;

  // インフライト操作が残っている場合は完了を待機（タイムアウト付き）
  if (this.inflightOps > 0) {
    const inflightDone = new Promise<void>((resolve) => {
      this.closingResolve = resolve;
    });

    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), LanceVectorStore.CLOSE_TIMEOUT_MS);
    });

    const result = await Promise.race([inflightDone.then(() => 'done' as const), timeout]);

    if (result === 'timeout') {
      // タイムアウト: インフライト操作の完了を待ちきれなかった。
      // ネイティブレベルのバグや I/O デッドロックの可能性がある。
      // 操作の完了を諦め、リソースを強制解放する。
      console.error(
        `[LanceVectorStore] close() timed out after ${LanceVectorStore.CLOSE_TIMEOUT_MS}ms ` +
        `with ${this.inflightOps} in-flight operation(s). Forcing resource release.`
      );
    }
  }

  // 全操作完了後（またはタイムアウト後）にリソースを解放
  // （Connection は明示的な close API を持たないため、
  // 参照解放により GC での回収を促進する）
  this.table = undefined;
  this.db = undefined;
  this.closing = false;
  this.closingResolve = undefined;
}
```

**CRUD 操作での `trackOp` 使用例:**

```typescript
async upsertChunks(filePath: string, chunks: Chunk[], vectors: number[][]): Promise<void> {
  // ... 検証・データ準備 ...
  await this.trackOp(() =>
    this.table!.mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows)
  );
}

async search(queryVector: number[], topK: number, filter?: string): Promise<SearchResult[]> {
  return this.trackOp(() => {
    let query = this.table!.vectorSearch(queryVector).limit(topK);
    if (filter) {
      query = query.where(filter);
    }
    return query.toArray();
  });
}
```

**設計判断:**

- **LanceDB の接続モデル:** `@lancedb/lancedb` の `Connection` オブジェクトは現時点で
  明示的な `close()` API を提供していない（ファイルシステムベースのストレージであり、
  TCP 接続のような永続的リソースを保持しない）。ただし、参照を `undefined` にリセット
  することで、GC による Rust 側リソース（Neon binding）の回収を確実にする
- **将来の拡張性:** LanceDB が将来的に `close()` や `dispose()` を提供した場合に
  即座に対応できるよう、インターフェースレベルで `close()` を定義しておく
- **`InMemoryVectorStore` の実装:** テスト用のインメモリ実装では `close()` は no-op
  （`async close(): Promise<void> {}`）とする。`trackOp` は `LanceVectorStore`
  固有の実装であり、`IVectorStore` インターフェースには含めない
- **インフライト I/O カウンタの軽量性:** `inflightOps` は単純なカウンタであり、
  `Map` やキュー等のデータ構造を保持しないため、パフォーマンスへの影響は無視できる。
  `Promise.allSettled` パターンも検討したが、各操作の Promise を個別に追跡する
  必要がありメモリオーバーヘッドが大きいため、カウンタ方式を採用した

#### ライフサイクル統合

`close()` は以下の箇所から呼び出される:

| 呼び出し元 | タイミング | 目的 |
|-----------|-----------|------|
| `IndexPipeline.stop()` | パイプライン停止時 | プロセスシャットダウン時のリソース解放 |
| Contract Test `cleanup` | テストケース終了時 | テスト環境のリソースリーク防止 |
| `NexusServer` シャットダウン | MCP サーバー終了時 | SIGTERM/SIGINT ハンドラから呼び出し |

**`IndexPipeline.stop()` の更新:**

```typescript
async stop(): Promise<void> {
  // 1. AbortController でバックグラウンド処理全体にキャンセルを通知
  //    これにより新規のインデックス処理やコンパクション処理は開始されない
  this.abortController.abort();

  // 2. タイマーを明示的にクリア
  if (this.idleCompactionTimer !== undefined) {
    clearTimeout(this.idleCompactionTimer);
    this.idleCompactionTimer = undefined;
  }

  // 3. DLQ リカバリループの停止
  if (this.dlqStopper !== undefined) {
    await this.dlqStopper();
    this.dlqStopper = undefined;
  }

  // 4. ベクトルストアの接続をクローズ
  //    close() は内部でインフライト I/O の完了を待機するため、
  //    実行中の mergeInsert や vectorSearch が安全に完了してから
  //    リソースが解放される
  await this.options.vectorStore.close();
}
```

**Contract Test `cleanup` の更新:**

```typescript
// LanceVectorStore の Contract Test ファクトリ
vectorStoreContractTests(async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-'));
  const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
  await store.initialize();
  return {
    store,
    cleanup: async () => {
      await store.close();  // DB 接続を解放してからディレクトリを削除
      await rm(tmpDir, { recursive: true });
    },
  };
});
```

### エラーハンドリング

- テーブル接続エラーはそのまま上位に伝播（Pipeline の retry 機構でカバー）
- フィルタ値のエスケープは前述の `escapeFilterValue()` で一元化
- `close()` は冪等であり、複数回呼び出しても安全（`closing` フラグにより二重クローズを防止）
- `close()` はインフライト I/O の完了を待機してからリソースを解放する（`trackOp` カウンタ方式）
- `close()` のインフライト I/O 待機にはタイムアウト（`CLOSE_TIMEOUT_MS`: 5000ms）が設定されており、
  ネイティブバインディングのデッドロック等で操作がハングした場合でもシャットダウンが永久にブロックされない
  （タイムアウト時はエラーログを出力し、リソースを強制解放する）
- `closing` 状態では `trackOp` が新規操作を拒否し、`Error` をスローする

## Compaction Pipeline 統合

### Post-reindex コンパクション

`src/indexer/pipeline.ts` の `reindex()` メソッド内、`tryAcquire(this.mutex).runExclusive()`
の排他ブロック末尾に `compactAfterReindex()` 呼び出しを追加する。

実際の `pipeline.ts` は `async-mutex` パッケージの `tryAcquire` / `runExclusive` パターンを
採用しており、`mutex.acquire()` / `mutex.release()` の手動管理は行わない。`runExclusive` は
コールバック関数の実行完了後（正常終了・例外スローの両方）に自動的にロックを解放するため、
`finally` ブロックでの明示的な `release()` は不要である。

```typescript
import { Mutex, E_ALREADY_LOCKED, tryAcquire } from 'async-mutex';

async reindex(
  run: (options?: { fullScan?: boolean; reason?: 'manual' }) => Promise<IndexEvent[]>,
  loadContent: ContentLoader,
  fullRebuild?: boolean,
): Promise<ReindexResult | { status: 'already_running' }> {
  try {
    return await tryAcquire(this.mutex).runExclusive(async () => {
      try {
        // ... 既存のリインデックス処理（run, processEvents 等） ...

        // リインデックス完了後、Mutex 排他ブロック内でコンパクション実行
        // best-effort: 失敗してもリインデックス結果には影響しない
        try {
          await this.options.vectorStore.compactAfterReindex();
        } catch (compactionError) {
          console.error('Post-reindex compaction failed (non-fatal):', compactionError);
        }

        return { /* ReindexResult */ };
      } finally {
        if (fullRebuild && this.options.eventQueue) {
          this.options.eventQueue.markFullScanComplete();
        }
      }
      // runExclusive がここで自動的に mutex を解放する
    });
  } catch (e) {
    if (e === E_ALREADY_LOCKED) {
      // 既にリインデックスが実行中 — 重複実行を防止
      return { status: 'already_running' as const };
    }
    throw e;
  }
}
```

**`tryAcquire` パターンの設計意図:**

- `tryAcquire(this.mutex)` はロック取得を **非ブロッキング** で試行する。ロックが
  既に保持されている場合は `E_ALREADY_LOCKED` をスローし、呼び出し元で
  `{ status: 'already_running' }` を返す
- `runExclusive(async () => { ... })` のコールバック内で `compactAfterReindex()` を
  呼び出すことで、コンパクションが排他制御下で実行されることを保証する
- コンパクション失敗は `try/catch` で捕捉し、ログ出力のみで握りつぶす（best-effort）

**エラーハンドリング:** コンパクション失敗はログ出力（`console.error`）のみで reindex
自体は成功扱い。コンパクションは best-effort であり、失敗しても次回のトリガーで再試行される。

### Idle-time コンパクション

`start()` メソッドでタイマーを登録する:

```
start() {
  // ... 既存の処理 ...
  this.idleCompactionTimer = this.options.vectorStore.scheduleIdleCompaction(
    () => this.options.vectorStore.compactIfNeeded(),
    IDLE_COMPACTION_DELAY_MS,  // デフォルト: 300,000ms (5分)
    this.mutex,                // CompactionMutex として渡す
    this.abortController.signal,
  )
}
```

#### タイマーのライフサイクル管理（リソースリーク防止）

バックグラウンドタイマーが Node.js のイベントループを不必要に占有し、MCP サーバーの
グレースフルシャットダウンを妨害するリスクを排除するため、以下のライフサイクル管理を適用する。

**`unref()` の適用:**

`scheduleIdleCompaction()` が返す `NodeJS.Timeout` に対して `.unref()` を呼び出す。
これにより、このタイマーがイベントループ内で唯一のアクティブな参照である場合、プロセスの
終了を妨げない。

```typescript
start() {
  // ... 既存の処理 ...
  this.idleCompactionTimer = this.options.vectorStore.scheduleIdleCompaction(
    () => this.options.vectorStore.compactIfNeeded(),
    IDLE_COMPACTION_DELAY_MS,
    this.mutex,
    this.abortController.signal,
  );
  // タイマーがイベントループを保持しないようにする
  this.idleCompactionTimer.unref();
}
```

> **先行事例:** `src/server/transport.ts` のセッションクリーンアップタイマーで同一パターン
> （`interval.unref()`）が採用されており、Nexus プロジェクトの確立された慣行に準拠する。

**`stop()` メソッドでの確実な破棄:**

```typescript
stop() {
  // 1. AbortController でバックグラウンド処理全体にキャンセルを通知
  this.abortController.abort();

  // 2. タイマーを明示的にクリア
  if (this.idleCompactionTimer !== undefined) {
    clearTimeout(this.idleCompactionTimer);
    this.idleCompactionTimer = undefined;
  }
}
```

**設計上の保証:**

| シナリオ | 防御メカニズム |
|----------|---------------|
| 正常シャットダウン（`stop()` 呼び出し） | `clearTimeout()` + `abortController.abort()` によりタイマーとコールバック内処理の両方が確実に停止 |
| 異常終了（`stop()` 未呼び出し） | `unref()` により、タイマーだけではプロセスが終了を妨げられない |
| シグナルハンドリング（SIGTERM/SIGINT） | プロセス終了フックから `stop()` が呼ばれる場合は正常パスに帰着。呼ばれない場合も `unref()` がフォールバック |
| タイマーコールバック実行中のシャットダウン | `abortSignal.aborted` チェックによりコンパクション処理が早期中断 |

### AsyncMutex と CompactionMutex の接続

`CompactionMutex` インターフェース:

```typescript
interface CompactionMutex {
  waitForUnlock(abortSignal?: AbortSignal): Promise<void>;
}
```

Pipeline の `AsyncMutex` がこのインターフェースを直接満たさない場合は、薄いアダプターを
Pipeline 内に定義する:

```typescript
const compactionMutex: CompactionMutex = {
  waitForUnlock: (signal) => this.mutex.waitForUnlock({ signal }),
};
```

### LanceDB コンパクション操作

元設計仕様書のコンパクション戦略に準拠。LanceDB Node.js クライアントは統合 API
`table.optimize(options?)` を提供する:

```typescript
// MVCC 猶予期間（Grace Period）: 並行クエリが参照中のスナップショットを保護するため、
// 現在時刻ではなく設定可能な猶予期間分だけ過去の時刻を指定する。
// デフォルト: 5分（CLEANUP_GRACE_PERIOD_MS）
const CLEANUP_GRACE_PERIOD_MS = 5 * 60 * 1000; // 設定可能（コンストラクタオプションで上書き可）

const stats: OptimizeStats = await table.optimize({
  cleanupOlderThan: new Date(Date.now() - CLEANUP_GRACE_PERIOD_MS),
});
```

> [!WARNING]
> **`cleanupOlderThan: new Date()` を使用してはならない。**
> LanceDB は MVCC（Multi-Version Concurrency Control）を採用しており、検索クエリは
> 開始時点のバージョンスナップショットを読み取る。`new Date()`（現在時刻）を指定すると、
> 現在のバージョン以外の全マニフェストが即座に物理削除されるため、**並行して実行中の
> 検索クエリがスナップショットを喪失しクラッシュするリスク**がある。
>
> Nexus は MCP サーバーであり、複数のクライアントツール呼び出し（`search` 等）が
> `reindex` や idle compaction と並行して発生しうる。猶予期間を設けることで、
> コンパクション開始時点で既に実行中のクエリが安全に完了するまでの時間を確保する。
>
> **5分のデフォルト値の根拠:** 通常の検索クエリ実行時間（数秒〜数十秒）に対して
> 十分なマージンを確保しつつ、古いバージョンファイルがディスクを圧迫しない
> バランスを取った値。運用環境に応じて `LanceVectorStoreOptions` で調整可能とする。

`table.optimize()` は内部で以下を一括実行する:

1. **compact** — 小フラグメントの統合
2. **prune** — tombstone 化された行の物理削除
3. **cleanup** — 旧バージョンマニフェストの削除（`cleanupOlderThan` で制御。猶予期間内のバージョンは保持）

フラグメンテーション率の判定は `compactIfNeeded()` メソッド内で行い、閾値 20% 未満なら
`optimize()` 呼び出しをスキップする。

## テスト戦略

### Contract Tests（IVectorStore 共通テストスイート）

`InMemoryVectorStore` と `LanceVectorStore` は同一の `IVectorStore` インターフェースを
実装しており、CRUD の振る舞い仕様は同一である。DRY 原則に従い、**インターフェースの契約を
定義する共通テストスイート**を作成し、両実装がそれをパスすることを検証する。

```typescript
// tests/shared/vector-store-contract.ts

/**
 * IVectorStore の Contract Test スイート。
 * ファクトリ関数を受け取り、任意の IVectorStore 実装に対してテストを実行する。
 */
export function vectorStoreContractTests(
  factory: () => Promise<{ store: IVectorStore; cleanup: () => Promise<void> }>,
): void {
  // ファクトリが返す store に対して describe ブロック内でテストを定義
}
```

#### Contract Test ケース一覧

| カテゴリ | テストケース |
|----------|-------------|
| 初期化 | `initialize()` — 二重呼び出しで冪等 |
| Upsert | `upsertChunks()` → `search()` で取得可能 |
| Upsert | 同一 filePath の再 upsert — 旧チャンクが新チャンクに置換される |
| Delete | `deleteByFilePath()` — 該当ファイルのチャンクが全削除 |
| Delete | `deleteByPathPrefix()` — プレフィックス配下の全チャンク削除 |
| Rename | `renameFilePath()` — 新パスで検索可能、旧パスでは 0 件、更新行数が正確 |
| Search | ベクトル検索結果のスコア降順、topK 制限、filter 適用 |
| Stats | `getStats()` — レコード数が正確 |
| Close | `close()` — 二重呼び出しで冪等（例外をスローしない） |
| Close | `close()` 後の `initialize()` — 再接続が可能（テスト用途での再利用を想定） |

#### 各実装でのテストファイル

**`tests/unit/storage/in-memory-vector-store.test.ts`（新規作成）:**

```typescript
import { vectorStoreContractTests } from '../../shared/vector-store-contract.js';
import { InMemoryVectorStore } from './in-memory-vector-store.js';

describe('InMemoryVectorStore', () => {
  vectorStoreContractTests(async () => ({
    store: new InMemoryVectorStore({ dimensions: 64 }),
    cleanup: async () => {},
  }));
});
```

**`tests/integration/vector-store.test.ts`（`tests/unit/storage/vector-store.test.ts` から移動・書き換え）:**

```typescript
import { vectorStoreContractTests } from '../shared/vector-store-contract.js';
import { LanceVectorStore } from '../../src/storage/vector-store.js';

describe('LanceVectorStore (LanceDB integration)', () => {
  vectorStoreContractTests(async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-'));
    const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
    await store.initialize();
    return {
      store,
      cleanup: async () => {
        await store.close();  // DB 接続を解放してからディレクトリを削除
        await rm(tmpDir, { recursive: true });
      },
    };
  });

  // LanceDB 固有のテスト（Contract に含まれない実装固有の振る舞い）
  describe('LanceDB-specific', () => {
    it('compactIfNeeded() — コンパクション実行後にデータが維持される');
    it('永続化 — initialize 後にデータが再読み込み可能');
  });
});
```

### テストファイルの再配置

| 変更 | 移動元 | 移動先 |
|------|--------|--------|
| LanceDB 実統合テスト | `tests/unit/storage/vector-store.test.ts` | `tests/integration/vector-store.test.ts`（Contract Tests + LanceDB 固有テスト） |
| Contract Test スイート | (新規作成) | `tests/shared/vector-store-contract.ts` |
| InMemoryVectorStore テスト | (新規作成) | `tests/unit/storage/in-memory-vector-store.test.ts`（Contract Tests 適用） |

### 事前検証・エスケープ関数のセキュリティ単体テスト

`validateFilterValue()` と `escapeFilterValue()` はセキュリティ境界を守るコードであり、
TDD の Red フェーズで悪意ある入力パターンを先行定義する。
`tests/unit/storage/filter-validation-and-escape.test.ts` に配置:

#### validateFilterValue() テストケース

| カテゴリ | テスト入力例 | 期待する振る舞い |
|----------|-------------|-----------------|
| 正常パス（ASCII） | `src/utils/parser.ts` | 例外をスローしない |
| 正常パス（ドット付き） | `./src/index.ts` | 例外をスローしない |
| 正常パス（コロン付き ID） | `src/main.ts:1-10` | 例外をスローしない |
| 空文字列 | `""` | 例外をスローしない（空は許可） |
| Null バイト | `file\0path` | `Error` をスロー（制御文字検出） |
| 改行文字 | `file\npath` | `Error` をスロー（制御文字検出） |
| CR/LF混在 | `file\r\npath` | `Error` をスロー（制御文字検出） |
| タブ文字 | `file\tpath` | `Error` をスロー（制御文字検出） |
| DEL文字 | `file\x7fpath` | `Error` をスロー（制御文字検出） |
| 非ASCII（日本語） | `ソース/main.ts` | 例外をスローしない（`\p{L}` カテゴリとして許可） |
| 非ASCII（絵文字） | `src/🚀.ts` | 例外をスローしない（`\p{S}` カテゴリとして許可） |
| Unicode正規化（NFC/NFD差異） | NFC/NFD の異なる同一文字 | 不正なバイト列や制御文字を含まない限り許可される（正規化差異はインジェクションリスクではなく一致判定の問題） |
| 制御文字混入 Unicode | `ソース/ma\x00in.ts` | `Error` をスロー（制御文字検出で拒否） |
| Private Use Area | `\uE000path` | `Error` をスロー（許可カテゴリ外の文字として拒否） |
| BOM（Byte Order Mark） | `\uFEFFsrc/main.ts` | `Error` をスロー（`U+FEFF` は `\p{Cf}`（Format）カテゴリであり、許可カテゴリ `L/N/P/Z/S` に該当しないため拒否） |
| ゼロ幅スペース | `src/ma\u200Bin.ts` | `Error` をスロー（`U+200B` は `\p{Cf}`（Format）カテゴリであり、不可視文字がパス内に混入するリスクを排除） |

#### escapeFilterValue() テストケース

| カテゴリ | テスト入力例 | 期待する振る舞い |
|----------|-------------|-----------------|
| 基本エスケープ | `O'Brien` | `O''Brien` に変換される |
| バックスラッシュ | `path\to\file` | `path\\to\\file` に変換される |
| 複合攻撃 | `'; DROP TABLE chunks --` | フィルタ構文を破壊しない文字列に変換される |
| SQL コメント | `file /* comment */ path` | リテラルとして保持される |
| セミコロン | `file; SELECT * FROM t` | リテラルとして保持される |
| 空文字列 | `""` | 空のフィルタ値として安全に処理される |
| 超長文字列 | 10,000 文字のパス | 例外やバッファ溢れが発生しない |

#### escapeLikeValue() テストケース

| カテゴリ | テスト入力例 | 期待する振る舞い |
|----------|-------------|-----------------|
| アンダースコア含有パス | `src/my_file.ts` | `src/my\_file.ts` に変換される（`_` がリテラルとして扱われる） |
| パーセント含有パス | `src/100%.ts` | `src/100\%.ts` に変換される（`%` がリテラルとして扱われる） |
| 複合ワイルドカード | `src/my_module/100%_done` | `_` と `%` の両方がエスケープされる |
| ワイルドカード無しのパス | `src/utils/parser.ts` | 変換なし（`escapeFilterValue` と同一結果） |
| クォートとワイルドカード混在 | `src/O'Brien_file.ts` | クォートとアンダースコアの両方が正しくエスケープされる |

#### 統合フロー（filePathFilter / filePathPrefixFilter）テストケース

| カテゴリ | テスト入力 | 期待する振る舞い |
|----------|-----------|-----------------|
| 検証→エスケープ連携 | 制御文字を含むパス | `validateFilterValue` 段階で例外スロー（`escapeFilterValue` に到達しない） |
| 正常入力の貫通 | `src/utils/parser.ts` | 検証通過後、正しいフィルタ文字列が構築される |
| LIKE ワイルドカードの安全なプレフィックス検索 | `src/my_module` | `filePathPrefixFilter` が `LIKE 'src/my\_module%' ESCAPE '\'` を生成し、`src/myXmodule` にはマッチしない |
| ESCAPE 句の付与 | 任意のプレフィックス | `filePathPrefixFilter` の出力に `ESCAPE '\'` が含まれる |
| 完全一致フィルタに ESCAPE なし | 任意のファイルパス | `filePathFilter` の出力に `ESCAPE` 句が含まれない（LIKE を使用しないため不要） |

これらのテストを全てパスするまで `validateFilterValue()`、`escapeFilterValue()`、
`escapeLikeValue()` の実装を拡張する。`PathSanitizer` が正常パスのみを通す前提に
依存せず、ストレージ層の検証・エスケープ関数が単体で堅牢性を保証する。

### Pipeline テスト追加

`tests/unit/indexer/pipeline.test.ts` に以下を追加:

- `reindex()` 完了後に `compactAfterReindex()` が呼ばれること
- `compactAfterReindex()` 失敗時も reindex は成功扱い
- `start()` で idle compaction タイマーが登録されること
- `start()` で登録されたタイマーに `unref()` が適用されていること
- `stop()` でタイマーがクリアされ `undefined` にリセットされること
- `stop()` 呼び出し後、`abortController.signal` が abort 状態であること
- `stop()` 呼び出し時に `vectorStore.close()` が呼ばれること
- `stop()` の二重呼び出しでエラーが発生しないこと

### In-flight I/O テスト追加

`tests/unit/storage/vector-store-inflight.test.ts` に以下を追加:

- `trackOp` — 正常完了後にカウンタが 0 に戻ること
- `trackOp` — 操作が例外をスローしてもカウンタがデクリメントされること（finally 保証）
- `close()` — インフライト操作中に `close()` を呼び出すと、操作完了まで待機してから解放されること
- `close()` — インフライト操作が `CLOSE_TIMEOUT_MS` 以内に完了しない場合、タイムアウトでリソースが強制解放されること
- `close()` — タイムアウト発生時に `console.error` でエラーログが出力されること
- `close()` — `closing` 状態で `trackOp` を呼び出すと `Error` がスローされること
- `close()` — インフライト操作なしの場合は即座にリソースが解放されること
- `close()` — 二重呼び出しで冪等（2回目は即座に return）

### 既存テストへの影響

| ファイル | 影響 |
|----------|------|
| `tests/unit/indexer/pipeline.test.ts` | `InMemoryVectorStore` 使用のため影響なし |
| `tests/integration/pipeline.test.ts` | `LanceVectorStore` コンストラクタに `dbPath` を渡す修正のみ |
| `tests/unit/storage/compaction.test.ts` | そのまま維持 |
| `tests/unit/storage/in-memory-vector-store.ts` | テスト用モック実装はそのまま維持 |

## 変更対象ファイル一覧

### 変更するファイル

| ファイル | 変更内容 |
|----------|----------|
| `src/types/index.ts` | `IVectorStore` に `close(): Promise<void>` メソッドを追加 |
| `src/storage/vector-store.ts` | インメモリ実装 → `@lancedb/lancedb` 実装に全面書き換え（`close()` 実装・`trackOp` インフライト I/O トラッキング含む） |
| `src/indexer/pipeline.ts` | `reindex()` に `compactAfterReindex()` 追加、`start()` に idle compaction タイマー登録 + `unref()` 適用、`stop()` にタイマークリア + 参照リセット + `abortController.abort()` + `vectorStore.close()` 追加 |
| `tests/unit/storage/in-memory-vector-store.ts` | `close()` の no-op 実装を追加 |
| `tests/integration/pipeline.test.ts` | `LanceVectorStore` コンストラクタに `dbPath` を渡す修正 |

### 移動するファイル

| 移動元 | 移動先 |
|--------|--------|
| `tests/unit/storage/vector-store.test.ts` | `tests/integration/vector-store.test.ts`（LanceDB 実 I/O テストに書き換え） |

### 新規作成するファイル

| ファイル | 内容 |
|----------|------|
| `tests/shared/vector-store-contract.ts` | `IVectorStore` Contract Test スイート（共通テスト定義） |
| `tests/unit/storage/in-memory-vector-store.test.ts` | InMemoryVectorStore の Contract Tests 適用 |
| `tests/unit/storage/filter-validation-and-escape.test.ts` | `validateFilterValue()` と `escapeFilterValue()` のセキュリティ単体テスト |
| `tests/unit/storage/vector-store-inflight.test.ts` | `trackOp` インフライト I/O カウンタと `close()` 待機動作の単体テスト |
| `tests/spike/mergeinsert-behavior.test.ts` | `mergeInsert` 振る舞い検証の Spike テスト |

### 変更しないもの

- ~~`src/types/index.ts` — `IVectorStore` インターフェース変更なし~~ → `close(): Promise<void>` メソッドの追加あり（「変更するファイル」に移動）
- `src/search/semantic.ts` — `IVectorStore.search()` 経由のため影響なし
- `src/server/tools/*.ts` — ツールハンドラ変更なし
- `tests/unit/indexer/pipeline.test.ts` — `InMemoryVectorStore` 使用のため影響なし
- `tests/unit/storage/compaction.test.ts` — 既存テストそのまま
- `tests/unit/storage/in-memory-vector-store.ts` — テスト用モック実装そのまま
