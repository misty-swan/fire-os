# FireOS ドキュメント・ドラフトパック

- **バージョン**: v0.2（未承認ドラフト）
- **作成日**: 2026-10-13
- **対象**: 団員30名未満の1分団を想定した消防団総合管理Webアプリ
- **方針**: Cloudflare中心の構成 / Google Mapsを使用 / Jev等を使ったAI業務支援

## 収録ファイル

| 文書 | 内容 |
|---|---|
| [00_プロジェクト概要.md](docs/00_プロジェクト概要.md) | 背景、スコープ、関係者、合意事項 |
| [01_要件定義書.md](docs/01_要件定義書.md) | 要件定義 v0.2 を収録。要件ID・受入条件 |
| [02_基本設計書.md](docs/02_基本設計書.md) | システム構成、モジュール分割、データの流れ |
| [03_画面設計・遷移.md](docs/03_画面設計・遷移.md) | 画面一覧、遷移、主要操作、モバイルUI方針 |
| [04_データ設計・ER図.md](docs/04_データ設計・ER図.md) | 概念ER図、エンティティ、制約、履歴方針 |
| [05_API仕様書.md](docs/05_API仕様書.md) | REST API案、入力・出力例、権限、エラー |
| [06_AI設計書.md](docs/06_AI設計書.md) | Jev/LLM、レビュー・承認、評価方針 |
| [07_セキュリティ・運用設計.md](docs/07_セキュリティ・運用設計.md) | 認証・認可、個人情報、障害時対応、料金管理 |
| [08_テスト・受入計画.md](docs/08_テスト・受入計画.md) | 主要テストケース、受入観点、AIの評価 |
| [09_ロードマップ・未決事項.md](docs/09_ロードマップ・未決事項.md) | フェーズ、依存関係、決定・未決事項 |

## プロトタイプ（画面の見た目の参照）

`prototype/` フォルダには、デザインツール Claude Design で作成した見た目の資料を置いています。2026-10-13 に Claude Design の最新版と同期しました。

| ファイル | 内容 |
|---|---|
| `FireOS Prototype.dc.html` | 画面の見た目を確認できるプロトタイプ |
| `FireOS Design System.dc.html` | 色・文字・ボタン・地図マーカーなどの部品ルール |
| `FireOS Directions.dc.html` | デザインの方向性の検討資料 |
| `support.js` | 上記の資料を表示するための共通部品（編集不要） |

**注**: `prototype/` の資料は見た目の参考です。仕様の正は `docs/` 配下の文書です。デザインシステムの画面内に出てくる「v0.2」は資料自身の版表記で、文書パックの版数とは別物です。

## 文書の読み方

1. `01_要件定義書.md` のP0/P1/P2を前提とする。
2. 基本設計・画面・DB・APIの記載は **実装前の設計案** であり、完成済み機能を意味しない。
3. APIパスやDBテーブル名、認証方式の細部は、実装時に改訂してよい。
4. Mermaid図はGitHubなどの対応ビューアーで表示できる。
5. **公開ポートフォリオは架空データのみ** とし、実際の団員名簿・出動情報・非公開水利情報を投入しない。
6. 画面の見た目は `prototype/` を参照する。プロトタイプは設計案であり、完成済み画面ではない。

## 決定済み／検討中

**会話で確定**: Cloudflareをインフラの中心とすること、Google Mapsを地図基盤とすること、消防団の総合管理を目的とすること、消火栓・防火水槽・格納箱を地図で扱うこと。

**設計提案（未確定）**: React/Vite、Hono、Drizzle、D1、R2、Better Auth、Workers AI、Jevの採用範囲、データ構造、画面遷移、通知方式など。

**重要な制約**: 緊急時の唯一の通信・指令系統としては使わない。AIによる結果は原則候補扱いで、重大な情報変更・連絡は権限を持つ人間の承認を必須とする。

## 次版（v0.2）に向けた確認事項

- 実際の分団で使う帳票・点検票・水利台帳の項目
- 団員・班長・幹部・管理者の責任分界
- 位置情報の提供元・利用許諾、公開範囲
- 実際のデータを使用できるか、利用前に必要な承認
- 公式な出動連絡とアプリの境界

## 技術参照（公式）

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Google Maps JavaScript API](https://developers.google.com/maps/documentation/javascript/overview)
- [Google Maps Platform Pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/)

**注**: 料金・モデル提供状況・ライブラリ互換性は変更され得るため、実装前に最新の公式ドキュメントで再確認する。
