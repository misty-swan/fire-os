# V02 添付の検査・EXIF除去・ready不変（T016）

方式: **Workers内の構造検査と無害化**（docs/07 §3.3〜3.4の「Workers互換の検査方式」）。実装は `src/server/attachments/scanner.ts`（FileScanner）と `src/server/jobs/handlers/attachment.ts`（inspectUpload）。

## 実施したこと（ローカルworkerd＋ローカルD1/R2シミュレータ）

| 確認 | 結果 | 試験 |
|---|---|---|
| 偽MIME（中身はPNGなのにCSVと申告）は ready にならない | 合格 | `forged_mime_or_scanner_failure_never_becomes_ready` |
| EXIF入りのPNG/JPEG/WebPは ready 実体からEXIFが消える（画素データIDATは保持。WebPはVP8Xフラグも落とす） | 合格 | 同上 |
| 壊れたPNG（IEND/IDAT無し・CRC不一致）は拒否 | 合格 | 同上 |
| 能動的埋込（/JavaScript /OpenAction 等）のPDFは拒否、無害なPDFは ready | 合格 | 同上 |
| 壊れたUTF-8・NUL入りのCSVは拒否、UTF-8のCSVは ready | 合格 | 同上 |
| R2から取得できない（検査不能）場合は checking のまま再試行。合格にも不合格にもしない | 合格 | 同上（`scanner_unavailable`） |
| 検査中に元版が変わった場合、遅れたjobは stale になり ready 実体を書き換えない | 合格 | 同上 |
| ready keyは `ready/{unit}/{attachment}/{sha256}` で内容固定・上書きしない（同内容は既存を再利用） | 合格 | T015/T016試験と `uq_attachments_ready_key` |
| 取得（API-27）はreadyだけをWorkers経由で配信し、署名GETへredirectしない | 合格 | tests/attachments.test.ts（T017） |

EXIF除去は**再符号化でなくメタデータ部分の削除と再構築**（JPEGはAPP1/COMセグメント削除、PNGはeXIf/テキスト系チャンク削除、WebPはEXIF/XMPチャンク削除＋VP8Xフラグ解消）。画素は无损で、デコード・再エンコードによる画質劣化がない。

## 方式の限界（無言で省略しない記録）

1. **pixelの完全なデコード検証はしていない。** Workersのランタイムには画像デコーダが無く、壊れ画像はチャンク/セグメント構造・CRCの整合で検出する。見た目が破綻するファイル（構造は正しいが内容が壊れている）は検出できない。
2. **PDFのマルウェア検査はしていない。** 字句検査（/JavaScript /JS /Launch /OpenAction /EmbeddedFile /RichMedia /SubmitForm /ImportData の出现で拒否）のみ。難読化された埋込は見逃し得る。
3. これらを本格的に行う場合は、Cloudflare中心を維持した別の検査/変換基盤（例: コンテナ実行の画像変換・外部アンチウイルス）の契約・費用・**実写真の外部送信の可否**を D16/D12 で判断する必要がある。現時点では「検査を省略せず、検出できる範囲を明示して運用する」方式。

## 未実施（検証済みとして扱わない）

**実Cloudflare（実R2・実Workers）上のV02は未実施。** 理由: この環境の `wrangler` は未ログインで、実R2バケット・実Workersがない。局所の試験はwranglerのR2シミュレータ（miniflare）上で実行しており、実R2の整合（一貫性・HEAD/GET/PUTの挙動・ключpreフィックス）は未確認。

残作業と手順（ユーザーの操作が必要）:
1. `npx wrangler login`（または `CLOUDFLARE_API_TOKEN` に R2/Workers 編集権限のトークン）。
2. stagingの資源: `npx wrangler r2 bucket create fireos-staging-files`、`wrangler.jsonc` の `env.staging` に反映（PH1のV01手順と共通）。
3. `npx wrangler d1 migrations apply DB --remote --env staging` → `npx wrangler deploy --env staging`。
4. `npm run bootstrap:admin -- --env staging --remote --confirm staging ...` で管理者を作る。
5. `LIVE_BASE_URL=... LIVE_BOOTSTRAP_EMAIL=... LIVE_BOOTSTRAP_TOKEN=... npm run test:live -- tests/live/file-inspection.test.ts` を実行（実R2へEXIF入りJPEGを送り、検査jobの実行と取得時のEXIF除去を確認）。
6. この文書の「未実施」を実測結果に書き換える。

この手順を実行するまで、V02は **局所のみ検証済み・実環境は未検証**。RG-04/05/10 は引き続き阻止される。添付機能（写真の運用）を「完成」とは扱わない。
