# shinkyo — 賃貸探しの自動化

仕様は docs/SPEC.md。仕様にないことはユーザーに聞く。採用・見送りの判断と理由は Knowledge/ に残す。

## コマンド

- `nix develop` で開発環境に入る
- `bun run shinkyo <fetch|evaluate|inquire|inbox|plan|status|serve|launchd> [--dry-run]`
- 本番の導入手順は docs/SETUP.md
- `bun run test` (画面をビルドしてから bun test) / `bun run typecheck` / `bun run lint`
- 画面は app/ (React Router v8 + shadcn/ui)。`app/components/ui` は shadcn の生成物なので手で直さず、`bunx --bun shadcn@latest add <部品>` で足す

## 守ること

- メール送信は src/mail/send.ts の send() だけを通す。ポリシー判定を迂回するコードを書かない
- 自動送信のカテゴリや宛先を増やすときは、先にユーザーの確認を取る
- SUUMO へのリクエストは src/fetch/suumo.ts の HttpClient だけを使う（間隔・上限・robots.txt・停止条件はそこで強制する）
- 情報は SQLite だけに置く。Notion などの第三者サービスへ物件・業者・やりとりの情報を送らない
- リポジトリは公開。data/、config/*.local.yaml、config/agents.yaml、認証情報はコミットせず、中身をログや出力に出さない
- 実際に探す条件 (間取り・家賃・地域・駅・通勤先など) は config/*.local.yaml にだけ置く。コミット・Knowledge・コミットメッセージ・仕様書に書かない
- tests/fixtures/ には合成データだけを置く。SUUMO の HTML や業者の実メールをそのまま入れない
- パーサーを直すときは、data/raw/ の最新HTMLの構造を写した合成HTMLを tests/fixtures/ に加え、先に失敗するテストを書く
- 変更後は typecheck・lint・test を通してからコミットする
