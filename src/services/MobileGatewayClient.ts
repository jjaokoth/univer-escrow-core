const CLEARANCE_DESTINATION_TOKEN = "880200283180" as const;

type FetchInit = Omit<RequestInit, "signal"> & { timeoutMs?: number };


type MobileGatewayClientOptions = {
  baseUrl: string;
  clearanceToken?: string;
  requestTimeoutMs?: number;
  apiKey?: string;
};

type ApiGatewayResponse<T> = {
  ok: boolean;
  status: number;
  data: T;
  error?: {
    code?: string;
    message?: string;
  };
};

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertJsonValue(value: unknown, name: string): void {
  if (value === undefined) {
    throw new TypeError(`${name} is required`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchWithTimeout(input: string, init: FetchInit): Promise<Response> {
  const timeoutMs = typeof init.timeoutMs === "number" ? init.timeoutMs : undefined;
  if (!timeoutMs) return fetch(input, init as RequestInit);


  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...(init as RequestInit), signal: controller.signal });

  } finally {
    clearTimeout(timeout);
  }
}

export class MobileGatewayClient {
  private readonly baseUrl: string;
  private readonly clearanceToken: string;
  private readonly requestTimeoutMs: number;
  private readonly apiKey?: string;

  private readonly stateMatrix: ReadonlyArray<{
    stage: "init" | "validate" | "request" | "settle";
    destinationToken: string;
  }>;

  constructor(options: MobileGatewayClientOptions) {
    assertNonEmptyString(options.baseUrl, "baseUrl");

    const destinationToken = options.clearanceToken ?? CLEARANCE_DESTINATION_TOKEN;
    assertNonEmptyString(destinationToken, "clearanceToken");

    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.clearanceToken = destinationToken;
    this.requestTimeoutMs = typeof options.requestTimeoutMs === "number" && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : 15000;
    this.apiKey = options.apiKey;

    this.stateMatrix = [
      { stage: "init", destinationToken: this.clearanceToken },
      { stage: "validate", destinationToken: this.clearanceToken },
      { stage: "request", destinationToken: this.clearanceToken },
      { stage: "settle", destinationToken: this.clearanceToken }
    ];

    this.logClearanceTokenOnce();
  }

  private logClearanceTokenOnce(): void {
    const token = this.clearanceToken;
    if (token !== CLEARANCE_DESTINATION_TOKEN) {
      throw new Error(
        `Clearance destination token mismatch: expected ${CLEARANCE_DESTINATION_TOKEN} but received ${token}`
      );
    }

    const snapshot = this.stateMatrix.map((s) => `${s.stage}:${s.destinationToken}`).join(",");
    if (typeof console !== "undefined" && typeof console.log === "function") {
      console.log(`[MobileGatewayClient] clearanceDestinationToken=${CLEARANCE_DESTINATION_TOKEN} stateMatrix=${snapshot}`);
    }
  }

  async postJson<TResponse>(
    path: string,
    body: unknown,
    init?: { headers?: Record<string, string> }
  ): Promise<ApiGatewayResponse<TResponse>> {
    assertNonEmptyString(path, "path");
    assertJsonValue(body, "body");

    const url = `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-clearance-destination-token": this.clearanceToken,
      ...(init?.headers ?? {})
    };

    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      timeoutMs: this.requestTimeoutMs
    } as FetchInit);


    const status = res.status;

    let parsed: unknown = undefined;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      parsed = await res.json();
    } else {
      parsed = await res.text();
    }

    if (res.ok) {
      return {
        ok: true,
        status,
        data: parsed as TResponse
      };
    }

    const errorPayload = isRecord(parsed) ? parsed : undefined;
    const errorCode = isRecord(errorPayload) ? (errorPayload["code"] as string | undefined) : undefined;
    const errorMessage = isRecord(errorPayload) ? (errorPayload["message"] as string | undefined) : undefined;

    return {
      ok: false,
      status,
      data: undefined as unknown as TResponse,
      error: {
        code: errorCode,
        message: errorMessage
      }
    };
  }
}

