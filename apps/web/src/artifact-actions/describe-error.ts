import {ApiError} from "@/api/client";
import {errorMessage} from "@/lib/presentation";

/**
 * Operator-facing text for a failed artifact action. Errors raised by the
 * actions themselves already carry a message written for the person using the
 * dialog; API failures go through the shared presentation mapping.
 */
export function describeActionError(error: Error): string {
  return error instanceof ApiError ? errorMessage(error) : error.message;
}
