// Redacts common API keys, tokens, and credential assignments before indexing or returning snippets.
const SECRET_PATTERNS = [
  // Key=value or Key: value for sensitive env var names
  {
    re: /\b((?:HF|HUGGING_FACE_HUB|OPENAI|ANTHROPIC|GEMINI|GOOGLE|WANDB|GITHUB|GITLAB|STRIPE|AWS|SLACK|DISCORD|TELEGRAM|WEBHOOK|API|SECRET|ACCESS|AUTH|PRIVATE|BEARER)_[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL)|(?:HF_TOKEN|API_KEY|SECRET_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD))\s*([:=])\s*(['"]?)([^\s'"`,;]{6,})\3/gi,
    replace: "$1$2$3[REDACTED]$3",
  },
  // Hugging Face tokens
  { re: /\bhf_[A-Za-z0-9]{16,}\b/g, replace: "[REDACTED:HF_TOKEN]" },
  // OpenAI / Anthropic / Stripe sk- keys
  { re: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g, replace: "[REDACTED:API_KEY]" },
  // GitHub tokens
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED:GH_TOKEN]" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: "[REDACTED:GH_TOKEN]" },
  // Google API keys
  { re: /\bAIza[0-9A-Za-z_-]{20,}\b/g, replace: "[REDACTED:GOOGLE_KEY]" },
  // AWS Access Key ID
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED:AWS_KEY]" },
  // Slack tokens
  { re: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, replace: "[REDACTED:SLACK_TOKEN]" },
  // Bearer tokens in headers/logs
  { re: /(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, replace: "$1[REDACTED]" },
  // Webhook URLs with embedded secrets
  { re: /(https:\/\/(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks)\/)[^\s'"]+/gi, replace: "$1[REDACTED]" },
];

// Strip ANSI escape sequences from terminal scrollback.
const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

export function stripAnsi(text) {
  return String(text || "").replace(ANSI_RE, "");
}

export function redactSecrets(text) {
  let out = String(text || "");
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

export function sanitizeText(text) {
  return redactSecrets(stripAnsi(text)).replace(/\r\n/g, "\n");
}
