type RequiredEnvKey =
  | "DATABASE_URL"
  | "REDIS_URL"
  | "NEXTAUTH_SECRET"
  | "NEXTAUTH_URL"
  | "APP_URL";

type OptionalEnvKey =
  | "MYSQL_PORT"
  | "REDIS_PORT"
  | "ABLY_API_KEY"
  | "SHORTLINK_BASE_URL"
  | "RESEND_API_KEY"
  | "RESEND_FROM_EMAIL"
  | "RESEND_REPLY_TO_EMAIL"
  | "R2_ACCOUNT_ID"
  | "R2_ACCESS_KEY_ID"
  | "R2_SECRET_ACCESS_KEY"
  | "R2_BUCKET"
  | "R2_PUBLIC_URL"
  | "WHATSAPP_MOCK_MODE"
  | "PAKASIR_PROJECT_SLUG"
  | "PAKASIR_API_KEY"
  | "PAKASIR_BASE_URL"
  | "PAKASIR_DEFAULT_METHOD"
  | "PAKASIR_WEBHOOK_PATH"
  | "PAKASIR_WEBHOOK_TOKEN"
  | "LOUVIN_API_KEY"
  | "LOUVIN_BASE_URL"
  | "LOUVIN_DEFAULT_METHOD"
  | "LOUVIN_WEBHOOK_PATH"
  | "LOUVIN_WEBHOOK_TOKEN"
  | "SUPERADMIN_EMAILS"
  | "DISABLE_BILLING";

export function isBillingDisabled(): boolean {
  return process.env.DISABLE_BILLING === "true";
}

let cachedEnv: AppEnv | null = null;

const DEV_FALLBACK_AUTH_SECRET = "20byte-dev-auth-secret-change-me";

function readRequiredEnv(key: RequiredEnvKey): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}

export function getEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const env = {} as AppEnv;

  for (const key of REQUIRED_ENV_KEYS) {
    env[key] = readRequiredEnv(key);
  }

  for (const key of OPTIONAL_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }

  env.MYSQL_PORT = env.MYSQL_PORT ?? "3307";
  env.REDIS_PORT = env.REDIS_PORT ?? "6379";
  cachedEnv = env;

  return env;
}

export function getAuthSecret(): string {
  const fromEnv = process.env.NEXTAUTH_SECRET;
  if (fromEnv) {
    return fromEnv;
  }

  if (process.env.NODE_ENV !== "production") {
    return DEV_FALLBACK_AUTH_SECRET;
  }

  throw new Error("Missing required environment variable: NEXTAUTH_SECRET");
}

export function getPakasirConfig() {
  const normalizeLooseQuoted = (value: string | undefined): string => {
    const trimmed = value?.trim() ?? "";
    if (!trimmed) {
      return "";
    }
    return trimmed.replace(/^['"]+|['"]+$/g, "");
  };

  const slug = normalizeLooseQuoted(process.env.PAKASIR_PROJECT_SLUG);
  const apiKey = normalizeLooseQuoted(process.env.PAKASIR_API_KEY);
  const baseUrl = normalizeLooseQuoted(process.env.PAKASIR_BASE_URL) || "https://app.pakasir.com";
  const defaultMethod = normalizeLooseQuoted(process.env.PAKASIR_DEFAULT_METHOD) || "qris";
  const webhookPath = normalizeLooseQuoted(process.env.PAKASIR_WEBHOOK_PATH) || "/api/billing/webhooks/pakasir";
  const webhookToken = normalizeLooseQuoted(process.env.PAKASIR_WEBHOOK_TOKEN);

  if (!slug) {
    throw new Error("Missing required environment variable: PAKASIR_PROJECT_SLUG");
  }

  if (!apiKey) {
    throw new Error("Missing required environment variable: PAKASIR_API_KEY");
  }

  return {
    slug,
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    defaultMethod,
    webhookPath,
    webhookToken
  };
}

export function getLouvinConfig() {
  const normalizeLooseQuoted = (value: string | undefined): string => {
    const trimmed = value?.trim() ?? "";
    if (!trimmed) {
      return "";
    }
    return trimmed.replace(/^['"]+|['"]+$/g, "");
  };

  const apiKey = normalizeLooseQuoted(process.env.LOUVIN_API_KEY);
  const baseUrl = normalizeLooseQuoted(process.env.LOUVIN_BASE_URL) || "https://api.louvin.dev";
  const defaultMethod = normalizeLooseQuoted(process.env.LOUVIN_DEFAULT_METHOD) || "qris";
  const webhookPath = normalizeLooseQuoted(process.env.LOUVIN_WEBHOOK_PATH) || "/api/billing/webhooks/louvin";
  const webhookToken = normalizeLooseQuoted(process.env.LOUVIN_WEBHOOK_TOKEN);

  if (!apiKey) {
    throw new Error("Missing required environment variable: LOUVIN_API_KEY");
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    defaultMethod,
    webhookPath,
    webhookToken
  };
}

export function getSuperadminEmailAllowlist(): Set<string> {
  const raw = process.env.SUPERADMIN_EMAILS ?? "";
  const emails = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return new Set(emails);
}

export function getResendConfig(): {
  enabled: boolean;
  apiKey: string;
  fromEmail: string;
  replyToEmail: string | null;
} {
  const apiKey = process.env.RESEND_API_KEY?.trim() ?? "";
  const fromEmail = process.env.RESEND_FROM_EMAIL?.trim() ?? "";
  const replyToEmailRaw = process.env.RESEND_REPLY_TO_EMAIL?.trim() ?? "";

  return {
    enabled: Boolean(apiKey && fromEmail),
    apiKey,
    fromEmail,
    replyToEmail: replyToEmailRaw || null
  };
}
