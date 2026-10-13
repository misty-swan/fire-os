# 05 API仕様書（ドラフト）

## 1. 前提

- APIベースパス（案）：`/api/v1`
- データ交換：JSON、認証済みの同一オリジンリクエストを基本とする。
- 認証方式の細部はBetter Auth等の技術検証後に確定。**クライアントが送るロールやユーザーIDをそのまま信用しない**。
- 正式な出動指令・119番通報等のAPIは設けない。
- 以下はインターフェース設計案であり、実装済みエンドポイントではない。

## 2. 標準レスポンス（案）

成功時：

```json
{
  "data": { "id": "example-id", "status": "open" },
  "meta": { "requestId": "req_example" }
}
```

失敗時：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "入力内容を確認してほしい",
    "details": [{ "field": "latitude", "reason": "範囲外" }]
  },
  "meta": { "requestId": "req_example" }
}
```

| HTTP | 用途 |
|---|---|
| 200 / 201 | 取得・更新成功 / 作成成功 |
| 204 | 削除/無効化処理成功（本文なし） |
| 400 | 入力不正 |
| 401 | 未認証 |
| 403 | 権限なし |
| 404 | 対象なし（権限不足を明かさない必要がある場合を含む） |
| 409 | 競合、重複、更新バージョン不一致 |
| 422 | 業務ルール不適合 |
| 429 | レート制限 |
| 500 / 503 | 内部障害 / 外部依存サービス障害 |

一覧は原則 `limit` と `cursor` でページングする。操作ログに残す相関IDとして `requestId` を返す。

## 3. エンドポイント一覧

| ID | メソッド / パス | 操作 | 主な権限 | 優先 |
|---|---|---|---|---|
| API-01 | `GET /me` | 自分のプロフィールと有効ロール | 全ログイン者 | P0 |
| API-02 | `GET /members` | 団員一覧 | 権限に応じた項目制限 | P0 |
| API-03 | `POST /members` | 団員登録 | 管理者 | P0 |
| API-04 | `PATCH /members/:id` | 団員変更/無効化 | 管理者等 | P0 |
| API-05 | `GET /activities` | 予定・活動一覧 | 全ログイン者 | P0 |
| API-06 | `POST /activities` | 予定作成 | 担当者/幹部 | P0 |
| API-07 | `GET /activities/:id` | 予定詳細・出欠 | 全ログイン者（可視範囲のみ） | P0 |
| API-08 | `PUT /activities/:id/attendance/me` | 自分の出欠の登録/変更 | 本人 | P0 |
| API-09 | `POST /activities/:id/actual-results` | 実績記録 | 担当者/幹部 | P0 |
| API-10 | `GET /facilities` | 施設一覧・地図表示範囲検索 | 全ログイン者 | P0 |
| API-11 | `POST /facilities` | 施設登録 | 権限ある担当者/幹部 | P0 |
| API-12 | `GET /facilities/:id` | 施設詳細・履歴 | 全ログイン者 | P0 |
| API-13 | `PATCH /facilities/:id` | 施設情報変更 | 権限ある担当者/幹部 | P0 |
| API-14 | `POST /facilities/:id/inspections` | 点検記録登録 | ログイン者（担当ルール適用） | P0 |
| API-15 | `GET /issues` | 異常・対応一覧 | ログイン者（可視範囲のみ） | P0 |
| API-16 | `POST /issues` | 異常報告 | ログイン者 | P0 |
| API-17 | `PATCH /issues/:id` | 担当/進捗更新 | 担当者/幹部 | P0 |
| API-18 | `GET /vehicles` | 車両一覧 | ログイン者 | P0 |
| API-19 | `GET /equipment` | 資機材一覧 | ログイン者 | P0 |
| API-20 | `POST /asset-inspections` | 車両・資機材点検 | ログイン者（担当ルール適用） | P0 |
| API-21 | `GET /incidents` | 出動イベント履歴 | ログイン者 | P0 |
| API-22 | `POST /incidents` | イベント登録（模擬/訓練/実績） | 担当者/幹部 | P0 |
| API-23 | `PUT /incidents/:id/participants/:memberId` | 参加・参集記録 | 本人/担当者（詳細ルール要確定） | P0 |
| API-24 | `GET /announcements` | お知らせ一覧 | ログイン者 | P0 |
| API-25 | `POST /announcements` | お知らせ作成 | 担当者/幹部 | P0 |
| API-26 | `POST /attachments/upload-intents` | 非公開添付アップロード準備 | 認証・対象権限必須 | P0 |
| API-27 | `GET /attachments/:id/content` | 非公開添付の取得 | 対象データの閲覧権限必須 | P0 |
| API-28 | `GET /dashboard` | 次回予定・要対応集計 | ログイン者 | P0 |
| API-29 | `POST /ai/classifications` | 分類ジョブ作成 | 登録権限のあるユーザー | P1 |
| API-30 | `GET /ai/reviews` | AI候補一覧 | 担当者/幹部 | P1 |
| API-31 | `POST /ai/reviews/:id/decision` | AI候補承認・却下 | 権限あるレビュアー | P1 |
| API-32 | `POST /reports/drafts` | 報告書下書き生成 | 担当者/幹部 | P1 |

**注記**: 招待、ログイン、セッション更新のエンドポイントは採用する認証ライブラリの仕様に従うため、ここでは固定しない。

## 4. 施設一覧APIの例

`GET /api/v1/facilities?type=hydrant&verificationStatus=verified&bbox=139.70,35.65,139.78,35.72&limit=100`

- `bbox` は `west,south,east,north` の順で、経緯度の妥当性を検証する。
- `type`：`hydrant | cistern | box`
- `verificationStatus`：`unverified | pending | verified`
- 表示地図範囲が大きい場合はページングまたはクラスタリングで対応する。

返却イメージ：

```json
{
  "data": [
    {
      "id": "fac_demo_001",
      "type": "hydrant",
      "managementNumber": "H-001",
      "latitude": 35.685,
      "longitude": 139.75,
      "verificationStatus": "verified",
      "lastInspectedAt": "2026-09-12T01:00:00Z",
      "openIssueCount": 1
    }
  ],
  "meta": { "nextCursor": null, "requestId": "req_example" }
}
```

※ 数値・座標・管理番号は架空のサンプルであり、実データではない。

### 施設登録の例

`POST /api/v1/facilities`

```json
{
  "type": "cistern",
  "managementNumber": "C-TEST-002",
  "latitude": 35.68,
  "longitude": 139.74,
  "locationNote": "架空地点の試験データ",
  "locationSource": "manual_demo",
  "verificationStatus": "unverified"
}
```

必須検証：管理番号重複、緯度経度範囲、登録権限、施設種別、施設登録対象の分団範囲。

## 5. 点検/異常登録APIの例

`POST /api/v1/facilities/fac_demo_001/inspections`

```json
{
  "inspectedAt": "2026-10-13T02:20:00Z",
  "result": "needs_review",
  "checkItems": [
    { "code": "lid", "result": "needs_review" }
  ],
  "note": "蓋の開閉時に抵抗を感じた（デモ）",
  "createIssue": true,
  "attachmentIds": []
}
```

**処理案**：受信→認証認可→必須項目検証→点検履歴保存→必要なら `issues` に確認待ちチケット生成→監査記録。P1では別ジョブでJev分類を行い、確定情報ではなく分類候補を追加する。

## 6. AIレビューAPI例（P1）

`POST /api/v1/ai/reviews/eval_demo_001/decision`

```json
{
  "decision": "approve_with_edit",
  "confirmedCategory": "equipment_issue",
  "reviewNote": "現地で再確認すること",
  "version": 1
}
```

承認はAIによる判定を「設備が使えないという確定事実」にする処理ではない。担当者が確認済みの業務分類・対応依頼として確定する。

## 7. セキュリティ・共通規約

- すべての更新APIは対象レコードの分団・権限をサーバー側で検証する。
- `GET /members` などのレスポンスは閲覧ロールに応じてフィールドを制限する。
- 重要な `POST` は `Idempotency-Key` を導入する方針とし、二重登録を防止する。
- 編集は `version` フィールド等で楽観ロックを行い、競合時409とする。
- ファイル名は信用せず、容量・種類・マルウェア対策・R2参照権限を検証する。
- エラーログにはパスワード、トークン、個人情報、AIへの全文入力を残さない。
- 外部から無制限に利用できる公開APIはP0で提供しない。

## 8. OpenAPI化の方針

この文書は設計ドラフトであり、実装開始前に上記のAPIをOpenAPI 3.1で機械可読に定義する。ZodスキーマとOpenAPIの不整合をCIで検出できる構成を目指す。
