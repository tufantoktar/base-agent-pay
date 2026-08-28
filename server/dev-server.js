import http from "node:http";
import { handleStockAnalysisRequest } from "./stocks/stock-analysis-handler.js";
import { handleStockAnalysisAuditRequest } from "./stocks/stock-audit-handler.js";
import { handleStockAnalysisAuditVerifyRequest } from "./stocks/stock-audit-verify-handler.js";
import { handleTaskRequest } from "./task/handler.js";

const port = Number(process.env.PORT ?? 8787);

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/task" || req.url?.startsWith("/api/task?")) {
    try {
      await handleTaskRequest(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "Internal Server Error",
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        }),
      );
    }
    return;
  }

  if (req.url === "/api/stock-analysis" || req.url?.startsWith("/api/stock-analysis?")) {
    try {
      await handleStockAnalysisRequest(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "Internal Server Error",
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        }),
      );
    }
    return;
  }

  if (
    req.url === "/api/stock-analysis/audit/verify" ||
    req.url?.startsWith("/api/stock-analysis/audit/verify?")
  ) {
    try {
      await handleStockAnalysisAuditVerifyRequest(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "Internal Server Error",
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        }),
      );
    }
    return;
  }

  if (
    req.url === "/api/stock-analysis/audit" ||
    req.url?.startsWith("/api/stock-analysis/audit?")
  ) {
    try {
      await handleStockAnalysisAuditRequest(req, res);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "Internal Server Error",
          code: "INTERNAL_SERVER_ERROR",
          message: error.message,
        }),
      );
    }
    return;
  }

  if (req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "Not Found", code: "NOT_FOUND" }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Base Agent Pay API listening on http://127.0.0.1:${port}`);
});
