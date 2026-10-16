import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { chunkDocument, type DocumentChunkInput } from "../src/server/documents/chunk";

/**
 * RAG検索評価の固定dataset（T065、docs/06 §5、docs/14 D16、docs/16 T065）を決定的に生成する。
 *
 *   npx tsx scripts/generate-retrieval-dataset.ts        # 生成（3ファイルを書き出す）
 *   npx tsx scripts/generate-retrieval-dataset.ts --check # 生成物がコミット済みと一致するかだけ検査
 *
 * 生成物（コミットする。実行ごとに同じ系列になる＝再現可能。乱数・現在時刻は使わない）:
 *  - tests/fixtures/ai/rag-holdout.jsonl          正本。資料100×20頁相当＋RAG質問55件（人手ラベル付き）
 *  - tests/fixtures/ai/generated-rag-holdout.ts   試験がimportする生成モジュール（正本と同一内容）
 *  - src/server/search/dataset/rag-holdout.ts     Worker/Vitest実行時にimportする生成モジュール（同一内容）
 *
 * すべて架空データ（実団員・実地名・連絡先を含まない）。正解根拠（docKey+pageNo+snippetでchunkを特定）
 * と期待挙動（found/not_found）は人手ラベルとしてdatasetに含み、評価はその再計算である。
 *
 * 生成時に検査する不変条件（違反は例外＝datasetを壊す編集を防ぐ）:
 *  - found質問のqueryは空白区切りの各語が3字以上で「"」を含まない
 *  - found質問（exact/paraphrase/other_unit）: 各語が正解頁テキストに連続して含まれ、
 *    **全語を含むchunkが正解文書の外に無い**（語の連結ANDで正解chunkが必ずtopKに入る構造）
 *  - abbreviation: 少なくとも1語が資料全体に無い（キーワード検索で拾えない＝正直な限界の計測点）
 *  - negation/no_evidence: 全語が資料全体に無い（検索しても根拠無し扱いになる構造）
 *  - snippetは資料全体で1か所だけ（正解根拠の誤特定を防ぐ）
 */

const ASPECTS = [
  "日常の巡視", "点検の記録", "備蓄の確認", "訓練の計画", "連絡体制",
  "復旧の手順", "広報の実施", "資機材の保全", "安全管理", "報告の様式",
  "詰所の運用", "水利の確認", "後援の受付", "役割の分担", "若手の研修",
  "暑熱対策", "冬季の対応", "夜間の対応", "初動の確認", "年度の見直し",
] as const;

interface Topic {
  name: string;
  lines: readonly string[];
}

const TOPICS: readonly Topic[] = [
  {
    name: "水防活動要領",
    lines: [
      "堤防の巡回は雨量計の値を確認してから開始する。",
      "砂袋は20袋を1組として詰所の奥に備蓄する。",
      "水位の観測は午前と午後の2回、決められた位置で行う。",
      "増水のおそれがあるときは本部に第一報を入れる。",
      "水防倉庫の鍵は当番係が管理し、使用後は直ちに返却する。",
      "巡視の記録は様式に沿って記入し、当直責任者の確認を受ける。",
      "夜間の巡視では照明器具と反射ベストを必ず携行する。",
      "撤収の際には使用した資材の点検と補充を忘れない。",
    ],
  },
  {
    name: "機材点検マニュアル",
    lines: [
      "可搬ポンプの始動試験は月次点検で必ず実施する。",
      "ホースの接続部に亀裂がない目視点検を行う。",
      "燃料の残量と補充の記録を点検票に書き込む。",
      "点検で異常を見つけたときは使用中止の札を掛ける。",
      "格納位置の表示がずれていないかも併せて確認する。",
      "吸水管のパッキンの劣化は早期に交換を申請する。",
      "点検の結果は月末までに機材係へ報告する。",
      "寒冷期は排水忘れによる凍結破損に注意する。",
    ],
  },
  {
    name: "訓練実施計画",
    lines: [
      "訓練の集合時刻の15分前には詰所に到着する。",
      "員数の確認は名簿の順に従い、欠員は直ちに報告する。",
      "訓練中の負傷に備えて応急処置班をあらかじめ決める。",
      "訓練の種目は年間計画に従って月ごとに割り振る。",
      "初参加の団員には補助員を一人つけて安全を確保する。",
      "実施の記録と写真は翌週までに事務局へ提出する。",
      "悪天候時の中止判断は開始1時間前に本部が行う。",
      "訓練で使用した資機材は元の位置へ戻して点呼を取る。",
    ],
  },
  {
    name: "給水活動手順",
    lines: [
      "給水活動では給水袋の容量と数を事前に数える。",
      "ポンプ車の放水口とホースの口径が合っているか確認する。",
      "給水の順番は要請の受け付け順を原則とする。",
      "メーターの読み値は開始時と終了時に記録する。",
      "長距離の送水では中継の配置を先に決めてから組む。",
      "給水後はホース内の水を抜いて乾燥させてから収納する。",
      "断水時の要請には優先順位の基準をあらかじめ決めておく。",
      "作業後の手洗いうがいを欠かさずに行う。",
    ],
  },
  {
    name: "無線運用要領",
    lines: [
      "無線の呼出は相手の呼出符号を先に送る。",
      "チャネルの切替は本部の指示に従って行う。",
      "通話の内容は簡潔に、復唱が必要な事項は必ず復唱する。",
      "充電は帰署後ただちに開始し、予備電池と交換する。",
      "混信が起きたときは一旦待避してから再送する。",
      "無線機の防水ケースは出動のたびに点検する。",
      "通話記録の様式に時刻と内容を整理して記入する。",
      "アンテナの調整は指定場所以外では行わない。",
    ],
  },
  {
    name: "安全管理規程",
    lines: [
      "熱中症の恐れがある日は作業と休息を交互に行う。",
      "体調不良の申告は遠慮せず、直ちに申し出ること。",
      "安全帯は高所の作業のときだけではなく移動時も着用する。",
      "事故が起きたときは応急処置のあと速やかに本部へ連絡する。",
      "ヒヤリハットの報告は処罰の対象ではなく改善の材料とする。",
      "嵐の接近が予想される日は屋外作業を中止する。",
      "飲酒後の作業はいかなる理由があっても認めない。",
      "安全教育は年2回、全員の参加で実施する。",
    ],
  },
  {
    name: "災害出動要領",
    lines: [
      "出動の要請は市の防災課を通じて受ける。",
      "初動の隊形は先頭に隊長、続いて機材搬送の順とする。",
      "出動の際には記名板への記入を忘れない。",
      "現場到着後はまず人命に関わる場所の確認から始める。",
      "活動の区切りごとに状況を本部へ報告する。",
      "帰還の判断は本部の指示と現場責任者の判断で行う。",
      "出動記録は活動実績の報告とともに整理する。",
      "揺れを感じたときは身の安全を確保してから情報を集める。",
    ],
  },
  {
    name: "資機材管理規程",
    lines: [
      "資機材の貸出しは備付帳への記入が必要である。",
      "格納庫の棚には区分のラベルを貼り、対応する位置に戻す。",
      "耐用年数を過ぎた資機材は廃棄の申請を行う。",
      "貯蔵庫の温度と湿度は月に1回記録する。",
      "紛失に気付いたときは探し物の前に届出を作成する。",
      "新しい資機材は受領後に資産台帳へ登録する。",
      "定期の棚卸しは年度の切り替わりに実施する。",
      "借用中の物品は返却期限を台帳に記して管理する。",
    ],
  },
  {
    name: "研修カリキュラム",
    lines: [
      "新規団員の研修は入団後1か月以内に開始する。",
      "講習の受講記録は個人台帳に記載して保管する。",
      "救急講習は2年ごとに全員が受講する。",
      "研修の教材は団の共有庫に保管して誰でも読めるようにする。",
      "修了試験は筆記と実技の両方で合格を確認する。",
      "外部の講師を招くときは経費の承認を先に取る。",
      "研修の振替は同じ月の中で完了させる。",
      "未受講が続く団員には個別に受講計画を作る。",
    ],
  },
  {
    name: "広報活動の手引き",
    lines: [
      "広報紙の原稿は発行の20日前までに集める。",
      "個人の氏名や顔を掲載するときは本人の同意を取る。",
      "自治会の回覧板を利用した啓発を年4回行う。",
      "子供向けの見学会では火あそびの体験を安全に案内する。",
      "掲示板のチラシは期限が過ぎたら速やかに剥がす。",
      "地区の行事へ出展するときは機材の展示と説明係を決める。",
      "写真の撮影は許可された範囲でのみ行う。",
      "広報の成果は問い合わせの件数で確かめる。",
    ],
  },
];

const DOCS_TOTAL = 100;
const PAGES_PER_DOC = 20;
/** A=主評価unit（1〜80）／B=別unit（81〜100。別unit質問の正解根拠はここにだけある） */
const UNIT_A_DOCS = 80;

/** 人手ラベル1件。snippetは正解根拠の行そのもの（資料全体で一意）。queryは検索に渡す語の列 */
interface QuestionPlan {
  docNo: number;
  page: number;
  snippet: string;
  text: string;
  query: string;
}

/** 完全一致（exact）: 資料の語句をそのまま引用して問う質問 */
const EXACT: readonly QuestionPlan[] = [
  { docNo: 7, page: 3, snippet: "夜間の帰還では現場責任者の許可を受けてから撤退の連絡をする。", text: "夜間の撤退の連絡は誰の許可が要るか", query: "現場責任者 撤退の連絡" },
  { docNo: 2, page: 7, snippet: "吸水管のパッキンは毎年11月に新品へ交換する。", text: "吸水管のパッキンの交換時期", query: "吸水管 パッキン 11月" },
  { docNo: 13, page: 4, snippet: "夜間訓練は8月の第2土曜に実施し、終了後に点呼を取る。", text: "夜間訓練はいつ行うか", query: "夜間訓練 第2土曜 点呼を取る" },
  { docNo: 24, page: 9, snippet: "第五号団地への給水は通行止めの解除後に開始する。", text: "第五号団地への給水の開始条件", query: "第五号団地への給水 通行止め" },
  { docNo: 35, page: 2, snippet: "予備の無線機は詰所の東側戸棚の上段に保管する。", text: "予備の無線機の保管場所", query: "予備の無線機 東側戸棚" },
  { docNo: 46, page: 6, snippet: "夏季の訓練では冷却タオルを全員に配布する。", text: "夏季訓練の冷却タオルの扱い", query: "冷却タオル 夏季の訓練 配布する" },
  { docNo: 57, page: 11, snippet: "土砂災害のおそれがある地域への出動では山側の監視員を置く。", text: "土砂災害現場の監視員の配置", query: "土砂災害 監視員" },
  { docNo: 68, page: 13, snippet: "廃棄の申請は3月末までに資機材係へ提出する。", text: "廃棄の申請の提出期限", query: "廃棄の申請 3月末" },
  { docNo: 79, page: 5, snippet: "ポンプ操法の研修は6月と10月に反復して実施する。", text: "ポンプ操法の研修の実施時期", query: "ポンプ操法 6月と10月" },
  { docNo: 10, page: 15, snippet: "広報紙の発行は4月と10月の年2回とする。", text: "広報紙の発行回数", query: "広報紙の発行 年2回" },
  { docNo: 1, page: 8, snippet: "過水の記録は雨量20ミリを超えた日に作成する。", text: "過水の記録を作る日", query: "過水の記録 雨量20ミリ" },
  { docNo: 22, page: 17, snippet: "可搬ポンプの始動試験は毎月第1日曜に行う。", text: "可搬ポンプの始動試験の日", query: "可搬ポンプ 始動試験 第1日曜" },
  { docNo: 51, page: 7, snippet: "第二堤防の巡回路には落石の表示を2か所に設置する。", text: "第二堤防の巡回路の表示", query: "第二堤防の巡回路 落石の表示" },
  { docNo: 63, page: 3, snippet: "年間訓練計画の見直しは2月の総会で承認を受ける。", text: "年間訓練計画の見直しの手続き", query: "年間訓練計画 総会で承認" },
  { docNo: 76, page: 19, snippet: "折りたたみ担架は詰所の北壁の専用ラックに格納する。", text: "折りたたみ担架の格納位置", query: "折りたたみ担架 北壁の専用ラック" },
];

/** 言い換え（paraphrase）: 質問文は言い換え。検索語は正解根拠の内容語（正解頁に連続して含まれる） */
const PARAPHRASE: readonly QuestionPlan[] = [
  { docNo: 5, page: 5, snippet: "予備電池は充電器の横の引き出しに常時2個を準備する。", text: "無線機の予備電池はどこにしまってあるか", query: "予備電池 引き出し" },
  { docNo: 18, page: 8, snippet: "ホースの予備は西側の棚の下段に20本を限度として保管する。", text: "予備のホースは何本まで置けるか", query: "ホースの予備 西側の棚" },
  { docNo: 31, page: 14, snippet: "給水袋の補充は災害備蓄倉庫の奥の列から出すこと。", text: "給水袋が足りないときはどこから出すか", query: "給水袋 備蓄倉庫" },
  { docNo: 44, page: 12, snippet: "メーターの検定は2年に1回、業者に依頼して行う。", text: "水道メーターの点検はどの間隔で行うか", query: "メーターの検定" },
  { docNo: 52, page: 10, snippet: "油圧シリンダは使用後50時間ごとに注油する。", text: "油圧シリンダの注油の間隔", query: "油圧シリンダ 注油する" },
  { docNo: 65, page: 6, snippet: "移動無線の故障時は携帯電話で本部へ連絡を代える。", text: "車載無線が使えないときの連絡方法", query: "移動無線 携帯電話" },
  { docNo: 71, page: 16, snippet: "土のうの在庫は100袋を下回ったら発注する。", text: "土のうは何袋になったら注文するか", query: "土のうの在庫 発注する" },
  { docNo: 26, page: 18, snippet: "訓練中の水分補給は30分に1回を原則とする。", text: "訓練中の飲み水のタイミング", query: "水分補給 30分に1回" },
  { docNo: 38, page: 3, snippet: "新しいチェーンソーは受領後7日以内に台帳へ登録する。", text: "新しい機材はいつまでに登録するか", query: "チェーンソー 台帳へ登録" },
  { docNo: 59, page: 9, snippet: "救急員の資格更新講習は11月に団の委託で受ける。", text: "救急の資格の更新はいつ行うか", query: "資格更新講習 11月" },
];

/** 略語（abbreviation）: 資料に無い略称で問う。キーワード検索では拾えない限界の計測点（Vectorize比較の動機） */
const ABBREVIATION: readonly QuestionPlan[] = [
  { docNo: 6, page: 7, snippet: "現場では安全靴とヘルメットの着用を義務付ける。", text: "PPEの着用義務について教えて", query: "PPE 着用を義務付ける" },
  { docNo: 27, page: 4, snippet: "ポンプ車は出動の合図があってから5分以内に進発する。", text: "消ポン車の進発は何分以内か", query: "消ポン 進発する" },
  { docNo: 39, page: 8, snippet: "団の共用車には走行記録の装置を取り付けている。", text: "共用車のGPS記録について", query: "GPS 走行記録" },
  { docNo: 48, page: 11, snippet: "自動体外式除細動器は詰所の玄関脇に設置している。", text: "AEDはどこに置いてあるか", query: "AED 玄関脇" },
  { docNo: 11, page: 13, snippet: "河川の水位は監視カメラの映像でも確認できる。", text: "CCTVで水位は見られるか", query: "CCTV 監視カメラ" },
  { docNo: 62, page: 15, snippet: "防護服のサイズはSからLLまでを各2着ずつ備える。", text: "NFPA規格の防護服のサイズ在庫", query: "NFPA サイズ" },
  { docNo: 74, page: 4, snippet: "濁水の吸込には目の細かい網を装着する。", text: "ストレーナ網はいつ使うか", query: "ストレーナ網 濁水の吸込" },
  { docNo: 33, page: 17, snippet: "点検の分担表は4月の最初の訓練で配る。", text: "PDCAで点検分担を見直すか", query: "PDCA 点検の分担表" },
  { docNo: 55, page: 12, snippet: "定期試験電波の発射は総務省の届出の範囲で行う。", text: "電波法上の届出の範囲は", query: "電波法 届出の範囲" },
  { docNo: 77, page: 2, snippet: "要請の受理から出動までの標準時間は10分とする。", text: "初動部隊のRRT基準は", query: "RRT 標準時間" },
];

/** 否定（negation）: 資料に無い事項を確かめる質問。検索しても根拠無し扱いになる構造 */
const NEGATION: readonly { text: string; query: string }[] = [
  { text: "団員に報酬は支給されるか", query: "報酬の額" },
  { text: "有給休暇を取得できるか", query: "有給休暇の取得" },
  { text: "内部監査はどの頻度で行われるか", query: "内部監査の頻度" },
  { text: "入団に必要な運転免許の種類は", query: "中型自動車免許 必要要件" },
  { text: "退団後の年金の窓口はどこか", query: "年金の受給窓口" },
  { text: "英会話の研修はあるか", query: "英会話の研修" },
];

/** 根拠なし（no_evidence）: 資料が扱わない一般的な質問。同じく根拠無し扱い */
const NO_EVIDENCE: readonly { text: string; query: string }[] = [
  { text: "各家庭への避難場所の地図の配布は", query: "避難場所の地図の配布" },
  { text: "災害時のペットの収容は", query: "ペットの収容" },
  { text: "被害を受けた世帯への融資のあっせんは", query: "融資のあっせん" },
  { text: "団の夏季休業の期間は", query: "夏季休業の期間" },
  { text: "博物館の無料見学の案内は", query: "博物館の無料見学" },
  { text: "詰所への太陽光発電の導入は", query: "太陽光発電の導入" },
];

/** 別unit（other_unit）: 正解根拠はunit Bの資料にだけある。unit Aの主体の検索では権限外（0件が正） */
const OTHER_UNIT: readonly QuestionPlan[] = [
  { docNo: 81, page: 3, snippet: "第三排水機場の点検は毎月15日に行う。", text: "第三排水機場の点検の日", query: "第三排水機場の点検" },
  { docNo: 82, page: 6, snippet: "口径65の吸水管は予備を2本保持在庫とする。", text: "口径65の吸水管の在庫数", query: "口径65 吸水管" },
  { docNo: 83, page: 9, snippet: "秋季の総合訓練は10月の第1日曜に実施する。", text: "秋季の総合訓練の実施日", query: "秋季の総合訓練" },
  { docNo: 84, page: 12, snippet: "耐圧試験に合格した給水ホースだけを出動用とする。", text: "出動用の給水ホースの条件", query: "耐圧試験 給水ホース" },
  { docNo: 85, page: 15, snippet: "無線室への立ち入りは無線従事者の資格を持つ者に限る。", text: "無線室に入れるのは誰か", query: "無線室 無線従事者" },
  { docNo: 86, page: 18, snippet: "労災の申請は事故の日から30日以内に行う。", text: "労災の申請の期限", query: "労災の申請 30日以内" },
  { docNo: 87, page: 2, snippet: "夜間の出動では現場の照明を2基以上確保する。", text: "夜間の出動の照明の数", query: "夜間の出動 現場の照明" },
  { docNo: 88, page: 5, snippet: "発電機の燃料は最低10リットルを常時備蓄する。", text: "発電機の燃料の備蓄量", query: "発電機の燃料は最低10リットル" },
];

const pad3 = (n: number) => String(n).padStart(3, "0");
const pad2 = (n: number) => String(n).padStart(2, "0");
const docKeyOf = (docNo: number) => `d${pad3(docNo)}`;

function topicOf(docNo: number): Topic {
  return TOPICS[(docNo - 1) % TOPICS.length]!;
}

/** 1文書20頁の頁テキストを決定的に組み立てる（乱数・現在時刻は使わない） */
function buildPages(docNo: number): string[] {
  const topic = topicOf(docNo);
  const s = ((docNo - 1) % 10) + 1; // 同一話題の中の系番（行の偏りを文書ごとに変える）
  const snippetPlans = plansByDoc.get(docNo) ?? [];
  const pages: string[] = [];
  for (let p = 1; p <= PAGES_PER_DOC; p++) {
    const lines: string[] = [];
    lines.push(`第${p}章 ${ASPECTS[(p - 1) % ASPECTS.length]}`);
    lines.push(topic.lines[(s + p) % topic.lines.length]!);
    lines.push(topic.lines[(s + p + 3) % topic.lines.length]!);
    lines.push(`本書の管理番号は${docKeyOf(docNo)}-${pad2(p)}である（架空の区分）。`);
    lines.push("本資料は試験用の架空文書であり、実在の団体・地域とは関係がない。");
    for (const plan of snippetPlans) {
      if (plan.page === p) lines.push(plan.snippet);
    }
    pages.push(lines.join("\n"));
  }
  return pages;
}

// --- 生成と検査 ------------------------------------------------------------

interface DatasetDocumentRow {
  kind: "document";
  key: string;
  unit: "A" | "B";
  title: string;
  topic: string;
  pages: string[];
}
interface DatasetQuestionRow {
  kind: "question";
  id: string;
  type: "exact" | "paraphrase" | "abbreviation" | "negation" | "no_evidence" | "other_unit";
  /** 自然文の質問（記録・生成評価用。検索には使わない） */
  text: string;
  /** 検索へ渡す語の列（空白区切り。両候補へ同一条件で渡す） */
  query: string;
  expected: {
    behavior: "found" | "not_found";
    docKey: string | null;
    pageNo: number | null;
    snippet: string | null;
  };
}

const plansByDoc = new Map<number, QuestionPlan[]>();
const registerPlans = (plans: readonly QuestionPlan[]): void => {
  for (const plan of plans) {
    const list = plansByDoc.get(plan.docNo) ?? [];
    if (list.some((x) => x.page === plan.page)) throw new Error(`doc${plan.docNo}の${plan.page}頁にsnippetが重複している`);
    list.push(plan);
    plansByDoc.set(plan.docNo, list);
  }
};
registerPlans(EXACT);
registerPlans(PARAPHRASE);
registerPlans(ABBREVIATION);
registerPlans(OTHER_UNIT);

const documents: DatasetDocumentRow[] = [];
for (let i = 1; i <= DOCS_TOTAL; i++) {
  const topic = topicOf(i);
  const s = ((i - 1) % 10) + 1;
  documents.push({
    kind: "document",
    key: docKeyOf(i),
    unit: i <= UNIT_A_DOCS ? "A" : "B",
    title: `${topic.name}（第${s}号・架空）`,
    topic: topic.name,
    pages: buildPages(i),
  });
}

const questions: DatasetQuestionRow[] = [];
EXACT.forEach((plan, i) => {
  questions.push({
    kind: "question", id: `q-e${pad2(i + 1)}`, type: "exact", text: plan.text, query: plan.query,
    expected: { behavior: "found", docKey: docKeyOf(plan.docNo), pageNo: plan.page, snippet: plan.snippet },
  });
});
PARAPHRASE.forEach((plan, i) => {
  questions.push({
    kind: "question", id: `q-p${pad2(i + 1)}`, type: "paraphrase", text: plan.text, query: plan.query,
    expected: { behavior: "found", docKey: docKeyOf(plan.docNo), pageNo: plan.page, snippet: plan.snippet },
  });
});
ABBREVIATION.forEach((plan, i) => {
  questions.push({
    kind: "question", id: `q-a${pad2(i + 1)}`, type: "abbreviation", text: plan.text, query: plan.query,
    expected: { behavior: "found", docKey: docKeyOf(plan.docNo), pageNo: plan.page, snippet: plan.snippet },
  });
});
NEGATION.forEach((q, i) => {
  questions.push({
    kind: "question", id: `q-n${pad2(i + 1)}`, type: "negation", text: q.text, query: q.query,
    expected: { behavior: "not_found", docKey: null, pageNo: null, snippet: null },
  });
});
NO_EVIDENCE.forEach((q, i) => {
  questions.push({
    kind: "question", id: `q-x${pad2(i + 1)}`, type: "no_evidence", text: q.text, query: q.query,
    expected: { behavior: "not_found", docKey: null, pageNo: null, snippet: null },
  });
});
OTHER_UNIT.forEach((plan, i) => {
  questions.push({
    kind: "question", id: `q-u${pad2(i + 1)}`, type: "other_unit", text: plan.text, query: plan.query,
    expected: { behavior: "found", docKey: docKeyOf(plan.docNo), pageNo: plan.page, snippet: plan.snippet },
  });
});

// --- 不変条件の検査（違反は例外。datasetを壊す編集を防ぐ） ------------------

const chunksOfDoc = new Map<string, DocumentChunkInput[]>();
for (const doc of documents) {
  const chunks = chunkDocument({
    versionId: `eval:${doc.key}`,
    documentId: doc.key,
    unitId: doc.unit,
    contentHash: `eval:${doc.key}`,
    extractorVersion: "dataset-generator",
    pages: doc.pages.map((text, idx) => ({ pageNo: idx + 1, text })),
  });
  chunksOfDoc.set(doc.key, chunks);
}
const allChunks = [...chunksOfDoc.values()].flat();
const corpusText = documents.map((d) => d.pages.join("\n")).join("\n");
const termsOf = (query: string): string[] => query.trim().split(/\s+/).filter((t) => t.length > 0);

for (const q of questions) {
  const terms = termsOf(q.query);
  if (terms.length === 0) throw new Error(`${q.id}: queryが空です`);
  for (const term of terms) {
    if (term.length < 3) throw new Error(`${q.id}: 3字未満の語はtrigramで一致判定できない（${term}）`);
    if (term.includes('"')) throw new Error(`${q.id}: queryに「"」は使えない（FTS5の構文）`);
  }
  if (q.expected.behavior === "found") {
    const docKey = q.expected.docKey!;
    const pageText = documents.find((d) => d.key === docKey)!.pages[q.expected.pageNo! - 1]!;
    if (!pageText.includes(q.expected.snippet!)) throw new Error(`${q.id}: snippetが正解頁に含まれない`);
    // abbreviationは資料に無い略称（欠落語）で問うため、それ以外の語は正解頁に連続して含まれること
    for (const term of terms) {
      if (q.type !== "abbreviation" && !pageText.includes(term)) {
        throw new Error(`${q.id}: 語「${term}」が正解頁に連続して含まれない`);
      }
    }
    // 正解chunkの特定（snippetを含むchunkが1つ。正解頁に含まれる語はすべてそのchunkに含まれること。
    // abbreviationは資料に無い略称を含むため、正解頁にある語だけで判定する）
    const targetChunks = chunksOfDoc.get(docKey)!.filter((c) => c.text.includes(q.expected.snippet!));
    if (targetChunks.length !== 1) throw new Error(`${q.id}: snippetを含むchunkが${targetChunks.length}個（1個であること）`);
    const pageTerms = terms.filter((t) => pageText.includes(t));
    if (pageTerms.length === 0) throw new Error(`${q.id}: 正解頁に含まれる検索語が無い`);
    if (!pageTerms.every((t) => targetChunks[0]!.text.includes(t))) throw new Error(`${q.id}: 正解chunkに検索語が含まれない`);
    // 正解文書の外に「正解頁の語をすべて含むchunk」が無いこと（語の連結ANDで正解が必ずtopKに入る構造）
    for (const [otherKey, chunks] of chunksOfDoc) {
      if (otherKey === docKey) continue;
      for (const chunk of chunks) {
        if (pageTerms.every((t) => chunk.text.includes(t))) {
          throw new Error(`${q.id}: 語の連結が他文書（${otherKey}）のchunkでも一致する。語を見直すこと`);
        }
      }
    }
    // snippetは資料全体で1か所
    if (allChunks.filter((c) => c.text.includes(q.expected.snippet!)).length !== 1) {
      throw new Error(`${q.id}: snippetが資料全体で一意でない`);
    }
    if (q.type === "paraphrase" && q.text.includes(q.expected.snippet!)) {
      throw new Error(`${q.id}: paraphraseなのに質問文が正解根拠の行をそのまま引用している`);
    }
    if (q.type === "abbreviation" && !terms.some((t) => !corpusText.includes(t))) {
      throw new Error(`${q.id}: abbreviationなのに全語が資料に含まれる（キーワード検索で拾えてしまう）`);
    }
  } else {
    // 否定・根拠なしは全語が資料に無い（検索してもヒットしない構造＝根拠無し扱いの再現）
    for (const term of terms) {
      if (corpusText.includes(term)) throw new Error(`${q.id}: 根拠無しの質問なのに語「${term}」が資料に含まれる`);
    }
  }
}

// --- 書き出し（正本のjsonlと同一内容の生成TSモジュール2つ） -----------------

const jsonl = [...documents, ...questions].map((row) => JSON.stringify(row)).join("\n") + "\n";

const writeGeneratedTs = (path: string, jsonlPath: string): void => {
  const body =
    `// このファイルは scripts/generate-retrieval-dataset.ts が生成する（手で編集しない。編集すると試験が落ちる）。\n` +
    `// 正本は ${jsonlPath}（同一内容。T065。T061と同じ二重管理）。\n` +
    `export const ragHoldoutJsonl = ${JSON.stringify(jsonl)};\n`;
  writeFileSync(path, body, "utf8");
};

const JSONL_PATH = "tests/fixtures/ai/rag-holdout.jsonl";

if (process.argv.includes("--check")) {
  const committed = await import("node:fs").then((fs) => fs.readFileSync(JSONL_PATH, "utf8"));
  if (committed !== jsonl) {
    console.error("--check: コミット済みのdatasetと生成結果が一致しません。npx tsx scripts/generate-retrieval-dataset.ts を実行して再生成してください");
    process.exit(1);
  }
  console.log(`--check OK: ${JSONL_PATH} は生成結果と一致します`);
} else {
  mkdirSync("tests/fixtures/ai", { recursive: true });
  mkdirSync("src/server/search/dataset", { recursive: true });
  writeFileSync(JSONL_PATH, jsonl, "utf8");
  writeGeneratedTs("tests/fixtures/ai/generated-rag-holdout.ts", JSONL_PATH);
  writeGeneratedTs("src/server/search/dataset/rag-holdout.ts", JSONL_PATH);
  console.log(`${JSONL_PATH}: 文書${documents.length}・質問${questions.length}件`);
  console.log(`chunk総数（chunkDocumentで計算）: ${allChunks.length}`);
  console.log(`sha256: ${createHash("sha256").update(jsonl).digest("hex")}`);
}
