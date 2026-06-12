#!/bin/bash
# ばあ！アプリ デプロイスクリプト（suminagashi-baby/deploy.sh と同パターン）
# git初期化 → GitHub publicリポ作成 → push → Pages有効化 まで一括実行
set -euo pipefail
cd "$(dirname "$0")"

REPO="baa-app"
OWNER="$(gh api user --jq .login)"

echo "=== 1/4 git 初期化・コミット ==="
if [ ! -d .git ]; then
  git init -b main
fi
git add -A
git commit -m "コミットメッセージは呼び出し側で指定する" || echo "(コミット済み・変更なし)"

echo "=== 2/4 GitHubリポ作成 & push ==="
if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  echo "(リポ既存 → push のみ)"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO.git"
  git push -u origin main
else
  gh repo create "$REPO" --public --source=. --push \
    --description "1歳から遊べる いないいないばあPWA（写真と声は端末内のみ）"
fi

echo "=== 3/4 GitHub Pages 有効化 ==="
gh api "repos/$OWNER/$REPO/pages" -X POST \
  -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 \
  && echo "Pages を有効化した" \
  || echo "(既に有効化済み)"

echo "=== 4/4 Pages 状態 ==="
gh api "repos/$OWNER/$REPO/pages" --jq '"URL: " + .html_url + "  status: " + .status'

echo ""
echo "=== 完了 ==="
echo "数分後に上記URLで配信開始。iPad/iPhoneのSafariで開いて共有→「ホーム画面に追加」"
