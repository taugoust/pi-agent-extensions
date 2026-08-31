import http, { type IncomingHttpHeaders, type RequestOptions } from "node:http";

export class HttpTransportError extends Error {
  constructor(
    message: string,
    readonly kind: "abort" | "timeout" | "request" | "response-error" | "response-aborted" | "response-closed" | "response-too-large",
    readonly responseStarted: boolean,
    readonly cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HttpTransportError";
  }
}

export type BufferedHttpResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

export async function bufferedHttpRequest(options: {
  request: URL | RequestOptions;
  method: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs: number;
  maxResponseBytes?: number;
}): Promise<BufferedHttpResponse> {
  const body = typeof options.body === "string" ? Buffer.from(options.body) : options.body;
  const maximum = options.maxResponseBytes ?? 8 * 1024 * 1024;
  return await new Promise<BufferedHttpResponse>((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: http.ClientRequest | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const fail = (kind: HttpTransportError["kind"], message: string, cause?: unknown) => {
      finish(() => reject(new HttpTransportError(message, kind, responseStarted, cause)));
      req?.destroy();
    };
    const onAbort = () => fail("abort", "HTTP request aborted");
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => fail("timeout", `HTTP request timed out after ${options.timeoutMs}ms`), options.timeoutMs);
    const requestOptions: RequestOptions = options.request instanceof URL
      ? { method: options.method, headers: options.headers, signal: undefined }
      : { ...options.request, method: options.method, headers: options.headers, signal: undefined };
    try {
      req = options.request instanceof URL
        ? http.request(options.request, requestOptions)
        : http.request(requestOptions);
    } catch (error) {
      fail("request", "HTTP request creation failed", error);
      return;
    }
    req.once("response", (res) => {
      responseStarted = true;
      const chunks: Buffer[] = [];
      let length = 0;
      res.on("data", (chunk) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > maximum) {
          fail("response-too-large", `HTTP response exceeded ${maximum} bytes`);
          res.destroy();
          return;
        }
        chunks.push(bytes);
      });
      res.once("error", (error) => fail("response-error", "HTTP response failed", error));
      res.once("aborted", () => fail("response-aborted", "HTTP response aborted before completion"));
      res.once("end", () => finish(() => resolve({ statusCode: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) })));
      res.once("close", () => {
        if (!settled && !res.complete) fail("response-closed", "HTTP response closed before completion");
      });
    });
    req.once("error", (error) => fail("request", "HTTP request failed", error));
    if (body) req.write(body);
    req.end();
  });
}
