import { handleStockAnalysisRequest } from "../server/stocks/stock-analysis-handler.js";

export default async function stockAnalysisHandler(req, res) {
  return handleStockAnalysisRequest(req, res);
}
