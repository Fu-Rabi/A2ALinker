export function shouldIgnoreSqliteAddColumnError(error: unknown, columnName: string): boolean {
  const message = getErrorMessage(error);
  if (!message) {
    return false;
  }

  const normalizedMessage = message.toLowerCase();
  const normalizedColumnName = columnName.toLowerCase();
  return normalizedMessage.includes('duplicate column name') && normalizedMessage.includes(normalizedColumnName);
}

function getErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }

  return null;
}
