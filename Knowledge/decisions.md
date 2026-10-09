# 設計判断の記録

## 2026-10-10 画面は Notion をやめ、M1 上の自前の Web 画面にする

- 決定：SQLite を唯一の正本にし、Hono + JSX + htmx の画面を `shinkyo serve` で常駐させて Tailscale 内だけに公開する
- Why：Notion に置くと、住所・交渉の経緯・業者の連絡先といった情報資産が第三者の管理下に入る。また判定・承認・メモが Notion 起点になり、SQLite が正本でなくなる
- 閲覧共有：ほかの人は閲覧だけで、操作は本人1人。Tailscale のノード共有で見せ、書き込みは本人の端末からだけ受け付ける。判定を人ごとに持つ必要はない

## 2026-10-10 言語は Python ではなく TypeScript + Bun

- 決定：TypeScript（strict）、Bun、zod、Hono、Biome、bun:test、bun:sqlite
- Why：元の仕様の Python は検討のうえ選んだものではなかった。常駐する Web 画面が加わると、型の付いた状態を画面とバッチの両方から安全に書き換えることが中心になり、静的型の価値が上がる
- zod の1つの定義から、設定の検証、`claude -p` の出力の検証、`--json-schema` に渡すスキーマの生成ができる
- 次点は Go（常駐の安定性と標準ライブラリの厚さ）。Bun の長時間常駐に問題が出たら、まず同じコードを Node で動かすことを試す

## 2026-10-10 公開リポジトリのまま運用する

- 決定：リポジトリは public のまま。業者の連絡先を含む config/agents.yaml は gitignore し、agents.example.yaml だけをコミットする
- テストの fixtures には合成データだけを置く。SUUMO の HTML や業者の実メールを公開すると、SUUMO の掲載内容の再配布や第三者の個人情報の公開になるため
