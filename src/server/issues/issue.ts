import { issueTransitions, issueStates } from "../../shared/states";
import { z } from "zod";
import { Id, Version } from "../../shared/contracts/common";

/**
 * 異常（docs/04 issues/issue_events、docs/11 異常、docs/05 API-15〜17、D07）。
 * 応答のDTO（T032で暫定から確定）。
 */
export const Issue = z.object({
  id: Id,
  version: Version,
  target: z.object({ type: z.enum(["facility", "vehicle", "equipment"]), id: Id }),
  title: z.string(),
  description: z.string(),
  reportedBy: z.string(),
  assigneeMemberId: Id.nullable(),
  status: z.enum(issueStates),
  confirmedCategory: z.string().nullable(),
  originInspectionId: Id.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Issue = z.infer<typeof Issue>;
export { issueTransitions };
