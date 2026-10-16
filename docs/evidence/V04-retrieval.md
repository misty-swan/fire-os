# V04 文書のテキスト抽出とRAG検索への投入（T064局所／OCR・実PDF集合での抽出率実測は未実施）

方式: **自前の最小PDF抽出器＋fail-closed（復元できないものは保存しない）＋引用spanの原文逆引き**（docs/06 §5、docs/14 D16/D20、docs/16 T064のプリフライト裁定）。実装は `src/server/documents/extract.ts`（extractDocument・extractPdfPages。PDF構造走査＋FlateDecode展開＋テキスト演算子抽出＋ToUnicode CMap対応）、`src/server/documents/chunk.ts`（chunkDocument・resolveCitationSpan。ページ/節/offset付きchunk化）、`src/server/jobs/handlers/document-extract.ts`（document.extract jobのhandler）、fixture（`tests/fixtures/documents/sample-ja.ts`＋生成済みPDF3種。生成手順: `npx tsx scripts/generate-document-fixtures.ts`）。

## 実施したこと（workerd〔vitest workers pool・実D1/R2〕での実測。実Cloudflareへの接続は無し）

| 確認 | 結果 | 試験 |
|---|---|---|
| 日本語PDF（3頁・見出し・表・改ページ。Type0+Identity-H+ToUnicode CMap+FlateDecode圧縮ストリーム）の抽出が、埋め込んだ元テキストと**1文字も違わず**一致する（chunk.textは頁テキストの部分列そのもの。全chunkの結合が頁テキストに戻る） | 合格 | `chunk_citation_can_be_resolved_to_exact_original_span`（tests/document-extract.test.ts） |
| 引用→原文spanの完全一致: chunk上の引用位置（spanStart/spanEnd）をsource_offsetsで原本の頁と文字位置へ逆引きすると、原本の該当文字列と完全一致する。頁（pageNo）も各頁で正しい | 合格 | 同上（1〜3頁の引用3件） |
| 原本hashの鎖: chunkのsource_offsets.contentHash＝版のcontent_hash＝原本添付のsha256（実bytesの再計算とも一致） | 合格 | 同上 |
| section（見出し）はAI不使用の決定的ルール（「第N章/節/編」「番号付き短い行」「12文字以内の句読点無しの行」）で付き、chunkの開始位置で有効な見出しが記録される | 合格 | 同上（null/第1章/第2章/備考/第3章） |
| 画像のみのPDFはjob=manual_review（error_code=document_ocr_required）で**chunk本文0字**（捏造テキスト無し。inventedOcrText=false） | 合格 | 同上 |
| 壊れたPDF（添付検査FileScannerは通るがFlateDecodeが壊れている）はmanual_review（unextractable_document）でchunk0件 | 合格 | 同上 |
| 同じjobの再実行（lease失効後の再実行を模倣）でも全削除+再INSERTの1つのD1 batchで冪等（chunk重複0。UNIQUE(unit_id,version_id,chunk_no)） | 合格 | 同上 |
| withdrawn版の抽出は実行時再検査でstale（document_withdrawn。chunkを作らない） | 合格 | 同上 |
| 抽出の実行対象と検索可能性の分離: draft版にchunk（index_status='pending'）は有るが、検索の正本authorizedDocumentVersionsは承認前の版を返さない（**index_statusは検索可能を意味しない**。検索はT066が承認済み＋ACLで二重に絞る） | 合格 | 同上 |
| 変異テスト（手動3件。scripts/mutate.shと同じ方式。終了時に復元済み）: ①withdrawn再検査を外す→DETECTED ②全削除+再INSERTのDELETEを外す→UNIQUE違反でDETECTED ③抽出直後にindex_status='indexed'と偽装→DETECTED | すべてDETECTED | 同上 |

抽出器の実装方式（プリフライト裁定2の「自前の最小抽出器」を選択。**依存ライブラリの追加は無し**）:

- **PDF構造走査**: xrefを解釈せず「N G obj〜endobj」の走査＋Catalog→Pages→Kidsの辿りで頁を集める（ObjStm〔PDF1.5以降の圧縮オブジェクト〕の展開に対応。ページ数2,000/深さ64の上限）。`/Length`が間接参照のストリームはendstream走査へ後退。
- **FlateDecode**: `DecompressionStream("deflate")`（zlib形式。失敗時は`deflate-raw`へ後退）。**Node専用APIは使わない**（workerd/vitest workers poolで実測＝ローカルdemoと同条件。workers互換は試験が常時担保する）。予測子（Predictor）付きは未対応=例外（fail-closed）。
- **テキスト演算子**: BT/Tf/Td/TD/Tm/TL/T\*（改行表示）/TJ/Tj/'/"。Y位置の変化で改行を挿入し、同じYの複数表示（表の同一行など）は連結（決定的）。
- **文字対応**: フォントのToUnicode CMap（codespacerange/bfchar/bfrange。Flate圧縮も解凍）を第一とし、無い場合はUniJIS-UCS2系（CID=UTF-16符号単位の直map。T058の帳票PDF出力がこの形）または単純フォントのASCIIのみ。**対応の無いコード・フォントは例外にして部分テキストも作らない**。

## 限界（検証済みとして扱わない）

- **OCRは未実装**: 画像のみのPDF（スキャン紙面）は抽出テキストが0字になるためjob=manual_review（document_ocr_required）に落ち、検索対象にも回答の引用にもならない。OCRの方式（Workers AIのモデル／外部サービス／人手入力）と品質判定は**D20の未決事項**で、了承・実測が取れるまで実装しない。
- **実PDF集合での抽出率は未実測**: 本実装は構造検証済みのfixture（生成物）でroundtripを担保するもの。実運用に紛れる多様なPDF（古い生成器、暗号化、CMYK画像、予測子〔Predictor〕付きFlate、Type3、埋め込み差分フォント等）でどの割合が抽出できるかの実測（抽出率・エラー分類の分布）は、架空データでの技術検証（V04）の残手順。
- **抽出できない要素はfail-closedで落とす**: ToUnicodeが無いType0（Adobe-Japan1のCID→Unicodeの内置換表は持たない）、/Differences、インライン画像（BI〜EI）、予測子付きFlate、暗号化PDF（pdf_encrypted）、未対応フィルタ。部分的な文字列も保存しないため、抽出できる文書のテキストは常に原本と完全一致する（捏造0と引き換えに取りこぼしは保留へ）。
- **表の同一行は連結**: 同じY位置の複数表示は区切り無しで連結する（列の区切りは原本の描き方に依存）。引用spanの完全一致は損なわない（chunk.textは頁テキストの部分列のまま）。
- **対応形式はPDFのみ**（プリフライト裁定）。DOCX/.XLSX等のOffice形式はdocs/14 D20「必要Office/PDF対応を無断削除しない」の確定後に検討する（現時点ではmanual_review unextractable_document）。

## 未実施（検証済みとして扱わない）

| 項目 | 現状 |
|---|---|
| OCR（画像PDFの文字起こし） | 未実装。D20の了承と方式確定まで、画像のみの資料はmanual_reviewのまま（検索不能を明示＝捏造しない） |
| 実PDF集合での抽出率・エラー分布の実測 | 未実施。架空fixtureでのroundtripとfail-closed動作のみ実測 |
| 検索（D1全文検索とVectorizeの比較） | T065/T066で実施（本実装はindex_status='pending'まで。検索方式の実測・日本語品質はD16の残手順） |
| RAG回答の品質（docs/06 §6のRAG評価50質問） | T067以降（引用原文一致100%・権限漏えい0の評価は後続） |
| 実Cloudflare（staging）でのjobs/Cron動作 | 未実施。`npm run test:live`のLIVE系手順で確認する |
