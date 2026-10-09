# 本番 (M1) への導入

## 1. 置き場所

launchd から読めるよう、Desktop・Documents・Downloads の外に clone する。`shinkyo launchd --install` はこれらの下では止まる。

```sh
git clone https://github.com/void2610/shinkyo ~/dev/shinkyo
cd ~/dev/shinkyo
nix develop -c bun install
```

## 2. 設定

| ファイル | 書くこと |
| --- | --- |
| `config/searches.yaml` | 巡回する SUUMO の検索一覧 URL。1〜3ページに収まるよう条件を絞る |
| `config/criteria.yaml` | 必須条件と採点の重み |
| `config/stations.yaml` | 駅名 → 通勤先までの分数。無い駅の通勤点は中立 (0.5) になる |
| `.env` | `.env.example` をコピーし、Jev の `TYPESAFE_API_KEY` を書く。無ければ注意フラグも Claude が選ぶ |
| `config/profile.local.yaml` | `profile.local.example.yaml` をコピーし、`ntfy_topic` と `web.allowed_origins`・`web.access`・`web.people` を書く (5. を参照) |

## 3. 動作確認

```sh
nix develop -c bun run shinkyo fetch --dry-run
nix develop -c bun run shinkyo fetch --ignore-active-hours   # 時間帯の外で手動確認するとき
```

`--ignore-active-hours` は手動実行専用。launchd の設定には入らないので、定期実行は必ず active_hours を守る。

## 4. 定期実行と画面

```sh
nix develop -c bun run shinkyo launchd            # 生成される plist を確認する
nix develop -c bun run shinkyo launchd --install  # ~/Library/LaunchAgents に置いて登録する
```

- `com.shinkyo.fetch`: `interval_min` ごとに取得 (J1) と評価 (J2) を走らせる。取得時間帯の判定は HttpClient が行う
- `com.shinkyo.serve`: 画面を 127.0.0.1:8787 で常駐させる
- ログは `data/logs/` に出る

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
5. `config/profile.local.yaml` に書いて、`com.shinkyo.serve` を再起動する

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
