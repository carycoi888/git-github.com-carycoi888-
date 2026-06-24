import { handleApiRequest } from "../../server.mjs";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function parseBody(event) {
  if (!event.body) return {};
  try {
    const text = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function normalizePath(event) {
  const rawPath = event.rawUrl ? new URL(event.rawUrl).pathname : event.path;
  if (rawPath.startsWith("/api/")) return rawPath;
  const suffix = rawPath.replace(/^\/\.netlify\/functions\/api\/?/u, "");
  return suffix ? `/api/${suffix}` : "/api";
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: jsonHeaders, body: "" };
  }
  try {
    const payload = await handleApiRequest({
      method: event.httpMethod,
      path: normalizePath(event),
      body: parseBody(event)
    });
    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify(payload, null, 2)
    };
  } catch (error) {
    return {
      statusCode: error.statusCode || 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: error.message }, null, 2)
    };
  }
}
