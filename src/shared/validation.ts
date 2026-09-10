/** Keep untrusted JSON unknown until a schema or type guard validates it. */
export const parseJson = (text: string): unknown => {
  const value: unknown = JSON.parse(text);
  return value;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const hasErrorCode = (error: unknown, code: string | number): boolean =>
  isRecord(error) && error.code === code;
