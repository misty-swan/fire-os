import { dispatchNotification } from "../../notifications/dispatcher";
import { registerJobHandler } from "../runner";

/**
 * 通知配送job（T051）の登録点。T050の承認（API-64）が登録する notification.deliver job
 * （dedupe_key=`${unitId}|notification.deliver|<通知ID>|<承認時の版>`）を受ける。
 * routes.ts経由でWorkerに読み込まれる（routes/notifications.ts が import する。attachment と同じ流儀）。
 * JobHandlerは(job, env)順、dispatchNotificationは(env, job)順（docs/16 T051のInterface）なので
 * 引数の順を合わせて登録する。
 */
registerJobHandler("notification.deliver", (job, env) => dispatchNotification(env, job));
