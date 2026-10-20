import { PageTitle } from "../../components/Page";
import { Card, Icon, Notice } from "../../components/ui";

/**
 * 使い方ガイド（T086・SHELL-HELP /app/help）。docs/16 T086手順3「導入/通常利用/点検/承認/通知/通信断/復旧の
 * 簡潔な操作説明」。内容の正は docs/USER_GUIDE.md で、この画面は**要点だけ**を章ごとに示す
 * （全文は操作説明書への誘導でカバー。USER_GUIDE §9「画面の操作が分からない」の案内先の一方）。
 *
 * prototypeにhelp画面の個別デザインは無いため、共通部品（PageTitle・Card・Notice・見出しの規約）で
 * 既存の説明系画面（同期の状況SCR-27など）に合わせた簡素な構成にする（docs/03 §1.1の作法）。
 * - 章立て・語彙・順序はUSER_GUIDE.mdと同じ（導入→通常利用→点検→通知→承認→通信断→復旧→困ったとき。
 *   USER_GUIDE §6 AIアシスタントは参考節のため「承認」章の1ステップに要約）。
 * - 各章は番号付きの短いステップ（1〜4行）に収め、実在の団体名・人名は書かない。
 */

/** USER_GUIDE各章の要約。stepsはアプリ内ではこの画面が1次情報にならないよう扼要に保つ */
const CHAPTERS: { id: string; icon: string; title: string; steps: string[] }[] = [
  {
    id: "intro",
    icon: "how_to_reg",
    title: "導入（はじめて使うとき）",
    steps: [
      "管理者から届いた招待のリンクから登録します（リンクには期限があります。誰にも転送しません）。",
      "パスワード（12文字以上）と二要素認証（認証アプリの6桁の数字）を設定します。",
      "回復コード（8個）は紙など安全な場所に書き留めます（1つのコードは1回だけ使えます）。",
    ],
  },
  {
    id: "daily",
    icon: "home",
    title: "通常利用（ホーム・出欠・名簿・お知らせ）",
    steps: [
      "ホームの数字のタイルから、予定・確認待ちの異常・点検期限・自分のタスクへ進めます（数字と一覧の件数は一致します）。",
      "出欠は「予定・活動」の活動を開いて「参加／不参加／未定」で回答します（代理回答は許可された役割だけで、理由が要ります）。",
      "お知らせは項目を開いて「内容を確認」で既読になります（改訂されて新しい版が出たら、もう一度確認します）。",
    ],
  },
  {
    id: "inspection",
    icon: "fact_check",
    title: "点検（施設・資機材・異常・訂正）",
    steps: [
      "「マップ」で施設を探して開き、「点検する」から様式を選び、項目ごとの結果を入れます（車両・資機材も同じ流れです）。",
      "写真とメモを添えて「点検を保存」します（写真は検査が済んだものだけ添付できます）。",
      "「異常あり」で保存すると異常の報告が自動で作られます。「点検管理」で 確認待ち→確認中→対応中→対応実施→終了 へ進めます。",
      "間違えて保存した記録は「訂正」で直します（元の記録は消えずに残ります）。",
    ],
  },
  {
    id: "notifications",
    icon: "notifications",
    title: "通知（受け取る・送る）",
    steps: [
      "自分宛の通知はホームの「通知」か「設定・通知」で読み、「内容を確認」を押すと既読になります（開いただけでは既読になりません）。",
      "届いたか分からないものは「到達不明」と正直に表示されます。",
      "通知の送信は下書きを保存して人の承認が必要です。承認後は配送結果（受付済み・失敗・到達不明）を確認できます。",
    ],
  },
  {
    id: "approvals",
    icon: "task_alt",
    title: "承認（AIの提案・帳票）",
    steps: [
      "AIが異常の分類や帳票の下書きを提案することはあっても、確定・送信・承認は必ず人の操作です。",
      "AIの提案は「AIレビュー」で原文との差分を確かめてから「修正して承認」か「却下」です（古い提案は承認できません）。",
      "活動記録は不足欄を埋めて「承認」で版を確定します。出力（PDF等）できるのは承認された版だけです。",
      "AIアシスタントには権限の範囲で質問でき、回答には出典が付きます（書込・通知の実行には人の確認が要ります）。",
    ],
  },
  {
    id: "offline",
    icon: "cloud_off",
    title: "通信断（圏外・つながらないとき）",
    steps: [
      "圏外でも点検や出欠の入力を始められます。入力は端末に一時保存され、通信が戻ると自動で送られます。",
      "保存の結果が確認できなかったときは「保存しました」と表示しません（入力は端末下書きに残ります）。",
      "通信断のときも、正式な連絡・報告は既存の系統（無線・電話・連絡網）で行ってください。",
    ],
  },
  {
    id: "recovery",
    icon: "cloud_sync",
    title: "復旧（通信が戻った・競合したとき）",
    steps: [
      "通信が戻れば端末下書きは自動で送られます。「同期の状況」で 反映／競合／拒否 の内訳を確認できます。",
      "「応答不明」の入力は「同期の状況」から再送または削除を選びます（削除してもサーバー側の結果は変わりません）。",
      "同じものを別の端末で変更した場合は「競合」として示され、確認してから処理します（前の記録が黙って上書きされることはありません）。",
    ],
  },
];

/** 困ったとき（USER_GUIDE §9の表から、利用者が自分で引き当てやすい6件を抜粋） */
const TROUBLES: { situation: string; action: string }[] = [
  { situation: "招待のリンクを開けない・期限が切れた", action: "管理者に再発行を依頼する" },
  { situation: "ログインできない", action: "管理者へ連絡する（招待の受領が済んでいないか、停止の可能性があります）" },
  { situation: "認証アプリが使えない", action: "ログイン画面の「回復コードを使う」。回復コードも失ったら管理者へ連絡" },
  { situation: "端末を紛失した", action: "すみやかに管理者へ連絡（その端末のログインをすべて解除します）" },
  { situation: "保存しても「結果を確認できません」のまま", action: "「同期の状況」で再送する。解決しなければ管理者へ" },
  { situation: "通知が届かないと言われた", action: "送信側で配送結果の「到達不明」を確認し、既存の連絡手段で直接確認する" },
];

export function HelpPage() {
  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      {/* PCは見出しがヘッダーに出るので、本文の大見出しはスマホのみ（ScreenPlaceholder・SyncPageと同じ規約） */}
      <PageTitle eyebrow="2026 · GUIDE" className="lg:[&_h2]:hidden">
        使い方ガイド
      </PageTitle>
      <Notice tone="info" icon="menu_book" role="status">
        操作の要点を章ごとに示します。詳しい手順は操作説明書（USER_GUIDE）に同じ内容があります。分からないことは管理者へ聞いてください。
      </Notice>
      <Card className="flex flex-col gap-2.5 p-4">
        <p className="text-[15px] font-bold">大事な原則</p>
        <ul className="flex flex-col gap-1.5">
          <li className="text-[13px] leading-[1.7] text-ink-sub">正式な指令・連絡は、いままでどおり既存の系統（無線・電話・連絡網・口頭）が正です。FireOSの通知は記録と補助のためのものです。</li>
          <li className="text-[13px] leading-[1.7] text-ink-sub">AIが決めることはありません。確定・送信・承認は必ず人の操作です。</li>
          <li className="text-[13px] leading-[1.7] text-ink-sub">最初の登録は招待制です。自分で新規登録はできません。</li>
        </ul>
      </Card>
      {CHAPTERS.map((c) => (
        <Card key={c.id} className="flex flex-col gap-3 p-4">
          <section aria-label={c.title} className="flex flex-col gap-3">
            <h3 className="flex items-center gap-2 text-[16px] font-bold">
              <Icon name={c.icon} className="text-[20px] text-ink-muted" />
              {c.title}
            </h3>
            <ol className="flex flex-col gap-1.5">
              {c.steps.map((step, i) => (
                <li key={i} className="flex gap-2.5 text-[13px] leading-[1.7] text-ink-sub">
                  <span aria-hidden="true" className="font-mono text-[12px] font-semibold leading-[1.75] text-ink-muted">
                    {i + 1}
                  </span>
                  <span className="min-w-0">{step}</span>
                </li>
              ))}
            </ol>
          </section>
        </Card>
      ))}
      <Card className="flex flex-col gap-3 p-4">
        <section aria-label="困ったとき" className="flex flex-col gap-3">
          <h3 className="flex items-center gap-2 text-[16px] font-bold">
            <Icon name="help" className="text-[20px] text-ink-muted" />
            困ったとき
          </h3>
          <dl className="flex flex-col gap-2.5">
            {TROUBLES.map((t) => (
              <div key={t.situation} className="flex flex-col gap-1">
                <dt className="text-[13px] font-bold text-ink-sub">{t.situation}</dt>
                <dd className="text-[13px] leading-[1.7] text-ink-muted">{t.action}</dd>
              </div>
            ))}
          </dl>
        </section>
      </Card>
    </div>
  );
}
