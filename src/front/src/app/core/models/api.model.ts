/** Every backend endpoint returns this envelope — see api/app/core/responses.py. */
export interface SuccessResponse<T> {
    status: string;
    data: T;
    meta?: Record<string, unknown> | null;
}

/**
 * One entry from a FastAPI/Pydantic 422 body.
 *
 * `loc` is the path to the offending value, e.g. `['body', 'phone_number']`, which is what lets the
 * client attach the message to the field that caused it rather than to the form as a whole.
 */
export interface ValidationDetail {
    type: string;
    loc: (string | number)[];
    msg: string;
    input?: unknown;
}

/** Errors are rendered by the handlers registered in api/app/main.py. */
export interface ErrorResponse {
    status: string;
    error_code: string;
    message: string;
    details?: ValidationDetail[] | unknown;
}
