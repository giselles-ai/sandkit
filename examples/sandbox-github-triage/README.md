# sandbox-github-triage

SaaS 向けの GitHub PR / Issue triage の durable ワークフロー例です。`sandbox-github-triage` は以下を示します。

- WebUI からトラッキング対象 repo を登録し、run 作成と実行を行う最小のアプリ形。
- `workspace.sandbox.runCommand(...)` を主役にした 4 ステップ durable ワークフロー:
  - `sync-repo`
  - `collect-context`
  - `analyze`
  - `render-report`
- repo ごとに 1 つの workspace を持ち、実行ごとにその workspace を再利用するアーキテクチャ。
- app 側 DB と Sandkit workspace state の両方を保持し、実行の履歴と成果物を継続管理する。
- `allowServices([github(), codex()])` を既定ポリシーに置き、GitHub 取得・LLM 解析の境界を明示。

## データモデル

- `triage_repositories`
  - `id`, `workspace_id`, `slug`, `default_branch`, `last_synced_at`
- `triage_runs`
  - 対象 repo、subject、状態、生成レポート情報を保存
- `triage_steps`
  - `run` の各ステップ実行結果（exitCode, stdout/stderr, artifact）を保存

## レビュー向けレポート

`/triage/<run-id>` では最終レポートを以下の構造でレビューできます。

- short summary（要約）
- reproducibility checklist（再現手順候補）
- label candidates（ラベル候補）
- priority candidates（優先度候補）
- assignee candidates（担当者候補）
- verification suggestions（検証提案）

## アーティファクト（workspace 配下）

`runCommand()` はすべて `/vercel/sandbox/home/triage/...` 配下へ成果物を保存します。

- `triage/repositories/<owner_repo>/`…リポジトリ clone
- `triage/artifacts/<run-id>/context.json`…取得した issue/PR context
- `triage/artifacts/<run-id>/analysis.json`…AI 解析の入力/出力
- `triage/artifacts/<run-id>/report.md`…最終レポート（Markdown）

この例の詳細画面では主要アーティファクト（`context.json` / `analysis.json` / `report.md`）の path を明示し、調査時に必要な資料への導線を残しています。

## OpenClaw 例との違い

`examples/sandbox-openclaw` が live session（`openSession()`）を使って常駐プロセスを扱うサンプルであるのに対し、本例は

- `runCommand()` を中心に**セッション不要**で実行を分割
- 各ステップ単位で結果を durable 化
- workspace を再利用して「履歴」と「資料」を蓄積

という durable-first の SaaS運用フローを示します。

## セットアップ

```bash
cd packages/sandkit
bun run build

cd ../examples/sandbox-github-triage
bun install
bun run db:migrate
bun run db:generate
bun run dev
```

## 環境変数

- `GITHUB_TOKEN`（optional）: GitHub API 呼び出し向け
- `CODEX_API_KEY`（optional）: 分析 step で Codex を使う場合
- `AI_GATEWAY_BASE_URL`（optional）: 既定は `https://api.openai.com/v1`
- `CODEX_MODEL`（optional）: 分析 step のモデル名。既定は `gpt-4o-mini`（CI 環境では `gpt-5-mini`）
- `TRIAGE_CODEX_MODEL`（optional）: `CODEX_MODEL` の別名
- `SANDBOX_RUNTIME`（optional）: 既定 `node24`
- `SANDBOX_TIMEOUT_MS`（optional）
