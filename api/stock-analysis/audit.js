import { handleStockAnalysisAuditRequest } from "../../server/stocks/stock-audit-handler.js";

export default async function stockAnalysisAuditHandler(req, res) {
  return handleStockAnalysisAuditRequest(req, res);
}
