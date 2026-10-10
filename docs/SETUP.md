# 本番 (M1) への導入

## 1. 置き場所とデプロイ

M1 は push された main を自分で取りに行き、CI を通った版だけを入れる (`com.shinkyo.deploy` が 2 分ごとに確認する)。置き場所は launchd から読めるよう、Desktop・Documents・Downloads の外にする (既定は `~/shinkyo`)。

```
~/shinkyo/
├── repo.git/            # GitHub の bare clone (deploy が fetch する)
├── releases/<sha>/      # 版ごとの取り出し・bun install・ビルド。新しいほうから 5 つ残す
├── current -> releases/<sha>   # launchd のジョブはすべてここで動く
└── shared/              # 版をまたいで残すもの。同じ相対パスで各版に symlink で貼る
    ├── .env
    ├── config/*.local.yaml
    └── data/            # SQLite・画像・生 HTML・ログ・ロック
```

最初の 1 回だけ、どこかに clone したリポジトリから入れる。

```sh
git clone https://github.com/void2610/shinkyo /tmp/shinkyo-bootstrap
cd /tmp/shinkyo-bootstrap
nix develop -c bun install
nix develop -c bun run shinkyo deploy        # ~/shinkyo を作り、CI を通った main を current に入れる
```

以降は `~/shinkyo/current` で作業し、bootstrap の clone は消してよい。

- 反映の流れ：origin/main の SHA が current と違えば、GitHub の check-runs (認証なし API) を見る。CI が終わっていなければ待ち、失敗していれば入れない (再実行で通れば次の確認で入る)
- ビルドに失敗したコミットは `releases/<sha>.failed` に理由を残し、二度とビルドしない。直したコミットを push すれば次の版として入る
- 切り替えたあと `com.shinkyo.serve` を再起動し、30 秒以内に応答しなければ前の版に戻して ntfy で知らせる
- すぐ反映したいときは `~/shinkyo/current` で `nix develop -c bun run shinkyo deploy` を手で実行する
- 取得中のジョブは起動したときの版のまま最後まで動く (current の差し替えは symlink の rename で一度に行う)

## 2. 設定

個人の設定は `~/shinkyo/shared/` に置く (git には入らない)。リポジトリの同名ファイルはサンプル。

| ファイル | 書くこと |
| --- | --- |
| `shared/config/searches.local.yaml` | 巡回する SUUMO の検索一覧 URL。1〜3ページに収まるよう条件を絞る |
| `shared/config/criteria.local.yaml` | 必須条件と採点の重み |
| `shared/config/stations.local.yaml` | 駅名 → 通勤先までの分数。無い駅の通勤点は中立 (0.5) になる |
| `shared/.env` | `.env.example` をコピーし、Jev の `TYPESAFE_API_KEY` を書く。無ければ注意フラグも Claude が選ぶ |
| `shared/.env` の `RAPIDAPI_KEY` | NAVITIME Route (totalnavi) の RapidAPI キー。無ければ座標だけ取り、通勤点は stations の分数を使う |
| `shared/config/profile.local.yaml` の `workplaces` | 通勤先の名前・緯度経度・到着時刻 (複数可)。地図画面と採点で、いちばん長い人の時間を使う |
| `shared/config/profile.local.yaml` | `profile.local.example.yaml` をコピーし、`ntfy_topic` と `web.allowed_origins`・`web.access`・`web.people` を書く (5. を参照) |

書いたら、次のデプロイを待たずに貼るため `shinkyo deploy` を手で実行するか、新しいファイルの symlink を `current/` に張る (既存のファイルの書き換えはそのまま効く)。

## 3. 動作確認

```sh
cd ~/shinkyo/current
nix develop -c bun run shinkyo fetch --dry-run
nix develop -c bun run shinkyo fetch --ignore-active-hours   # 時間帯の外で手動確認するとき
```

`--ignore-active-hours` は手動実行専用。launchd の設定には入らないので、定期実行は必ず active_hours を守る。

## 4. 定期実行と画面

```sh
cd ~/shinkyo/current
nix develop -c bun run shinkyo launchd            # 生成される plist を確認する
nix develop -c bun run shinkyo launchd --install  # ~/Library/LaunchAgents に置いて登録する
```

- `com.shinkyo.fetch`: `interval_min` ごとに取得 (J1) と評価 (J2) を走らせる。取得時間帯の判定は HttpClient が行う
- `com.shinkyo.serve`: 画面を 127.0.0.1:8787 で常駐させる。ビルドはデプロイ時に済ませるので `--skip-build` で起動する
- `com.shinkyo.deploy`: 2 分ごとに新しい main を確かめて入れる (1. を参照)
- ログは `~/shinkyo/shared/data/logs/` に出る
- plist の中身が変わる変更 (ジョブの追加など) を入れたときは、`launchd --install` をもう一度実行する。デプロイは plist を書き換えない
- `--root` で置き場所を変えたときは、`deploy`・`launchd` の両方に同じ `--root` を付ける

## 5. 公開 (Cloudflare Tunnel + Access)

画面は 127.0.0.1:8787 にしか bind しないので、cloudflared のトンネルで公開し、Cloudflare Access で入れる人を限る。人によって権限は変えず、Access が確認したメールアドレスで誰の操作かを記録する。

1. cloudflared を入れる (nix-darwin の Homebrew の brews に `cloudflared` を足して適用する)
2. トンネルを作り、ホスト名を割り当てる

   ```sh
   cloudflared tunnel login                              # ブラウザでドメインを選ぶ
   cloudflared tunnel create shinkyo
   cloudflared tunnel route dns shinkyo heya.example.com
   ```

3. `~/.cloudflared/config.yml` を書き、常駐させる

   ```yaml
   tunnel: <tunnel create で表示された ID>
   credentials-file: /Users/<user>/.cloudflared/<ID>.json
   ingress:
     - hostname: heya.example.com
       service: http://127.0.0.1:8787
     - service: http_status:404
   ```

   ```sh
   cloudflared service install
   ```

4. Cloudflare の Zero Trust ダッシュボードで、Access のアプリを作る
   - Applications → Add → Self-hosted。ホスト名に `heya.example.com`
   - ポリシーは Allow、条件は Emails に入れる人のメールアドレス (ログイン方法は One-time PIN で足りる)
   - 作ったアプリの Application Audience (AUD) タグと、チームのドメイン (`<team>.cloudflareaccess.com`) を控える
5. `~/shinkyo/shared/config/profile.local.yaml` に書いて、`com.shinkyo.serve` を再起動する

   ```yaml
   web:
     allowed_origins: [https://heya.example.com]
     access:
       team_domain: <team>.cloudflareaccess.com
       aud: <AUD タグ>
     people:
       someone@example.com: 表示名
   ```

`web.access` が無いと全員を `local` として扱う (開発用)。本番では必ず設定する。
