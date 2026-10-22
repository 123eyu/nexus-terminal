import axios from "axios";
import https from "https";
import { INotificationSender } from "../notification.dispatcher.service";
import { ProcessedNotification } from "../notification.processor.service";
import { GotifyConfig } from "../../types/notification.types";
import { buildGotifyMessageUrl, normalizeGotifyBaseUrl, normalizeGotifyPriority } from "../gotify-url";

/**
 * Gotify 推送。
 *
 * 协议就一步：`POST {serverUrl}/message?token={token}`，body `{ title, message, priority }`。
 * 地址与优先级的归一化逻辑抽在 `gotify-url.ts`（纯函数 + 单测），
 * 这里只负责「发出去 + 把失败原因说清楚」。
 */
class GotifySenderService implements INotificationSender {
  async send(notification: ProcessedNotification): Promise<void> {
    const config = notification.config as GotifyConfig;
    const serverUrl = (config.serverUrl || "").trim();
    const token = (config.token || "").trim();

    if (!serverUrl || !token) {
      console.error("[GotifySender] Missing serverUrl or token in configuration.");
      throw new Error("Gotify configuration is incomplete (missing serverUrl or token).");
    }

    const normalized = normalizeGotifyBaseUrl(serverUrl);
    if (!normalized.baseUrl) {
      console.error(`[GotifySender] Invalid serverUrl (${normalized.error}): ${serverUrl}`);
      throw new Error(normalized.error === 'unsupportedProtocol'
        ? `Gotify server URL must start with http:// or https://: ${serverUrl}`
        : `Invalid Gotify server URL: ${serverUrl}`);
    }

    const priority = normalizeGotifyPriority(config.priority);
    const title = (config.title || "").trim() || notification.subject || "Nexus Terminal";
    const messageUrl = buildGotifyMessageUrl(normalized.baseUrl, token);

    try {
      console.log(`[GotifySender] Sending notification to ${normalized.baseUrl} (token: ${maskToken(token)}, priority: ${priority})`);
      const response = await axios.post(
        messageUrl,
        { title, message: notification.body, priority },
        {
          timeout: 10000,
          headers: { "Content-Type": "application/json" },
          validateStatus: () => true,
          ...(config.skipTlsVerify ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) } : {}),
        }
      );

      if (response.status >= 200 && response.status < 300) {
        console.log(`[GotifySender] Successfully sent notification (id: ${response.data?.id ?? "n/a"}).`);
      } else {
        const errorDetail = typeof response.data === "string"
          ? response.data.slice(0, 200)
          : (response.data?.errorDescription || response.data?.error || JSON.stringify(response.data|| {}).slice(0, 200));
        console.error(`[GotifySender] Failed with HTTP ${response.status}: ${errorDetail}`);
        throw new Error(`Gotify API error (HTTP ${response.status}): ${errorDetail}`);
      }
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        console.error(`[GotifySender] Axios error sending notification: ${error.message}`);
        throw new Error(`Failed to send Gotify notification (Axios Error): ${error.message}`);
      }
      console.error("[GotifySender] Unexpected error sending notification:", error);
      throw new Error(`Failed to send Gotify notification (Unexpected Error): ${error.message || error}`);
    }
  }
}

/** Token 只保留首尾几位，日志与报错信息里不出现完整凭据。 */
function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}

const gotifySenderService = new GotifySenderService();
export default gotifySenderService;
