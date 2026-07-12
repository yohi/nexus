# プロジェクト単位 Nexus 自動コネクター設計

## 目的

MCP クライアントはプロジェクトごとに一つの Nexus プロセスを共有する。起動済みなら
そのプロセスに接続し、未起動なら一つだけを安全に起動する。最後のクライアントが切断
したら、そのプロセスを終了する。systemd などの外部プロセス管理は使わない。

## 前提と非目標

- プロジェクト内の SQLite、LanceDB、watcher は一つの Nexus ランタイムだけが所有する。
- stdio はクライアントごとの接続に限定し、共有プロセスへの接続には Streamable HTTP を
  用いる。
- 同一プロジェクトで複数の MCP クライアントが同時に接続できる。
- ポート番号、HTTP URL、PID をユーザーが手動で指定・管理する必要はない。
- ネットワーク公開、外部ホストへの接続、systemd サービス化は対象外とする。

## 選定アーキテクチャ

`nexus http-bridge` はコネクターとして動作する。起動時に `.nexus/endpoint.json` を確認し、
有効な Nexus HTTP サービスを見つけたら接続する。見つからなければ bootstrap lock を取得
した一つのコネクターだけが、loopback の空きポートで管理対象の Nexus HTTP サービスを
デタッチ起動する。

サービスは listen 完了後に endpoint descriptor を原子的に書き込む。競合して起動に失敗
したコネクターはプロセスロックを削除せず、descriptor の公開とヘルスチェック成功を待つ。
descriptor は URL、PID、ランダムな instance ID、プロジェクト識別子を含める。

HTTP サービスは共有 runtime とクライアントごとの MCP server/transport を分離する。各
クライアントの切断を数え、接続数がゼロになった時点でサービスを正常終了する。終了時は
endpoint descriptor とロックを削除する。起動後にクライアントが接続しない場合も、短い
grace period 後に終了する。

## 起動フロー

1. MCP クライアントが `nexus http-bridge` を起動する。
2. コネクターは設定から project root と storage root を解決する。
3. descriptor が存在するときは、project identity、PID、生存状態、HTTP health を確認する。
4. 有効なら descriptor の URL に Streamable HTTP transport を接続する。
5. 無効または不在なら bootstrap lock を取得する。
6. lock を取得したコネクターは `nexus` の管理対象 HTTP モードをデタッチ起動し、descriptor
   の公開を待つ。lock を取得できなかったコネクターは同じ descriptor を待つ。
7. HTTP 接続後は現在の Bridge と同様に stdio JSON-RPC を転送する。

## 終了フロー

1. Bridge の stdin EOF、シグナル、または HTTP 接続終了でクライアントの接続が終了する。
2. HTTP サービスは該当クライアントの transport と MCP server だけを閉じる。
3. 接続数がゼロなら runtime を閉じ、endpoint descriptor とプロセスロックを削除して終了する。
4. 次のコネクターは descriptor 不在を検出し、新しいプロジェクトプロセスを起動する。

## 失敗時の扱い

- stale descriptor、死んだ PID、到達不能な URL は削除して再起動候補として扱う。
- 起動競合では既存の有効なプロセスを停止・削除しない。
- descriptor が所定時間内に公開されなければ、コネクターは stderr に原因を出して終了する。
- MCP stdout は JSON-RPC 専用とし、診断は stderr に出力する。

## テスト境界

- descriptor が有効な場合、コネクターは新しいサービスを起動せず既存サービスを使う。
- 同時に二つのコネクターを起動しても、HTTP サービスは一つだけになる。
- 不正または stale な descriptor では、新しいサービスを一つだけ起動する。
- 複数クライアントは共有 runtime を使いながら独立した MCP server/transport を持つ。
- 最後のクライアント切断後、サービスは descriptor とロックを解放して終了する。
