const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-access-key",
};

const modelMap = {
  glm: "@cf/zai-org/glm-4.7-flash",
  llama: "@cf/meta/llama-3.2-1b-instruct",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

function isValidMessages(messages) {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every(
      (message) =>
        message &&
        typeof message === "object" &&
        ["system", "user", "assistant"].includes(message.role) &&
        typeof message.content === "string"
    )
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Send a POST request." }, 405);
    }

    if (!env.AI || typeof env.AI.run !== "function") {
      return jsonResponse(
        {
          error: "Workers AI is not bound to this Worker.",
          details: 'Add a Workers AI binding named "AI" in the Worker settings.',
        },
        500
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "Request body must be a JSON object." }, 400);
    }

    const selectedModel = modelMap[body.model] || body.model;
    if (!Object.values(modelMap).includes(selectedModel)) {
      return jsonResponse(
        {
          error: "Invalid or unsupported model specified.",
          validOptions: Object.keys(modelMap),
          validIdentifiers: Object.values(modelMap),
        },
        400
      );
    }

    const input = {};
    if (body.messages !== undefined) {
      if (!isValidMessages(body.messages)) {
        return jsonResponse(
          { error: "messages must be a non-empty array of role/content objects." },
          400
        );
      }
      input.messages = body.messages;
    } else if (typeof body.prompt === "string" && body.prompt.trim()) {
      input.prompt = body.prompt;
    } else {
      return jsonResponse(
        { error: "Provide a non-empty prompt or a non-empty messages array." },
        400
      );
    }

    const requestedMaxTokens = Number(body.max_tokens);
    input.max_tokens = Number.isInteger(requestedMaxTokens)
      ? Math.min(2048, Math.max(128, requestedMaxTokens))
      : 1600;
    input.temperature = 0.2;
    input.stream = false;

    try {
      const result = await env.AI.run(selectedModel, input);
      return jsonResponse({ model: selectedModel, result });
    } catch (error) {
      return jsonResponse(
        {
          error: "Workers AI request failed.",
          details: error instanceof Error ? error.message : String(error),
        },
        502
      );
    }
  },
};
