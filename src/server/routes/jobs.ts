import { Job } from "../../shared/contracts/common";
import { getPrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { findJobForRequester } from "../jobs/store";

/** API-86: 永続ジョブの状態照会。依頼者本人のみ。内部入力・内部error本文・Secretは返さない。 */
export function registerJobRoutes(app: ApiApp): void {
  defineRoute(app, "API-86", async (c) => {
    const principal = await getPrincipal(c);
    if (!principal) throw new HttpError("UNAUTHENTICATED");
    const { params } = await parseApiRequest(c, "API-86");
    const job = await findJobForRequester(c.env, params.id, principal.unitId, principal.userId);
    if (!job) throw new HttpError("NOT_FOUND"); // 他人のjobも存在しないものと同じ応答
    // Job DTO(strict)を通すことで、DBの余計な列が応答へ漏れない
    return ok(c, Job.parse({ id: job.id, status: job.status, attempts: job.attempts, errorCode: job.errorCode, resultRef: job.resultRef }));
  });
}
