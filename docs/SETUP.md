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
| `config/profile.local.yaml` | `profile.local.example.yaml` をコピーし、`ntfy_topic` と `web.owner_logins`・`web.allowed_origins` を書く |

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
tailscale serve --bg 8787                         # tailnet 内だけに https で公開する
```

- `com.shinkyo.fetch`: `interval_min` ごとに取得 (J1) と評価 (J2) を走らせる。取得時間帯の判定は HttpClient が行う
- `com.shinkyo.serve`: 画面を 127.0.0.1:8787 で常駐させる
- ログは `data/logs/` に出る

`tailscale serve` が付ける `Tailscale-User-Login` が `web.owner_logins` に含まれる人だけが操作でき、ほかの人は閲覧専用になる。閲覧してもらう人には、Tailscale の管理画面からこのマシンを共有する。
