import type { syncOperationStates } from "../../shared/states";

/**
 * 端末下書きの型（T075、docs/07 端末保持・docs/14 D14）。
 *
 * 端末に置くのは「まだ送っていない業務入力」だけ。生のsession token・認証情報は
 * どういう形でも保存しない（docs/16 T075。store.putの検査も参照）。
 */

/** 下書きの保存範囲。この3つで「どの端末の・どの分団の・誰の下書きか」を分ける（docs/07: user/unit/device別） */
export interface DraftScope {
  /** 利用者（members.id＝API-01のprofile.memberId） */
  userId: string;
  /** 分団。現行のDTOに分団識別子が無いためT075では表示名（MeData.unitName）を使う（scope絞り込み専用。分離の本体はuserId） */
  unitId: string;
  /** 端末。store.deviceIdOf()が発行・保持する推測不能なUUID（sync操作のdeviceId＝API-81と同じ値） */
  deviceId: string;
}

/** 下書きの状態。語彙は同期操作（docs/11）と同じ。T075が書くのは local_draft で、以降の遷移はT077の同期runnerが担う */
export type DraftStatus = (typeof syncOperationStates)[number];

/** 下書きが参照する端末内の写真。実体はstoreのblob側に置き、ここには参照だけを持つ（docs/07: 必要添付intent参照） */
export interface LocalDraftAttachment {
  /** store.putAttachmentで保存した実体の鍵。attachmentId（サーバー側）は同期時に確定する（T076/T077） */
  blobKey: string;
  name: string;
  contentType: string;
  byteSize: number;
}

/**
 * 端末に置く1件の保留操作。API-81（SyncCommand）の元になる下書きで、
 * clientOperationId/payloadHash/baseVersion はdocs/07端末保持のとおり同期の鍵としてそのまま載る。
 */
export interface LocalDraft {
  scope: DraftScope;
  /** 同期操作の鍵。再送でも不変（docs/07: clientOperationId） */
  clientOperationId: string;
  /** 送り先の業務操作。語彙はT076のallowlist（点検保存・本人出欠・出動参集）で確定する */
  operationCode: string;
  /** 元対象。新規作成の下書きは空（API-81へ載せる形はT077で確定させる） */
  targetId: string;
  /** 元対象の版。新規作成は0（docs/05 同期: VersionOrZero） */
  baseVersion: number;
  /** 業務入力。認証情報は含まない（secret検査はstore.put） */
  payload: Record<string, unknown>;
  /** payloadのSHA-256（16進64桁）。docs/07: payloadHash */
  payloadHash: string;
  status: DraftStatus;
  attachments: LocalDraftAttachment[];
  createdAt: string;
  /** この時刻を過ぎた下書きは送信されず消える（expire）。D14推奨案の検証設定7日（lifecycle.DRAFT_TTL_DAYS） */
  expiresAt: string;
  /**
   * 同期runner（T077）が書く進行メモ（任意欄。無い行はT075作成時の形としてそのまま扱う）。
   * 状態語彙はstatusに寄せ、判明した付帯情報（写真のattachmentId・応答不明印・サーバー側の操作ID・
   * 保留理由）だけをここに置く。ユーザー入力は含まないためsecret検査の対象外。
   */
  memo?: DraftSyncMemo;
}

/** 同期runnerの進行メモ（LocalDraft.memo。任意。T075の行には無い欄なので無いものとしても動く） */
export interface DraftSyncMemo {
  /** blobKey → サーバーのattachmentId（転送・検査を済ませた写真の再利用。同じblobを二重に上げない） */
  attachmentIds?: Record<string, string>;
  /** 送信の応答が消失している（同じclientOperationIdでの照会・再送が必要。勝手に新しい鍵は作らない） */
  responseUnknown?: boolean;
  /** サーバーの同期操作ID（判明していればAPI-82で照会する。docs/05 API-82「本人」） */
  syncOperationId?: string;
  /** 最後に試みた日時（ISO） */
  at?: string;
  /** 保留理由の表示用（サーバーのdetails要約・写真待ちなど。STATUS_LABELと一緒にSCR-27で出す） */
  reason?: string;
  /** サーバーのエラーコード（VERSION_CONFLICT / IDEMPOTENCY_MISMATCH / DUPLICATE など） */
  errorCode?: string;
}

/** 端末保存の失敗の種類。画面はquota/limitを「保存できなかった」と報告する（成功と表示しない。docs/16 T075） */
export type DraftStoreErrorKind =
  | "quota" // 端末の保存容量が足りない（IndexedDB QuotaExceededError）
  | "limit" // 写真の枚数・容量の上限超え（既存の添付経路と同じ上限）
  | "invalid" // 下書きの内容が保存の前提を満たさない（参照する写真が無い、鍵が空など）
  | "secret" // payloadに認証情報と思われる欄がある
  | "unavailable" // この端末・ブラウザでIndexedDBが使えない
  | "io"; // それ以外の読み書きの失敗

export class DraftStoreError extends Error {
  constructor(public readonly kind: DraftStoreErrorKind, message: string) {
    super(message);
    this.name = "DraftStoreError";
  }
}

/**
 * 端末下書きの読み書き。実装はstore.ts（IndexedDB）。scopeによる分離とログアウト消去の責務を持つ
 * （getAttachment/removeはT077の同期runnerと削除操作が使う。読みは必ず本人の鍵だけ）。
 */
export interface DraftStore {
  put(input: LocalDraft): Promise<void>;
  list(scope: { userId: string; unitId: string; deviceId: string }): Promise<LocalDraft[]>;
  purge(scope: DraftScope): Promise<void>;
  expire(now: string): Promise<void>;
  /** 写真の実体を読む（同期時の転送用。無い鍵はnull＝壊れた下書きとして人に報告する） */
  getAttachment(key: string): Promise<{ data: ArrayBuffer; contentType: string; byteSize: number } | null>;
  /** 下書き1件と、それだけが参照する写真を実削除する（反映済み・人が削除した分。送信済みは端末に残さない） */
  remove(clientOperationId: string): Promise<void>;
}
