export type NotificationChannelType = 'webhook' | 'email' | 'telegram' | 'gotify';

// Align NotificationEvent with AuditLogActionType as requested
export type NotificationEvent =
  | 'LOGIN_SUCCESS' | 'LOGIN_FAILURE' | 'LOGOUT' | 'PASSWORD_CHANGED'
  | '2FA_ENABLED' | '2FA_DISABLED'
  // Passkey Events
  | 'PASSKEY_REGISTERED'
  | 'PASSKEY_AUTH_SUCCESS' // Could also use LOGIN_SUCCESS with a 'method: passkey' detail
  | 'PASSKEY_AUTH_FAILURE'
  | 'PASSKEY_DELETED'
  | 'CONNECTION_CREATED' | 'CONNECTION_UPDATED' | 'CONNECTION_DELETED'
  | 'PROXY_CREATED' | 'PROXY_UPDATED' | 'PROXY_DELETED'
  | 'FOLDER_CREATED' | 'FOLDER_UPDATED' | 'FOLDER_DELETED'
  | 'SETTINGS_UPDATED' | 'IP_WHITELIST_UPDATED' | 'IP_BLOCKED' 
  | 'NOTIFICATION_SETTING_CREATED' | 'NOTIFICATION_SETTING_UPDATED' | 'NOTIFICATION_SETTING_DELETED'
  | 'SSH_CONNECT_SUCCESS' | 'SSH_CONNECT_FAILURE' | 'SSH_SHELL_FAILURE'
  | 'DATABASE_MIGRATION' | 'ADMIN_SETUP_COMPLETE';

export interface WebhookConfig {
  url: string;
  method?: 'POST' | 'GET' | 'PUT'; // Default to POST
  headers?: Record<string, string>; // Optional custom headers
  bodyTemplate?: string; // Optional template for the request body (e.g., using placeholders like {{event}}, {{details}})
}

export interface EmailConfig {
  to: string; // Comma-separated list of recipient emails
  bodyTemplate?: string; // Optional body template (plain text)
  // SMTP settings per channel
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean; // Use TLS
  smtpUser?: string;
  smtpPass?: string; // Consider encryption or secure storage
  from?: string; // Sender email address
}

export interface TelegramConfig {
  botToken: string; // Consider storing this securely, maybe encrypted or via env vars
  chatId: string; // Target chat ID
  messageTemplate?: string; // Optional message template
  customDomain?: string; // 允许用户自定义 Telegram API 域名
}

/**
 * Gotify（自建推送服务）。
 *
 * 协议极简：`POST {serverUrl}/message?token={token}`，
 * body 为 `{ title, message, priority }`，成功返回 `{ id, appid, message }`。
 * 所以只需要「服务器地址 + 应用 Token」两项必填，priority 是可选调优项。
 */
export interface GotifyConfig {
  serverUrl: string; // 例如 https://gotify.example.com（不要带 /message）
  token: string; // 应用 Token（Gotify → Apps → 某个应用的 token）
  priority?: number; // 0~10，默认 5；>=8 在客户端会触发高优先级提醒
  title?: string; // 可选固定标题，留空则用事件名
  messageTemplate?: string; // 可选消息模板
  skipTlsVerify?: boolean; // 自签证书场景：跳过 TLS 校验（谨慎使用）
}

export type NotificationChannelConfig = WebhookConfig | EmailConfig | TelegramConfig | GotifyConfig;

export interface NotificationSetting {
  id?: number;
  channel_type: NotificationChannelType;
  name: string;
  enabled: boolean;
  config: NotificationChannelConfig; // Parsed JSON config
  enabled_events: NotificationEvent[]; // Parsed JSON array
  created_at?: number | string;
  updated_at?: number | string;
}

// Raw data structure from the database before parsing JSON fields
export interface RawNotificationSetting {
    id: number;
    channel_type: NotificationChannelType;
    name: string;
    enabled: number; // SQLite stores BOOLEAN as 0 or 1
    config: string; // JSON string
    enabled_events: string; // JSON string
    created_at: number | string;
    updated_at: number | string;
}

// Type for the data sent with a notification event
export interface NotificationPayload {
    event: NotificationEvent;
    timestamp: number;
    details?: Record<string, any> | string; // Contextual information about the event
}
