import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    // Intentionally permissive; upstream may attach additional fields.
    [key: string]: any;
  }
}

