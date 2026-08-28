import { handleStockAnalysisAuditVerifyRequest } from "../../../server/stocks/stock-audit-verify-handler.js";

export default async function stockAnalysisAuditVerifyHandler(req, res) {
  return handleStockAnalysisAuditVerifyRequest(req, res);
}
