# Luna

Roblox client (Bloxstrap / Voidstrap style). Tauri 2 + React + TypeScript + Rust.

```
pnpm install
pnpm tauri dev
```

## 現在のステップ
- UI は Dusk のものを月光カラーに改変（400x560 固定ウィンドウ）
- Settings は Dusk のものをそのまま配置（Appearance / Updates / FastFlags / Advanced / Mod profiles など）
- バックエンドも Dusk のモジュールを Luna 名義（%LOCALAPPDATA%\Luna\state）で配置
- 効果音は削除。UI は英語 / 韓国語（Settings → Advanced → Language。src/locales/en.ts と ko.ts は同じキーが必須で、足りないと型エラー）
- フォント: 英語は Inter、韓国語は Pretendard（可変フォント）
- Settings のスクロール時は上下端が背景にフェードします
- テーマ: Dark / Light（Settings → Advanced → Theme）。Liquid Glass は削除。以前の設定が glass / dark-glass でも light / dark として開く
  - Light でもホームの空の部分だけは夜空（星・流れ星・月・リング・水平線が見えるように）
- ホームの月はローポリ（三角の面を光の向きで塗り分け、色はテーマの --moon-lit / --moon-shade）。空の上端はタイトルバーの色に溶ける
- Skybox: 「My skyboxes」に自分で作った組を名前を付けて保存・いつでも適用（user_sky.rs）
- ReCache: Roblox のキャッシュのコピーを保存し、消えたときに復元（recache.rs。置き換えたスカイボックスは戻さない）
- 全ボタンはホバー/フォーカスで少し膨らむ（motion.css）。Sky template はポインタが触れた1枚が大きいまま、グリッド上にいる間は他が少し縮んだまま（隙間で戻らない）
- テキストボックスをクリックすると枠線がすっと現れる。フォーカス中のパネルは少し拡大
- Skybox: 内蔵25テンプレート。mods/ に手で置いたフォルダも、`content/sky` `content/textures/sky` `PlatformContent/pc/textures/sky` のどの構成でも「適用中」と認識し、起動時に Roblox が読む全フォルダへ同じ空を配置（sky.rs の `mirror_sky_entries`）。PNG/JPG を .tex の名前で入れた場合は BC1 DDS に変換
- 全コンポーネントの CSS は src/styles/components.css に集約（表示順で他のパネルの大きさが変わらないように）

## 自動更新（GitHub Releases）
手順は `.github/workflows/release.yml` の先頭コメントにあります。要点:
```
npm run tauri signer generate -- -w %USERPROFILE%\.tauri\luna.key
node scripts/setup-updater.mjs OWNER/REPO
npm run release -- 0.1.1      # バージョン更新 + コミット + タグ
git push origin HEAD --tags   # Actions がビルド・署名・公開
```
tauri.conf.json の updater の endpoints は YukiLumiy/Luna を仮置きしています。

## 次のステップ
- Roblox 自前インストール / 更新（ブートストラッパー）

- 配色: Settings → Advanced → Palette で8種類（A Midnight Indigo / B Dusty Rose / C Deep Teal / D Wine & Champagne / E Sakura / F Violet Dusk / G Crimson / H Graphite）。それぞれダーク・ライトあり。`src/styles/palettes.css` は生成物（元データは palettes.ts と同じ表）
- ライトテーマはダークの場面の明暗を反転（淡い空・暗い月・暗い星。ウィンドウのタブも）。パネルはホバーしても拡大しない
- 削除の「Delete?」は useArmed.ts（別の場所をクリック / Esc / 数秒で × に戻る）。ツールチップは TooltipLayer.tsx（title 属性を自動で置き換え）。アップデート通知は UpdateToast.tsx、更新後の初回だけ PatchNotes.tsx（本文は RELEASE_NOTES.md がリリース本文になる）
- 色は `tools/genpal.py` で生成（palettes.css）。色を足す・調整するときはここの表を編集して実行
- Skybox fix は設定画面から削除。スカイボックスの適用・リセット・プロファイルの ON/OFF/削除・Roblox 起動のたびに skyfix::sync_with_skybox が自動で適用/解除（スカイボックスを持つ有効なプロファイルがあれば適用、なければ解除）
