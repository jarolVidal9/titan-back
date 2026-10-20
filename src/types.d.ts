import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    /** Lo pone `requireAuth`. */
    user?: { id: number; email: string };
    tokenHash?: string;
  }
}
