# 賃貸探し自動化 仕様書（Claude Code向け）

Oct 9, 2026 · @Shuya Izumi

## 1. 概要

東京の賃貸探しを「新着の取得 → 評価 → 問い合わせ → 返信処理 → 内見調整 → 申込 → 審査通過」まで自動化し、人の作業を判断・内見・申込入力・審査の電話だけに絞る。このドキュメントはClaude Codeが実装するための仕様である。

**完了の定義**：申込が受理され、審査通過の連絡を受けた時点（＝部屋を確保した状態）。

**スコープ外**：賃貸借契約、IT重説、初期費用の支払い、鍵の受け取り、引っ越しの手配。LINEと電話の自動化、SUUMO以外のポータルは後続バージョンで扱う（9章）。

### 設計原則

1. 取得・保存・送信は決定的なコードで行い、Claudeは判断（採点・分類・抽出・文面作成）だけを担う。
2. 取り消せない操作（申込、条件交渉、キャンセル、新しい業者への初回送信）は必ず人が承認する。
3. 連絡はメールに寄せる。電話・LINEへの誘導には定型文で返し、メールに戻す。
4. 物件の取得は自分の部屋探しのための低頻度・私的利用に限る（7章）。

### 用語

| 用語 | 意味 |
| --- | --- |
| 掲載 | ポータル上の1つの物件ページ。同じ部屋に複数業者の掲載がありうる |
| 部屋 | 実体としての1部屋。複数の掲載を unit\_key で束ねたもの |
| unit\_key | 重複統合用の正規化キー（4章） |
| ハブ業者 | 問い合わせを集約する、メール対応の仲介会社（1〜2社） |
| 判定 | 人が部屋に付ける ◎（問い合わせる）／○（保留）／×（見送り） |
| 定型文 | templates/mail/ にあるメール雛形 |
| 自動送信 | 人の承認を経ない送信。policy.yaml で許可したカテゴリだけ |

## 2. 全体アーキテクチャ

常時稼働のM1 MacBook Pro上で、TypeScript（Bun）のパイプラインが SUUMO・Gmail・SQLite をつなぎ、判断が要る箇所だけ `claude -p` を呼ぶ。人は Web画面、メール、スマホ通知の3か所で関わる。

送信してよいかはコード側のポリシー（7章）が決め、Claudeは判断の材料を返すだけ。

情報はすべて自宅のM1の SQLite に置き、第三者のサービス（Notion 等）には置かない。

### コンポーネント

| コンポーネント | 役割 | 実装 |
| --- | --- | --- |
| fetcher | SUUMO検索一覧の巡回、新規掲載の詳細取得 | TypeScript（fetch + HTMLパーサー） |
| store | 掲載・部屋・業者・メッセージ・イベントの記録（唯一の正本） | SQLite（bun:sqlite, data/shinkyo.db, WAL） |
| evaluator | 必須条件の判定と基礎点はコード、注意フラグは Jev、要約・補正は Claude | TypeScript + Jev + `claude -p` |
| web | 部屋の一覧・詳細・比較、判定と承認とメモの入力 | React Router v8（framework mode）+ shadcn/ui。入口は Hono（Tailscale内だけに公開） |
| mailer | 問い合わせの送信、受信の分類（Jev）と抽出、返信の下書き（Claude） | Gmail API + Jev + `claude -p` |
| notifier | 新着ダイジェスト、要判断、異常の通知 | ntfy |
| scheduler | 各ジョブの定期実行と web の常駐 | launchd |
| skills | 対話で使う補助（状況確認、比較、電話メモ、パーサー修理） | Claude Code スキル |

### 人が関わる場所

- Web画面：判定（◎○×）を付ける、申込を承認する、内見後のメモを書く
- スマホ通知（ntfy）：新着ダイジェスト、要判断、異常
- Gmail（専用アドレス）：自動送信されなかった下書きを確認して送る
- Claude Code（Tailscale経由のSSHかRemote Control）：/shinkyo-status などのスキル

操作するのは本人1人だけ。ほかの人には Web画面を閲覧専用で見せる（4章）。

### 実行環境と技術スタック

- 本番：M1 MacBook Pro（常時稼働）。開発：M5 MacBook Pro
- リポジトリは \~/dev/shinkyo のように Desktop・Documents・Downloads の外に置く（macOSのバックグラウンド実行から読めないため）
- TypeScript（strict）＋ Bun。ツールチェーンは Nix の devShell で固定し、依存は bun.lock で固定
- 検証：設定のYAML、`claude -p` の出力、Web画面の入力は zod で検証する。`--json-schema` に渡すスキーマも同じ zod の定義から生成する
- Web画面：React Router v8 の framework mode（SSR）と shadcn/ui（Base UI + Tailwind CSS v4）。Hono を入口にして、権限・CSRF・写真の配信を行い、残りを React Router に渡す。`shinkyo serve` が起動時に `react-router build` する
- テスト：bun:test。lint と format は Biome
- LLM：Claude Code の `claude -p`。`--output-format json --json-schema` で構造化出力を受け、結果は `structured_output` から読む（[headless](https://code.claude.com/docs/en/headless.md)）
- Gmail API（OAuth。スコープは gmail.modify と gmail.compose）
- 通知：ntfy（既存のトピックを流用）

## 3. リポジトリ構成と設定

値はすべて config/ のYAMLに置き、コードに埋め込まない。個人情報と実際の探す条件（criteria・searches・stations）は `*.local.yaml` に置き、gitに入れない。リポジトリの同名ファイルはサンプルで、`*.local.yaml` があればそちらを優先して読む。リポジトリは公開なので、業者の連絡先を含む agents.yaml も gitignore し、agents.example.yaml だけをコミットする。

```text
shinkyo/
├── CLAUDE.md                 # 付録A
├── docs/SPEC.md              # この仕様書
├── flake.nix                 # devShell（bun, sqlite）
├── package.json, bun.lock, tsconfig.json, biome.json
├── config/
│   ├── criteria.yaml         # 必須条件と採点の重み
│   ├── searches.yaml         # 巡回する検索一覧URL
│   ├── stations.yaml         # 駅ごとの通勤時間（分）
│   ├── agents.yaml           # 業者（hub / candidate / excluded。gitignore）
│   ├── policy.yaml           # 取得頻度・自動送信・停止スイッチ
│   └── profile.local.yaml    # 氏名・署名・入居時期など（gitignore）
├── templates/mail/           # 定型文 T1〜T6（6章）
├── prompts/                  # claude -p 用のプロンプト（スキーマは src の zod 定義から生成）
├── app/                      # React Router の画面 (routes/, components/。components/ui は shadcn が生成)
├── src/
│   ├── cli.ts                # shinkyo fetch|evaluate|inquire|inbox|plan|status|serve
│   ├── fetch/suumo.ts        # HttpClient（間隔・上限・robots.txt・停止条件を強制）
│   ├── store/db.ts
│   ├── evaluate.ts
│   ├── web/                  # Hono の入口 (server.ts)・画面用のクエリ・絞り込み
│   ├── mail/gmail.ts, classify.ts, compose.ts, send.ts
│   ├── llm.ts                # claude -p の呼び出しを1か所に集約
│   └── notify.ts
├── tests/fixtures/           # 合成したHTMLとメール（実データは置かない）
├── .claude/skills/           # 対話用スキル（付録B）
├── launchd/                  # plist
└── data/                     # shinkyo.db, raw/（gitignore）
```

### criteria.yaml（例。値は10章で確定）

```yaml
hard:                       # 1つでも外れたら自動で見送り（コードで判定）
  rent_total_max: 120000    # 家賃+管理費（円）
  area_min_m2: 25
  walk_max_min: 10
  built_from: 1982-01       # 新耐震の目安
  floor_min: 2
  layouts: [1LDK, 2K, 2DK]
  exclude: [定期借家]
weights:                    # 基礎点の配分（合計100）
  commute: 30
  rent: 25
  area: 15
  age: 10
  features: 20
features: [バス・トイレ別, 独立洗面台, 室内洗濯機置場, 南向き, 宅配ボックス]
notify_min_score: 60        # これ以上の部屋だけ通知する
```

### policy.yaml（初期値）

```yaml
paused: false                       # true で取得と送信を全停止
fetch:
  active_hours: "08:00-22:00"
  interval_min: 45
  request_gap_sec: 10               # 1リクエストごとの最小間隔
  jitter_sec: 3
  max_pages_per_search: 3
  daily_request_cap: 300
  stop_on_status: [403, 429, 503]
images:                             # 物件写真。候補のサムネイルと間取り図は定期実行で先に取得し、残りは画面で見たときに取得する
  request_gap_sec: 0.2              # ブラウザで SUUMO を見るときの同時読み込みより控えめ
  jitter_sec: 0.1
  daily_cap: 1000
mail:
  send_hours: "09:00-21:00"
  send_slots: ["10:00", "15:00"]    # J3 のまとめ送信の時刻
  no_followup_weekdays: [tue, wed]
  followup_after_hours: 24
  auto_send_categories: [inquiry_on_approval, phone_redirect_reply, viewing_propose, viewing_confirm, followup]
  auto_send_to_roles: [hub]
  auto_send_daily_cap: 10
stop_inquiries_when_status: [申込, 審査中]
stop_fetch_when_status: [確定]
```

### その他の設定

| ファイル | 中身 |
| --- | --- |
| searches.yaml | id と SUUMO の検索一覧URL。条件を絞って1〜3ページに収まるようにする |
| stations.yaml | 駅名 → 通勤先までの分数。初回に人が埋める（Claudeに経路を調べさせてもよい） |
| agents.yaml | 会社名、担当者、メールアドレスまたはドメイン、role、手数料条件、メモ |
| profile.local.yaml | 氏名、署名、入居希望時期、人数、職業・年収帯の書き方、内見できる時間帯、審査の電話に出られる時間帯 |

## 4. データモデル

SQLiteが唯一の正本で、Web画面はそれを直接読み書きする。同じ部屋の複数掲載は unit\_key で1つの「部屋」にまとめる。

### SQLite

| テーブル | 主な列 |
| --- | --- |
| listings | listing\_id（SUUMOの物件コード）, url, search\_id, first\_seen, last\_seen, missing\_runs, rent, admin\_fee, deposit, key\_money, layout, area\_m2, built\_ym, floor, building\_name, address, stations(json), agent\_name, raw\_path, unit\_key |
| units | unit\_key, status, judgment, base\_score, adj\_score, flags(json), summary, memo, apply\_approved, agent\_id, viewing\_at, next\_action, updated\_at |
| agents | agent\_id, name, email, role, median\_reply\_min, redirect\_count |
| messages | gmail\_id, thread\_id, direction, agent\_id, unit\_keys(json), category, extracted(json), action（none / draft / auto\_sent / human\_sent）, template\_id, created\_at |
| events | id, unit\_key, type, from\_status, to\_status, actor（system / human）, at, detail |
| fetch\_log | run\_id, url, status\_code, items, started\_at, error |

### unit\_key（重複統合）

- 基本形：建物名（全角半角・空白・記号の揺れを正規化）＋住所（丁目まで）＋階＋面積（0.5㎡単位に丸め）＋間取り
- 建物名が空、または「〇〇駅の賃貸」のような汎用名なら、住所＋階＋面積＋家賃で代用する
- 面積差1㎡以内などの曖昧な一致は統合せず、「統合候補」フラグを付けて人に見せる

### ステータス遷移

| 状態 | 次の状態 | きっかけ | 主体 |
| --- | --- | --- | --- |
| 新着 | 候補 / 見送り | 必須条件の判定と採点（J2） | システム |
| 候補 | 問合せ中 / 見送り | 判定 ◎ / ×（J3） | 人 |
| 問合せ中 | 空室確認済 / 見送り | 返信の「空室あり」/「募集終了」（J4） | システム |
| 空室確認済 | 内見予約済 | 内見日時の確定（J4） | システム（人が決めた時間帯の範囲内） |
| 内見予約済 | 内見済 | 内見日時の経過。メモ入力を促す通知 | システム |
| 内見済 | 申込 / 見送り | 「申込を承認」/ ×（J6） | 人 |
| 申込 | 審査中 | 申込完了の連絡（J4） | システム |
| 審査中 | 確定 / 見送り | 審査結果の連絡（J4） | システム |

- 掲載が2回連続で一覧から消えたら「掲載終了の可能性」フラグ（状態は変えない）
- 家賃が下がったら「値下げ」フラグを付けて通知する
- 状態の変更はすべて events に記録する

ハブが「取扱不可」と返した部屋は状態を変えず、次アクションに「掲載元へ問い合わせ」と記録する（J3）。

### Web画面

`shinkyo serve` で常駐し、Tailscale のネットワーク内だけに公開する。

**部屋の一覧と詳細**：名前（建物名・階・間取り）、状態、判定（◎ / ○ / ×）、申込を承認、スコア、家賃・管理費（円）、敷金・礼金（月）、初期費用見積（円）、間取り、面積（㎡）、築年、階、最寄駅・徒歩、通勤（分）、フラグ、要約、評価メモ、URL、他の掲載、担当業者、内見日時、次アクション、最終連絡、unit\_key

**業者**：会社名、担当者、役割（ハブ / 候補 / 除外）、返信の中央値（分）、電話・LINE誘導の回数、手数料条件、メモ。役割の正本は agents.yaml

人が書くのは「判定」「申込を承認」「評価メモ」だけで、変更は events に actor=human で記録する。

**閲覧専用の共有**：操作するのは本人だけ。ほかの人には Tailscale のノード共有で見せ、書き込み（GET 以外）は本人の端末からだけ受け付ける。誰からの接続かは Tailscale の接続元で判定する。業者の連絡先は閲覧者に見せない。

## 5. ジョブ仕様

6つのジョブはすべて `shinkyo <job>` として実装し、launchd から定期実行する。どのジョブも冪等で、二重に動いても登録や送信が重複しない。全ジョブに `--dry-run`（外部への書き込みと送信をせず、ログだけ出す）を付ける。

| ジョブ | コマンド | 実行タイミング |
| --- | --- | --- |
| J1 取得 | shinkyo fetch | 8:00〜22:00 に45分ごと |
| J2 評価 | shinkyo evaluate | J1 の直後 |
| J3 問い合わせ | shinkyo inquire | 15分ごと（送信は10:00と15:00の枠） |
| J4 受信処理 | shinkyo inbox | 9:00〜21:00 に15分ごと |
| J5 内見計画 | shinkyo plan / /shinkyo-viewing | 手動 |
| J6 申込〜確定 | J3・J4 の中で処理 | 人の承認から |

### Claudeの呼び出し（llm.ts）

- 判断が要る処理（評価の補正、メールの分類と抽出、返信の自由記述部分）だけ `claude -p` を使う
- 入力はJSONでstdinから渡す。作業ディレクトリは空の一時ディレクトリにし、`--permission-mode dontAsk` でツールを使わせない
- 出力は `--json-schema` で受け、`structured_output` を検証してから使う。不一致は1回だけ再試行し、だめなら「人の判断が要る」として通知し、送信はしない

```bash
claude -p \
  --output-format json \
  --json-schema "$SCHEMA" \
  --append-system-prompt-file prompts/classify.md \
  --permission-mode dontAsk < input.json
```

サブスクのログインで `claude -p` を呼ぶ（2026-10-10 決定）。`--bare` は API キーが要るので使わない。\~/.claude のフックや設定も読み込まれるため、作業ディレクトリを空の一時ディレクトリにして影響を抑える（[headless](https://code.claude.com/docs/en/headless.md)）。

### J1 取得（shinkyo fetch）

1. paused、または active\_hours の外なら何もしない
2. robots.txt を1日1回取得し、searches.yaml の各URLが許可されているか確認する
3. 一覧を最大 max\_pages\_per\_search ページ取得する。間隔は request\_gap\_sec＋0〜jitter\_sec 秒
4. 掲載を解析して upsert する。新しい listing\_id だけ詳細ページを1回取得し、raw HTML を data/raw/ に7日間保存する
   - 物件写真は URL を保存し、見送り以外の部屋のカードの1枚目と間取り図は取得ジョブの最後に先回りして取得する。残りは画面で表示されたときに取得する。どちらも data/images/ に残す（ページとは別の間隔と上限）
5. 一覧に2回連続で無い掲載に「掲載終了の可能性」、家賃の低下に「値下げ」を付ける
6. stop\_on\_status の応答か CAPTCHA の兆候で、その日の取得を止めて通知する
7. 一覧が200なのに0件しか解析できなければ、パーサー破損として通知する

出力：新規・更新された unit\_key の一覧（J2の入力）。

### J2 評価（shinkyo evaluate）

1. 必須条件（criteria.hard）をコードで判定し、外れたら「見送り（自動）」にする
2. 基礎点を weights で計算する。家賃が同じ駅・間取りの収集データの中央値より15%以上安ければ「相場より安い」フラグ
3. 通過した部屋の注意フラグを Jev で判定し（フラグごとの yes/no、確率 0.7 以上を採用）、Claude から一行要約・±10点の補正と理由を受け取る。Jev が使えないときは注意フラグも Claude が選ぶ
4. 評価結果を SQLite に保存する（Web画面にそのまま出る）
5. notify\_min\_score（criteria.yaml）以上の上位5件を ntfy でダイジェスト通知する（1日最大3回にまとめる）

注意フラグの例：北向き、1階、線路・幹線道路沿いの可能性、定期借家、告知事項あり、旧耐震の可能性、統合候補。

### J3 問い合わせ（shinkyo inquire）

1. SQLite から 判定=◎ かつ 状態=候補 の部屋を集める
2. 宛先は role=hub の業者。ハブが「取扱不可」と返した部屋だけ掲載元の業者に回す
3. 同じハブ宛ての部屋を次の送信枠で1通にまとめ、T1 を差し込みで作る（Claudeは使わない）
4. ◎ が承認を兼ねるので、ハブ宛ては自動送信し、状態を「問合せ中」にする
5. 掲載元への問い合わせは SUUMO のフォーム経由になるため、文面だけ作って人に通知する（送信は人。Claude in Chrome で入力し、送信ボタンだけ人が押してもよい）

ハブが決まるまでの初週は、掲載元3〜5社に同じ文面を人が送る（7章）。

### J4 受信処理（shinkyo inbox）

1. Gmail のラベル shinkyo/agent（agents.yaml のアドレス・ドメインで振り分け）の未処理メッセージを取得する
2. カテゴリを Jev の choice で分類し、確信度が低いものだけ Claude で再判定する（前例 ../gmail-triage）。抽出は Claude で行う。出力は category、対象の部屋（URLや物件名）、空室の有無、内見候補日時、初期費用の内訳、必要書類、電話・LINEへの誘導の有無、人の判断が要るか（理由つき）
3. SQLite を更新し、4章の遷移に従って状態を進める
4. 下の表のとおり返信する
5. 送信から24時間返信がなければ T5 を作る（火・水は数えない。ハブ宛ては自動、それ以外は下書き）

| カテゴリ | 対応 | 送信 |
| --- | --- | --- |
| 空室回答 | T4（候補の提示）で内見候補日を返す | 自動（ハブ、送信時間内） |
| 内見日程の提示 | 内見できる時間帯に合う最初の枠で T4（確定）を返す | 時間帯内なら自動、外なら下書き＋通知 |
| 見積 | 記録し、不明点があれば質問を下書き | 下書き |
| 他物件の提案 | 掲載として登録し J2 で採点 | なし |
| 電話・LINEへの誘導 | T2 で返す | 自動 |
| 申込の案内 | 申込URLを人に通知 | なし（人が入力） |
| 審査の連絡 | 状態を更新して通知 | なし |
| その他 | 下書き＋通知 | 下書き |

電話があったときは /shinkyo-call に用件を書けば、T2 の形で返信を下書きする。

### J5 内見計画（shinkyo plan / /shinkyo-viewing）

1. 内見予約済の部屋を日付ごとにまとめ、移動順と時刻を組む（OHEYAGO のセルフ内見は1件約30分）
2. 部屋ごとの確認リストを作る：騒音、採光、携帯の電波、水回り、収納と家具の寸法、共用部、ゴミ置き場。注意フラグに応じて項目を足す
3. 内見後のメモ（音声入力のテキストでよい）から、評価メモとスコアの補正を SQLite に反映する
4. 比較表（2年総額＝家賃と管理費の24か月分＋初期費用＋更新料、通勤、評価）を Web画面に出す

### J6 申込〜確定

1. 人が「申込を承認」をオンにすると T3 を下書きする。交渉項目（礼金、入居日など）は人が選ぶ
2. T3 の送信、申込フォームの入力、書類のアップロードは人が行う
3. 申込完了の連絡で状態を「申込」にし、J3 の新規問い合わせを止める
4. 審査中は、業者から聞いた保証会社の番号を連絡先に登録するよう通知する（通話スクリーニングで止めないため）
5. 通過なら「確定」にして J1 を止め、他の業者への T6 を下書きする。否決なら「見送り」にして問い合わせを再開する

## 6. メールテンプレート

定型文は templates/mail/ に置き、{ } の差し込みはコードで行う。Claudeが書くのは T2 の {answers} と T3 の {negotiation\_items} だけ。

| ID | 用途 | 送信 |
| --- | --- | --- |
| T1 | 問い合わせ（ハブ宛て、初週の掲載元宛て） | ハブは自動、掲載元は人 |
| T2 | 電話・LINEへの誘導への返信 | 自動 |
| T3 | 申込の意思表示と確認 | 人 |
| T4 | 内見の日程（候補の提示・確定） | 時間帯内なら自動 |
| T5 | 返信がないときの催促 | ハブは自動、他は人 |
| T6 | 見送りの連絡 | 人 |

### T1 問い合わせ

```text
件名：空室確認と内見のお願い（{n}件／{move_in}入居希望）

{agent_name} {contact_name}様

{name}と申します。下記物件の空室確認と内見をお願いできますでしょうか。他社様掲載の物件も含みますので、お取り扱い可能なものだけで構いません。

{units}

物件番号ごとに、①空室の有無 ②内見可能な日時 ③初期費用の内訳 ④保証会社と必要書類 をご返信いただけますと助かります。

入居希望：{move_in}／人数：{people}名／職業・年収：{job_income}
内見の候補：{slots}

ご連絡はこのメールアドレスにお願いいたします（電話・LINEでのやりとりは控えております）。返信は当日中にいたします。

{signature}
```

{units} は1行1件で「番号. 物件名 URL」。

### T2 電話・LINEへの誘導への返信

```text
件名：Re: {subject}

ご案内ありがとうございます。恐れ入りますが、条件や日程を記録に残したいため、引き続きメールでお願いできますでしょうか。お尋ねの点は以下のとおりです。

{answers}

{signature}
```

### T3 申込の意思表示

```text
件名：{unit_name}の申込について

本日内見した{unit_name}を申し込みたいと考えています。申込前に、次の点をご確認いただけますか。

{negotiation_items}

申込はWebで行えますでしょうか。審査の確認のお電話は{call_window}であれば対応できます。保証会社名と発信番号を事前に教えていただけると助かります。

{signature}
```

### T4 内見の日程（候補の提示・確定）

日時を確定するとき：

```text
件名：Re: {subject}

ご調整ありがとうございます。{unit_name}の内見は {slot} でお願いいたします。当日は現地集合でよろしいでしょうか。

{signature}
```

候補を提示するとき：

```text
件名：Re: {subject}

ご連絡ありがとうございます。{unit_name}の内見は、次のいずれかでお願いできますでしょうか。

{slots}

{signature}
```

### T5 催促

```text
件名：Re: {subject}

お忙しいところ恐れ入ります。{sent_date}にお送りした件について、状況を教えていただけますと助かります。空室がない物件は、その旨だけでも構いません。

{signature}
```

### T6 見送りの連絡

```text
件名：{unit_name}について

ご対応ありがとうございました。今回は別の物件で進めることになりましたので、{unit_name}は見送らせてください。またご相談する際はよろしくお願いいたします。

{signature}
```

## 7. 運用ポリシー

取得は自分用の低頻度に限り、自動送信はハブ宛ての定型文に限る。取り消せない操作は人が行う。これらはコード（fetch/suumo.ts の HttpClient と mail/send.ts）で強制し、設定だけに頼らない。

### 物件の取得（SUUMO）

- [SUUMOご利用規約](https://cdn.p.recruit.co.jp/terms/suu-t-1003/index.html)（2025年10月1日改定）は、私的利用の範囲を超える使用、運営を妨げる行為、商業目的の利用、当社が不適当と判断する行為を禁じ、違反と判断すれば予告なく利用停止できる。スクレイピングを名指しで禁じる条項はない
- [robots.txt](https://suumo.jp/robots.txt) は全クローラー向けに sort= 付きURL、/map/chintai/、一部のAPIなどを除外している。賃貸の検索一覧と物件詳細は除外されていない。Bing には30秒の間隔を指定している
- 守ること：
  - データは自分用に留め、公開・商用利用をしない。Web画面を閲覧専用で見せるのは Tailscale で招待した身近な人に限る
  - 公開リポジトリには SUUMO の HTML も業者の実メールも置かない。テストには、構造だけを写して値を架空にした合成データを使う
  - ログインせずに取得する
  - robots.txt で除外されたURLは使わない
  - 間隔は request\_gap\_sec 以上、1日の上限は daily\_request\_cap
  - 403・429・503・CAPTCHA で、その日の取得を止める
  - UAの偽装やローテーション、IPの切り替え、ヘッドレスブラウザでの回避はしない
- 取得元は自宅回線のM1。止められると手動の閲覧も巻き添えになるため、上限を守る

### 自動送信

- 自動で送るのは policy.mail.auto\_send\_categories のカテゴリだけ。宛先は agents.yaml で role=hub の業者だけ
- 人の承認が必須：申込の意思表示、条件交渉、キャンセル、見送りの連絡、新しい業者への初回連絡、個人情報を含む文面
- 送信は 9:00〜21:00 だけ。火・水は催促しない（業界の定休日が多いため）
- 自動送信は1日10通まで。すべての送信を messages に記録する（テンプレID、本文、auto / human）

### 個人情報

- 身分証、収入証明、勤務先の詳細は、リポジトリにも SQLite にも置かない。申込フォームには人が直接入力する
- profile.local.yaml は gitignore。Claude に渡すのは差し込みに要る最小限（氏名、入居時期、人数、職業・年収帯）
- メール本文に身分証や収入の情報を書かない

### 停止スイッチ

- policy.paused を true にすると取得と送信を全停止する（メールの読み取りと Web画面は続ける）
- 状態が「申込」「審査中」の部屋がある間は、J3 の新規問い合わせを止める
- 「確定」になったら J1 を止める

### ハブ業者の選び方

初週に掲載元3〜5社へ T1 と同じ文面を送り、次の点で比べる：メールで返信したか、全項目に答えたか、返信までの時間、電話・LINEへの誘導の有無、仲介手数料。上位1〜2社を agents.yaml で role=hub にする。OHEYAGO の物件は、ハブとは別に直接予約してよい。

## 8. エラー処理・テスト・受け入れ基準

失敗したときは「送らない・止める・知らせる」を基本にする。送信ポリシーのテストは全ケースを通すまで自動送信を有効にしない。

### エラー処理

| 事象 | 対応 |
| --- | --- |
| 取得で 403・429・503・CAPTCHA | その日の取得を止めて通知 |
| 一覧が200なのに0件 | パーサー破損として通知し、raw HTML を保存 |
| Gmail API の一時エラー | 指数バックオフで3回まで再試行し、失敗は次回に持ち越す |
| `claude -p` の失敗・スキーマ不一致 | 1回だけ再試行。だめなら人の判断が要るとして通知し、送信しない |
| 二重実行 | ジョブごとにロックファイル。送信は gmail\_id と unit\_key で冪等にする |
| launchd が止まっていた | 起動時に前回実行時刻を見て、取りこぼした J1・J4 を1回だけ追いつき実行する |

### テスト

- パーサー：tests/fixtures/suumo/ の合成HTMLで、家賃・管理費・敷金・礼金・間取り・面積・築年・階・駅・徒歩の抽出を検証する
- unit\_key：表記揺れのケース集で、統合すべきもの・すべきでないものを検証する
- 分類と抽出：合成したサンプルメール20件で category と抽出項目を検証する
- 送信ポリシー：許可外のカテゴリ、ハブ以外の宛先、送信時間外、停止中、1日の上限超えのどれでも送信されないことを単体テストで保証する
- `--dry-run`：全ジョブで、送信と外部への書き込みをせずにログだけ出せること

### 受け入れ基準

- J1：SUUMOに出た新着が、次の巡回（最大45分後）までに SQLite に入る。1日のリクエスト数が上限を超えない
- J2：取得から10分以内に Web画面に部屋が出て、必須条件を外れた部屋は候補に上がらない
- J3：◎を付けると次の送信枠でハブにメールが届き、状態が「問合せ中」になる
- J4：業者の返信から15分以内に、分類・SQLite の更新・返信（自動か下書き）が済む
- J6：「申込」になった時点で新規問い合わせが止まり、「確定」で取得が止まる

## 9. マイルストーン

受信処理から作る。業者とのやりとりが一番手間で、物件選びは手作業でも回るため。各段階は、前の段階の受け入れ基準を満たしてから始める。

1. **M1 受信処理**：リポジトリ、Nix devShell、Gmail の接続、Web画面（一覧・詳細・判定）、定型文、J4（分類と下書きのみ、自動送信なし）。物件は手で選んでハブに送る
2. **M2 取得と評価**：J1・J2、ntfy 通知、launchd での定期実行
3. **M3 問い合わせの自動化**：J3 と J4 の自動送信。送信ポリシーのテストがすべて通ってから有効にする
4. **M4 内見と申込**：J5、J6、停止スイッチ
5. **v2（任意）**：間取り図の画像読解、HOME'S など他のポータルの追加（規約と robots.txt を個別に確認）、ハザードマップへのリンク生成
6. **v3（任意）**：050番号のAI留守電を文字起こししてメール化し、J4 に流す

## 10. 未決事項

M1 に入る前に、次の値を決めて config/ に入れる。

- [ ] 希望エリア（路線・駅）と、巡回する SUUMO 検索一覧のURL
- [ ] 家賃上限（管理費込み）、面積、駅徒歩、築年、間取り、必須設備、NG条件
- [ ] 通勤先と、駅ごとの通勤時間
- [ ] 入居希望時期、人数、職業・年収帯の書き方
- [ ] 内見できる曜日と時間帯（内見日時の自動確定に使う）
- [ ] 審査の電話に出られる時間帯
- [ ] 物件探し用の Gmail（新しいアカウントか、既存アカウントの +エイリアスか）
- [x] LLM の呼び出し方：サブスクのログインで `claude -p`
- [ ] ハブ業者（初週の比較で決める）

## 付録A. CLAUDE.md

リポジトリ直下の CLAUDE.md に置く。仕様の要点ではなく、実装中に破ってはいけない約束だけを書く。

## 付録B. Claude Code スキル

`.claude/skills/<name>/SKILL.md` に置く、対話用の補助。定期実行のジョブは CLI 側で動くので、スキルには入れない。

| スキル | 用途 | やること |
| --- | --- | --- |
| /shinkyo-status | 全体の状況確認 | 状態ごとの件数、人の判断待ち、今日の送信を SQLite から要約する |
| /shinkyo-compare | 部屋の比較 | 指定した部屋の比較表（2年総額・通勤・評価）を Web画面に出す |
| /shinkyo-call | 電話の後始末 | 電話の用件メモから T2 の形で返信を下書きする |
| /shinkyo-viewing | 内見日の準備 | J5 を対話で実行し、順路と確認リストを出す |
| /shinkyo-fix-parser | パーサーの修理 | data/raw/ の最新HTMLで失敗を再現し、修正してテストを足す |

## 出典

- [SUUMOご利用規約](https://cdn.p.recruit.co.jp/terms/suu-t-1003/index.html)
- [SUUMO robots.txt](https://suumo.jp/robots.txt)
- [Claude Code：Run Claude Code programmatically（headless）](https://code.claude.com/docs/en/headless.md)
- [OHEYAGO](https://oheyago.jp/)
