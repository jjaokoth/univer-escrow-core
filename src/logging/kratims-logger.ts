/*
KRA eTIMS-compliant logging structure (KRA Command/ETIMS fields)

Implementation notes:
- This module defines a structured logging helper that emits JSON.
- Keep PII and secrets out of logs.
- In production, wire it to your logger transport (pino/winston/aws-logs).
*/

export type KratimsLogFields = {
  // KRA / Tax Automation (standardize according to your eTIMS integration)
  kra_tax_year: string | null;
  form_code: string; // e.g. "ETIMS_PAYOUT", "ETIMS_ESCROW"
  transaction_direction: "IN" | "OUT";

  // Correlation / traceability
  correlation_id: string;
  request_id?: string | null;
};

export type KratimsLogger = {
  info(obj: Record<string, unknown>): void;
  warn(obj: Record<string, unknown>): void;
  error(obj: Record<string, unknown>): void;
};

export function createKratimsLogger(options: {
  app: string;
  env: string;
  etims: Omit<KratimsLogFields, "correlation_id">;
  emit?: (line: string) => void;
}): KratimsLogger {

  const emit = options.emit ?? ((line: string) => {
    // eslint-disable-next-line no-console
    console.log(line);
  });

  function base(obj: Record<string, unknown>): Record<string, unknown> {
    return {
      ts: new Date().toISOString(),
      app: options.app,
      env: options.env,
      // KRA eTIMS structure stub
      etims: obj.etims,
      level: obj.level,
      message: obj.message,
      // add any other fields
      ...obj,
    };
  }

  function withLevel(level: "info" | "warn" | "error", obj: Record<string, unknown>) {
    const objAny = obj as any;
    const correlation_id = (objAny.etims?.correlation_id as string | undefined) ?? objAny.correlation_id ?? "";
    const etims = {
      kra_tax_year: options.etims.kra_tax_year,
      form_code: options.etims.form_code,
      transaction_direction: options.etims.transaction_direction,
      correlation_id,
      request_id: (objAny.etims?.request_id as string | null | undefined) ?? null,
    };


    emit(JSON.stringify(
      base({
        ...obj,
        etims,
        level,
        message: obj.message ?? obj.kind ?? "",
      })
    ));
  }

  return {
    info(obj) {
      withLevel("info", obj);
    },
    warn(obj) {
      withLevel("warn", obj);
    },
    error(obj) {
      withLevel("error", obj);
    },
  };
}

