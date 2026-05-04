import crypto from "node:crypto";

export const CLAUDE_VERSION = "2.1.63";
const BILLING_PREFIX = "x-anthropic-billing-header:";

function generateBillingHeader(payload) {
  const content = JSON.stringify(payload);
  const cch = crypto.createHash("sha256").update(content).digest("hex").slice(0, 5);
  const buildHash = crypto.randomBytes(2).toString("hex").slice(0, 3);
  return `${BILLING_PREFIX} cc_version=${CLAUDE_VERSION}.${buildHash}; cc_entrypoint=cli; cch=${cch};`;
}

function generateUUID() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function applyCloaking(body, token) {
  if (!token || !token.includes("sk-ant-oat")) return body;

  const result = { ...body };
  const billingBlock = { type: "text", text: generateBillingHeader(body) };
  if (Array.isArray(result.system)) {
    if (!result.system[0]?.text?.startsWith(BILLING_PREFIX)) {
      result.system = [billingBlock, ...result.system];
    }
  } else if (typeof result.system === "string") {
    result.system = [billingBlock, { type: "text", text: result.system }];
  } else {
    result.system = [billingBlock];
  }

  if (!result.metadata?.user_id) {
    result.metadata = { ...result.metadata, user_id: generateUUID() };
  }
  return result;
}
