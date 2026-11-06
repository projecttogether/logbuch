import nodemailer from "nodemailer";
import { logger } from "@/lib/logger";
import type { ChannelMode, NotificationChannels } from "./types";

/*
 * Slack over its Web API, email over SMTP or the MailerSend API, plus console
 * transports for development and tests, which only log.
 */

/** A failed send. The worker retries it with backoff, at most 5 attempts. */
export class DeliveryError extends Error {
  readonly code?: string;
  readonly retryAfterMs?: number;
  constructor(message: string, options: { code?: string; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "DeliveryError";
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface SlackTransport {
  mode: "live" | "console";
  /** The Slack user ID for a work email, or null if there is no such (active) user. */
  lookupUserByEmail(email: string): Promise<string | null>;
  /** Sends a direct message from the app to a Slack user. */
  postMessage(userId: string, text: string): Promise<void>;
}

export interface Email {
  to: string;
  toName: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailTransport {
  mode: "live" | "console";
  /** "smtp", "mailersend", or "console". */
  kind: string;
  send(email: Email): Promise<void>;
}

export interface Transports {
  slack?: SlackTransport;
  /** The Slack channel for one post per entry (SLACK_CHANNEL_ID). */
  slackChannelId?: string;
  email?: EmailTransport;
  /** LOGBUCH_BASE_URL, for links in messages. */
  baseUrl: string;
}

/** What the admin page shows for each channel. */
export function channelModes(transports: Transports): NotificationChannels {
  const mode = (t: { mode: "live" | "console" } | undefined): ChannelMode => t?.mode ?? "off";
  return {
    slack: mode(transports.slack),
    slackChannel: transports.slackChannelId ? mode(transports.slack) : "off",
    email: mode(transports.email),
  };
}

const TIMEOUT_MS = 15_000;

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  user?: { id: string; deleted?: boolean };
}

export function createSlackTransport(token: string, fetchImpl: typeof fetch = fetch): SlackTransport {
  async function call(method: string, init: { query?: Record<string, string>; body?: Record<string, unknown> }): Promise<SlackResponse> {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new DeliveryError(`Slack ${method}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 429) throw new DeliveryError(`Slack ${method}: rate limited`, { code: "ratelimited", retryAfterMs: retryAfterMs(response) });
    if (!response.ok) throw new DeliveryError(`Slack ${method}: HTTP ${response.status}`);
    return (await response.json()) as SlackResponse;
  }

  return {
    mode: "live",
    async lookupUserByEmail(email) {
      const result = await call("users.lookupByEmail", { query: { email } });
      if (!result.ok) {
        if (result.error === "users_not_found") return null;
        throw new DeliveryError(`Slack users.lookupByEmail: ${result.error ?? "unknown error"}`, { code: result.error });
      }
      return result.user && !result.user.deleted ? result.user.id : null;
    },
    async postMessage(userId, text) {
      const result = await call("chat.postMessage", { body: { channel: userId, text, unfurl_links: false, unfurl_media: false } });
      if (!result.ok) throw new DeliveryError(`Slack chat.postMessage: ${result.error ?? "unknown error"}`, { code: result.error });
    },
  };
}

export function createMailerSendTransport(
  options: { token: string; from: string; fromName: string },
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  return {
    mode: "live",
    kind: "mailersend",
    async send(email) {
      let response: Response;
      try {
        response = await fetchImpl("https://api.mailersend.com/v1/email", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: JSON.stringify({
            from: { email: options.from, name: options.fromName },
            to: [{ email: email.to, name: email.toName }],
            subject: email.subject,
            text: email.text,
            html: email.html,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new DeliveryError(`MailerSend: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.ok) return;
      const body = (await response.text().catch(() => "")).slice(0, 300);
      throw new DeliveryError(`MailerSend: HTTP ${response.status} ${body}`.trim(), { retryAfterMs: retryAfterMs(response) });
    },
  };
}

/** Mail servers answer 4xx for temporary and 5xx for permanent errors; both are retried. */
interface SmtpError extends Error {
  responseCode?: number;
  code?: string;
}

export function createSmtpTransport(
  options: { url: string; from: string; fromName: string },
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport,
): EmailTransport {
  const transporter = createTransport(options.url, {
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  return {
    mode: "live",
    kind: "smtp",
    async send(email) {
      try {
        await transporter.sendMail({
          from: { name: options.fromName, address: options.from },
          to: { name: email.toName, address: email.to },
          subject: email.subject,
          text: email.text,
          html: email.html,
        });
      } catch (error) {
        const smtp = error as SmtpError;
        const detail = smtp.responseCode ? `SMTP ${smtp.responseCode}` : (smtp.code ?? "SMTP");
        throw new DeliveryError(`${detail}: ${smtp.message}`.slice(0, 500), { code: smtp.code });
      }
    },
  };
}

/** Logs Slack messages instead of sending them (development and tests). */
export function createConsoleSlackTransport(): SlackTransport {
  return {
    mode: "console",
    lookupUserByEmail: async () => null,
    async postMessage(userId, text) {
      logger.info({ channel: "slack", to: userId, text }, "notification (console transport)");
    },
  };
}

/** Logs emails instead of sending them (development and tests). */
export function createConsoleEmailTransport(): EmailTransport {
  return {
    mode: "console",
    kind: "console",
    async send(email) {
      logger.info({ channel: "email", to: email.to, subject: email.subject, text: email.text }, "notification (console transport)");
    },
  };
}

function createEmailTransport(config: {
  SMTP_URL?: string;
  MAILERSEND_API_TOKEN?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME: string;
}): EmailTransport | undefined {
  if (!config.MAIL_FROM) return undefined;
  if (config.SMTP_URL) return createSmtpTransport({ url: config.SMTP_URL, from: config.MAIL_FROM, fromName: config.MAIL_FROM_NAME });
  if (config.MAILERSEND_API_TOKEN) {
    return createMailerSendTransport({ token: config.MAILERSEND_API_TOKEN, from: config.MAIL_FROM, fromName: config.MAIL_FROM_NAME });
  }
  return undefined;
}

/** The transports for this worker's configuration. A channel without its settings is off. */
export function createTransports(config: {
  NOTIFICATION_TRANSPORT: "live" | "console";
  LOGBUCH_BASE_URL: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_CHANNEL_ID?: string;
  SMTP_URL?: string;
  MAILERSEND_API_TOKEN?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME: string;
}): Transports {
  if (config.NOTIFICATION_TRANSPORT === "console") {
    return {
      baseUrl: config.LOGBUCH_BASE_URL,
      slack: createConsoleSlackTransport(),
      slackChannelId: config.SLACK_CHANNEL_ID ?? "console-channel",
      email: createConsoleEmailTransport(),
    };
  }
  return {
    baseUrl: config.LOGBUCH_BASE_URL,
    slack: config.SLACK_BOT_TOKEN ? createSlackTransport(config.SLACK_BOT_TOKEN) : undefined,
    slackChannelId: config.SLACK_CHANNEL_ID,
    email: createEmailTransport(config),
  };
}
