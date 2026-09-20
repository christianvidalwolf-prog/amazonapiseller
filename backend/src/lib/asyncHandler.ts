import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Forwards rejected promises from async route handlers to Express's error middleware. */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
