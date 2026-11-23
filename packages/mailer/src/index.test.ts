import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cockpit-chess/env/shared", () => ({
  env: {
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: 587,
    SMTP_USER: "relay-user",
    SMTP_PASS: "relay-pass",
    SMTP_FROM: "Cockpit Chess <no-reply@example.test>",
  },
}));

const sendMail = vi.fn();
const verify = vi.fn();
const createTransport = vi.fn((_options: Record<string, unknown>) => ({ sendMail, verify }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

const {
  SmtpDeadlineError,
  sendEmail,
  verifyTransport,
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_RETRY_WINDOW_MS,
  SMTP_SEND_DEADLINE_MS,
  SMTP_SOCKET_TIMEOUT_MS,
  SMTP_VERIFY_DEADLINE_MS,
} = await import("./index.js");

const message = { to: "player@example.test", subject: "Hi", html: "<p>Hi</p>" };
const never = () => new Promise<never>(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  sendMail.mockReset();
  verify.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("sendEmail", () => {
  it("passes bounded connection, greeting and idle timeouts to the transport", async () => {
    sendMail.mockResolvedValue({});
    await sendEmail(message);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({
      host: "smtp.example.test",
      port: 587,
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    });
  });

  it("retries a quick failure up to three attempts", async () => {
    sendMail.mockRejectedValue(new Error("421 try later"));
    const sent = sendEmail(message);
    const settled = expect(sent).rejects.toThrow("421 try later");
    await vi.runAllTimersAsync();
    await settled;
    await expect(sent).rejects.not.toBeInstanceOf(SmtpDeadlineError);
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it("returns once an attempt succeeds", async () => {
    sendMail.mockRejectedValueOnce(new Error("421 try later")).mockResolvedValue({});
    const sent = sendEmail(message);
    await vi.runAllTimersAsync();
    await expect(sent).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("allows a retry after one slow failure still inside the window", async () => {
    sendMail
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + SMTP_CONNECTION_TIMEOUT_MS);
        throw new Error("Connection timeout");
      })
      .mockResolvedValue({});
    const sent = sendEmail(message);
    await vi.runAllTimersAsync();
    await expect(sent).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("does not start a retry whose backoff ends past the retry window", async () => {
    // Fails just inside the window; the 500 ms backoff carries it past.
    sendMail.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + SMTP_RETRY_WINDOW_MS - 100);
      throw new Error("Timeout");
    });
    const sent = sendEmail(message);
    const settled = expect(sent).rejects.toThrow("Timeout");
    await vi.runAllTimersAsync();
    await settled;
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("gives up at the elapsed deadline even if the relay keeps the attempt alive", async () => {
    // A relay trickling replies under the idle timeout never ends the attempt.
    sendMail.mockImplementation(never);
    const sent = sendEmail(message);
    const settled = expect(sent).rejects.toThrow(SmtpDeadlineError);
    await vi.advanceTimersByTimeAsync(SMTP_SEND_DEADLINE_MS - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // Every request finishes well inside Cloudflare's ~100 s response timeout.
    expect(SMTP_SEND_DEADLINE_MS).toBeLessThan(90_000);
  });
});

describe("verifyTransport", () => {
  it("reports a reachable relay", async () => {
    verify.mockResolvedValue(true);
    await expect(verifyTransport()).resolves.toBe(true);
  });

  it("reports false at its deadline instead of hanging the request", async () => {
    verify.mockImplementation(never);
    const checked = verifyTransport();
    await vi.advanceTimersByTimeAsync(SMTP_VERIFY_DEADLINE_MS);
    await expect(checked).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
