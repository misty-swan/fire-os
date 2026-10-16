# V04 文書のテキスト抽出とRAG検索への投入（T064/T065。OCR・実PDF集合の抽出率実測・Vectorize実測比較は未実施）

方式: **自前の最小PDF抽出器＋fail-closed（復元できないものは保存しない）＋引用spanの原文逆引き**（docs/06 §5、docs/14 D16/D20、docs/16 T064のプリフライト裁定）。実装は `src/server/documents/extract.ts`（extractDocument・extractPdfPages。PDF構造走査＋FlateDecode展開＋テキスト演算子抽出＋ToUnicode CMap対応）、`src/server/documents/chunk.ts`（chunkDocument・resolveCitationSpan。ページ/節/offset付きchunk化）、`src/server/jobs/handlers/document-extract.ts`（document.extract jobのhandler）、fixture（`tests/fixtures/documents/sample-ja.ts`＋生成済みPDF3種。生成手順: `npx tsx scripts/generate-document-fixtures.ts`）。**検索方式の選定（T065）はこの文書のT065節**（d1_fts＋trigramをconfig/search-development.jsonに暫定固定。Vectorize実測比較は未実施手順）。**選定した索引の本番経路（投入・検索・失効回収）の実装（T066）はこの文書のT066節**。

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
| 検索（D1全文検索とVectorizeの比較） | **開発選定は実施済み**（T065節。d1_fts＋trigramをconfig/search-development.jsonに暫定固定）。**本番DDL/索引投入/検索/失効回収の実装はT066で実施**（下のT066節。実装方式と選択backend専用コードのファイル名を記録）。**Vectorizeとの実測比較と実Cloudflareでの実測が残手順**（下の「未実施手順」） |
| RAG回答の品質（docs/06 §6のRAG評価50質問） | T067以降（引用原文一致100%・権限漏えい0の評価は後続） |
| 実Cloudflare（staging）でのjobs/Cron動作 | 未実施。`npm run test:live`のLIVE系手順で確認する |

## T065 検索方式の選定（2026-10-16。実Cloudflare未接続の開発選定）

> **この節の位置づけ**: 実Cloudflare未接続の現時点で確定した**開発選定**であり、下記「未実施手順」の実測比較が完了するまで**採用確定ではない**（docs/14 D16「未決のまま正式リリース: 不可」。d1_ftsへの暫定固定はこの未決を解消しない）。測定値はすべてworkerd（vitest workers pool・実D1。ローカル）での実測で、実Cloudflareでの値ではない。

### 実施したこと（workerd〔実D1〕での実測。指定試験 `retrieval_selection_requires_same_fixed_dataset_and_acl`）

| 確認 | 結果 | 試験内の断言 |
|---|---|---|
| FTS5仮想表がworkerd D1で作成・検索できる（unicode61/trigramの両tokenizer。事前プローブ: `MATCH 点検`〔unicode61〕=0件・`MATCH ポンプ車`〔trigram〕=1件・2字語はtrigramで一致しない〔`MATCH 点検`〔trigram〕=0件〕） | 合格 | tokenizer比較のassertion（trigram > unicode61） |
| **unicode61は日本語を分かち書きしない**: 固定datasetの55問すべてで1件もヒットしない | recall@5 = **0** | `tokenizerComparison.unicode61.recallAtK === 0` |
| **trigram**: 完全一致15/15・言い換え10/10・**略語0/10**（資料に無い略称〔PPE・AED・消ポン等〕はキーワード検索で拾えない＝正直な限界） | recall@5 = **0.581**（25/43） | `recallByType.exact.found === total`・`recallByType.abbreviation.found === 0` |
| 否定・根拠なし・別unitの質問は**全問0件**（根拠無し扱いになる構造。生成時に「語が資料に無いこと」を検査） | unexpectedHitsOnNoEvidence = 0 | 同上 |
| **ACL前置**: unit前置つき検索のraw結果をauthorizedDocumentVersionsで再検査すると拒否0 | unauthorizedChunks = **0** | ブリーフのassertion |
| 防御の実証: unit前置を外した診断実行では別unit質問8件がraw hitとして現れ、再検査が8件すべて拒否 | unauthorizedChunks = 8（診断） | `unfiltered.unauthorizedChunks > 0` |
| 両候補を同一の固定datasetで評価（dataset sha256=808631d64ea1f4ce89598a5d519b5ed0383bd38a9b00975d462f004b700bc860。資料100×20頁相当・chunk 2,000・質問55件〔完全一致15/言い換え10/略語10/否定6/根拠なし6/別unit8〕） | comparedDatasetHashes = [hash, hash] | ブリーフのassertion |
| **根拠（実測）の無い候補の選定は拒否される**（Vectorizeは実測欠如。metrics/measuredAt/evidenceを要求するselectRetrievalBackendが例外で拒否） | missingEvidenceSelectionRejected = **true** | ブリーフのassertion |
| 選定configのversionが記録される（search-dev-v1。config/search-development.jsonと一致） | version ≠ "" | ブリーフのassertion |
| 検索レイテンシ（ローカル実測の参考値。55問・topK=5・chunk 2,000） | trigram p50=1ms/p95=1ms、unicode61 p50=0ms/p95=1ms | 記録のみ（D18の遅延合格値とは別物） |

固定dataset（tests/fixtures/ai/rag-holdout.jsonl。すべて架空データ）は決定的生成スクリプト（scripts/generate-retrieval-dataset.ts。`--check`で一致検査可）と生成TSモジュール2種（tests/fixtures/ai/generated-rag-holdout.ts＋src/server/search/dataset/rag-holdout.ts。T061と同じ二重管理）でコミットし、sha256一致を試験が常時検証する。正解根拠（docKey+pageNo+snippetでchunk特定）と期待挙動（found/not_found）は人手ラベルとしてdatasetに含み、**snippetの資料全体での一意性**と**「検索語の連結ANDが正解文書の外で一致しないこと」**を生成時に検査する（違反は例外＝datasetを壊す編集を防ぐ。検索語は3字以上＝trigramの一致条件）。

### 選定（開発環境の暫定固定。config/search-development.json）

- **backend=d1_fts、tokenizer=trigram、topK=5、version=search-dev-v1**。
- 根拠: ①FTS5がworkerd D1で動く（追加binding・追加契約なし）②trigramが完全一致・言い換えをtopK=5で回収し、unicode61は日本語で0③否定・根拠なし・別unitを1件も返さない（unexpectedHits=0・unauthorizedChunks=0）④Vectorizeは実測欠如のため選定不可（選定関数が根拠の無い候補を拒否）。
- 留意（正直な限界）: 略語10問は0/10。RAG回答（T067）では略語質問は「確認できない」扱いになり得る（根拠を偽装しない）。2字の検索語はtrigramで一致しないため、検索語の組み立て（T066/T067のquery構築）は3字以上の語で行う。
- parseSearchConfig（port.ts）は未知backend・空version・未知キーを拒否する。静的importでのbundle埋め込みはT066接続時。

### 費用比較（公式情報。単価は2026-10-16取得。**実データ量での実測は未実施＝要確認**）

| 項目 | d1_fts（採用） | Workers AI embedding＋Vectorize（未実測） |
|---|---|---|
| 課金の単位 | rows read / rows written / storage（検索=仮想表走査のrows read） | embedding: 入力tokens〔Neurons換算〕＋Vectorize: queried/stored vector dimensions |
| 公式単価 | rows read $0.001/100万行、rows written $1.00/100万行、storage $0.75/GB月〔Workers Paid。読取250億行/月・書込5,000万行/月込み〕（[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)。Free枠は読取500万行/日・書込10万行/日・5GB） | Workers AI $0.011/1,000 Neurons（無料枠10,000 Neurons/日）。embedding候補: @cf/baai/bge-m3 $0.012/100万入力tokens、@cf/pfnet/plamo-embedding-1b $0.019/100万入力tokens〔日本語対応をうたうが**品質は未確認**〕、@cf/qwen/qwen3-embedding-0.6b $0.012/100万入力tokens（[Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)）。Vectorize: queried dimensions $0.01/100万〔5,000万/月込み〕・stored dimensions $0.05/1億〔1,000万込み〕（[Vectorize Pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)） |
| 固定dataset規模での概算（**測定値ではない**） | chunk 2,000行の索引走査≈1検索あたり最大2,000 rows read≈$0.000002。検索1,000回/月≈$0.002（Free枠内の見込み） | 索引化: chunk 2,000×平均~100tokens≈20万tokens≈$0.0024（初回。更新は差分）。検索1,000回/月: 質問embedding＋queried dimensions（2,000×1024次元等）≈40万dimensions＋embedding数十万tokens → 数円未満/月の見込み。**月間件数の前提はD18未確定のため要確認** |
| 運用の追加構成 | 無し（D1のみ。deindex/reindex jobはT063がenqueue済み・T066がhandler実装） | wrangler.jsoncへAI binding＋Vectorize index（次元・metric）追加、索引同期job、metadata filter（unitId/versionId）の運用。失効時のベクトル削除（deindex）も必要 |
| 要確認 | 実データ量・実クエリ数でのrows read（T066がEXPLAIN QUERY PLANとmeta.rows_readで確認） | 日本語品質（plamo/bge-m3/qwen3の実測比較）・次元数（モデルページで要確認）・metadata filterのunit前置の動き・月間クエリ数（D18） |

### 未実施手順（Vectorize候補の実測。検証済みとして扱わない）

1. 実Cloudflare用env（staging）のwrangler.jsoncにAI bindingとvectorize bindingを追加し、`wrangler vectorize create fireos-rag --dimensions=<モデルに合わせる> --metric=cosine` で索引を作る（次元は採用モデルの仕様ページで要確認: bge-m3=1024・plamo-embedding-1b=768・qwen3-embedding-0.6b=1024と案内があるが未確認）。
2. T066の索引投入経路と同じ条件（承認済み＋authorizedDocumentVersionsで通る版）でchunkをembedding化してupsertする（vector id=document_chunks.id、metadata={unitId, documentId, versionId}。検索時はmetadata filterでunit前置を再現する）。
3. **同じsha256の固定dataset**の55問を同一条件（topK=5・同一の期待ラベル）で実行し、本節の表と同じ指標（recall@5・種別別recall・unexpectedHits・unauthorizedChunks・レイテンシ・usage実測）を計算してこの節に追記する。
4. 費用はusage実測（Neurons/dimensions）×公式単価で記録する（上の概算を測定値と混同しない）。
5. **再評価の合否基準（d1_ftsからの乗換え条件）**:
   - 品質: recall@5（全体）がd1_fts実測の0.581を上回り、**略語10問のうち5問以上**を回収すること（キーワード検索で拾えない語をembeddingが拾うのが乗換えの動機。達成できなければ構成増の動機にならない）。
   - 安全: unauthorizedChunks=0・unexpectedHitsOnNoEvidence=0を同じく満たすこと（metadata filterのunit前置＋authorizedDocumentVersions再検査の二重。docs/06 §5.5）。
   - 費用: 月間コストの実測見積がD11の費用枠内で、索引同期・deindexを含む運用手順がdocs/07と整合すること。
   - 判定: D16の未決事項として実測表と合否をdocs/16（T065/T066欄）へ追記して確定する。基準を満たさなければd1_fts＋trigramを本番でも採用する（略語質問は「確認できない」回答で運用）。

## T066 選定した索引の本番経路（投入・検索・失効回収）（2026-10-16。実Cloudflare未接続。実装はworkerd〔実D1エンジン〕で実測）

**選択backend専用コードの具体ファイル名（d1_fts＋trigram。version=search-dev-v1）**:

| 役割 | ファイル | 内容 |
|---|---|---|
| 恒久DDL | `drizzle/0028_search_index.sql` | FTS5仮想表`document_chunks_fts`（trigram。列構成はT065の選定評価と同じ: chunk_id/unit_id/version_id/document_id/page_no/chunk_no UNINDEXED＋text）。**外部contentテーブル方式は不採用**（jobの「全削除＋再投入」で重複0を保証する方が単純で、実測済みの評価条件と一致する） |
| 索引の投入・回収 | `src/server/jobs/handlers/document-index.ts`（indexDocument） | document.index（承認）/document.deindex（撤回）/document.reindex（ACL変更）の3kindを1つのhandlerで受ける（T063がenqueue・handler登録点はsrc/server/routes/documents.tsのimport副作用）。実行時に現状態（承認済み＋非withdrawn）と突き合わせて収束。index/reindexは「FTS行の全削除＋現chunksからの再投入＋index_status='indexed'・index_key=`d1_fts:v1/<chunkId>`更新」の1つのD1 batch（重複実行で効果0）。deindexと失権中のreindexは回収（FTS行削除＋'removed'＋index_key=NULL）。失権中のindex jobは索引化せずstale（document_version_not_indexable）。抽出jobがまだの版はchunks 0件の黙確定を避けretryable（chunks_pending） |
| 検索 | `src/server/search/adapter.ts`（createRetrievalPort(env, config)・SEARCH_CONFIG） | config/search-development.jsonを静的importでbundleに埋め込み（parseSearchConfigに加え非trigramのtokenizerも起動時拒否＝DDLはtrigram）。`RetrievalPort.search`は①検索SQL前置（unit一致・v.status='approved'・d.status<>'withdrawn'・c.index_status='indexed'・FTS行とchunks行の対応。MATCH式は語ごとに引用符で括る＝FTS構文の注入面を潰す。3字以上の語が一致条件）②hit後のauthorizedDocumentVersions再検査（src/server/documents/authorized.ts＝単一の正本）③承認済み・可視のchunkだけをAuthorizedChunkで返す（score=-rank）。backend=vectorizeは実測欠如のため例外で拒否 |
| 回帰試験 | `tests/retrieval.test.ts`（指定試験`index_hit_is_filtered_by_current_d1_acl_and_version`） | 下表のとおり。実Cloudflareの手順は`tests/live/retrieval.test.ts`（環境変数が揃わなければ必ず失敗＝未実施を成功扱いにしない） |

### 実施したこと（workerd〔vitest workers pool・実D1エンジン〕での実測。指定試験 `index_hit_is_filtered_by_current_d1_acl_and_version`）

| 確認 | 結果 | 試験内の断言 |
|---|---|---|
| 承認（API-75）→document.index job→FTS行の投入＋chunksがindexed・index_key=`d1_fts:v1/<chunkId>`へ | 合格（result_ref=`indexed:<N>`） | `result_ref === indexed:${chunks.length}`・index_keyの完全一致 |
| 承認済み・索引済み版の検索hit（trigram。chunk本文はchunks側の正本から返る） | 合格 | `versionIdsOf(hits) === [versionId]`・text/chunkIdがchunks行と一致 |
| **版変更**（v2承認でv1はsuperseded。v1のFTS行は残る）でも旧版は検索で返らない | 合格 | `ftsCount(v1) > 0`（古い行が残っている）で最終検索のreturnedVersionIdsに含まれない |
| **ACL失権**（団員をdeny）はreindex jobの実行前でも即遮断。見える者（admin）は引き続きhit | 合格 | 団員の検索結果`[]`・adminは`[vQ]`・索引にはまだ残っている（ftsCount>0） |
| **撤回**（API-92）はdeindex jobの実行前でも即遮断し、job実行でFTS行削除＋chunksが'removed'へ回収 | 合格 | 遅延中の検索`[]`・`ftsCount(vR)===0`・全chunk行がremoved＋index_key=NULL |
| **失権中のindex jobは索引化しない**（承認→撤回→job実行の順） | 合格 | `staleIndexActivated === false`（jobはstale document_version_not_indexable） |
| **重複実行で効果0**（index job・deindex jobの再実行。lease失効後の再実行を模倣） | 合格 | `duplicateIndexEffects === 0`（FTS行数不変） |
| 抽出jobの再実行でchunk行が作り直された場合、**孤児FTS行（旧chunk_id）は検索で返らない**。reindex jobで現chunksへ収束し検索が回復 | 合格 | 孤児状態の検索`[]`→reindex後、新chunk idでのhit復帰 |
| **古いbackend hit＋現ACL/版の再検査**: 生の索引結果（superseded版のFTS行を含む）のうち、承認済み・可視の版だけが返る。再検査で落としたchunkはraw hitに実在（再検査が実働） | 合格 | `returnedVersionIds === currentAuthorizedVersionIds`（ブリーフのassertion）・admin=[v2,vQ]/団員=[v2]・droppedForMember>0・unauthorizedChunks=0 |
| 変異テスト（手動3件。scripts/mutate.shと同じ方式。終了時に復元済み＝緑を取り直し）: ①adapterのauthorizedDocumentVersions再検査を外す→DETECTED ②失権中index jobの索引化抑止を外す→DETECTED ③索引再構築のDELETE（全削除）を外す→DETECTED | すべてDETECTED | 同上 |

### 限界・残手順（検証済みとして扱わない）

- **実Cloudflare（staging）での実測は未実施**: `tests/live/retrieval.test.ts`の手順（migration 0028適用→API-73/26/74/75で投入→API-86でdocument.indexのsucceededと`indexed:<N>`を確定→〔T067以降〕API-76で検索→API-92で撤回→`removed:<N>`を確定）をLIVE_BASE_URL等の環境変数が揃った状態で実施し、本節を実測で確定する（環境変数が無い状態ではこの試験は必ず失敗する＝skip成功扱いにしない）。
- **実データ量・実クエリ数でのrows read実測は未実施**: 固定dataset規模の概算はT065節どおり。T082（性能・D1クエリ費用）でEXPLAIN QUERY PLANとmeta.rows_readを確認する。
- **検索品質の実測はT065の固定dataset値のまま**: 本番経路（SQL前置＋再検査つき）での再実測・略語0/10の改善（Vectorize対比）は「未実施手順」のとおり。trigramは3字以上の語のみ一致（2字語・資料に無い略語は拾えない＝正直な限界。T067の回答は略語質問で「確認できない」になり得る）。
- **D1のbatch内`meta.changes`はFTS仮想表のDELETEと併用時に信頼できる計上にならない**（実測で発覚。removed数はbatch後のCOUNTで確定する実装にした＝document-index.ts。将来batchのchangesを Effect数に使う場合は単文で確認すること）。

## T067 出典付きRAG回答（2026-10-16。実Cloudflare未接続・実AI未実施。機構の実装と決定的検証で完了）

**選択backend専用コードの具体ファイル名**:

| 役割 | ファイル | 内容 |
|---|---|---|
| 回答の本体 | `src/server/search/rag.ts`（answerRag・runRagLlm・validateRagResponse・buildRagMessages） | フロー: 質問→許可chunk検索（T066のcreateRetrievalPort＋SEARCH_CONFIG）→生成（最小化input＝検索chunk本文＋質問〔D12〕。非信頼本文はsystemに混ぜずuser側`<chunks>`へ＝docs/06 §1）→構造/引用span検証（**決定的**: `{"answer","citations":[{chunk,quote}]}`ちょうどのJSON契約で、quoteがchunk.textに**正規化なしの完全一致**するかindexOfで検査。不適合は限定retry〔1回〕→検証不可はabstained。検証済み出力だけを保存）→出力前の現ACL再検査（authorizedDocumentVersions on cited versionIds＝docs/10 §4の3層目）→保存（rag_answers＋rag_citationsを1つのD1 batch。query_hash=SHA-256のみで質問本文は保存しない）→応答。**引用元に1つでも失権した版があれば回答全体をwithheld**（本文が失権chunkに依存しないことを機械保証できないため。引用を落として残った根拠で出す方式は本文と引用の不一致＝根拠のない主張を残す危険があるため不採用＝docs/16 T067裁定）。LLM_MODELはT057と同じ暫定固定（`@cf/meta/llama-3.3-70b-instruct-fp8-fast`） |
| route | `src/server/routes/rag.ts`（registerRagRoutes） | API-76の登録点（Idempotency-Key不要の読み取り専用POST＝docs/05 §2）。認可以下の本体はanswerRag |
| fake AI（e2e用） | `src/server/ai/local-fake.ts` | TEST_AI_FAKE=1（localのみ）で、検索chunk本文から質問語〔3字以上〕を含む行をそのまま引用して並べる決定的RAG応答（引用はchunk本文の部分列にしかなり得ない＝捏造不能。chunkに質問語が無ければcitations空＝abstain）。**報告書生成のfake保留は変更しない**（応答形は従来どおり不適合→保留。docs/03 §1.1） |
| 回帰試験 | `tests/rag.test.ts`（指定試験`answer_citations_remain_authorized_and_exact`） | 下表のとおり。固定dataset（T065のrag-holdout・sha256固定）＋決定的fake＋サーバー側決定的検証 |
| 実AI評価 | `tests/live/rag-quality.test.ts` | 実Cloudflare（staging・実AI binding）で固定dataset 50問を実行する手順。環境変数が揃わなければ必ず失敗＝未実施を成功扱いにしない |

### 実施したこと（workerd〔vitest workers pool・実D1エンジン〕での実測。指定試験 `answer_citations_remain_authorized_and_exact`）

固定dataset（資料100×20頁・質問55件。T065と同一のsha256 `808631d6…`）を本番経路で検索可能な状態（chunks＋document_chunks_fts）へ投入し、決定的fakeで回答させた。ブリーフのassertionは全て断言済み:

| 確認 | 結果 |
|---|---|
| **根拠ありケース**（exact 2＋exact 1〔団員〕＋paraphrase 1。期待出典はdatasetの人手ラベルからchunk解決）は期待出典付き回答をする | 合格: `citationMatchRate === 1`・`answerableResponsesWithExpectedSources === answerableCaseIds`（全問保留で見かけ上合格にしない） |
| **引用spanが原文と完全一致**（正規化なし。DTOのoffset→chunk.text.slice→rag_citations.quoted_span→T064のresolveCitationSpanで頁テキストへ逆引きまで） | 合格（引用は所在〔pageNo〕も保持） |
| **権限外の内容0**（別unit・非公開〔ACL allow admin/officer〕・draft版〔FTS行まで残して検索条件が落とすのを実測〕・注入文書の指示文・悪いfakeの捏造引用） | 合格: `unauthorizedContentCount === 0`・捏造語彙（50名/18時/【指示】）は全応答に現れない |
| **根拠なし・別unit・非公開・draft版の質問はabstained**（引用0・「確認できない」固定文言・returned=false） | 合格: `noEvidence.abstained === true` |
| **注入文は効果を持たない**（正fakeはchunk本文の引用のみ・悪いfake〔chunk外のquoteを返す〕はサーバー検証が破棄→abstained。検証前の捏造本文はどこにも保存しない＝unvalidatedJsonSaved=false） | 合格 |
| **生成中撤回**（fakeの生成中に正解文書を撤回〔documents.status='withdrawn'。API-92と同じ現状態〕→出力前ACL再検査で失権） | 合格: `returned === false`（withheld。引用0。status='withheld'で保存） |
| **AI無し環境はfail-closed**（503 DEPENDENCY_UNAVAILABLE。偽の回答を作らない） | 合格（answerRag直接・route経由の両方。route未接続なら404になるので接続確認も兼ねる） |
| **保存**（status語彙 answered/abstained/withheld・model_id=要求カタログ名・query_hash=SHA-256〔質問本文は現れない〕・source_versions=根拠版・rag_citationsのchunk_id/quoted_span/page_no/section） | 合格（API-76は都度新行＝同一質問の再実行は複数行） |
| maxSources | 合格（引用数の上限として動く） |

### 限界・残手順（検証済みとして扱わない）

- **実AIでの品質評価は未実施**: staging（実AI binding）で固定dataset 50問以上を実行し、citationMatchRate===1・漏えい0・捏造0・abstained率・usageを実測して本節へ記録する（`tests/live/rag-quality.test.ts`の手順。環境変数が無い状態では必ず失敗）。実AIの応答形（`{"response": …}`の契約・json_schema構造出力への対応）は**実測で初めて確定する前提のfail-closed実装**（契約外の応答は全て検証で破棄＝abstained。T057と同じ考え方）。
- **RAG評価のai_evaluation_runs機構への追加は未実施**（docs/04:155のkind語彙拡張='rag'は実モデル出力が存在するようになってから＝V04。プリフライト裁定3。現状の開発閾値〔引用一致100%/漏えい0/捏造0〕は本節の固定dataset＋決定的検証と上表の試験断言で運用）。
- **回答本文の有用性は未評価**: サーバーが機械的に保証するのは「引用が原文に存在すること」と「権限外の内容が現れないこと」まで。本文の文章品質・質問への適合性・引用の足りなさ（引用は最小の行単位）は実AI評価（上記）と人の確認に委ねる。fakeは「引用の並び」しか作らない（e2e用の決定的応答であり品質の模倣ではない）。
- **略語質問は検索0件→abstained**（T065の正直な限界のまま。Vectorize対比の再評価合否基準はT065節のとおり）。2字語は一致しないため、T070の画面側の質問入力ガイドで「3字以上の語で質問する」運用を検討する。
