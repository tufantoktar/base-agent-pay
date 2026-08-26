import { handleTaskRequest } from "../server/task/handler.js";

export default async function taskHandler(req, res) {
  return handleTaskRequest(req, res);
}
